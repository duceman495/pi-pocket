/**
 * Pi Pocket 桥接扩展
 *
 * 作用：让**终端里正在运行的 pi** 也能被 Pi Pocket 连接。
 *
 * 这样同一个会话就只有**一个** agent 进程（终端里那个），手机是它的客户端，
 * 于是电脑和手机的显示天然一致 —— 不会再出现"两边各跑一个进程、各自记自己的消息"。
 *
 * 安装：npm run install-bridge（或把本文件放到 ~/.pi/agent/extensions/）
 * 之后正常 `pi` 启动即可，无需任何参数。
 *
 * ## 为什么用 Unix socket 而不是固定端口
 *
 * 最初用固定端口 8788（先到先得），实践中直接失败：同时开着的几个 pi 里只有最先启动的
 * 能占住端口，而它往往不是你当前在用的那个会话；更麻烦的是 Pi Pocket 自己 spawn 的
 * rpc 进程也会抢，而且抢到之后很快就退出——结果你想同步的会话反而连不上。
 *
 * 现在每个 pi 实例在 <agentDir>/pi-pocket-bridge/<pid>.sock 上监听。服务端扫描该目录，
 * 读每个 socket 的 hello，就能按**会话文件**精确匹配到"哪个 pi 正在跑这个会话"，
 * 与启动顺序无关。服务端自己 spawn 的进程带 PI_POCKET_AGENT=1，不提供桥接。
 *
 * 实现上刻意**不用任何 npm 依赖**：扩展经 jiti 加载，解析不到 pi 的 node_modules，
 * import("ws") 会失败。这里用 node:http 手写 WebSocket 握手，只依赖 Node 内置模块。
 *
 * 协议见 docs/bridge-protocol.md。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const VERSION = 1;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
/** 所有桥接 socket 都放这里，服务端扫描该目录 */
const SOCKET_DIR = join(AGENT_DIR, "pi-pocket-bridge");
/** 本实例专属的 socket */
const SOCKET_PATH = join(SOCKET_DIR, `${process.pid}.sock`);
/** 诊断日志：扩展里的失败在 TUI 里看不见，写文件才排得出版 */
const LOG_FILE = process.env.PI_POCKET_BRIDGE_LOG ?? join(AGENT_DIR, "pi-pocket-bridge.log");
const VERBOSE = process.env.PI_POCKET_BRIDGE_VERBOSE === "1";
/**
 * Pi Pocket 服务端自行 spawn 的 pi（--mode rpc）不需要提供桥接：
 * 服务端已直连它的 stdin/stdout，再开 socket 只会造成"谁抢到算谁的"混乱。
 *
 * 判断依据用**实际运行模式**而不是环境变量：环境变量会被子进程继承，
 * 用户在 pi 里再启动一个 pi 时也会带上它，那种 TUI 其实是该提供桥接的。
 */
const SPAWNED_BY_PI_POCKET = process.env.PI_POCKET_AGENT === "1";

/**
 * 进程级单例。
 *
 * 为什么必须有：`/reload` 会重新加载扩展模块并**创建新的扩展实例**，
 * 但旧实例不会被销毁（旧的事件订阅仍然活着）。如果 socket 服务建在实例里，
 * reload 后就会出现「服务归旧实例、事件处理器在新实例」的错位 ——
 * 表现是 hello/history 正常但事件全丢，极难排查（这个坑踩过一次）。
 *
 * 所以把服务本体挂在 globalThis 上：新实例检测到已有实例，就只把事件
 * 转发进来，不再重复监听 socket。
 */
type BridgeCore = {
	clients: Set<any>;
	server: any;
	socketPath: string;
	/** 当前活跃实例的事件出口（reload 后会被新实例替换） */
	emit: (obj: unknown) => void;
	/** 当前活跃实例的上下文提供者 */
	getHello: () => unknown;
	getHistory: () => unknown[];
	handleCommand: (ws: any, msg: any) => void;
};

const GLOBAL_KEY = "__piPocketBridgeCore";
function getCore(): BridgeCore | null {
	return (globalThis as any)[GLOBAL_KEY] ?? null;
}
function setCore(core: BridgeCore) {
	(globalThis as any)[GLOBAL_KEY] = core;
}

