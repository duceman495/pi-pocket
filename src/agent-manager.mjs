/**
 * Agent 进程管理器
 *
 * 三种进入方式：
 *  - resume（默认）：`pi --mode rpc --session <file>`，真正续上指定会话文件，
 *    历史消息、分支、上下文都在。
 *  - copy：把会话 fork 成一个新文件再进入，完全不碰原文件（适合原会话
 *    可能同时开在电脑终端时）。设置 PI_POCKET_ISOLATE=1 全局启用。
 *  - new：在指定 cwd 下开全新会话。
 *
 * 注意：resume 会让手机端进程和电脑终端进程写同一个会话文件，两边不要同时
 * 对同一会话发消息。
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { getAgentDir, getPackageDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { cwdFromSessionPath } from "./session-catalog.mjs";

const RECENT_TURNS = 60;
const ISOLATE_MODE = process.env.PI_POCKET_ISOLATE === "1";
const CLI = process.env.PI_POCKET_CLI ?? `${getPackageDir()}/dist/cli.js`;

/**
 * 电脑上有几个「终端里自己开的」pi？
 *
 * 用来判断"用户明明开着 pi，为什么手机不同步"这类问题。
 * 必须排除掉本服务自己 spawn 的 agent，否则永远大于 0，提示就没有意义了。
 *
 * 注意：不能用 lsof 看会话文件 —— pi 只在写的时候才打开文件，不持续持有，
 * 所以 lsof 查不到（试过，会漏判）。
 */
