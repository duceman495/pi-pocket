#!/usr/bin/env node
/**
 * Pi Pocket 服务端
 *
 *  手机浏览器 ──HTTP/WS──> 本机 8787 ──spawn/RPC──> pi agent 进程（每个会话一个）
 */
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { agentManager, RUNTIME_INFO } from "./src/agent-manager.mjs";
import { listCatalog } from "./src/session-catalog.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="));
const hostArg = args.find((a) => a.startsWith("--host="));
const PORT = Number(portArg?.split("=")[1] ?? process.env.PI_POCKET_PORT ?? 8787);
const HOST = hostArg?.split("=")[1] ?? process.env.PI_POCKET_HOST ?? "0.0.0.0";
const TOKEN = process.env.PI_POCKET_TOKEN ?? null;

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
};

function json(res, code, data) {
	const body = JSON.stringify(data);
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	res.end(body);
}

function readBody(req, limit = 1_000_000) {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
			if (raw.length > limit) reject(new Error("body too large"));
		});
		req.on("end", () => {
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("invalid json"));
			}
		});
		req.on("error", reject);
	});
}

function checkToken(req, url) {
	if (!TOKEN) return true;
	const t = req.headers["x-pi-pocket-token"] ?? url.searchParams.get("token");
	return t === TOKEN;
}

function lanAddresses() {
	const out = [];
	for (const [name, list] of Object.entries(networkInterfaces())) {
		for (const ni of list ?? []) {
			if (ni.family === "IPv4" && !ni.internal) out.push({ name, address: ni.address });
		}
	}
	return out;
}

/* ---------------------------------- HTTP ---------------------------------- */

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
	const path = url.pathname;

	try {
		if (path === "/api/health" && req.method === "GET") {
			return json(res, 200, {
				ok: true,
				host: HOST,
				port: PORT,
				lan: lanAddresses(),
				auth: Boolean(TOKEN),
				runtime: RUNTIME_INFO,
			});
		}

		if (path.startsWith("/api/")) {
			if (!checkToken(req, url)) return json(res, 401, { error: "unauthorized" });

			if (path === "/api/catalog" && req.method === "GET") {
				const catalog = await listCatalog();
				return json(res, 200, catalog);
			}

			if (path === "/api/agents" && req.method === "GET") {
				return json(res, 200, { agents: agentManager.list() });
			}

			if (path === "/api/agents/open" && req.method === "POST") {
				const body = await readBody(req);
				const { bridge, reused } = await agentManager.open({
					sessionPath: body.sessionPath,
					cwd: body.cwd,
					forceNew: Boolean(body.forceNew),
					copy: Boolean(body.copy),
				});
				await bridge.refreshState();
				return json(res, 200, { agent: bridge.snapshot(), reused });
			}

			const closeMatch = path.match(/^\/api\/agents\/(.+)\/close$/);
			if (closeMatch && req.method === "POST") {
				const key = decodeURIComponent(closeMatch[1]);
				const ok = await agentManager.close(key);
				return json(res, ok ? 200 : 404, { ok });
			}

			return json(res, 404, { error: "not found" });
		}

		// 静态资源
		let filePath = join(PUBLIC_DIR, normalize(path === "/" ? "/index.html" : path));
		if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });
		if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
			if (path === "/") filePath = join(PUBLIC_DIR, "index.html");
			if (!existsSync(filePath)) return json(res, 404, { error: "not found" });
		}
		res.writeHead(200, {
			"content-type": MIME[extname(filePath)] ?? "application/octet-stream",
			"cache-control": "no-cache",
		});
		createReadStream(filePath).pipe(res);
	} catch (err) {
		json(res, 500, { error: String(err?.message ?? err) });
	}
});

/* -------------------------------- WebSocket -------------------------------- */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
	if (url.pathname !== "/ws") {
		socket.destroy();
		return;
	}
	if (!checkToken(req, url)) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		socket.destroy();
		return;
	}
	const key = url.searchParams.get("key");
	wss.handleUpgrade(req, socket, head, (ws) => {
		attachClient(ws, key);
	});
});

