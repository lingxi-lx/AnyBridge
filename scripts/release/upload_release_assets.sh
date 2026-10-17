#!/usr/bin/env bash
#
# 上传资产到 GitHub Release（带就绪等待与有限重试）。
#
# 为什么不直接用裸 `gh release upload --clobber`：
#   1. release 刚 create 完的几秒内，uploads.github.com 端点存在瞬时不一致，
#      立即上传会 HTTP 404（v0.5.26 发布时踩到，release id 正确但上传被拒）；
#   2. --clobber 内部先 GET 资产列表再逐个 DELETE，列表缓存过时时会因
#      "删除不存在的资产"而 404 中断（v0.5.25 手动重跑时踩到）。
#
# 本脚本统一：先等 release 在 API 侧可见，再对上传做有限次重试，
# 把这类瞬时故障吸收掉，避免发布流程因瞬时不一致而中断。
#
# 用法: upload_release_assets.sh <tag> <repo> <file...>

set -uo pipefail

TAG="${1:-}"
REPO="${2:-}"
shift 2 || true

if [ -z "$TAG" ] || [ -z "$REPO" ] || [ "$#" -eq 0 ]; then
  echo "用法: upload_release_assets.sh <tag> <repo> <file...>" >&2
  exit 1
fi

FILES=()
for f in "$@"; do
  if [ -f "$f" ]; then
    FILES+=("$f")
  else
    echo "跳过不存在的文件: $f"
  fi
done

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "::error::没有任何可上传的文件: $*"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "::error::未找到 gh CLI，无法上传 Release 资产" >&2
  exit 1
fi

# 1) 等 release 在 API 侧可见（刚 create 时可能瞬时查不到）
READY=0
for i in $(seq 1 10); do
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    READY=1
    break
  fi
  echo "等待 release $REPO:$TAG 就绪（$i/10）..."
  sleep 6
done
if [ "$READY" -ne 1 ]; then
  echo "::error::release $REPO:$TAG 等待超时仍不可见"
  exit 1
fi

# 2) 先按名字精确删除已存在的同名资产，再上传。
#
# 为什么不再用 `gh release upload --clobber`：它内部是「按缓存的资产列表逐个 DELETE，
# 再上传」。列表缓存过时会先 404（删了一个已经不存在的 id），紧接着上传又 422
# （ReleaseAsset.name already exists）——两次失败互为因果，重试多少次都重复同一场竞态。
# v0.5.30、v0.5.34 发布时同步到公开仓库就是这样失败的，结果公开仓库少了 8 个更新
# 元数据，用户自动更新静默失效，只能手动补传。
#
# 这里改为「按当前列表精确删除同名资产 → 上传」，删除与上传都各自容错，状态可收敛。
asset_exists() {
  local base="$1" names
  names="$(gh release view "$TAG" --repo "$REPO" --json assets --jq -r '.assets[].name' 2>/dev/null)"
  [ -z "$names" ] && return 1
  printf '%s\n' "$names" | grep -Fxq "$base"
}

delete_existing_assets() {
  local base waited
  for f in "${FILES[@]}"; do
    base="$(basename "$f")"
    asset_exists "$base" || continue

    echo "删除已存在的同名资产: $base"
    gh release delete-asset "$TAG" --repo "$REPO" "$base" --yes 2>/dev/null || \
      echo "::warning::删除 $base 失败（可能已被并发删除）"

    # 删除是异步收敛的：API 列表可能已删、上传端点仍认为存在（422 already exists），
    # 也可能反过来（删除请求落到已失效的资产 id 而 404）。两者都会让「删了再传」
    # 变成死循环（v0.5.30 / v0.5.34 就是这么失败的）。所以必须等到资产名从 API
    # 列表里真正消失再上传；等不到就把现状说出来，交由上传重试那一层兜底。
    waited=0
    while asset_exists "$base"; do
      if [ "$waited" -ge 60 ]; then
        echo "::warning::$base 删除后 60s 仍在资产列表中可见，继续尝试上传"
        break
      fi
      sleep 3
      waited=$((waited + 3))
    done
  done
}

for attempt in $(seq 1 6); do
  delete_existing_assets
  if gh release upload "$TAG" --repo "$REPO" "${FILES[@]}"; then
    echo "已上传 ${#FILES[@]} 个资产到 $REPO:$TAG（第 $attempt 次尝试）"
    exit 0
  fi
  echo "::warning::$REPO:$TAG 资产上传失败（第 $attempt/6 次），12 秒后重试"
  sleep 12
done

echo "::error::$REPO:$TAG 资产上传重试 6 次仍失败"
exit 1
