#!/bin/bash
# 开发自检用：起一个「终端里的 pi」（带桥接扩展）+ Pi Pocket 服务，
# 然后就可以跑 tools/bridge-sync-check.mjs 验证两端同步。
#
# 注意：桥接扩展只需装一次（npm run install-bridge），之后 pi 启动即自动生效。
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PI_POCKET_PORT:-8787}"

echo "== 清理上次的自检进程"
pkill -f "script -q /dev/null pi" 2>/dev/null
sleep 1

# 用一个新的会话文件（--no-session 没有会话文件，桥接无法按会话匹配）
echo "== 启动终端 pi（TUI + 桥接）"
(sleep 900 | script -q /dev/null pi > /tmp/terminal-pi.log 2>&1) &
for i in $(seq 1 40); do
	if ls "$HOME/.pi/agent/pi-pocket-bridge/"*.sock >/dev/null 2>&1; then
		echo "   桥接已就绪：$(ls "$HOME/.pi/agent/pi-pocket-bridge/" | tr '\n' ' ')"
		break
	fi
	sleep 1
done

echo "== 启动 Pi Pocket 服务"
./pocket start >/dev/null 2>&1 || true
sleep 1
./pocket status

cat <<EOF

  接下来可以跑：
    node tools/bridge-sync-check.mjs $PORT        # 接入终端同一 agent，不新起进程
    node tools/bridge-multiclient-check.mjs $PORT # 多端广播、两端显示一致

  结束自检：
    pkill -f "script -q /dev/null pi"   # 关掉测试用的终端 pi
    ./pocket stop
EOF