/** 只转发这些事件（其余对手机端无意义，且高频） */
const FORWARD = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);
// 说明：pi 的扩展事件里没有 queue_update / compaction_* / auto_retry_*
// （那些只在 RPC 事件流里），所以不在这里注册。

/* ------------------------- 极简 WebSocket 服务端 -------------------------
 * 只实现桥接需要的部分：文本帧收发、ping/pong、关闭。
 * 不引入 ws 的原因见文件头：扩展经 jiti 加载，解析不到 pi 的 node_modules。
 */

class MiniWS {
	private socket: Socket;
	private buf = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	alive = true;
	onmessage?: (text: string) => void;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => this.#onData(chunk));
		// 必须兜住 error：客户端异常断开会冒泡成 uncaughtException，把 pi 进程带崩
		socket.on("error", () => this.destroy());
		socket.on("close", () => {
			this.alive = false;
		});
	}

	#onData(chunk: Buffer) {
		this.buf = Buffer.concat([this.buf, chunk]);
		for (;;) {
			const frame = this.#decode();
			if (!frame) return;
			if (frame.opcode === 0x8) return this.destroy(); // close
			if (frame.opcode === 0x9) {
				this.#frame(0xa, frame.payload); // ping → pong
				continue;
			}
			if (frame.opcode === 0xa) continue; // pong
			if (frame.opcode === 0x1 || frame.opcode === 0x0) {
				this.fragments.push(frame.payload);
				if (frame.fin) {
					const text = Buffer.concat(this.fragments).toString("utf8");
					this.fragments = [];
					this.onmessage?.(text);
				}
			}
		}
	}

	/** null 表示数据还不够一帧 */
	#decode(): { fin: boolean; opcode: number; payload: Buffer } | null {
		const b = this.buf;
		if (b.length < 2) return null;
		const fin = (b[0] & 0x80) !== 0;
		const opcode = b[0] & 0x0f;
		const masked = (b[1] & 0x80) !== 0;
		let len = b[1] & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (b.length < 4) return null;
			len = b.readUInt16BE(2);
			offset = 4;
		} else if (len === 127) {
			if (b.length < 10) return null;
			const big = b.readBigUInt64BE(2);
			if (big > 8_000_000n) {
				this.destroy();
				return null;
			}
			len = Number(big);
			offset = 10;
		}
		let mask: Buffer | null = null;
		if (masked) {
			if (b.length < offset + 4) return null;
			mask = b.subarray(offset, offset + 4);
			offset += 4;
		}
		if (b.length < offset + len) return null;
		const payload = Buffer.from(b.subarray(offset, offset + len));
		if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
		this.buf = b.subarray(offset + len);
		return { fin, opcode, payload };
	}

	#frame(opcode: number, payload: Buffer) {
		const len = payload.length;
		let header: Buffer;
		if (len < 126) {
			header = Buffer.from([0x80 | opcode, len]);
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		try {
			this.socket.write(Buffer.concat([header, payload]));
		} catch {
			this.alive = false;
		}
	}

	send(text: string) {
		if (!this.alive || this.socket.destroyed) return;
		this.#frame(0x1, Buffer.from(text, "utf8"));
	}

	destroy() {
		this.alive = false;
		try {
			this.socket.destroy();
		} catch {
			/* ignore */
		}
	}

	close() {
		try {
			this.#frame(0x8, Buffer.alloc(0));
		} catch {
			/* ignore */
		}
		this.destroy();
	}
}


