// plugins/multi2api/adapter.js
// multi2api adapter for AnyBridge plugin system
// 上游：https://github.com/Practice019/multi2api
//
// 所有方法第一个参数为 ctx（显式注入，无 bind）。
// ctx 由 sidecar/plugin-loader.js 注入：
//   { commandExists, fetch, fs, path, exec, log, generateHex, generateBase64, generatePassword, pluginDir }
//
// 分工：发布包的获取（下载 + 解压 + 换二进制 + 记版本）由 AnyBridge 的 Rust 侧统一完成，
// 走的是和 CPA（CLIProxyAPI / CPA Manager Plus）安装部署完全相同的一条链路 ——
// 系统代理 + 镜像测速挑最快源 + 逐源重试。plugin.json 的 deploy.asset 声明要哪个产物。
//
// 这里只负责下载之后的事：磁盘预检、生成配置、启动参数、健康检查、面板数据。
// 不再用 curl 下载：curl.exe 用自带 CA 包，本机代理 / 企业网下极易 60 失败。

const BINARY = 'wb2api-server';
const PLUGIN_ID = 'multi2api';
const DEFAULT_PORT = 7863;
const VERSION_FILE = '.wb2api-version';
const CONFIG_NAME = 'config.json';
const MIN_DISK_MB = 120; // 与 plugin.json 的 deploy.minDiskMB 保持一致
const NETWORK_TIMEOUT_MS = 30000;

function binFileName() {
  return process.platform === 'win32' ? `${BINARY}.exe` : BINARY;
}

// ── 路径 ──────────────────────────────────────────────────────────────────
// 与 Rust 侧 plugins_dir()（dirs::config_dir + AnyBridge/plugins）对齐，
// 用于在无 installPath 的面板方法里读回端口与密钥。
//
// 用户目录可能含空格或中文（C:\Users\John Doe、/home/张三），因此路径一律用
// path.join 组装、绝不在 shell 命令里裸拼；拿不到主目录就明确报错，而不是
// 退化成相对路径把插件装到当前工作目录里去。
function homeDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('无法确定用户主目录（HOME / USERPROFILE 均未设置），无法定位插件数据目录。');
  }
  return home;
}

function anybridgePluginDir(ctx) {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || ctx.path.join(homeDir(), 'AppData', 'Roaming');
    return ctx.path.join(appData, 'AnyBridge', 'plugins', PLUGIN_ID);
  }
  if (platform === 'darwin') {
    return ctx.path.join(homeDir(), 'Library', 'Application Support', 'AnyBridge', 'plugins', PLUGIN_ID);
  }
  const xdg = process.env.XDG_CONFIG_HOME || ctx.path.join(homeDir(), '.config');
  return ctx.path.join(xdg, 'AnyBridge', 'plugins', PLUGIN_ID);
}

async function readInstalledVersion(ctx, installPath) {
  try {
    return (await ctx.fs.readFile(ctx.path.join(installPath, VERSION_FILE), 'utf-8')).trim();
  } catch {
    return '';
  }
}

// 磁盘空间预检：二进制约 5MB，但解压过程与后续运行（账号池、日志）都需要余量。
// 空间不足时提前说清楚，好过写配置到一半失败。
async function ensureDiskSpace(ctx, installPath) {
  const statfs = ctx.fs.statfs;
  if (typeof statfs !== 'function') return; // 老版本 Node 没有 statfs，跳过而不拦路
  try {
    const st = await statfs(installPath);
    const freeMB = (st.bavail * st.bsize) / (1024 * 1024);
    if (freeMB < MIN_DISK_MB) {
      throw new Error(
        `磁盘空间不足：安装目录仅剩 ${Math.round(freeMB)} MB，至少需要 ${MIN_DISK_MB} MB。请清理后重试。`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('磁盘空间不足')) throw e;
    // 探测失败（如不支持的文件系统）不阻断安装
  }
}

// 二进制由 Rust 在部署/更新开始时放到安装目录。这里只校验、不下载：
// 缺失说明前置步骤没走完，如实报错而不是自己再造一条下载路径。
async function requireBinary(ctx, installPath) {
  const binPath = ctx.path.join(installPath, binFileName());
  try {
    await ctx.fs.access(binPath);
  } catch {
    throw new Error(
      `安装目录缺少 ${binFileName()}（${binPath}）。请重新执行安装，让 AnyBridge 重新获取发布包。`
    );
  }
  return binPath;
}

// ── 网关 HTTP ─────────────────────────────────────────────────────────────
async function readStoredConfig(ctx) {
  try {
    return JSON.parse(await ctx.fs.readFile(ctx.path.join(anybridgePluginDir(ctx), CONFIG_NAME), 'utf-8'));
  } catch {
    return {};
  }
}

async function gatewayFetch(ctx, port, urlPath, apiKey) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await ctx.fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers,
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  return res;
}

