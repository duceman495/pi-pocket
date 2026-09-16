#!/bin/bash
# 启动一个「终端里的 pi」+ 带桥接扩展，并起 Pi Pocket 服务，用于验证两端同步
set -e
cd "$(dirname "$0")/.."
pkill -f "pi-pocket-bridge" 2>/dev/null || true
pkill -f "server.mjs" 2>/dev/null || true
sleep 1
# 终端里的 pi（pty 里跑，模拟真实使用）
(sleep 900 | script -q /dev/null pi -e ./extensions/pi-pocket-bridge.ts \
   > /tmp/terminal-pi.log 2>&1) &
echo "终端 pi 启动中..."
for i in $(seq 1 30); do
  (echo > /dev/tcp/127.0.0.1/8788) 2>/dev/null && { echo "  桥接端口 8788 就绪"; break; }
  sleep 1
done
nohup node server.mjs > /tmp/pi-pocket.log 2>&1 &
sleep 3
echo "Pi Pocket 已启动"
