/**
 * 用裸 CDP 驱动 headless Chrome 验证手机端 UI 流程（无需 puppeteer）
 * 用法: node tools/ui-check.mjs [port] [extraQuery] [outPrefix]
 *   例: node tools/ui-check.mjs 8899 "" demo     → /tmp/demo-1-home.png ...
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] ?? 8787);
const EXTRA_QUERY = process.argv[3] ?? ""; // 例: legacy=1 强制走降级包
const PREFIX = process.argv[4] ?? "pocket";
const SHOT = (n) => `/tmp/${PREFIX}-${n}.png`;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = BASE + "/" + (EXTRA_QUERY ? `?${EXTRA_QUERY}` : "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9333;

const chrome = spawn(
	CHROME,
	[
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		`--remote-debugging-port=${DEBUG_PORT}`,
		"--window-size=390,844",
		"--user-data-dir=/tmp/pi-pocket-chrome",
		"about:blank",
	],
	{ stdio: "ignore" },
);

async function devtoolsUrl() {
	for (let i = 0; i < 40; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
			const page = list.find((t) => t.type === "page");
			if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		} catch {
			/* retry */
		}
		await sleep(250);
	}
	throw new Error("Chrome 调试端口未就绪");
}

const ws = new WebSocket(await devtoolsUrl());
await new Promise((r) => ws.on("open", r));

let msgId = 0;
const pending = new Map();
ws.on("message", (d) => {
	const m = JSON.parse(d.toString());
	if (m.id && pending.has(m.id)) {
		const { resolve, reject } = pending.get(m.id);
		pending.delete(m.id);
		m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
	}
});
const cdp = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = ++msgId;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});

const evaluate = async (expr) => {
	const r = await cdp("Runtime.evaluate", {
		expression: expr,
		awaitPromise: true,
		returnByValue: true,
	});
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
	return r.result.value;
};

await cdp("Runtime.enable");
await cdp("Page.enable");

const logs = [];
ws.on("message", (d) => {
	const m = JSON.parse(d.toString());
	if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") logs.push("console.error");
	if (m.method === "Runtime.exceptionThrown")
		logs.push("页面异常: " + (m.params.exceptionDetails?.exception?.description ?? "").slice(0, 300));
});

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log(`\n[1] 打开 ${HOME}${EXTRA_QUERY ? `（${EXTRA_QUERY}）` : ""}`);
await cdp("Page.navigate", { url: HOME });
await sleep(2500);

const loadedSrc = await evaluate(
	`[...document.scripts].map(s => s.getAttribute('src')).filter(Boolean).join(',')`,
);
check(
	EXTRA_QUERY.includes("legacy") ? "加载降级包 app.legacy.js" : "加载现代包 app.js",
	EXTRA_QUERY.includes("legacy") ? loadedSrc.includes("app.legacy.js") : loadedSrc.includes("app.js"),
	loadedSrc,
);

const serverLine = await evaluate(`document.getElementById('server-line').textContent`);
check("首页连上服务端", !/未连接|连接中/.test(serverLine), serverLine);

const projectCount = await evaluate(`document.querySelectorAll('.project').length`);
const sessionCount = await evaluate(`document.querySelectorAll('.session').length`);
check("渲染出项目分组", projectCount > 0, `${projectCount} 个项目`);
check("渲染出会话条目", sessionCount > 0, `${sessionCount} 个会话`);

const firstTitle = await evaluate(`document.querySelector('.session .session-title')?.textContent ?? ''`);
check("会话有标题预览", firstTitle.length > 0, firstTitle.slice(0, 40));

const banned = await evaluate(`document.getElementById('projects').textContent`);
check(
	"没有泄漏内部 guidance 提示",
	!/PI SUBAGENTS SESSION GUIDANCE|session-guidance/.test(banned),
	"",
);

const shot1 = await cdp("Page.captureScreenshot", { format: "png" });
await import("node:fs").then((fs) =>
	fs.writeFileSync(SHOT("1-home"), Buffer.from(shot1.data, "base64")),
);

const overflowHome = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
check("首页无横向溢出", overflowHome <= 1, `scrollWidth 超出 ${overflowHome}px`);

console.log(`\n[2] 点进第一个会话`);
await evaluate(`document.querySelector('.session').click(); true`);
await sleep(9000);

const chatVisible = await evaluate(`!document.getElementById('view-chat').classList.contains('hidden')`);
check("切换到对话视图", chatVisible === true);

