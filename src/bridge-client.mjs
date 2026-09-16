/**
 * 桥接探测：发现终端里正在运行的 pi（通过 pi-pocket-bridge 扩展暴露的 WebSocket）。
 *
 * 用于解决「同一个会话被开了两个 agent 进程」导致两端不同步的问题：
 * 如果能桥接到终端里的 pi，就不需要再 spawn 一个，手机直接成为那个 agent 的客户端。
 */
import { createHash } from "node:crypto";

export const DEFAULT_BRIDGE_PORT = Number(process.env.PI_POCKET_BRIDGE_PORT ?? 8788);
const PROBE_TIMEOUT = 1200;

/** 短连接探一下桥接是否活着，并取回 hello */
export async function probeBridge(port = DEFAULT_BRIDGE_PORT, timeoutMs = PROBE_TIMEOUT) {
	let WebSocketImpl;
	try {
		({ default: WebSocketImpl } = await import("ws"));
	} catch {
		return null;
	}
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
			ws = new WebSocketImpl(`ws://127.0.0.1:${port}`);
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

/** 会话文件路径 → 稳定的短 key，用作前端 URL 片段 */
export function bridgeKey(sessionFile, sessionId) {
	const src = sessionFile ?? sessionId ?? "unknown";
	return "bridge-" + createHash("sha1").update(String(src)).digest("hex").slice(0, 12);
}

/**
 * 这个会话能不能桥接？
 * 只有 hello 里的 sessionFile 和当前会话对得上才算数 —— 否则手机上点开会话 A
 * 却连到了终端里的会话 B，那是错的。
 */
export async function matchBridge(port, { sessionPath, sessionId, cwd } = {}) {
	const hello = await probeBridge(port);
	if (!hello) return null;
	if (!hello.sessionFile) return null; // 终端用了 --no-session，没有会话文件无法对应
	const same =
		(sessionPath && hello.sessionFile === sessionPath) ||
		(!sessionPath && sessionId && hello.sessionId === sessionId) ||
		(!sessionPath && !sessionId && cwd && hello.cwd === cwd);
	if (!same) return null;
	return hello;
}
