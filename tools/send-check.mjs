/**
 * 交互验证：真发一条消息给 agent，检查流式渲染 / 用户气泡 / 工具事件 / 思考折叠。
 * 用法: node tools/send-check.mjs [port] [sessionIndex]
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const IDX = Number(process.argv[3] ?? 0);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DP = 9340;
const PROMPT = "回复三个字：我收到。然后运行 `date +%H:%M` 把结果贴出来。";

const chrome = spawn(CHROME, ["--headless=new","--disable-gpu","--no-first-run",`--remote-debugging-port=${DP}`,"--window-size=390,844","--user-data-dir=/tmp/pi-send","about:blank"], { stdio: "ignore" });
let wsUrl;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); const p = l.find(t => t.type === "page"); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(250); }
const ws = new WebSocket(wsUrl); await new Promise(r => ws.on("open", r));
let id = 0; const pend = new Map(); const errors = [];
ws.on("message", d => { const m = JSON.parse(d.toString());
  if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
  if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } });
const cdp = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await cdp("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return "THROW: " + (r.exceptionDetails.exception?.description ?? "").slice(0,300); return r.result.value; };
await cdp("Runtime.enable"); await cdp("Page.enable");

const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "  ✅" : "  ❌"} ${n}${d ? ` — ${d}` : ""}`); };

await cdp("Page.navigate", { url: BASE + "/" }); await sleep(2500);
await ev(`document.querySelectorAll('.session')[${IDX}].click(); true`);
await sleep(9000);
const entered = await ev(`!document.getElementById('view-chat').classList.contains('hidden')`);
check("进入会话", entered === true);
const before = await ev(`document.querySelectorAll('#messages .msg').length`);

console.log(`\n发送: ${PROMPT}`);
await ev(`(() => { const i=document.getElementById('input'); i.value=${JSON.stringify(PROMPT)}; i.dispatchEvent(new Event('input')); document.getElementById('btn-send').click(); return true; })()`);
await sleep(1200);
const userBubble = await ev(`[...document.querySelectorAll('#messages .msg.user')].some(n => n.innerText.includes('我收到'))`);
check("用户消息立刻出现在气泡里", userBubble === true);
const streaming = await ev(`document.getElementById('status-strip').innerText`);
check("状态切到生成中", /生成中/.test(streaming), streaming.replace(/\n/g, " | "));
const stopVisible = await ev(`!document.getElementById('btn-stop').classList.contains('hidden')`);
check("显示「停止」按钮", stopVisible === true);

// 等待稳定
let settled = false;
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  const s = await ev(`document.getElementById('status-strip').innerText`);
  if (/空闲/.test(s)) { settled = true; break; }
}
check("本轮生成结束回到空闲", settled === true);

const after = await ev(`document.querySelectorAll('#messages .msg').length`);
check("消息数增加", after > before, `${before} → ${after}`);
const assistantText = await ev(`[...document.querySelectorAll('#messages .msg.assistant')].map(n=>n.innerText).join('\\n')`);
check("助手回复渲染出来", /收到/.test(assistantText), assistantText.slice(-120).replace(/\n/g, " "));
const toolCard = await ev(`document.querySelectorAll('#messages .tool').length`);
check("工具调用卡片存在", toolCard > 0, `${toolCard} 张`);
const toolHasResult = await ev(`[...document.querySelectorAll('#messages .tool-out')].some(n => n.textContent.trim().length > 0)`);
check("工具卡片里有输出", toolHasResult === true);
const sendBack = await ev(`!document.getElementById('btn-send').classList.contains('hidden')`);
check("发送按钮恢复", sendBack === true);

const shot = await cdp("Page.captureScreenshot", { format: "png" });
(await import("node:fs")).writeFileSync("/tmp/pocket-4-send.png", Buffer.from(shot.data, "base64"));

await ev(`(async()=>{const r=await fetch('/api/agents').then(x=>x.json()); for(const a of r.agents) await fetch('/api/agents/'+encodeURIComponent(a.key)+'/close',{method:'POST'}); return true})()`);
check("无 JS 异常", errors.length === 0, errors.join(" | "));

console.log(`\n截图: /tmp/pocket-4-send.png`);
console.log(`结果: ${results.filter(Boolean).length}/${results.length} 通过\n`);
ws.close(); chrome.kill();
process.exit(results.every(Boolean) ? 0 : 1);
