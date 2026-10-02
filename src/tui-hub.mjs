/**
 * TuiHub：管理所有连到终端 pi（桥接）上的浏览器客户端。
 *
 * 与 AgentManager 的区别：
 *   AgentManager → 服务端自己 spawn 一个 pi 进程（终端没开 pi 时的回退方案）
 *   TuiHub       → 接上终端里已经在跑的那个 pi（同一个 agent，两端天然同步）
 *
 * 对外暴露的接口刻意和 AgentBridge 保持一致（snapshot / onEvent / request / recent …），
 * 这样 server.mjs 和前端都不用区分两种模式。
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { findBridgeForSession, listBridges, anyBridge } from "./bridge-client.mjs";

const RECENT_TURNS = 60;
/** 浏览器本地命令 → 桥接命令 的映射 */
const BRIDGE_COMMANDS = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"set_name",
	"set_thinking",
	"get_commands",
	"history",
]);

export class TuiHub {
	/** @param {string} socketPath 该 pi 实例的 unix socket 路径 */
	constructor(socketPath) {
		this.socketPath = socketPath;
		/** 桥接 hello（同一个 pi 实例，所有桥接会话共用） */
		this.hello = null;
		/** 这个会话文件对应的客户端连接（到扩展的 WebSocket） */
		this.conn = null;
		this.key = null;
		/** 浏览器侧订阅者 */
		this.emitter = new EventEmitter();
		this.emitter.setMaxListeners(0);
		/** 从扩展收到的最新历史 */
		this.entries = [];
		this.idle = true;
		this.status = "idle";
		this.lastError = null;
		this.appliedKey = null; // 已应用到的最后一个 entry id
		this.connecting = null;
		this.reconnectTimer = null;
	}

	/* ------------------------------ 对外查询 ------------------------------ */

	/**
	 * 会话 key。必须与 server.mjs 里登记 hub 时用的 key 完全一致，
	 * 否则前端拿到 key 后按它连 WS 会查不到（该会话未打开）。
	 */
	keyFor() {
		if (this.key) return this.key;
		return this.hello?.sessionId ? `bridge-${this.hello.sessionId}` : `bridge-${this.hello?.pid ?? "unknown"}`;
	}

	snapshot() {
		return {
			key: this.keyFor(),
			sessionPath: this.hello?.sessionFile ?? null,
			sourcePath: this.hello?.sessionFile ?? null,
			sessionId: this.hello?.sessionId ?? null,
			cwd: this.hello?.cwd ?? null,
			// 前端据此显示「已连终端」标记
			mode: "bridge",
			status: this.status,
			events: [],
			state: {
				model: this.hello?.model ?? null,
				thinkingLevel: this.hello?.thinkingLevel ?? null,
				sessionName: this.hello?.sessionName ?? null,
			},
			stats: null,
			pending: { steering: [], followUp: [] },
			lastError: this.lastError,
			pid: this.hello?.pid ?? null,
			connected: Boolean(this.conn),
		};
	}

	onEvent(listener) {
		this.emitter.on("event", listener);
		return () => this.emitter.off("event", listener);
	}

	onExit(listener) {
		this.emitter.on("exit", listener);
		return () => this.emitter.off("exit", listener);
	}

