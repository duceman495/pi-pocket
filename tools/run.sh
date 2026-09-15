#!/bin/bash
# 后台常驻启动 Pi Pocket（日志写到 /tmp/pi-pocket.log）
cd "$(dirname "$0")/.." || exit 1
if pgrep -f "node server.mjs" > /dev/null; then
  echo "Pi Pocket 已在运行："
  grep -E "局域网|本机" /tmp/pi-pocket.log 2>/dev/null
  exit 0
fi
nohup node server.mjs "$@" > /tmp/pi-pocket.log 2>&1 &
sleep 2
cat /tmp/pi-pocket.log
