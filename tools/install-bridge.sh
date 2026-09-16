#!/bin/bash
# 把桥接扩展装到 pi 的全局扩展目录，之后正常 `pi` 启动就会自动带上
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)/extensions/pi-pocket-bridge.ts"
DEST_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"
mkdir -p "$DEST_DIR"
LINK="$DEST_DIR/pi-pocket-bridge.ts"

if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "已存在同名扩展（非软链），请先手动处理：$LINK" >&2
  exit 1
fi
ln -sfn "$SRC" "$LINK"
echo "✅ 已安装桥接扩展"
echo "   $LINK -> $SRC"
echo
echo "之后正常启动 pi 即可（无需额外参数）："
echo "   pi"
echo "启动后手机打开 Pi Pocket，顶部会出现「终端 pi 正在运行」卡片，点一下就能接入同一个 agent。"
echo
echo "卸载： rm '$LINK'"