function terminalPiCount() {
	try {
		const out = execFileSync("pgrep", ["-x", "pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const pids = out.split("\n").map((x) => x.trim()).filter(Boolean).map(Number);
		let count = 0;
		for (const pid of pids) {
			try {
				// 父进程是本服务的，就是手机自己开的 agent，不算
				const ppid = Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim());
				if (ppid !== process.pid) count++;
			} catch {
				/* ignore */
			}
		}
		return count;
	} catch {
		return 0; // pgrep 无匹配时退出码非 0
	}
}

/** 一条会话在服务端的运行时状态 */


class AgentBridge {
	constructor({ key, sessionPath, cwd, sessionId, mode, sourcePath }) {
		this.key = key;
		this.sessionPath = sessionPath ?? null;
		this.sourcePath = sourcePath ?? null;
		this.cwd = cwd;
		this.sessionId = sessionId ?? null;
		this.mode = mode; // "resume" | "copy" | "new"
		this.proc = null;
		this.status = "idle"; // idle | starting | streaming | error | exited
		this.events = [];
		this.queue = [];
		this.pending = new Map();
		this.pendingSteer = [];
		this.pendingFollowUp = [];
		this.state = { model: null, thinkingLevel: null, sessionName: null };
		this.stats = null;
		this.lastError = null;
		/** 提示性警告（如"终端也开着这个会话"），前端会显示成横幅 */
		this.warning = null;
		this.emitter = new EventEmitter();
		this.emitter.setMaxListeners(0);
		this.stdoutBuf = "";
		this.stderrTail = "";
	}

	snapshot() {
		return {
			key: this.key,
			sessionPath: this.sessionPath,
			sourcePath: this.sourcePath,
			sessionId: this.sessionId,
			cwd: this.cwd,
			mode: this.mode,
			status: this.status,
			events: this.events,
			state: this.state,
			stats: this.stats,
			pending: { steering: this.pendingSteer, followUp: this.pendingFollowUp },
			lastError: this.lastError,
			warning: this.warning,
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

	#emit(event) {
		this.emitter.emit("event", event);
	}

	/* ---------- 进程 ---------- */

	async start() {
		if (this.proc) return;
		this.status = "starting";
		const args = ["--mode", "rpc"];
		if (this.sessionPath) args.push("--session", this.sessionPath);
		const env = { ...process.env, PI_POCKET_AGENT: "1" };

		const proc = spawn(process.execPath, [CLI, ...args], {
			cwd: this.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;

		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk) => this.#onStdout(chunk));
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-4000);
		});
		proc.on("exit", (code, signal) => {
			this.proc = null;
			this.status = "exited";
			this.lastError = this.lastError ?? `pi 进程退出 (code=${code}, signal=${signal})`;
			for (const [, req] of this.pending) req.reject(new Error("pi 进程已退出"));
			this.pending.clear();
			this.#emit({ type: "piapp_status", status: this.status, error: this.lastError });
			this.emitter.emit("exit", { code, signal });
		});
		proc.on("error", (err) => {
			this.status = "error";
			this.lastError = String(err?.message ?? err);
			this.#emit({ type: "piapp_status", status: this.status, error: this.lastError });
		});

		// 等就绪（能响应 get_state 即为就绪）
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				await this.request("get_state", {}, 5_000);
				this.status = "idle";
				return this;
			} catch {
				if (!this.proc) throw new Error(this.lastError ?? "pi 启动失败");
				await new Promise((r) => setTimeout(r, 300));
			}
		}
		throw new Error("pi 启动超时");
	}

	#onStdout(chunk) {
		this.stdoutBuf += chunk;
		while (true) {
			const idx = this.stdoutBuf.indexOf("\n");
			if (idx === -1) break;
			let line = this.stdoutBuf.slice(0, idx);
			this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			this.#handleMessage(msg);
		}
	}

	#handleMessage(msg) {
		if (msg.type === "response") {
			const req = msg.id ? this.pending.get(msg.id) : null;
			if (req) {
				this.pending.delete(msg.id);
				if (msg.success === false) req.reject(new Error(msg.error ?? "命令失败"));
				else req.resolve(msg.data ?? {});
			} else if (msg.success === false) {
				this.#push({ type: "piapp_error", error: msg.error ?? "命令失败" });
			}
			return;
		}

		this.#updateFromEvent(msg);
		this.#push(msg);
	}

	#updateFromEvent(ev) {
		switch (ev.type) {
			case "agent_start":
				this.status = "streaming";
				this.#push({ type: "piapp_status", status: this.status });
				break;
			case "agent_settled":
				this.status = "idle";
				this.#push({ type: "piapp_status", status: this.status });
				break;
			case "turn_end": {
				const message = ev.message;
				if (message?.role === "assistant" && message.usage) {
					this.stats = { ...(this.stats ?? {}), lastUsage: message.usage };
				}
				break;
			}
			case "queue_update":
				this.pendingSteer = ev.steering ?? [];
				this.pendingFollowUp = ev.followUp ?? [];
				break;
			case "auto_retry_start":
				this.lastError = ev.errorMessage ?? this.lastError;
				break;
			case "extension_error":
				this.lastError = ev.error ?? this.lastError;
				break;
			default:
				break;
		}
	}

	#push(ev) {
		this.events.push(ev);
		if (this.events.length > 4000) this.events.splice(0, this.events.length - 4000);
		this.#emit(ev);
	}

	/** 发送 RPC 命令并等待响应 */
	request(type, payload = {}, timeoutMs = 120_000) {
		return new Promise((resolve, reject) => {
			if (!this.proc) {
				reject(new Error("pi 进程未运行"));
				return;
			}
			const id = randomUUID();
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`命令超时: ${type}`));
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
			this.proc.stdin.write(JSON.stringify({ id, type, ...payload }) + "\n");
		});
	}

	/* ---------- 高层动作 ---------- */

	async prompt(message) {
		const data = await this.request("prompt", { message }, 30_000);
		return data;
	}

	async refreshState() {
		const [state, stats] = await Promise.all([
			this.request("get_state").catch(() => null),
			this.request("get_session_stats").catch(() => null),
		]);
		if (state) {
			this.state = {
				model: state.model ? `${state.model.provider}/${state.model.id}` : null,
				thinkingLevel: state.thinkingLevel ?? null,
				sessionName: state.sessionName ?? null,
			};
			this.sessionId = state.sessionId ?? this.sessionId;
			this.sessionPath = state.sessionFile ?? this.sessionPath;
			this.status = state.isStreaming ? "streaming" : this.status === "starting" ? "idle" : this.status;
		}
		if (stats) this.stats = stats;
		return { state: this.state, stats: this.stats };
	}

	async recent() {
		let messages = [];
		let entries = [];
		try {
			const data = await this.request("get_entries");
			entries = data.entries ?? [];
		} catch {
			const data = await this.request("get_messages").catch(() => ({ messages: [] }));
			messages = data.messages ?? [];
			return { messages, entries: [], rendering: "messages" };
		}
		const start = Math.max(0, entries.length - RECENT_TURNS);
		messages = entries.slice(start).map((e) => ({
			id: e.id,
			type: e.type,
			parentId: e.parentId ?? null,
			timestamp: e.timestamp ?? null,
			message: e.message ?? null,
			summary: e.summary ?? null,
			label: e.label ?? null,
		}));
		return { messages, entries: messages, rendering: "entries" };
	}

	async shutdown() {
		if (!this.proc) return;
		const proc = this.proc;
		proc.stdin.end();
		const force = setTimeout(() => proc.kill("SIGKILL"), 4000);
		proc.once("exit", () => clearTimeout(force));
		proc.kill("SIGTERM");
	}
}

