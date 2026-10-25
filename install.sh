#!/usr/bin/env bash
# dsh-systemd-restart — 安装到 dsh 的 web profile。
#
# 用法：
#   bash install.sh             只安装 + 打印装配状态
#   bash install.sh --restart   安装完再重启 dsh-web（冷启动一遍，最干净）
#
# 为什么需要你手动跑：这一步要写 ~/.dsh/profiles/web/package.json 与 node_modules，
# 在 DSH 会话的文件沙箱（workspace-write，只许写工作区）之外；沙箱提权请求若没被
# 及时批准会超时。你本人在终端里跑没有这个限制。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "找不到 profile 目录：$PROFILE_DIR" >&2
  exit 1
fi

echo "== 1/4 备份（这批改动的回滚点）=="
cp -p "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-restart-plugin-$STAMP"
echo "   package.json -> package.json.bak-restart-plugin-$STAMP"
if [ -f "$PROFILE_DIR/pnpm-lock.yaml" ]; then
  cp -p "$PROFILE_DIR/pnpm-lock.yaml" "$PROFILE_DIR/pnpm-lock.yaml.bak-restart-plugin-$STAMP"
  echo "   pnpm-lock.yaml -> pnpm-lock.yaml.bak-restart-plugin-$STAMP"
fi

echo "== 2/4 安装（dsh plugin --profile $PROFILE add）=="
cd "$PROFILE_DIR"
export PATH="$HOME/.local/bin:$PATH"
dsh plugin --profile "$PROFILE" add "$DIR"

echo "== 3/4 装配状态 =="
python3 - "$PROFILE_DIR/package.json" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1]))
deps = data.get("dependencies", {})
print("   dependencies:", {k: v for k, v in deps.items() if "restart" in k})
print("   bundles:", data.get("dsh", {}).get("profile", {}).get("bundles"))
PY

echo "== 4/4 loader entry =="
dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -n "systemd-restart" | head -5 \
  || echo "   （dump-config 里没找到；看 ~/.dsh/web-stdout.log 本次启动段）"

echo
echo "装好了。宿主半会随 patchReload 立即可用；浏览器刷新一次（Ctrl+Shift+R）"
echo "就能在 设置 → 通用 里看到「重启 dsh web」那一行。"
echo "以后要走冷启动：systemctl --user restart dsh-web"

if [ "${1:-}" = "--restart" ]; then
  echo
  echo "== 重启 dsh-web =="
  systemctl --user restart dsh-web
fi
