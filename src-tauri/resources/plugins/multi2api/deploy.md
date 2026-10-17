# Deploy: multi2api

## Strategy: Adapter

### Prerequisites

- 不需要 Go / Node / Docker / git：直接使用上游 CI 预编译的 Go 静态二进制，运行时零依赖
- 不需要本机装 curl / tar：下载与解压由 AnyBridge 主程序完成
- 需要能访问 GitHub：下载走镜像测速（gh-proxy / ghproxy 等），由 AnyBridge 挑最快且能用的源

### Steps

#### 1. 获取发布包

由 AnyBridge 主程序完成（与 CPA 安装部署同一条链路）：

- 按 `plugin.json` 的 `deploy.asset.repo` 取最新版本号（GitHub API 优先，失败转网页重定向）
- 按当前平台拼产物名 `wb2api-server-{goos}-{goarch}.{zip|tar.gz}`，并在该版本的资产列表里精确匹配
- 并发测速所有镜像，按速度从快到慢逐个尝试，单源失败自动重试与换源
- 下载跟随 Windows 系统代理；全程流式写盘并上报进度

#### 2. 解压并替换二进制

由 AnyBridge 主程序完成：Release 包内含一层同名顶层目录，解压时统一剥离；
只把 `wb2api-server{ext}` 换到安装目录，配置、凭证、数据目录一概不动。
覆盖前若旧进程仍占着文件，会等待句柄释放，超时则明确报错而不是假装成功。

#### 3. 生成网关配置

由 adapter.js 写入 `config.json`：监听地址、API 密钥、管理令牌、账号池与自动签到参数。

#### 4. 启动与健康检查

启动由 AnyBridge 插件管理器自动完成（`plugin_start`）。
**验证**：
- 进程启动成功
- GET `http://127.0.0.1:{config.port}/healthz` 返回 `service` 字段（账号池为空时为 503，属正常）

## Notes

- 上面除第 4 步外的验证都写在主程序里；adapter 不再自带 shell 命令，因此安装向导不会执行任何本地构建。
- 安装中途失败时，暂存目录与压缩包会被清理，不会在磁盘上留下半成品；已就位的旧二进制不动。
- 「更新」「切换版本」复用同一份获取逻辑：更新取最新版本，切换版本用指定 tag，两者都由主程序下载后替换二进制。
- 端口默认 7863（上游默认，避开了 8000 这类大量开发服务占用的常见端口）。它与 AnyBridge 健康检查使用的端口必须一致：改动端口后需要「重新生成配置文件」再重启。
- 凭证目录 auths/ 与运行状态 data/ 都落在 installPath 下（相对路径），所以二进制的工作目录固定为安装目录。
- **卸载会删除安装目录**，其中的 OAuth 凭证会先行备份到 `~/.anybridge/multi2api-backup-<时间戳>/`，重新安装后可手动拷回 auths/ 恢复账号。
- 日常管理（账号池、模型目录、请求日志、API Key）请使用插件面板的「打开管理控制台」按钮，它会打开上游自带的 /ui 控制台。

## Uninstall

卸载前 adapter 自动备份 auths/（凭证）与 data/（账号池状态）到用户目录。
其余文件连同安装目录一并删除。
