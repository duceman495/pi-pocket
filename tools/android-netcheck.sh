#!/bin/bash
# 在 JVM 上直接验证 Net.java（局域网发现逻辑），不需要模拟器/真机。
# Net.java 只用 JDK 的 java.net，不含任何 Android API，所以能脱离 Android 跑。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/com/pipocket"
cp "$ROOT/android/app/src/main/java/com/pipocket/Net.java" "$WORK/com/pipocket/"

cat > "$WORK/com/pipocket/NetCheck.java" <<'EOF'
package com.pipocket;
import java.util.List;
public class NetCheck {
  static int pass = 0, total = 0;
  static void ok(String name, boolean cond, String detail) {
    total++;
    if (cond) pass++;
    System.out.println((cond ? "  ✅ " : "  ❌ ") + name + (detail.isEmpty() ? "" : " — " + detail));
  }
  public static void main(String[] args) {
    System.out.println("--- 地址规整 ---");
    String[][] cases = {
      {"192.168.1.50", "192.168.1.50:8787"},
      {"192.168.1.50:9000", "192.168.1.50:9000"},
      {"http://192.168.1.50:8787/", "192.168.1.50:8787"},
      {"  10.0.0.5  ", "10.0.0.5:8787"},
      {"192.168.1.50:99999", "null"},
      {"", "null"},
      {"http://", "null"},
      {"has space", "null"},
    };
    for (String[] c : cases) {
      String got = String.valueOf(Net.normalizeHost(c[0]));
      ok("'" + c[0] + "'", got.equals(c[1]), got.equals(c[1]) ? "-> " + got : "得到 " + got + "，期望 " + c[1]);
    }

    System.out.println("--- 本机网段 ---");
    List<String[]> subs = Net.localSubnets();
    for (String[] s : subs) System.out.println("    " + s[0] + "/" + s[1] + "  (" + s[2] + ")");
    ok("识别出至少一个网段", !subs.isEmpty(), "");
    String gw = Net.guessGateway();
    ok("网关猜测格式正确", gw.isEmpty() || gw.matches("\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+"), gw);

    String probeHost = args.length > 0 ? args[0] : null;
    if (probeHost != null) {
      System.out.println("--- 探活 " + probeHost + " ---");
      String err = Net.probe(probeHost, null);
      ok("探活成功（目标确实是 Pi Pocket）", err == null, err == null ? "" : err);
      System.out.println("--- 真实扫描 ---");
      long t0 = System.currentTimeMillis();
      List<String> found = Net.scan(null);
      long ms = System.currentTimeMillis() - t0;
      ok("扫到目标服务", found.contains(probeHost), found + "  耗时 " + ms + "ms");
    } else {
      System.out.println("--- 跳过探活/扫描（未传目标地址）---");
      System.out.println("    用法: tools/android-netcheck.sh 192.168.1.50:8787");
    }

    System.out.println("\n结果: " + pass + "/" + total + " 通过");
    if (pass != total) System.exit(1);
  }
}
EOF

javac -encoding UTF-8 -nowarn -d "$WORK/out" "$WORK"/com/pipocket/*.java 2>/dev/null
HOST="${1:-$(ipconfig getifaddr en0 2>/dev/null || echo "")}"
if [ -n "$HOST" ]; then HOST="$HOST:8787"; fi
java -cp "$WORK/out" com.pipocket.NetCheck "$HOST"