export default function (pi: ExtensionAPI) {
	let ctxRef: any = null;
	let idle = true;

	const log = (msg: string) => {
		const line = `[${new Date().toISOString()}] ${msg}\n`;
		try {
			appendFileSync(LOG_FILE, line);
		} catch {
			/* 日志写不了就算了，不能影响 pi 本身 */
		}
		if (VERBOSE) console.error("[pi-pocket-bridge] " + msg);
	};


	const helloPayload = () => {
		const sm: any = ctxRef?.sessionManager;
		return {
			t: "hello",
			v: VERSION,
			sessionId: sm?.getSessionId?.() ?? null,
			sessionFile: sm?.getSessionFile?.() ?? null,
			cwd: ctxRef?.cwd ?? process.cwd(),
			mode: ctxRef?.mode ?? "unknown",
			pid: process.pid,
			model: ctxRef?.model ? `${ctxRef.model.provider}/${ctxRef.model.id}` : null,
			thinkingLevel: ctxRef?.thinkingLevel ?? null,
			isIdle: idle,
			sessionName: sm?.getSessionName?.() ?? null,
			socket: SOCKET_PATH,
		};
	};

	const entriesOf = (): unknown[] => {
		try {
			return ctxRef?.sessionManager?.getEntries?.() ?? [];
		} catch {
			return [];
		}
	};

	/** 事件/状态统一从这里出去，写进单例，reload 后自动指向新实例 */
	const emit = (obj: unknown) => {
		const core = getCore();
		if (!core) return;
		const text = JSON.stringify(obj);
		for (const ws of core.clients) ws.send(text);
	};

	/* ---------------------------- 命令处理 ---------------------------- */

	const handleCommand = async (ws: any, msg: any) => {
		const id = msg.id ?? null;
		const reply = (obj: Record<string, unknown>) => {
			const core = getCore();
			if (core?.clients.has(ws)) ws.send(JSON.stringify({ id, ...obj }));
		};
		try {
			switch (msg.t) {
				case "prompt":
					// 生成中改用 steer 排队，否则会被拒绝
					(pi as any).sendUserMessage(String(msg.message ?? ""), {
						deliverAs: idle ? undefined : "steer",
						expandPromptTemplates: msg.command === true,
					});
					reply({ ok: true });
					break;
				case "steer":
					(pi as any).sendUserMessage(String(msg.message ?? ""), { deliverAs: "steer" });
					reply({ ok: true });
					break;
				case "follow_up":
					(pi as any).sendUserMessage(String(msg.message ?? ""), { deliverAs: "followUp" });
					reply({ ok: true });
					break;
				case "abort":
					ctxRef?.abort?.();
					reply({ ok: true });
					break;
				case "history":
					reply({ ok: true, entries: entriesOf() });
					break;
				case "set_name":
					(pi as any).setSessionName(String(msg.name ?? ""));
					reply({ ok: true });
					break;
				case "set_thinking":
					(pi as any).setThinkingLevel?.(String(msg.level ?? "medium"));
					reply({ ok: true });
					break;
				case "get_commands":
					reply({ ok: true, commands: (pi as any).getCommands?.() ?? [] });
					break;
				default:
					reply({ ok: false, error: `不支持的桥接命令: ${msg.t}` });
			}
		} catch (err: any) {
			reply({ ok: false, error: String(err?.message ?? err) });
		}
	};

	/* ------------------------------ 事件转发 ------------------------------ */

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx as any;
		idle = ctx.isIdle?.() ?? true;
		log(
			`session_start mode=${ctx.mode} id=${(ctx.sessionManager as any).getSessionId?.()} ` +
				`(已有服务=${Boolean(getCore())})`,
		);

		// 每次 session_start 都把单例里的绑定点刷新到"当前这个实例"，
		// 这样 /reload、切会话之后事件转发依然从最新实例出去。
		const core = getCore();
		if (core) {
			core.emit = emit;
			core.getHello = helloPayload;
			core.getHistory = entriesOf;
			core.handleCommand = handleCommand;
			// 已有服务：把当前状态同步给已连接的客户端
			emit({ t: "hello", ...(helloPayload() as object) });
			return;
		}

		if (SPAWNED_BY_PI_POCKET && ctx.mode === "rpc") {
			log("跳过桥接（本进程由 Pi Pocket 以 rpc 模式启动，已有直连通道）");
			return;
		}
		startServer();
	});

	pi.on("agent_start", async () => {
		idle = false;
		emit({ t: "status", isIdle: idle });
	});
	pi.on("agent_settled", async () => {
		idle = true;
		emit({ t: "status", isIdle: idle });
	});

	for (const type of FORWARD) {
		pi.on(type as any, async (event: any, ctx: any) => {
			if (!ctxRef) ctxRef = ctx;
			emit({ t: "event", event });
		});
	}

	/* ------------------------------ socket 服务 ------------------------------ */

	let server: Server | null = null;
	let startError: string | null = null;

	const startServer = () => {
		if (getCore()) return; // 已经有人提供过服务了
		try {
			mkdirSync(SOCKET_DIR, { recursive: true });
			// 上次异常退出可能留下陈旧 socket，先清掉
			try {
				rmSync(SOCKET_PATH, { force: true });
			} catch {
				/* ignore */
			}
		} catch (err: any) {
			log("创建 socket 目录失败: " + (err?.message ?? err));
			return;
		}

		log(`启动桥接 socket=${SOCKET_PATH} node=${process.version} pid=${process.pid}`);
		try {
			server = createServer((_req: IncomingMessage, res: any) => {
				// 普通 HTTP 请求给个 JSON，方便 curl --unix-socket 确认存活
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true, service: "pi-pocket-bridge", v: VERSION, pid: process.pid }));
			});

			const core: BridgeCore = {
				clients: new Set<any>(),
				server,
				socketPath: SOCKET_PATH,
				emit,
				getHello: helloPayload,
				getHistory: entriesOf,
				handleCommand,
			};
			setCore(core);

			server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
				const key = req.headers["sec-websocket-key"];
				if (!key) {
					socket.destroy();
					return;
				}
				const accept = createHash("sha1")
					.update(String(key) + WS_GUID)
					.digest("base64");
				socket.write(
					"HTTP/1.1 101 Switching Protocols\r\n" +
						"Upgrade: websocket\r\n" +
						"Connection: Upgrade\r\n" +
						`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
				);

				const ws = new MiniWS(socket);
				const live = getCore() ?? core;
				live.clients.add(ws);
				log(`客户端接入（当前 ${live.clients.size} 个）`);

				// hello 与 history 都从"当前最新实例"取，reload 后也是对的
				ws.send(JSON.stringify(live.getHello()));
				ws.send(JSON.stringify({ t: "history", entries: live.getHistory() }));

				ws.onmessage = (text: string) => {
					let msg: any;
					try {
						msg = JSON.parse(text);
					} catch {
						return;
					}
					(getCore() ?? live).handleCommand(ws, msg);
				};

				socket.on("close", () => {
					live.clients.delete(ws);
					log(`客户端断开（剩 ${live.clients.size} 个）`);
				});
				// socket 的 error 已在 MiniWS 内兜住，
				// 否则客户端异常断开会变成 uncaughtException 把 pi 进程带崩
			});

			server.on("error", (err: any) => {
				startError = err?.code === "EADDRINUSE" ? "socket 已被占用" : String(err?.message);
				log("桥接服务出错: " + (startError ?? ""));
			});

			server.listen(SOCKET_PATH, () => log(`桥接就绪 unix:${SOCKET_PATH}`));
		} catch (err: any) {
			// 起不来就退化为"只提示不桥接"，绝不影响 pi 正常使用
			startError = err?.message ?? String(err);
			log("无法启动桥接: " + (err?.stack ?? startError));
		}
	};

	/* ------------------------------ 收尾 ------------------------------ */

	// 注意：session_shutdown 在 /reload 时也会触发，此时**不能**关掉 socket 服务，
	// 否则 reload 完就再也连不上了。只在真正退出进程时清理。
	const cleanup = () => {
		const core = getCore();
		if (core) {
			for (const ws of core.clients) ws.close();
			core.clients.clear();
		}
		try {
			core?.server?.close?.();
		} catch {
			/* ignore */
		}
		try {
			rmSync(SOCKET_PATH, { force: true });
		} catch {
			/* ignore */
		}
		log("桥接已停止");
	};

	pi.on("session_shutdown", async (event: any) => {
		// reason: "quit" 才是真的退出；reload/new/resume/fork 都要保留服务
		if (event?.reason === "quit" || event?.reason === undefined) cleanup();
		else log(`保留桥接（shutdown reason=${event.reason}）`);
	});

	// 进程退出时兜底清理 socket 文件，避免留下垃圾让服务端反复探测
	process.once("exit", () => {
		try {
			rmSync(SOCKET_PATH, { force: true });
		} catch {
			/* ignore */
		}
	});
}