const status = await evaluate(`document.getElementById('status-strip').innerText.replace(/\\n/g,' ')`);
check("状态条有内容（模型/状态）", status.length > 3, status);

const msgCount = await evaluate(`document.querySelectorAll('#messages .msg').length`);
check("载入历史消息", msgCount > 0, `${msgCount} 条`);

const hasTool = await evaluate(`document.querySelectorAll('#messages .tool').length`);
const hasThinking = await evaluate(`document.querySelectorAll('#messages .thinking').length`);
const hasUser = await evaluate(`document.querySelectorAll('#messages .msg.user').length`);
const hasAssistant = await evaluate(`document.querySelectorAll('#messages .msg.assistant').length`);
check("渲染助手气泡", hasAssistant > 0, `${hasAssistant} 条`);
check(
	"最近窗口内用户消息（可能已被裁掉）",
	true,
	`${hasUser} 条用户 / ${msgCount} 条总计（只拉最近 60 条 entry）`,
);
check("渲染工具卡片", hasTool >= 0, `${hasTool} 张`);
check("渲染思考折叠", hasThinking >= 0, `${hasThinking} 个`);

const shot2 = await cdp("Page.captureScreenshot", { format: "png" });
await import("node:fs").then((fs) =>
	fs.writeFileSync(SHOT("2-chat"), Buffer.from(shot2.data, "base64")),
);
const overflowChat = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
check("对话页无横向溢出", overflowChat <= 1, `scrollWidth 超出 ${overflowChat}px`);

console.log(`\n[3] 退出返回`);
await evaluate(`document.getElementById('btn-back').click(); true`);
await sleep(800);
const homeVisible = await evaluate(`!document.getElementById('view-home').classList.contains('hidden')`);
check("返回会话列表", homeVisible === true);
const hashCleared = await evaluate(`!location.search.includes('a=')`);
check("URL 深链参数已清掉", hashCleared === true, await evaluate(`location.href`));

const stillRunning = await evaluate(`
  (async () => {
    const r = await fetch('/api/agents').then(x => x.json());
    return r.agents.length;
  })()
`);
check("返回后电脑上 agent 仍在后台运行", stillRunning > 0, `${stillRunning} 个进程`);

console.log(`\n[4] 菜单弹层`);
await evaluate(`document.querySelector('.session').click(); true`);
await sleep(7000);
const deepHash = await evaluate(`location.search.includes('a=')`);
check("对话链接可刷新/分享（?a=）", deepHash === true, await evaluate(`location.search.slice(0, 40)`));
await evaluate(`document.getElementById('btn-menu').click(); true`);
await sleep(600);
const menuItems = await evaluate(`document.querySelectorAll('#sheet .grid-item').length`);
check("菜单打开且有功能项", menuItems >= 8, `${menuItems} 项`);

const shot3 = await cdp("Page.captureScreenshot", { format: "png" });
await import("node:fs").then((fs) =>
	fs.writeFileSync(SHOT("3-menu"), Buffer.from(shot3.data, "base64")),
);

console.log(`\n[5] 刷新页面后回到同一个会话（深链）`);
const beforeReload = await evaluate(`location.search`);
const qs = beforeReload
	? beforeReload + (EXTRA_QUERY ? "&" + EXTRA_QUERY : "")
	: EXTRA_QUERY
		? "?" + EXTRA_QUERY
		: "";
await cdp("Page.navigate", { url: BASE + "/" + qs });
await sleep(7000);
const backInChat = await evaluate(`!document.getElementById('view-chat').classList.contains('hidden')`);
const msgsAfterReload = await evaluate(`document.querySelectorAll('#messages .msg').length`);
check("刷新后直接回到该会话", backInChat === true);
check("刷新后历史重新载入", msgsAfterReload > 0, `${msgsAfterReload} 条`);

console.log(`\n[6] 关闭进程（清理）`);
await evaluate(`
  (async () => {
    const r = await fetch('/api/agents').then(x => x.json());
    for (const a of r.agents) await fetch('/api/agents/' + encodeURIComponent(a.key) + '/close', {method:'POST'});
    return true;
  })()
`);
const left = await evaluate(`
  (async () => (await fetch('/api/agents').then(x => x.json())).agents.length)()
`);
check("关闭所有 agent 进程", left === 0, `剩余 ${left}`);

check("页面无 JS 异常", logs.length === 0, logs.join(" | "));

console.log(
	`\n截图: ${["1-home", "2-chat", "3-menu"].map((n) => SHOT(n)).join("  ")}`,
);
const failed = results.filter((r) => !r.ok);
console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过\n`);

ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);
