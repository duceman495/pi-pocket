/**
 * 验证「终端 pi ↔ 手机」双向同步。
 *
 * 与 ui-check 的区别：这个脚本专门验证**同一个 agent 被两端共享**——
 * 手机端发消息后，消息必须进入终端那个 pi 进程（同一个 pid），而不是新起一个进程。
 *
 * 前置：先跑 ./tools/bridge-check.sh（终端里起带桥接扩展的 pi + Pi Pocket 服务）
 * 用法：node tools/bridge-sync-check.mjs [port]
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const json = async (p, init) => (await fetch(BASE + p, init)).json();
const post = (p, body) =>
	json(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

/** 当前有几个 pi 进程在跑（用于证明"没有多起进程"） */
function piProcesses() {
	try {
		// pgrep -f 匹配完整命令行；排除服务端自身
		const out = execFileSync("pgrep", ["-f", "pi-coding-agent|/cli\.js|bundle/cli\.js"], { encoding: "utf8" });
		return out
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return []; // pgrep 无匹配时退出码为 1
	}
}

/** 这个 pid 是不是那个终端 pi（用 ps 单独确认，避免 pgrep 模式写法导致假阳性） */
function pidAlive(pid) {
	try {
		execFileSync("ps", ["-p", String(pid)], { encoding: "utf8" });
		return true;
	} catch {
		return false;
	}
}

console.log("\n[1] 桥接可用性");
const health = await json("/api/health");
check("服务报告终端 pi 可桥接", health.bridge?.available === true, JSON.stringify(health.bridge?.sessionFile ? "有会话文件" : health.bridge));
if (!health.bridge?.available || !health.bridge?.sessionFile) {
	console.log("\n⚠️  终端里没有带会话文件的 pi 在跑，先执行 ./tools/bridge-check.sh\n");
	process.exit(1);
}
const termPid = health.bridge.pid;
const sessionFile = health.bridge.sessionFile;

console.log("\n[2] 会话目录里能认出这一条");
const catalog = await json("/api/catalog");
const target = catalog.sessions.find((s) => s.path === sessionFile);
// 刚启动、还没有任何消息的会话不会出现在列表里（listAll 只收录有消息的会话），
// 所以这里不作为失败条件，只报告；手机端用「终端 pi 正在运行」卡片接进去。
check(
	"能在目录里定位到终端会话（没消息时列表不收录，属正常）",
	true,
	target ? `${target.projectName} / ${target.messageCount} 条` : "列表暂未收录，用首页的终端卡片接入",
);

console.log("\n[3] 手机接入（应当走桥接而非新起进程）");
const before = piProcesses();
const opened = await post("/api/agents/open", { sessionPath: sessionFile, cwd: target?.cwd });
check("返回 bridged=true", opened.bridged === true, `mode=${opened.agent?.mode}`);
check("模式标记为 bridge", opened.agent?.mode === "bridge", String(opened.agent?.mode));
check("会话文件与终端一致", opened.agent?.sessionPath === sessionFile, String(opened.agent?.sessionPath));
check("pid 指向终端那个 pi", opened.agent?.pid === termPid, `手机侧看到 pid=${opened.agent?.pid}, 终端 pid=${termPid}`);
const after = piProcesses();
check("没有额外 spawn 新 pi 进程", after.length <= before.length, `${before.length} → ${after.length} 个`);

const key = opened.agent.key;

console.log("\n[4] WebSocket 接入并取历史");
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${encodeURIComponent(key)}`);
const pending = new Map();
const events = [];
// 注意：message 监听必须在 await open 之前挂上。
// 服务端在连接建立的瞬间就发 hello，如果等 await 回来再挂监听，hello 会丢。
ws.on("message", (raw) => {
	const m = JSON.parse(raw.toString());
	if (m.type === "response" && m.id && pending.has(m.id)) {
		const { resolve, reject } = pending.get(m.id);
		pending.delete(m.id);
		m.success === false ? reject(new Error(m.error)) : resolve(m.data ?? {});
		return;
	}
	if (m.type === "event") events.push(m.event);
	if (m.type === "hello") events.push({ type: "hello", agent: m.agent });
});
// 两种竞态都要防：连接可能已经 open（再等 open 事件会永远等不到），
// 也可能还没 open（必须挂上监听）。用 readyState 判断。
await new Promise((res, rej) => {
	if (ws.readyState === ws.OPEN) return res();
	ws.on("open", res);
	ws.on("error", rej);
});
const rpc = (type, payload = {}, timeoutMs = 30_000) =>
	new Promise((resolve, reject) => {
		const id = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`超时 ${type}`));
		}, timeoutMs);
		pending.set(id, {
			resolve: (v) => {
				clearTimeout(timer);
				resolve(v);
			},
			reject: (e) => {
				clearTimeout(timer);
				reject(e);
			},
		});
		ws.send(JSON.stringify({ id, type, ...payload }));
	});

const history = await rpc("recent", {}, 15_000).catch((e) => ({ messages: [], error: e.message }));
// hello 和 recent 的响应谁先到不保证，断言前先等一拍
await sleep(1200);
const hello = events.find((e) => e.type === "hello");
check("WS hello 显示 bridge 模式", hello?.agent?.mode === "bridge", JSON.stringify(hello?.agent?.mode ?? "未收到 hello"));
const histCount = (history.messages ?? []).length;
check("从终端 pi 取回历史", histCount > 0, `${histCount} 条`);

console.log("\n[5] 手机发消息 → 进入终端那个 agent");
const beforeEvents = events.length;
const probe = "只回复两个字：同步";
await rpc("prompt", { message: probe }, 30_000);
check("prompt 被接受", true, probe);

let gotAssistant = "";
let settled = false;
for (let i = 0; i < 60; i++) {
	await sleep(1500);
	for (const ev of events.slice(beforeEvents)) {
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			gotAssistant = (ev.message.content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("");
		}
		if (ev.type === "agent_settled") settled = true;
	}
	if (settled) break;
}
check("收到流式事件（说明两端共用事件流）", events.length > beforeEvents, `新增 ${events.length - beforeEvents} 个事件`);
check("agent 返回了回复", gotAssistant.length > 0, JSON.stringify(gotAssistant.slice(0, 60)));
check("本轮结束回到空闲", settled === true);

const during = piProcesses();
check("全程没有新增 pi 进程（没有分叉成两个 agent）", during.length <= before.length, `${before.length} → ${during.length} 个`);

console.log("\n[6] 终端那边确实收到了同一条消息");
const entries = await rpc("recent", {}, 15_000).catch(() => ({ messages: [] }));
const found = (entries.messages ?? []).some((m) =>
	JSON.stringify(m.message?.content ?? "").includes("只回复两个字：同步"),
);
check("终端 pi 的历史里有手机发的消息", found === true);

console.log("\n[7] 断开桥接不应影响终端 pi");
await post(`/api/agents/${encodeURIComponent(key)}/close`);
await sleep(1500);
const stillAlive = pidAlive(termPid);
check("断开后终端 pi 仍在运行", stillAlive, `pid ${termPid} ${stillAlive ? "存活" : "已消失"}`);
const health2 = await json("/api/health");
check("桥接仍可用（随时可重连）", health2.bridge?.available === true);

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过\n`);
process.exit(failed.length ? 1 : 0);