export default {
  // ═══════════════════════════════════════════════════════════════════════
  // 部署阶段
  // ═══════════════════════════════════════════════════════════════════════

  // 预编译二进制直接运行，本机不需要 Go / Node / Docker / git。
  // 下载工具也无需检查：抓包由 AnyBridge 的 Rust 侧完成（不依赖 curl / tar）。
  async checkEnvironment(ctx, strategy = 'adapter') {
    return { ready: true, missing: [], strategy };
  },

  async generateConfig(ctx, configValues, installPath) {
    await ctx.fs.mkdir(installPath, { recursive: true });
    await ensureDiskSpace(ctx, installPath);
    await requireBinary(ctx, installPath);

    const port = Number(configValues.port) || DEFAULT_PORT;
    const apiKey = configValues.apiKey || ctx.generateBase64(32);
    const adminToken = configValues.adminToken || ctx.generateBase64(32);

    // 保持与上游 config.example.json 的部署形态一致；
    // max_body_mb 上调到 32：编码 Agent 的长上下文请求体容易超过默认 8MB 触发 413。
    const config = {
      listen: `127.0.0.1:${port}`,
      api_key: apiKey,
      admin_token: adminToken,
      service_name: BINARY,
      auth_dir: './auths',
      state_file: './data/state.json',
      server: { max_body_mb: 32 },
      pool: { health_check_interval_seconds: 600 },
      session_sticky: { enabled: true },
      schedule: {
        checkin_enabled: true,
        checkin_hours: [9, 21],
        keepalive_enabled: true,
        keepalive_hours: [22],
        activity_enabled: true,
        activity_hours: [10]
      },
      login: { open_browser: true, isolated: true }
    };

    const configPath = ctx.path.join(installPath, CONFIG_NAME);
    await ctx.fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    ctx.log('info', `配置文件已生成 ${configPath}`);
    return { configPath };
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 运行阶段
  // ═══════════════════════════════════════════════════════════════════════

  async prepareStart(ctx, installPath, configValues) {
    const binPath = await requireBinary(ctx, installPath);

    const port = Number(configValues.port) || DEFAULT_PORT;
    ctx.log('info', `启动 ${BINARY} -config config.json（端口 ${port}）`);

    return {
      command: binPath,
      args: ['-config', CONFIG_NAME],
      cwd: installPath,
      env: {}
    };
  },

  // 返回 null：交由 AnyBridge 发送 stopSignal（SIGTERM）。
  // 上游已注册 SIGTERM 信号处理，会先落盘账号池状态再做优雅停机。
  async prepareStop(ctx, installPath, configValues) {
    return null;
  },

  // ── 健康检查 ────────────────────────────────────────────────────────────
  // 上游的 /healthz 是**业务**健康检查：账号池里没有可用账号时返回 503
  // （{"healthy":0,"service":"wb2api-server","total":0}）。刚装好还没加账号
  // 必然是 503，若拿它当进程存活判据，插件会一直显示异常。
  //
  // 这里改判「能否拿到它的响应」——回答说得出话就是活着；账号数为 0 只是
  // 尚未配置，放到 detail 里展示，不算故障。
  async healthCheck(ctx, port) {
    try {
      const res = await ctx.fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => ({}));
      const alive = Boolean(body.service);
      return {
        ok: alive,
        detail: alive
          ? `HTTP ${res.status} 可用账号 ${body.healthy ?? '-'}/${body.total ?? '-'}`
          : `HTTP ${res.status} 响应缺少 service 字段`
      };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 更新：二进制由 Rust 换成新版本后才调用到这里，这里只做收尾核对。
  // config.json、auths/ 凭证目录、data/ 运行状态全程不动。
  // ═══════════════════════════════════════════════════════════════════════

  async upgrade(ctx, installPath, configValues, onProgress) {
    await requireBinary(ctx, installPath);
    const version = await readInstalledVersion(ctx, installPath);
    onProgress?.({ step: 'done', status: 'done', message: '二进制已更新，凭证与配置保留不变' });
    return {
      ok: true,
      message: version ? `已更新 ${BINARY} 到 ${version}` : `${BINARY} 已更新`,
    };
  },

  // 版本切换由 Rust 侧拦截处理（下载 → 换二进制 → 按原状态重启），这里不实现，
  // 以免出现第二条下载路径。

  // ═══════════════════════════════════════════════════════════════════════
  // 卸载：凭证是 OAuth 登录的成果，丢失后需要逐个重新扫码，故先备份再删除
  // ═══════════════════════════════════════════════════════════════════════

  async prepareUninstall(ctx, installPath, configValues) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = ctx.path.join(
      homeDir(),
      '.anybridge',
      `${PLUGIN_ID}-backup-${stamp}`
    );

    let copied = 0;
    for (const dir of ['auths', 'data']) {
      const from = ctx.path.join(installPath, dir);
      if (!await ctx.fs.access(from).then(() => true).catch(() => false)) continue;
      await ctx.fs.cp(from, ctx.path.join(backupRoot, dir), { recursive: true });
      copied++;
    }

    if (copied > 0) {
      ctx.log('info', `凭证与运行状态已备份到 ${backupRoot}`);
    }
    return { backupPath: copied > 0 ? backupRoot : '' };
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 管理面板（panels → gateway）
  // 复杂管理交给上游自带的 /ui 控制台；这里只呈现确定契的字段。
  // ═══════════════════════════════════════════════════════════════════════

  async getGatewayStatus(ctx, port) {
    const stored = await readStoredConfig(ctx);
    const apiBase = `http://127.0.0.1:${port || stored.port || DEFAULT_PORT}/v1`;

    const healthRes = await ctx.fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    // 没有可用账号时这里是 503 —— 那属于「还没添加账号」，不是故障，别在这里抛
    const health = await healthRes.json().catch(() => ({}));
    if (!health.service) {
      throw new Error(`网关未响应（HTTP ${healthRes.status}）`);
    }

    const modelsRes = await gatewayFetch(ctx, port, '/v1/models', stored.apiKey);
    if (!modelsRes.ok) {
      throw new Error(`拉取模型目录失败 HTTP ${modelsRes.status}。请检查配置中的 API 密钥。`);
    }
    const modelsPayload = await modelsRes.json();
    const models = Array.isArray(modelsPayload?.data) ? modelsPayload.data : [];

    return {
      service: health.service || BINARY,
      apiBase,
      version: stored.installPath ? await readInstalledVersion(ctx, stored.installPath) : '',
      models: models.length,
      // 显示出来才能复制给别的客户端（Codex / Claude Code / 其他工具）。
      // 顺带说明：网关只绑 127.0.0.1，本机访问免令牌，所以这把钥匙泄露面只在本机。
      apiKey: stored.apiKey || ''
    };
  },

  async openConsole(ctx, port) {
    const stored = await readStoredConfig(ctx);
    const url = `http://127.0.0.1:${port || stored.port || DEFAULT_PORT}/ui`;
    if (process.platform === 'win32') {
      await ctx.exec(`start "" "${url}"`);
    } else if (process.platform === 'darwin') {
      await ctx.exec(`open "${url}"`);
    } else {
      await ctx.exec(`xdg-open "${url}"`);
    }
    return { url };
  }
};
