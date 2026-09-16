/**
 * Pi Pocket 桥接扩展
 *
 * 作用：让**终端里正在运行的 pi** 也能被 Pi Pocket 连接。
 *
 * 这样同一个会话就只有**一个** agent 进程（终端里那个），手机是它的客户端，
 * 于是电脑和手机的显示天然一致 —— 不会再出现"两边各跑一个进程、各自记自己的消息"。
 *
 * 安装：把本文件放到 ~/.pi/agent/extensions/pi-pocket-bridge.ts（或 npm run install-bridge）
 * 之后正常 `pi` 启动即可，扩展会自己在 127.0.0.1:8788 起一个 WebSocket 服务。
 *
 * 协议见 docs/bridge-protocol.md。端口可用 PI_POCKET_BRIDGE_PORT 覆盖。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const VERSION = 1;
const PORT = Number(process.env.PI_POCKET_BRIDGE_PORT ?? 8788);
const HOST = "127.0.0.1";
/** 诊断日志：扩展里的失败默认是不可见的（TUI 不会展示），写文件才排得出版 */
const LOG_FILE = process.env.PI_POCKET_BRIDGE_LOG ?? `${process.env.HOME}/.pi/agent/pi-pocket-bridge.log`;
const VERBOSE = process.env.PI_POCKET_BRIDGE_VERBOSE === "1";

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
	"queue_update",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
]);

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
	/** @type {Set<any>} */
	const clients = new Set();
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

	const send = (obj: unknown) => {
		const text = JSON.stringify(obj);
		for (const ws of clients) ws.send(text);
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
		};
	};

	/** 历史回填：把会话的完整 entry 列表发给新连接，手机端重建界面 */
	const sendHistory = (ws: MiniWS, id: string | null) => {
		try {
			const entries = ctxRef?.sessionManager?.getEntries?.() ?? [];
			// 主动推送用 {t:"history"}，应答请求用 {id,ok,entries}
			// 主动推送用 {t:"history"}，应答请求用 {id, ok, entries}
			ws.send(JSON.stringify(id ? { id, ok: true, entries } : { t: "history", entries }));
		} catch (err: any) {
			ws.send(JSON.stringify({ id, ok: false, error: String(err?.message ?? err) }));
		}
	};

	const handleCommand = async (ws: MiniWS, msg: any) => {
		const id = msg.id ?? null;
		const reply = (obj: Record<string, unknown>) => ws.send(JSON.stringify({ id, ...obj }));
		try {
			switch (msg.t) {
				case "prompt": {
					// deliverAs 让生成中的消息按 steer/followUp 排队，而不是被拒绝
					(pi as any).sendUserMessage(String(msg.message ?? ""), {
						deliverAs: idle ? undefined : "steer",
						expandPromptTemplates: msg.command === true,
					});
					reply({ ok: true });
					break;
				}
				case "steer": {
					(pi as any).sendUserMessage(String(msg.message ?? ""), { deliverAs: "steer" });
					reply({ ok: true });
					break;
				}
				case "follow_up": {
					(pi as any).sendUserMessage(String(msg.message ?? ""), { deliverAs: "followUp" });
					reply({ ok: true });
					break;
				}
				case "abort": {
					ctxRef?.abort?.();
					reply({ ok: true });
					break;
				}
				case "history": {
					sendHistory(ws, id);
					break;
				}
				case "set_name": {
					(pi as any).setSessionName(String(msg.name ?? ""));
					reply({ ok: true });
					break;
				}
				case "set_thinking": {
					const level = String(msg.level ?? "medium");
					(pi as any).setThinkingLevel?.(level);
					reply({ ok: true });
					break;
				}
				case "get_commands": {
					reply({ ok: true, commands: (pi as any).getCommands?.() ?? [] });
					break;
				}
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
		log(`session_start mode=${ctx.mode} id=${(ctx.sessionManager as any).getSessionId?.()}`);
	});

	pi.on("agent_start", async () => {
		idle = false;
		send({ t: "status", isIdle: idle });
	});
	pi.on("agent_settled", async () => {
		idle = true;
		send({ t: "status", isIdle: idle });
	});

	// 逐个事件转发（pi 的 on() 是类型化重载，这里用统一处理器逐个注册）
	for (const type of FORWARD) {
		pi.on(type as any, async (event: any, ctx: any) => {
			if (!ctxRef) ctxRef = ctx;
			send({ t: "event", event });
		});
	}

	/* ------------------------------ WS 服务端 ------------------------------ */

	let server: Server | null = null;
	let startError: string | null = null;

	const startServer = () => {
		log(`启动桥接 host=${HOST} port=${PORT} node=${process.version} pid=${process.pid}`);
		try {
			server = createServer((_req: IncomingMessage, res: any) => {
				// 只用 GET /ws 做 WebSocket 升级；其余请求给个 JSON 提示，
				// 方便直接用浏览器/curl 确认"桥接活着"
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true, service: "pi-pocket-bridge", v: VERSION, pid: process.pid }));
			});

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
				clients.add(ws);
				log(`客户端接入（当前 ${clients.size} 个）`);
				ws.send(JSON.stringify(helloPayload()));
				sendHistory(ws, null); // 新连接先推历史，手机端立刻有完整界面

				ws.onmessage = (text: string) => {
					let msg: any;
					try {
						msg = JSON.parse(text);
					} catch {
						return;
					}
					handleCommand(ws, msg);
				};

				socket.on("close", () => {
					clients.delete(ws);
					log(`客户端断开（剩 ${clients.size} 个）`);
				});
				// socket 的 error 已在 MiniWS 内部兜住，
				// 否则客户端异常断开会变成 uncaughtException 把 pi 进程带崩
			});

			server.on("error", (err: any) => {
				startError = err?.code === "EADDRINUSE" ? "端口被占用" : String(err?.message);
				log("桥接服务出错: " + (startError ?? ""));
			});

			server.listen(PORT, HOST, () => log(`桥接就绪 ws://${HOST}:${PORT}`));
		} catch (err: any) {
			// 起不来就退化为"只提示不桥接"，绝不影响 pi 正常使用
			startError = err?.message ?? String(err);
			log("无法启动桥接: " + (err?.stack ?? startError));
		}
	};

	startServer();

	pi.on("session_shutdown", async () => {
		for (const ws of clients) ws.close();
		clients.clear();
		try {
			server?.close?.();
		} catch {
			/* ignore */
		}
		log("桥接已停止");
	});
}
