package com.pipocket;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** 局域网相关：地址规整、探活、扫描 */
public final class Net {

	public static final int DEFAULT_PORT = 8787;

	private Net() {
	}

	/** "192.168.1.5" / "192.168.1.5:8787" / "http://192.168.1.5:8787/" → "192.168.1.5:8787" */
	public static String normalizeHost(String raw) {
		if (raw == null) return null;
		String s = raw.trim();
		if (s.isEmpty()) return null;
		s = s.replaceFirst("^[a-zA-Z]+://", "");
		int slash = s.indexOf('/');
		if (slash >= 0) s = s.substring(0, slash);
		if (s.isEmpty()) return null;

		String host = s;
		String port = String.valueOf(DEFAULT_PORT);
		int colon = s.lastIndexOf(':');
		if (colon > 0 && s.indexOf(']') < colon) {
			host = s.substring(0, colon);
			port = s.substring(colon + 1);
		}
		try {
			int p = Integer.parseInt(port);
			if (p < 1 || p > 65535) return null;
		} catch (NumberFormatException e) {
			return null;
		}
		if (host.isEmpty() || host.contains(" ")) return null;
		// 校验 host 形如 IP 或主机名，避免拼出乱七八糟的 URL
		for (char c : host.toCharArray()) {
			if (!Character.isLetterOrDigit(c) && c != '.' && c != '-' && c != '_' && c != ':') return null;
		}
		return host + ":" + port;
	}

	/** 探活：返回 null 表示成功，否则返回错误原因 */
	public static String probe(String hostPort, String token) {
		HttpURLConnection conn = null;
		try {
			URL url = new URL("http://" + hostPort + "/api/health" + (token != null && !token.isEmpty() ? "?token=" + token : ""));
			conn = (HttpURLConnection) url.openConnection();
			conn.setConnectTimeout(2500);
			conn.setReadTimeout(2500);
			conn.setRequestMethod("GET");
			int code = conn.getResponseCode();
			if (code == 200) {
				String body = read(conn.getInputStream());
				if (body.contains("\"ok\":true")) return null;
				return "该端口响应了，但不是 Pi Pocket";
			}
			if (code == 401) return "令牌不对（HTTP 401）";
			return "HTTP " + code;
		} catch (Exception e) {
			return e.getClass().getSimpleName() + ": " + e.getMessage();
		} finally {
			if (conn != null) conn.disconnect();
		}
	}

	private static String read(InputStream in) throws Exception {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		byte[] buf = new byte[4096];
		int n;
		while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
		return out.toString("UTF-8");
	}

	/** 网卡优先级：Wi-Fi/以太网优先，虚拟网桥放最后 */
	private static int rank(String name) {
		if (name.startsWith("wlan")) return 0;
		if (name.startsWith("eth")) return 1;
		if (name.startsWith("en")) return 2;
		if (name.startsWith("ap") || name.startsWith("swlan")) return 3;
		if (name.startsWith("bridge") || name.startsWith("vmnet") || name.startsWith("docker")) return 9;
		return 5;
	}

	/** 本机 Wi-Fi/以太网的 IPv4 + 前缀长度（按可用性排序） */
	public static List<String[]> localSubnets() {
		List<String[]> out = new ArrayList<>();
		try {
			Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
			for (NetworkInterface ni : Collections.list(nis)) {
				if (!ni.isUp() || ni.isLoopback()) continue;
				String name = ni.getName();
				if (name.startsWith("rmnet") || name.startsWith("dummy") || name.startsWith("p2p")) continue;
				for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
					InetAddress addr = ia.getAddress();
					if (!(addr instanceof Inet4Address) || addr.isLoopbackAddress()) continue;
					int prefix = ia.getNetworkPrefixLength();
					if (prefix <= 0 || prefix > 30) continue;
					out.add(new String[]{addr.getHostAddress(), String.valueOf(prefix), name});
				}
			}
		} catch (Exception ignored) {
		}
		Collections.sort(out, (a, b) -> Integer.compare(rank(a[2]), rank(b[2])));
		return out;
	}

	/** 常见家用网关猜测（本机网段的 .1） */
	public static String guessGateway() {
		List<String[]> subs = localSubnets();
		if (subs.isEmpty()) return "";
		String ip = subs.get(0)[0];
		int dot = ip.lastIndexOf('.');
		return ip.substring(0, dot) + ".1:" + DEFAULT_PORT;
	}

	public interface ScanProgress {
		void onProgress(String host, int done, int total);
	}

	/**
	 * 扫描本机所在网段的 1..254，找出跑着 Pi Pocket 的主机（默认端口）。
	 * 先并发探测 8787 端口，再对端口开放的做 HTTP 探活，避免误报。
	 */
	public static List<String> scan(ScanProgress progress) {
		return scan(progress, null);
	}

	/**
	 * 扫描本机所在网段的 1..254，找出跑着 Pi Pocket 的主机（默认端口）。
	 * 先并发探测 8787 端口，再对端口开放的做 HTTP 探活，避免误报。
	 *
	 * @param into 可选的输出列表，发现一台就立刻写进去（调用方可以边扫边显示）
	 */
	public static List<String> scan(ScanProgress progress, List<String> into) {
		List<String> found = into != null ? into : Collections.synchronizedList(new ArrayList<String>());

		for (String[] sub : localSubnets()) {
			final String base = sub[0].substring(0, sub[0].lastIndexOf('.'));
			final int prefix = Integer.parseInt(sub[1]);
			// /24 或更小的网段才逐个扫，超大网段只试网关和常见地址
			List<String> targets = new ArrayList<>();
			if (prefix >= 24) {
				for (int i = 1; i <= 254; i++) targets.add(base + "." + i);
			} else {
				targets.add(base + ".1");
				for (int i = 1; i <= 8; i++) targets.add(base + "." + i);
			}

			ExecutorService pool = Executors.newFixedThreadPool(48);
			List<Future<String>> futures = new ArrayList<>();
			final int total = targets.size();
			final int[] done = {0};

			for (final String ip : targets) {
				futures.add(pool.submit((Callable<String>) () -> {
					boolean open = portOpen(ip, DEFAULT_PORT, 700);
					String ok = null;
					if (open) {
						String hp = ip + ":" + DEFAULT_PORT;
						if (probe(hp, null) == null) {
							found.add(hp);
							ok = hp;
						}					}
					synchronized (done) {
						done[0]++;
						if (progress != null && (done[0] % 16 == 0 || ok != null || done[0] == total)) {
							progress.onProgress(ip, done[0], total);
						}
					}
					return ok;
				}));
			}

			for (Future<String> f : futures) {
				try {
					f.get(3, TimeUnit.SECONDS);
				} catch (Exception ignored) {
				}
			}
			pool.shutdownNow();
		}
		return found;
	}

	private static boolean portOpen(String ip, int port, int timeoutMs) {
		Socket s = new Socket();
		try {
			s.connect(new InetSocketAddress(ip, port), timeoutMs);
			return true;
		} catch (Exception e) {
			return false;
		} finally {
			try {
				s.close();
			} catch (Exception ignored) {
			}
		}
	}
}
