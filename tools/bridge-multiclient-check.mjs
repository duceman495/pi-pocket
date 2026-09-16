/**
 * 验证「多端同步」：两个客户端接到同一个 agent，
 * 一端发的消息，另一端必须实时看到（含流式增量）。
 * 这对应真实场景里"电脑终端 + 手机同时看同一个会话"。
 */
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const ck = (n, ok, d = "") => {
	results.push(ok);
	console.log(`${ok ? "  ✅" : "  ❌"} ${n}${d ? ` — ${d}` : ""}`);
};

function client(key, name) {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${encodeURIComponent(key)}`);
	const rec = { name, events: [], deltas: "", assistant: "", settled: 0, users: [] };
	ws.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "event") {
			const ev = m.event;
			rec.events.push(ev.type);
			if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
				rec.deltas += ev.assistantMessageEvent.delta;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				rec.assistant = (ev.message.content ?? [])
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("");
			}
			if (ev.type === "message_end" && ev.message?.role === "user") {
				rec.users.push(JSON.stringify(ev.message.content));
			}
			if (ev.type === "agent_settled") rec.settled++;
		}
	});
	return { ws, rec };
}

const health = await (await fetch(BASE + "/api/health")).json();
if (!health.bridge?.available) {
	console.log("⚠️  终端没有可桥接的 pi，先跑 ./tools/bridge-check.sh");
	process.exit(1);
}
const opened = await (
	await fetch(BASE + "/api/agents/open", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionPath: health.bridge.sessionFile, cwd: health.bridge.cwd }),
	})
).json();
const key = opened.agent.key;
console.log(`接入 ${key}（终端 pid ${opened.agent.pid}）\n`);

console.log("[1] 两个客户端同时接入同一个 agent");
const A = client(key, "A");
const B = client(key, "B");
await sleep(2500);
ck("A 已连接", A.ws.readyState === WebSocket.OPEN);
ck("B 已连接", B.ws.readyState === WebSocket.OPEN);

console.log("\n[2] 从 A 发消息，B 应当也能实时看到");
const before = { a: A.rec.events.length, b: B.rec.events.length };
A.ws.send(JSON.stringify({ id: "a1", type: "prompt", message: "只回复两个字：广播" }));

for (let i = 0; i < 60; i++) {
	await sleep(1500);
	if (A.rec.settled > 0 && B.rec.settled > 0) break;
}

ck("A 收到了本轮事件", A.rec.events.length > before.a, `+${A.rec.events.length - before.a}`);
ck("B 收到了本轮事件", B.rec.events.length > before.b, `+${B.rec.events.length - before.b}`);
ck("B 看到了 A 发出的用户消息", B.rec.users.some((u) => u.includes("广播")), B.rec.users.slice(-1)[0]?.slice(0, 50) ?? "无");
ck("B 也收到了流式增量", B.rec.deltas.length > 0, JSON.stringify(B.rec.deltas.slice(0, 30)));
ck("两端看到的助手回复一致", A.rec.assistant === B.rec.assistant && A.rec.assistant.length > 0,
	`A=${JSON.stringify(A.rec.assistant.slice(0,20))} B=${JSON.stringify(B.rec.assistant.slice(0,20))}`);

console.log("\n[3] 从 B 反向发消息，A 也应当看得到");
const b2 = A.rec.events.length;
B.ws.send(JSON.stringify({ id: "b1", type: "prompt", message: "只回复两个字：反向" }));
for (let i = 0; i < 60; i++) {
	await sleep(1500);
	if (A.rec.assistant.includes("反向")) break;
}
ck("A 收到了 B 触发的回复", A.rec.assistant.includes("反向"), JSON.stringify(A.rec.assistant.slice(0, 30)));
ck("A 事件数增加（反向也同步）", A.rec.events.length > b2, `+${A.rec.events.length - b2}`);

A.ws.close();
B.ws.close();
await fetch(`${BASE}/api/agents/${encodeURIComponent(key)}/close`, { method: "POST" }).catch(() => {});

const failed = results.filter((r) => !r).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过\n`);
process.exit(failed ? 1 : 0);
