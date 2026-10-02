/**
 * 在真机/模拟器上验证 Android App：通过 adb forward 接 WebView 的 CDP，
 * 检查 App 里的网页到底渲染成了什么样（不是"应该能跑"，而是真的跑起来了）。
 *
 * 前置：
 *   1. 电脑上 Pi Pocket 服务在跑
 *   2. 模拟器里 App 已连上（地址用 10.0.2.2:8787，模拟器访问宿主机的特殊地址）
 *   3. adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
 *
 * 用法: node tools/android-app-check.mjs [cdpPort]
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const CDP_PORT = Number(process.argv[2] ?? 9223);
const ADB = process.env.ADB ?? `${process.env.HOME}/android-sdk/platform-tools/adb`;
const PKG = "com.pipocket";

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8" }).trim();

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("\n[A] App 状态");
let pid = "";
try {
	pid = adb("shell", "pidof", PKG);
} catch {
	pid = "";
}
check("App 进程在运行", Boolean(pid), pid ? `pid=${pid}` : "未运行");

const top = adb("shell", "dumpsys", "activity", "activities");
const inWeb = top.includes(`${PKG}/.WebActivity`);
check("已进入 WebView 界面（WebActivity）", inWeb, inWeb ? "" : top.match(/topResumedActivity=\S+/)?.[0] ?? "");

console.log("\n[B] WebView 调试通道");
let targets = [];
for (let i = 0; i < 5; i++) {
	try {
		const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
		targets = await r.json();
		if (targets.some((t) => t.type === "page")) break;
	} catch {
		/* retry */
	}
	await sleep(800);
}
const page = targets.find((t) => t.type === "page");
check("拿到 WebView 里的页面", Boolean(page), page?.url ?? "无");
if (!page) {
	console.log("\n提示：先 adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>");
	process.exit(1);
}
check("页面加载的是电脑上的 Pi Pocket", /^http:\/\/[\d.]+:\d+\//.test(page.url ?? ""), page.url);
check("页面标题正确", page.title === "Pi Pocket", page.title);

console.log("\n[C] 网页在安卓 WebView 里的真实渲染");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));
let id = 0;
const pending = new Map();
const exceptions = [];
ws.on("message", (d) => {
	const m = JSON.parse(d.toString());
	if (m.method === "Runtime.exceptionThrown") {
		exceptions.push((m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
	}
	if (m.id && pending.has(m.id)) {
		const { resolve, reject } = pending.get(m.id);
		pending.delete(m.id);
		m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
	}
});
const cdp = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const i = ++id;
		pending.set(i, { resolve, reject });
		ws.send(JSON.stringify({ id: i, method, params }));
	});
const ev = async (expr) => {
	const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) return "THROW: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 200);
	return r.result.value;
};
await cdp("Runtime.enable");

const ua = await ev(`navigator.userAgent`);
check("确认是安卓 WebView 环境", /Android/.test(ua) && /wv\)/.test(ua + ")"), ua.replace(/.*(Android [\d.]+).*/, "$1"));

const loadedSrc = await ev(`[...document.scripts].map(s=>s.getAttribute('src')).filter(Boolean).join(',')`);
check("安卓 WebView 里选中的包", loadedSrc.includes("app.legacy.js") || loadedSrc.includes("app.js"), loadedSrc);

const serverLine = await ev(`document.getElementById('server-line').textContent`);
check("首页已连上电脑的服务", !/未连接|连接中/.test(serverLine), serverLine);

const projects = await ev(`document.querySelectorAll('.project').length`);
const sessions = await ev(`document.querySelectorAll('.session').length`);
check("会话列表渲染出来", projects > 0 && sessions > 0, `${projects} 个项目 / ${sessions} 个会话`);

const overflow = await ev(`document.documentElement.scrollWidth - window.innerWidth`);
check("没有横向溢出（适应手机宽度）", overflow <= 1, `超出 ${overflow}px`);

console.log("\n[D] 点进会话（安卓里的完整交互）");
await ev(`document.querySelector('.session').click(); true`);
await sleep(9000);
const chatVisible = await ev(`!document.getElementById('view-chat').classList.contains('hidden')`);
check("进入对话页", chatVisible === true);
const msgs = await ev(`document.querySelectorAll('#messages .msg').length`);
check("历史消息渲染出来", msgs > 0, `${msgs} 条`);
const tools = await ev(`document.querySelectorAll('#messages .tool').length`);
const thinking = await ev(`document.querySelectorAll('#messages .thinking').length`);
check("工具卡片 / 思考折叠渲染", tools > 0, `${tools} 张卡片 / ${thinking} 个折叠`);
const status = await ev(`document.getElementById('status-strip').innerText.replace(/\\n/g,' ')`);
check("状态条有模型信息", status.length > 5, status);

const shot = await cdp("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/pocket-android-chat.png", Buffer.from(shot.data, "base64"));

console.log("\n[E] 安卓返回键 = 回列表（agent 继续在电脑上跑）");
await ev(`history.back(); true`);
await sleep(1500);
const backHome = await ev(`!document.getElementById('view-home').classList.contains('hidden')`);
check("返回键回到会话列表", backHome === true);

const agents = await fetch("http://127.0.0.1:8787/api/agents").then((r) => r.json()).catch(() => ({ agents: [] }));
check("电脑上 agent 仍在后台运行", agents.agents.length > 0, `${agents.agents.length} 个进程`);

const shot2 = await cdp("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/pocket-android-home.png", Buffer.from(shot2.data, "base64"));

check("WebView 中无 JS 异常", exceptions.length === 0, exceptions.join(" | "));

// 清理：关掉电脑上的 agent 进程
await ev(`(async()=>{const r=await fetch('/api/agents').then(x=>x.json()); for(const a of r.agents) await fetch('/api/agents/'+encodeURIComponent(a.key)+'/close',{method:'POST'}); return true})()`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n截图: /tmp/pocket-android-home.png /tmp/pocket-android-chat.png`);
console.log(`结果: ${results.length - failed}/${results.length} 通过\n`);
ws.close();
process.exit(failed ? 1 : 0);
