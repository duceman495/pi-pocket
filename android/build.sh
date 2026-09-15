#!/bin/bash
# Pi Pocket Android 构建脚本
#
# 不依赖 Gradle / Android Studio：直接用 SDK 自带的 aapt2 + javac + d8 + apksigner
# 打出一个可安装的 APK（纯 Java + WebView，无 AndroidX 依赖）。
#
# 用法：
#   ./android/build.sh            # 构建并签名，输出 android/dist/pi-pocket.apk
#   ./android/build.sh --install  # 构建 + adb install -r
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/app"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
OUT_APK="$DIST/pi-pocket.apk"

: "${ANDROID_HOME:=$HOME/android-sdk}"
export ANDROID_HOME

BT="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1)"
PLATFORM="$(ls -d "$ANDROID_HOME"/platforms/android-* 2>/dev/null | sort -V | tail -1)"
ANDROID_JAR="$PLATFORM/android.jar"

AAPT2="$BT/aapt2"
D8="$BT/d8"
ZIPALIGN="$BT/zipalign"
APKSIGNER="$BT/apksigner"

for f in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER" "$ANDROID_JAR"; do
  if [ ! -e "$f" ]; then
    echo "缺少构建组件: $f" >&2
    echo "请先安装：sdkmanager --install 'platforms;android-35' 'build-tools;35.0.1'" >&2
    exit 1
  fi
done

echo "== 清理"
rm -rf "$BUILD"
mkdir -p "$BUILD/compiled" "$BUILD/gen" "$BUILD/classes" "$DIST"

echo "== aapt2 compile 资源"
"$AAPT2" compile --dir "$APP/src/main/res" -o "$BUILD/compiled/res.zip"

echo "== aapt2 link（生成带资源的 APK 骨架 + R.java）"
"$AAPT2" link \
  -o "$BUILD/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$APP/src/main/AndroidManifest.xml" \
  --java "$BUILD/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 35 \
  --version-code 1 --version-name 0.1.0 \
  --no-version-vectors \
  "$BUILD/compiled/res.zip"

echo "== javac 编译 Java 源码"
find "$APP/src/main/java" "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
javac -encoding UTF-8 \
  -source 11 -target 11 \
  -classpath "$ANDROID_JAR" \
  -d "$BUILD/classes" \
  -Xlint:-options -nowarn \
  @"$BUILD/sources.txt"

echo "== d8 转 dex"
find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
"$D8" --release --min-api 24 --lib "$ANDROID_JAR" --output "$BUILD" @"$BUILD/classes.txt"

echo "== 打包 dex 进 APK"
cp "$BUILD/base.apk" "$BUILD/unsigned.apk"
( cd "$BUILD" && zip -q -X unsigned.apk classes.dex )

echo "== zipalign"
"$ZIPALIGN" -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

echo "== 签名"
KS="$ROOT/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias pipocket \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass pipocket -keypass pipocket \
    -dname "CN=Pi Pocket, OU=Dev, O=PiPocket, L=Local, C=CN" >/dev/null 2>&1
  echo "   已生成调试签名 android/debug.keystore"
fi
"$APKSIGNER" sign \
  --ks "$KS" --ks-key-alias pipocket \
  --ks-pass pass:pipocket --key-pass pass:pipocket \
  --out "$OUT_APK" "$BUILD/aligned.apk"
"$APKSIGNER" verify --print-certs "$OUT_APK" | head -4

SIZE=$(du -h "$OUT_APK" | awk '{print $1}')
echo
echo "✅ 构建完成：$OUT_APK  ($SIZE)"

if [ "${1:-}" = "--install" ]; then
  echo "== adb install"
  adb install -r "$OUT_APK"
  adb shell monkey -p com.pipocket -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  echo "   已安装并尝试启动"
fi