	#push(ev) {
		this.emitter.emit("event", ev);
	}

	/* ------------------------------ 连接管理 ------------------------------ */

	/** 连上扩展（幂等） */
	async connect() {
		if (this.conn) return this.conn;
		if (this.connecting) return this.connecting;
		this.connecting = this.#doConnect().finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	async #doConnect() {
		const { default: WebSocketImpl } = await import("ws");
		// 通过 unix socket 连到那个 pi 实例（ws 库的 ws+unix:// 语法）
		const ws = new WebSocketImpl(`ws+unix://${this.socketPath}:/`);
		this.conn = ws;
		this.status = "connecting";

		ws.on("message", (raw) => this.#onMessage(raw));
		ws.on("error", (err) => {
			this.lastError = String(err?.message ?? err);
		});
		ws.on("close", () => {
			this.conn = null;
			this.status = "bridge-lost";
			this.#push({ type: "piapp_status", status: this.status, error: "终端里的 pi 断开了" });
			this.emitter.emit("exit", { reason: "bridge-closed" });
		});

		await new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("连接桥接超时")), 3000);
			ws.once("open", () => {
				clearTimeout(t);
				resolve();
			});
			ws.once("error", (e) => {
				clearTimeout(t);
				reject(e);
			});
		});
		return ws;
	}

	#onMessage(raw) {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		// 应答服务端的请求
		if (msg.id && this.pending?.has(msg.id)) {
			const { resolve, reject } = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			msg.ok === false ? reject(new Error(msg.error ?? "桥接命令失败")) : resolve(msg);
			return;
		}

		if (msg.t === "hello") {
			this.hello = { ...this.hello, ...msg };
			this.idle = msg.isIdle !== false;
			this.status = this.idle ? "idle" : "streaming";
			// key 只在首次确定（后续 hello 不能把 key 改掉，否则前端会失联）
			if (!this.key) {
				this.key = msg.sessionId ? `bridge-${msg.sessionId}` : `bridge-${msg.pid ?? this.hello?.pid ?? "unknown"}`;
			}
			this.#push({ type: "piapp_status", status: this.status });
			return;
		}

		if (msg.t === "history") {
			this.entries = msg.entries ?? [];
			// 整份快照：让前端重建
			this.#push({ type: "piapp_history", entries: this.entries });
			return;
		}

		if (msg.t === "status") {
			this.idle = msg.isIdle !== false;
			this.status = this.idle ? "idle" : "streaming";
			this.#push({ type: "piapp_status", status: this.status });
			return;
		}

		if (msg.t === "error") {
			this.lastError = msg.message;
			this.#push({ type: "piapp_error", error: msg.message });
			return;
		}

		if (msg.t === "event" && msg.event) {
			const ev = msg.event;
			// 顺带维护历史游标，重连后可以增量补齐
			if (ev.type === "message_end" && ev.message) {
				this.idle = false;
			}
			if (ev.type === "agent_start") this.status = "streaming";
			if (ev.type === "agent_settled" || ev.type === "agent_end") {
				this.idle = true;
				this.status = "idle";
			}
			this.#push(ev);
		}
	}

	/* ------------------------------ 命令发送 ------------------------------ */

	pending = new Map();

	/** 发一条桥接命令给扩展 */
	send(type, payload = {}, timeoutMs = 120_000) {
		return new Promise((resolve, reject) => {
			if (!this.conn) return reject(new Error("未连接终端 pi"));
			const id = randomUUID();
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`桥接命令超时: ${type}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			try {
				this.conn.send(JSON.stringify({ id, t: type, ...payload }));
			} catch (err) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(err);
			}
		});
	}

	/** 兼容 AgentBridge 的 request() 接口 */
	async request(type, payload = {}, timeoutMs = 120_000) {
		if (type === "refresh_state") {
			await this.connect();
			return { state: this.snapshot().state, stats: null };
		}
		if (!BRIDGE_COMMANDS.has(type)) {
			throw new Error(`桥接模式不支持该命令: ${type}`);
		}
		const cmd = type === "abort" ? "abort" : type;
		return this.send(cmd, payload, timeoutMs);
	}

	/** 兼容 AgentBridge 的 recent()：返回扩展推过来的历史 */
	async recent() {
		await this.connect();
		// 主动要一次，保证拿到的是最新
		try {
			const r = await this.send("history", {}, 8000);
			if (r?.entries) this.entries = r.entries;
		} catch {
			/* 用缓存的 */
		}
		const messages = this.entries.map((e) => ({
			id: e.id,
			type: e.type,
			parentId: e.parentId ?? null,
			timestamp: e.timestamp ?? null,
			message: e.message ?? null,
			summary: e.summary ?? null,
			label: e.label ?? null,
		}));
		const start = Math.max(0, messages.length - RECENT_TURNS);
		return { messages: messages.slice(start), entries: messages.slice(start), rendering: "entries" };
	}

	async refreshState() {
		return { state: this.snapshot().state, stats: null };
	}

	async shutdown() {
		clearTimeout(this.reconnectTimer);
		try {
			this.conn?.close();
		} catch {
			/* ignore */
		}
		this.conn = null;
	}
}

export { listBridges, anyBridge, findBridgeForSession };
