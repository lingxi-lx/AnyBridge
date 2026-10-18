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
# 无条件按名字删一遍：资产列表与 uploads 端点之间存在最终一致性差异，
# 「列表里查不到」并不代表「上传时不存在」。v0.5.37 就是栽在这里 —— 脚本先查列表、
# 查不到就跳过删除，紧接着上传却报 422 already exists，重试 6 次全撞同一场竞态。
# 因此不能以列表为准，只能以「实际上传结果」为准：先删（删不到也无妨）再传，
# 失败就再删再传，直到状态收敛。
delete_by_name() {
  local base
  for f in "${FILES[@]}"; do
    base="$(basename "$f")"
    if gh release delete-asset "$TAG" --repo "$REPO" "$base" --yes 2>/dev/null; then
      echo "已删除同名资产: $base"
    fi
  done
}

for attempt in $(seq 1 8); do
  delete_by_name
  if gh release upload "$TAG" --repo "$REPO" "${FILES[@]}"; then
    echo "已上传 ${#FILES[@]} 个资产到 $REPO:$TAG（第 $attempt 次尝试）"
    exit 0
  fi
  echo "::warning::$REPO:$TAG 资产上传失败（第 $attempt/8 次），15 秒后重试"
  sleep 15
done

echo "::error::$REPO:$TAG 资产上传重试 8 次仍失败"
exit 1
