#!/bin/bash
# Pi Pocket 启动脚本
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
exec node server.mjs --qr "$@"
