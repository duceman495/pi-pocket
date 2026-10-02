/**
 * 桥接发现：找出电脑上所有正在运行的 pi，以及各自在跑哪个会话。
 *
 * 每个 pi（装了 pi-pocket-bridge 扩展）会在 <agentDir>/pi-pocket-bridge/<pid>.sock
 * 上监听。这里扫描该目录、逐个读 hello，就得到一张
 * 「socket → 会话文件 / cwd / pid / 模型」的表。
 *
 * 为什么不用固定端口：见 extensions/pi-pocket-bridge.ts 顶部注释。简单说，
 * 固定端口是先到先得，同时开几个 pi 时你想要的会话往往抢不到，而且
 * Pi Pocket 自己 spawn 的 rpc 进程也会抢（那个进程根本不需要桥接）。
 */
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const BRIDGE_DIR = join(getAgentDir?.() ?? join(homedir(), ".pi", "agent"), "pi-pocket-bridge");
const PROBE_TIMEOUT = 1200;

/** 用一个临时 Node 进程通过 unix socket 做 WebSocket 握手并读 hello（避免依赖 ws 客户端） */
async function probeSocket(socketPath, timeoutMs = PROBE_TIMEOUT) {
	const { default: WebSocketImpl } = await import("ws");
	return new Promise((resolve) => {
		let ws;
		const done = (v) => {
			try {
				ws?.close();
			} catch {
				/* ignore */
			}
			clearTimeout(timer);
			resolve(v);
		};
		const timer = setTimeout(() => done(null), timeoutMs);
		try {
			ws = new WebSocketImpl(`ws+unix://${socketPath}:/`);
		} catch {
			return done(null);
		}
		ws.on("message", (raw) => {
			try {
				const msg = JSON.parse(raw.toString());
				if (msg.t === "hello") done(msg);
			} catch {
				/* ignore */
			}
		});
		ws.on("error", () => done(null));
		ws.on("close", () => done(null));
	});
}

/** 列出所有还活着的桥接 socket 路径（顺手清理死 socket 文件） */
export function listBridgeSockets(dir = BRIDGE_DIR) {
	let names = [];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".sock"));
	} catch {
		return []; // 目录不存在 = 没有 pi 装扩展
	}
	return names.map((n) => ({ name: n, path: join(dir, n), pid: Number(n.replace(/\.sock$/, "")) }));
}

function pidAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM 说明进程存在但没有权限发信号
		return err?.code === "EPERM";
	}
}

/**
 * 发现所有可桥接的 pi。
 * 返回 [{ socket, sessionFile, sessionId, cwd, pid, model, thinkingLevel, isIdle, mode }]
 */
export async function listBridges(dir = BRIDGE_DIR) {
	const sockets = listBridgeSockets(dir);
	if (!sockets.length) return [];

	const hellos = await Promise.all(
		sockets.map(async (s) => {
			// 进程已经没了就顺手把死 socket 清掉，免得目录越积越多
			if (s.pid && !pidAlive(s.pid)) {
				try {
					rmSync(s.path, { force: true });
				} catch {
					/* ignore */
				}
				return null;
			}
			const hello = await probeSocket(s.path);
			if (!hello) {
				// 进程活着但连不上：可能正在启动，留着下一轮再试
				return null;
			}
			return { socket: s.path, ...hello };
		}),
	);

	return hellos.filter(Boolean);
}

/** 按会话精确匹配：哪个 pi 正在跑这个会话文件 */
export async function findBridgeForSession({ sessionPath, sessionId, cwd }, dir = BRIDGE_DIR) {
	const bridges = await listBridges(dir);
	if (!bridges.length) return null;
	if (sessionPath) {
		// 优先按会话文件精确匹配；终端用 --no-session 时 sessionFile 为 null，不会误命中
		return bridges.find((b) => b.sessionFile && b.sessionFile === sessionPath) ?? null;
	}
	if (sessionId) return bridges.find((b) => b.sessionId === sessionId) ?? null;
	if (cwd) return bridges.find((b) => b.cwd === cwd) ?? null;
	return null;
}

/** 有没有任何一个 pi 可以桥接（首页用来决定是否显示「终端 pi 正在运行」卡片） */
export async function anyBridge(dir = BRIDGE_DIR) {
	const bridges = await listBridges(dir);
	// 优先返回 TUI 模式的（那才是用户真正在终端里用的）
	return bridges.find((b) => b.mode === "tui") ?? bridges[0] ?? null;
}

export { probeSocket };