/** 客户端的控制命令白名单（直接透传给 pi RPC） */
const PASSTHROUGH = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"clear_queue",
	"new_session",
	"compact",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"get_available_thinking_levels",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_state",
	"get_messages",
	"get_entries",
	"get_tree",
	"get_last_assistant_text",
	"get_session_stats",
	"set_session_name",
	"get_commands",
	"get_fork_messages",
	"fork",
	"clone",
	"switch_session",
	"export_html",
]);

function attachClient(ws, key) {
	const bridge = key ? agentManager.get(decodeURIComponent(key)) : null;
	if (!bridge) {
		ws.send(JSON.stringify({ type: "fatal", error: "该会话未打开或已关闭" }));
		ws.close();
		return;
	}

	const send = (payload) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
	};

	send({ type: "hello", agent: bridge.snapshot() });

	const offEvent = bridge.onEvent((event) => send({ type: "event", event }));
	const offExit = bridge.onExit((info) => send({ type: "exit", info }));

	// 心跳，防止手机切后台后连接被静默回收
	const ping = setInterval(() => {
		if (ws.readyState === ws.OPEN) ws.ping();
	}, 25_000);

	ws.on("message", async (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return send({ type: "response", success: false, error: "invalid json" });
		}
		const id = msg.id ?? null;
		const type = msg.type;
		if (!type) return send({ type: "response", id, success: false, error: "missing type" });

		// 客户端本地命令
		if (type === "refresh_state") {
			try {
				const data = await bridge.refreshState();
				return send({ type: "response", id, success: true, data });
			} catch (err) {
				return send({ type: "response", id, success: false, error: String(err?.message ?? err) });
			}
		}
		if (type === "recent") {
			try {
				const data = await bridge.recent();
				return send({ type: "response", id, success: true, data });
			} catch (err) {
				return send({ type: "response", id, success: false, error: String(err?.message ?? err) });
			}
		}

		if (!PASSTHROUGH.has(type)) {
			return send({ type: "response", id, success: false, error: `不支持的命令: ${type}` });
		}

		const payload = { ...msg };
		delete payload.type;
		delete payload.id;
		try {
			// prompt 的响应只表示“已接受”；compact 要等压缩真正跑完
			const timeout = type === "compact" ? 600_000 : type === "prompt" ? 60_000 : 120_000;
			const data = await bridge.request(type, payload, timeout);
			if (type === "get_state" || type === "get_session_stats") await bridge.refreshState();
			send({ type: "response", id, success: true, data });
		} catch (err) {
			send({ type: "response", id, success: false, error: String(err?.message ?? err) });
		}
	});

	ws.on("close", () => {
		clearInterval(ping);
		offEvent();
		offExit();
	});
}

/* --------------------------------- 启动 --------------------------------- */

server.listen(PORT, HOST, () => {
	const lan = lanAddresses();
	const first = lan[0]?.address ?? "127.0.0.1";
	const url = `http://${first}:${PORT}`;
	console.log("\n  Pi Pocket 已启动");
	console.log(`  本机     http://127.0.0.1:${PORT}`);
	for (const ni of lan) console.log(`  局域网   http://${ni.address}:${PORT}  (${ni.name})`);
	console.log(`  模式     ${RUNTIME_INFO.isolateMode ? "copy（fork 新文件，不碰原会话）" : "resume（续上原会话文件）"}`);
	if (TOKEN) console.log("  需要令牌 是（x-pi-pocket-token 或 ?token=）");
	console.log("");

	if (args.includes("--qr") || args.includes("--open")) {
		import("qrcode-terminal")
			.then((m) => {
				const qr = m.default ?? m;
				qr.generate(`${url}${TOKEN ? `/?token=${encodeURIComponent(TOKEN)}` : ""}`, { small: true });
				console.log(`  扫码打开：${url}\n`);
			})
			.catch(() => console.log(`  二维码不可用，请手动打开 ${url}\n`));

		if (args.includes("--open")) {
			import("node:child_process").then(({ spawn }) =>
				spawn("open", [`${url}${TOKEN ? `/?token=${encodeURIComponent(TOKEN)}` : ""}`], {
					stdio: "ignore",
					detached: true,
				}).unref(),
			);
		}
	}
});

const shutdown = async () => {
	console.log("\n  正在关闭所有 agent 进程…");
	await agentManager.closeAll();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
