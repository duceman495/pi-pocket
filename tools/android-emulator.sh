#!/bin/bash
# 一键：起模拟器 + 装 App + 打开调试通道（仅用于开发自测）
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
AVD="${1:-pipocket}"

if ! "$ADB" devices | grep -q "emulator-.*device"; then
  echo "== 启动模拟器 $AVD"
  (cd "$ANDROID_HOME/emulator" && nohup ./emulator -avd "$AVD" -no-audio -no-boot-anim \
     -no-snapshot -gpu swiftshader_indirect > /tmp/emulator.log 2>&1 &)
  echo "   等待开机…"
  "$ADB" wait-for-device
  until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
  echo "   开机完成"
fi

cd "$(dirname "$0")/../android"
./build.sh --install

echo "== 开通 WebView 调试通道 (:9222)"
P="$("$ADB" shell pidof com.pipocket | tr -d '\r')"
if [ -n "$P" ]; then
  "$ADB" forward tcp:9222 "localabstract:webview_devtools_remote_$P" >/dev/null
  echo "   已转发。跑：node tools/android-app-check.mjs 9222"
else
  echo "   App 未运行，先在模拟器里打开 Pi Pocket"
fi