export class AgentManager {
	constructor() {
		/** @type {Map<string, AgentBridge>} */
		this.bridges = new Map();
		/** 同一个 key 的并发 open 合并成一次启动 */
		this.inflight = new Map();
	}

	keyFor(sessionPath) {
		return sessionPath ?? `new:${randomUUID()}`;
	}

	get(externalKey) {
		return this.bridges.get(externalKey) ?? null;
	}

	/** 打开（或复用）一个会话 */
	async open({ sessionPath, cwd, forceNew = false, copy = false }) {
		const isolate = copy || ISOLATE_MODE;
		const targetCwd = sessionPath ? (cwd ?? cwdFromSessionPath(sessionPath) ?? process.cwd()) : (cwd ?? process.cwd());
		const mode = !sessionPath ? "new" : isolate ? "copy" : "resume";
		const key = sessionPath ? (isolate ? `${sessionPath}#copy` : sessionPath) : `new:${randomUUID()}`;

		const existing = this.bridges.get(key);
		if (existing && existing.proc && !forceNew) return { bridge: existing, reused: true };
		if (existing && forceNew) await this.close(key);

		const pending = this.inflight.get(key);
		if (pending && !forceNew) return pending;

		const task = this.#spawnBridge({ key, sessionPath, targetCwd, mode });
		this.inflight.set(key, task);
		try {
			const bridge = await task;
			return { bridge, reused: false };
		} finally {
			if (this.inflight.get(key) === task) this.inflight.delete(key);
		}
	}

	async #spawnBridge({ key, sessionPath, targetCwd, mode }) {
		let managedPath = null;
		let sessionId = null;
		try {
			if (!sessionPath) {
				const manager = SessionManager.create(targetCwd);
				sessionId = manager.getSessionId();
			} else if (mode === "copy") {
				// fork 成一个新文件，不动原会话
				managedPath = SessionManager.forkFrom(sessionPath, targetCwd)?.getSessionFile() ?? null;
				const manager = managedPath ? SessionManager.open(managedPath) : SessionManager.open(sessionPath);
				sessionId = manager.getSessionId();
			} else {
				const manager = SessionManager.open(sessionPath, undefined, targetCwd);
				sessionId = manager.getSessionId();
			}
		} catch {
			/* 交给 pi 进程自己解析路径 */
		}

		const bridge = new AgentBridge({
			key,
			sessionPath: mode === "copy" ? managedPath : sessionPath,
			sourcePath: sessionPath ?? null,
			cwd: targetCwd,
			sessionId,
			mode,
		});

		// 用户终端里开着 pi、但手机这边只能自己起进程 → 说清楚为什么不同步
		if (mode === "resume") {
			const terminals = terminalPiCount();
			if (terminals > 0) {
				bridge.warning =
					`检测到电脑终端里还开着 ${terminals} 个 pi，但手机这边连不上它，` +
					`所以现在是独立的 agent 进程，两端不会互相同步（同时发消息还可能互相覆盖）。` +
					`想让两端实时同步：在终端那个 pi 里敲 /reload 启用桥接，` +
					`或改用「开副本」在不影响原会话的前提下继续。`;
			}
		}
		this.bridges.set(key, bridge);
		try {
			await bridge.start();
			await bridge.refreshState();
		} catch (err) {
			this.bridges.delete(key);
			await bridge.shutdown().catch(() => {});
			throw err;
		}
		return bridge;
	}

	async close(key) {
		const bridge = this.bridges.get(key);
		if (!bridge) return false;
		await bridge.shutdown();
		this.bridges.delete(key);
		return true;
	}

	async closeAll() {
		await Promise.all([...this.bridges.values()].map((b) => b.shutdown()));
		this.bridges.clear();
	}

	list() {
		return [...this.bridges.values()].map((b) => b.snapshot());
	}
}

export const agentManager = new AgentManager();
export const RUNTIME_INFO = {
	isolateMode: ISOLATE_MODE,
	cli: CLI,
	agentDir: getAgentDir(),
};
