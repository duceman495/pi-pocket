/* Pi Pocket 前端：会话列表 → 进入对话 → 返回/退出 */
/* ------------------------------------------------------------------ 工具 */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
};

const esc = (s) =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/** 极简 markdown → HTML（手机端够用，全部先做转义） */
function md(text) {
	if (!text) return "";
	const blocks = [];
	let src = String(text).replace(/\r\n/g, "\n");

	// 代码块
	src = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
		blocks.push(`<pre><code data-lang="${esc(lang.trim())}">${esc(code.replace(/\n$/, ""))}</code></pre>`);
		return `\u0000B${blocks.length - 1}\u0000`;
	});

	src = esc(src);

	// 行内代码
	src = src.replace(/`([^`\n]+)`/g, "<code>$1</code>");
	// 粗体 / 斜体
	src = src.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
	src = src.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	// 链接
	src = src.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

	// 块级
	const out = [];
	let list = null;
	const flushList = () => {
		if (list) {
			out.push(`<${list.type}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.type}>`);
			list = null;
		}
	};
	for (const rawLine of src.split("\n")) {
		const line = rawLine.replace(/\s+$/, "");
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		const ul = line.match(/^\s*[-*+]\s+(.*)$/);
		const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
		if (/^\u0000B\d+\u0000$/.test(line.trim())) {
			flushList();
			out.push(line.trim().replace(/\u0000B(\d+)\u0000/, (_m, i) => blocks[Number(i)]));
			continue;
		}
		if (heading) {
			flushList();
			const lvl = Math.min(3, heading[1].length + 2);
			out.push(`<h${lvl}>${heading[2]}</h${lvl}>`);
			continue;
		}
		if (ul) {
			if (!list || list.type !== "ul") {
				flushList();
				list = { type: "ul", items: [] };
			}
			list.items.push(ul[1]);
			continue;
		}
		if (ol) {
			if (!list || list.type !== "ol") {
				flushList();
				list = { type: "ol", items: [] };
			}
			list.items.push(ol[1]);
			continue;
		}
		flushList();
		if (!line.trim()) continue;
		out.push(`<p>${line.replace(/\n/g, "<br>")}</p>`);
	}
	flushList();
	return out.join("");
}

function fmtTime(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	const now = Date.now();
	const diff = (now - d.getTime()) / 1000;
	if (diff < 60) return "刚刚";
	if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
	if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
	if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
	return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
		d.getMinutes(),
	).padStart(2, "0")}`;
}

function fmtNum(n) {
	if (n == null) return "—";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
	return (n / 1_000_000).toFixed(2) + "M";
}

let toastTimer = null;
function toast(msg, ms = 2200) {
	const t = $("toast");
	t.textContent = msg;
	t.classList.remove("hidden");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

function openSheet(title, buildBody) {
	$("sheet-title").textContent = title;
	const body = $("sheet-body");
	body.replaceChildren();
	buildBody(body);
	$("sheet").classList.remove("hidden");
}
function closeSheet() {
	$("sheet").classList.add("hidden");
}

function confirmDialog(title, message, okLabel = "确定") {
	return new Promise((resolve) => {
		$("confirm-title").textContent = title;
		const body = $("confirm-body");
		body.replaceChildren(el("p", null, message));
		const ok = $("confirm-ok");
		ok.textContent = okLabel;
		const close = (v) => {
			$("confirm").classList.add("hidden");
			ok.removeEventListener("click", onOk);
			$("confirm-cancel").removeEventListener("click", onCancel);
			resolve(v);
		};
		const onOk = () => close(true);
		const onCancel = () => close(false);
		ok.addEventListener("click", onOk);
		$("confirm-cancel").addEventListener("click", onCancel);
		$("confirm").classList.remove("hidden");
	});
}

/* ------------------------------------------------------------------ 状态 */

const params = new URLSearchParams(location.search);
const TOKEN = params.get("token") ?? localStorage.getItem("pi-pocket-token") ?? "";
if (params.get("token")) localStorage.setItem("pi-pocket-token", params.get("token"));

/** 拼一个保留 token 的 URL（?a= 指向已打开的 agent，便于刷新/分享） */
function chatUrl(agentKey) {
	const p = new URLSearchParams();
	if (TOKEN) p.set("token", TOKEN);
	if (agentKey) p.set("a", agentKey);
	const q = p.toString();
	return location.pathname + (q ? `?${q}` : "");
}

/** 深链目标（首屏带着 ?a= 打开时用） */
const bootKey = params.get("a");

/** 是否运行在 Android App 里（App 会注入 PiPocketNative） */
const IN_APP = typeof window.PiPocketNative !== "undefined";

const app = {
	health: null,
	catalog: { projects: [], sessions: [] },
	running: new Map(), // key -> agent snapshot
	chat: null, // { key, ws, info, entries, nodes, streaming }
	stick: true,
	search: "",
	entering: false,
};

async function api(path, opts = {}) {
	const res = await fetch(path, {
		...opts,
		headers: {
			"content-type": "application/json",
			...(TOKEN ? { "x-pi-pocket-token": TOKEN } : {}),
			...(opts.headers ?? {}),
		},
	});
	const text = await res.text();
	let data = {};
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text };
	}
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

/* --------------------------------------------------------------- 首页渲染 */

function sessionTitle(s) {
	if (s.name) return s.name;
	const p = s.preview?.trim();
	if (!p) return "(空会话)";
	return p.length > 60 ? p.slice(0, 60) + "…" : p;
}

/** 终端里那个 pi（有桥接时）→ 首页顶部一张"接着聊"卡片 */
function bridgeBanner() {
	const b = app.health?.bridge;
	if (!b?.available) return null;
	// 已经有会话在跟它连线就不重复给了
	const alreadyOpen = [...app.running.values()].some((a) => a.mode === "bridge");
	if (alreadyOpen) return null;

	const box = el("div", "bridge-card");
	const head = el("div", "bridge-head");
	head.append(el("span", "badge live", "终端 pi 正在运行"), el("span", "dim", `pid ${b.pid ?? "?"}`));
	box.append(head);
	box.append(el("div", "bridge-cwd", prettyCwd(b.cwd) || b.cwd || "—"));
	box.append(
		el("div", "bridge-hint", "接上去继续聊——和终端是同一个 agent，两边显示实时一致"),
	);
	box.addEventListener("click", () => enterTerminalSession());
	return box;
}

/** 接入终端里正在跑的那个 pi */
async function enterTerminalSession() {
	const b = app.health?.bridge;
	if (!b?.available) return toast("终端里没有可接入的 pi");
	const box = $("messages");
	box.replaceChildren(el("div", "msg note", "正在接入终端的 pi…"));
	showView("chat");
	app.chat = {
		key: null,
		label: "终端会话",
		cwd: b.cwd,
		info: { status: "starting", state: {}, cwd: b.cwd, mode: "bridge" },
		nodes: new Map(),
		pending: new Map(),
		callCards: new Map(),
		toolResults: new Map(),
	};
	history.pushState({ view: "chat" }, "", chatUrl(null));
	try {
		const { agent } = await api("/api/agents/open", {
			method: "POST",
			body: JSON.stringify({ sessionPath: b.sessionFile, cwd: b.cwd }),
		});
		app.chat.key = agent.key;
		app.chat.info = { ...agent, label: agent.state?.sessionName || "终端会话" };
		app.chat.label = app.chat.info.label;
		history.replaceState({ view: "chat" }, "", chatUrl(agent.key));
		await attachToBridge(agent.key);
		loadRunning();
	} catch (err) {
		box.replaceChildren(el("div", "msg err", `接入失败：${err.message}`));
	}
}

function renderHome() {
	const wrap = $("projects");
	wrap.replaceChildren();
	const q = app.search.trim().toLowerCase();

	const card = bridgeBanner();
	if (card) wrap.append(card);

	let total = 0;
	for (const project of app.catalog.projects) {
		const sessions = project.sessions.filter((s) => {
			if (!q) return true;
			return (
				(s.name ?? "").toLowerCase().includes(q) ||
				(s.preview ?? "").toLowerCase().includes(q) ||
				(s.projectLabel ?? "").toLowerCase().includes(q) ||
				(s.id ?? "").toLowerCase().includes(q)
			);
		});
		if (!sessions.length) continue;
		total += sessions.length;

		const box = el("div", "project");
		const head = el("div", "project-head");
		head.append(
			el("div", "project-name", project.name),
			el("div", "project-path", project.label),
			el("div", "project-count", String(sessions.length)),
		);
		box.append(head);

		for (const s of sessions) {
			const runningInfo = app.running.get(s.path);
			const node = el("div", "session" + (runningInfo ? " running" : ""));
			const main = el("div", "session-main");
			const title = el("div", "session-title", sessionTitle(s));
			const prev = el("div", "session-preview", s.preview || "（没有消息预览）");
			const meta = el("div", "session-meta");
			meta.append(el("span", null, fmtTime(s.modified)));
			meta.append(el("span", null, `${s.messageCount} 条`));
			if (s.name) meta.append(el("span", "badge", "已命名"));
			if (runningInfo) {
				meta.append(
					el("span", "badge live", runningInfo.status === "streaming" ? "运行中" : "已打开"),
				);
			}
			main.append(title, prev, meta);
			const actions = el("div", "session-go");
			const copyBtn = el("span", "ghost-btn", "⧉");
			copyBtn.title = "副本方式打开（不碰原会话文件）";
			copyBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				enterSession({ ...s, copy: true });
			});
			actions.append(copyBtn, el("span", null, "›"));
			node.append(main, actions);
			node.addEventListener("click", () => enterSession(s));
			box.append(node);
		}
		wrap.append(box);
	}

	$("home-empty").classList.toggle("hidden", total > 0);
}

async function loadCatalog() {
	try {
		const health = await api("/api/health");
		app.health = health;
		app.catalog = await api("/api/catalog");
		// 只显示当前连接的地址，不要把电脑上所有网卡 IP 都列出来（截图/共享时容易泄露网络信息）
		$("server-line").textContent = `${location.host}${health.auth ? " · 已加密钥" : ""}${
			health.bridge?.available ? " · 终端可接入" : ""
		}`;
		$("banner").classList.add("hidden");
		renderHome();
	} catch (err) {
		$("banner").classList.remove("hidden");
		$("banner").textContent = `连接失败：${err.message}。请确认手机与电脑在同一 Wi-Fi，且电脑端 Pi Pocket 正在运行。`;
		$("server-line").textContent = "未连接";
	}
}

async function loadRunning() {
	try {
		const { agents } = await api("/api/agents");
		app.running = new Map(agents.map((a) => [a.key, a]));
		renderHome();
	} catch {
		/* ignore */
	}
}

/* --------------------------------------------------------------- 对话视图 */

function showView(name) {
	$("view-home").classList.toggle("hidden", name !== "home");
	$("view-chat").classList.toggle("hidden", name !== "chat");
}

function entryToNode(entry) {
	const msg = entry.message;
	if (!msg) {
		if (entry.type === "compaction") {
			return el("div", "msg note", `▣ 上下文已压缩：${String(entry.summary ?? "").slice(0, 160)}`);
		}
		if (entry.type === "branch_summary") {
			return el("div", "msg note", `⑂ 分支摘要：${String(entry.summary ?? "").slice(0, 160)}`);
		}
		if (entry.type === "session_info") return el("div", "msg note", `✎ 会话重命名为「${entry.name}」`);
		return null;
	}

	if (msg.role === "user") {
		const node = el("div", "msg user");
		const text = typeof msg.content === "string"
			? msg.content
			: (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		const body = el("div", "md");
		body.innerHTML = md(text);
		node.append(body);
		const imgs = (Array.isArray(msg.content) ? msg.content : []).filter((c) => c.type === "image");
		if (imgs.length) {
			const box = el("div", "msg-images");
			for (const img of imgs) {
				const i = el("img");
				i.src = `data:${img.mimeType};base64,${img.data}`;
				box.append(i);
			}
			node.append(box);
		}
		return node;
	}

	if (msg.role === "assistant") {
		const node = el("div", "msg assistant");
		renderAssistantContent(node, msg.content);
		return node;
	}

	if (msg.role === "toolResult") {
		// 历史里工具结果单独成条：能配上前面那张卡片就贴上去
		const card = app.chat?.callCards?.get(msg.toolCallId);
		if (card) {
			setToolResult(card, msg);
			return null;
		}
		return toolCardFromResult(msg);
	}
	if (msg.role === "bashExecution") {
		const node = el("div", "msg assistant");
		node.append(toolCard({ name: "bash", args: { command: msg.command } }, {
			text: msg.output ?? "",
			isError: msg.exitCode !== 0,
		}));
		return node;
	}

	if (msg.role === "custom" || entry.type === "custom_message") {
		if (msg.display === false || entry.display === false) return null;
		const customType = msg.customType ?? entry.customType ?? "";
		// 内部注入的提示（如扩展的 session guidance）不往手机上搬
		if (/guidance|system|prompt/i.test(customType)) return null;
		const text =
			typeof msg.content === "string"
				? msg.content
				: (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		return text.trim() ? el("div", "msg note", text) : null;
	}

	return null;
}

function renderAssistantContent(node, content) {
	const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
	for (const block of blocks) {
		if (block.type === "thinking") {
			const d = el("details", "thinking");
			d.append(el("summary", null, "💭 思考过程"));
			d.append(el("div", null, block.thinking));
			node.append(d);
		} else if (block.type === "text") {
			const body = el("div", "md");
			body.innerHTML = md(block.text);
			node.append(body);
		} else if (block.type === "image") {
			const img = el("img");
			img.src = `data:${block.mimeType};base64,${block.data}`;
			img.style.maxWidth = "160px";
			node.append(img);
		} else if (block.type === "toolCall") {
			const card = toolCard(block);
			if (block.id) {
				card.dataset.callId = block.id;
				registerCallCard(block.id, card);
			}
			node.append(card);
		}
	}
	return node;
}

/** 记住 callId -> 卡片，后续 toolResult / tool_execution_* 事件能贴回来 */
function registerCallCard(callId, card) {
	if (!app.chat) return;
	if (app.chat.callCards == null) app.chat.callCards = new Map();
	app.chat.callCards.set(callId, card);
}

function toolSummary(name, args = {}) {
	const a = args ?? {};
	const pick = a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.session_id;
	return pick ? String(pick) : JSON.stringify(a).slice(0, 120);
}

function toolCard(call, result) {
	const node = el("div", "tool");
	const head = el("div", "tool-head");
	const icon = el("span", "spin", result ? "●" : "◐");
	head.append(icon, el("span", "tool-name", call.name ?? "tool"), el("span", "tool-args", toolSummary(call.name, call.arguments)));
	node.append(head);
	const out = el("pre", "tool-out" + (result?.isError ? " tool-err" : ""));
	out.style.display = "none";
	node.append(out);
	node._call = call;
	node._out = out;
	head.addEventListener("click", () => {
		out.style.display = out.style.display === "none" ? "block" : "none";
	});
	if (result) setToolResult(node, result);
	return node;
}

function toolResultText(result) {
	if (!result) return "";
	const content = result.content ?? [];
	if (typeof content === "string") return content;
	return content
		.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[图片]" : ""))
		.filter(Boolean)
		.join("\n");
}

function setToolResult(node, result) {
	const text = toolResultText(result);
	const out = node._out;
	out.textContent = text.slice(0, 8000) + (text.length > 8000 ? "\n…（已截断）" : "");
	out.classList.toggle("tool-err", Boolean(result?.isError));
	out.style.display = text ? "block" : "none";
	const icon = node.querySelector(".spin");
	if (icon) {
		icon.classList.remove("spin");
		icon.textContent = result?.isError ? "✕" : "✓";
	}
}

function toolCardFromResult(msg) {
	const node = el("div", "tool");
	const head = el("div", "tool-head");
	head.append(
		el("span", null, msg.isError ? "✕" : "✓"),
		el("span", "tool-name", msg.toolName ?? "tool"),
		el("span", "tool-args", "(结果)"),
	);
	const out = el("pre", "tool-out" + (msg.isError ? " tool-err" : ""), toolResultText(msg).slice(0, 8000));
	node.append(head, out);
	head.addEventListener("click", () => {
		out.style.display = out.style.display === "none" ? "block" : "none";
	});
	return node;
}

function nearBottom(container) {
	return container.scrollHeight - container.scrollTop - container.clientHeight < 140;
}

function appendEntry(entry) {
	const box = $("messages");
	if (app.chat.nodes.has(entry.id)) return;
	const node = entryToNode(entry);
	if (!node) {
		app.chat.nodes.set(entry.id, null);
		return;
	}
	node.dataset.entryId = entry.id;
	app.chat.nodes.set(entry.id, { node, entry });
	box.append(node);
	if (app.stick) box.scrollTop = box.scrollHeight;
}

function renderChatEntries(entries) {
	const box = $("messages");
	box.replaceChildren();
	app.chat.nodes = new Map();
	app.chat.callCards = new Map();
	app.chat.streaming = null;
	for (const e of entries) appendEntry(e);
	box.scrollTop = box.scrollHeight;
}

/** 把 /Users/xxx/foo 这类路径缩成 ~/foo，避免在手机上暴露电脑用户名 */
function prettyCwd(p) {
	if (!p) return "";
	const m = String(p).match(/^(\/(?:Users|home)\/[^/]+)(\/.*)?$/);
	return m ? "~" + (m[2] ?? "") : String(p);
}

function updateStatus() {
	const info = app.chat?.info || (app.chat && app.chat.info);
	if (!info) return;
	const strip = $("status-strip");
	strip.replaceChildren();
	const dot = el("span", "dot" + (info.status === "streaming" ? " streaming" : ""));
	const label = { streaming: "生成中", idle: "空闲", starting: "启动中", exited: "已退出", error: "错误" }[
		info.status
	] ?? info.status;
	strip.append(dot, el("span", null, label));
	if (info.state?.model) strip.append(el("span", null, `· ${info.state.model}`));
	if (info.state?.thinkingLevel) strip.append(el("span", null, `· 思考:${info.state.thinkingLevel}`));
	const ctx = info.stats?.contextUsage;
	if (ctx?.percent != null) strip.append(el("span", null, `· ctx ${Math.round(ctx.percent)}%`));
	// 桥接模式：手机连的是终端里那个 pi，两端同一个 agent，显示天然一致
	if (info.mode === "bridge") {
		strip.append(
			el("span", "badge live", info.connected ? "已连终端" : "终端断开"),
		);
	} else if (info.mode) {
		strip.append(
			el("span", null, `· ${info.mode === "new" ? "新会话" : info.mode === "copy" ? "副本" : "续接"}`),
		);
	}
	$("chat-title").textContent = info.state?.sessionName || info.label || "会话";
	$("chat-sub").textContent = prettyCwd(info.cwd);
	$("btn-stop").classList.toggle("hidden", info.status !== "streaming");
	$("btn-send").classList.toggle("hidden", info.status === "streaming");
}

/* ----------------------------------------------------------- WS 事件处理 */

function handleAgentEvent(ev) {
	const chat = app.chat;
	if (!chat) return;
	const box = $("messages");
	if (typeof ev.type === "string" && ev.type.startsWith("piapp_")) {
		if (ev.type === "piapp_status") {
			chat.info.status = ev.status;
			if (ev.error) chat.info.lastError = ev.error;
			updateStatus();
		}
		if (ev.type === "piapp_error") toast(ev.error);
		// 桥接会话：整份历史快照（终端那边推过来的）
		if (ev.type === "piapp_history") {
			const entries = (ev.entries ?? []).filter((e) => e.message);
			if (entries.length) renderChatEntries(entries);
		}
		return;
	}

	switch (ev.type) {
		case "agent_start":
			chat.info.status = "streaming";
			updateStatus();
			break;
		case "agent_settled":
			chat.info.status = "idle";
			chat.streaming = null;
			updateStatus();
			break;
		case "message_start": {
			const msg = ev.message;
			if (msg?.role === "assistant") {
				const key = `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
				const node = el("div", "msg assistant");
				node.dataset.entryId = key;
				const holder = { node, entry: { id: key, message: msg } };
				chat.nodes.set(key, holder);
				box.append(node);
				chat.streaming = { key, node, holder, text: "", thinking: "", tools: new Map() };
				if (app.stick) box.scrollTop = box.scrollHeight;
			} else if (msg?.role === "user") {
				const text = typeof msg.content === "string"
					? msg.content
					: (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
				if (text.trim()) {
					const key = `live-u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
					const node = el("div", "msg user");
					const body = el("div", "md");
					body.innerHTML = md(text);
					node.append(body);
					node.dataset.entryId = key;
					chat.nodes.set(key, { node, entry: { id: key, message: msg } });
					box.append(node);
					if (app.stick) box.scrollTop = box.scrollHeight;
				}
			}
			break;
		}
		case "message_update": {
			const d = ev.assistantMessageEvent;
			if (!d || !chat.streaming) break;
			if (d.type === "text_delta") {
				chat.streaming.text += d.delta ?? "";
				let body = chat.streaming.node.querySelector(".md:last-of-type");
				if (!body) {
					body = el("div", "md");
					chat.streaming.node.append(body);
				}
				body.innerHTML = md(chat.streaming.text);
				if (app.stick) box.scrollTop = box.scrollHeight;
			} else if (d.type === "thinking_delta") {
				chat.streaming.thinking += d.delta ?? "";
				let det = chat.streaming.node.querySelector("details.thinking");
				if (!det) {
					det = el("details", "thinking");
					det.open = true;
					det.append(el("summary", null, "💭 思考过程"));
					chat.streaming.node.prepend(det);
				}
				let inner = det.querySelector("div");
				if (!inner) {
					inner = el("div");
					det.append(inner);
				}
				inner.textContent = chat.streaming.thinking;
				if (app.stick) box.scrollTop = box.scrollHeight;
			} else if (d.type === "toolcall_start") {
				const card = toolCard({ name: d.toolName, arguments: {} });
				card.dataset.callId = d.id;
				registerCallCard(d.id, card);
				chat.streaming.node.append(card);
				if (app.stick) box.scrollTop = box.scrollHeight;
			}
			break;
		}
		case "message_end": {
			const msg = ev.message;
			if (msg?.role !== "assistant" || !chat.streaming) break;
			const target = chat.streaming.node;
			target.replaceChildren();
			renderAssistantContent(target, msg.content);
			// 已经收到的工具结果补回去（卡片被重建了）
			for (const [callId, result] of chat.toolResults ?? []) {
				const card = chat.callCards.get(callId);
				if (card) setToolResult(card, result);
			}
			chat.streaming = null;
			break;
		}
		case "tool_execution_start": {
			const card = findToolCard(ev.toolCallId);
			if (card) {
				card._call = { name: ev.toolName, arguments: ev.args };
				const argsEl = card.querySelector(".tool-args");
				if (argsEl) argsEl.textContent = toolSummary(ev.toolName, ev.args);
			}
			break;
		}
		case "tool_execution_update": {
			const card = findToolCard(ev.toolCallId);
			if (card) setToolResult(card, ev.partialResult);
			break;
		}
		case "tool_execution_end": {
			if (chat.toolResults == null) chat.toolResults = new Map();
			chat.toolResults.set(ev.toolCallId, ev.result);
			const card = findToolCard(ev.toolCallId);
			if (card) setToolResult(card, ev.result);
			break;
		}
		case "queue_update":
			chat.info.pending = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
			updateStatus();
			break;
		case "compaction_start":
			box.append(el("div", "msg note", `▣ 正在压缩上下文（${ev.reason}）…`));
			break;
		case "compaction_end":
			if (ev.result) box.append(el("div", "msg note", `▣ 上下文压缩完成（${ev.result.tokensBefore} tokens）`));
			break;
		case "auto_retry_start":
			box.append(el("div", "msg note", `↻ 自动重试 ${ev.attempt}/${ev.maxAttempts}：${ev.errorMessage ?? ""}`));
			break;
		case "extension_error":
			box.append(el("div", "msg note", `⚠ 扩展错误：${ev.error ?? ""}`));
			break;
		case "turn_end": {
			const usage = ev.message?.usage;
			if (usage) {
				chat.info.stats = { ...(chat.info.stats ?? {}), lastUsage: usage };
				updateStatus();
			}
			break;
		}
		default:
			break;
	}
}

function findToolCard(callId) {
	if (!callId) return null;
	const registered = app.chat?.callCards?.get(callId);
	if (registered) return registered;
	if (app.chat?.streaming?.tools?.has(callId)) return app.chat.streaming.tools.get(callId);
	return document.querySelector(`[data-call-id="${CSS.escape(callId)}"]`);
}

function connectWs(key) {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const url = `${proto}://${location.host}/ws?key=${encodeURIComponent(key)}${
		TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ""
	}`;
	const ws = new WebSocket(url);
	app.chat.ws = ws;
	app.chat.pending = new Map();
	app.chat.toolResults = new Map();
	app.chat.wsReady = new Promise((resolve, reject) => {
		ws.onopen = () => resolve(ws);
		ws.onerror = () => reject(new Error("WebSocket 连接失败"));
	});
	app.chat.wsReady.catch(() => {});

	ws.onmessage = (e) => {
		let msg;
		try {
			msg = JSON.parse(e.data);
		} catch {
			return;
		}
		if (msg.type === "hello") {
			app.chat.info = { ...app.chat.info, ...msg.agent, label: app.chat.label };
			updateStatus();
		} else if (msg.type === "event") {
			handleAgentEvent(msg.event);
		} else if (msg.type === "exit") {
			app.chat.info.status = "exited";
			updateStatus();
			$("messages").append(el("div", "msg note", "⚠ agent 进程已退出"));
		} else if (msg.type === "fatal") {
			toast(msg.error);
			leaveChat({ closeProcess: false });
		} else if (msg.type === "response") {
			const pending = app.chat.pending?.get(msg.id);
			if (pending) {
				app.chat.pending.delete(msg.id);
				msg.success ? pending.resolve(msg.data ?? {}) : pending.reject(new Error(msg.error ?? "命令失败"));
			} else if (msg.success === false) {
				toast(msg.error ?? "命令失败");
			}
		}
	};
	ws.onclose = () => {
		if (app.chat?.ws === ws) {
			app.chat.ws = null;
			const box = $("messages");
			box.append(el("div", "msg note", "⚠ 连接已断开，点菜单里的「同步」或重新进入可恢复"));
		}
	};
}

/** 通过 WS 发命令并等待响应 */
async function rpc(type, payload = {}, timeoutMs = 60_000) {
	const chat = app.chat;
	if (!chat) throw new Error("未进入会话");
	let ws = chat.ws;
	if (!ws || (chat.wsReady && ws.readyState === WebSocket.CONNECTING)) {
		ws = await (chat.wsReady ?? Promise.reject(new Error("未连接")));
	}
	if (ws.readyState !== WebSocket.OPEN) throw new Error("未连接");
	return new Promise((resolve, reject) => {
		const id = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
		const timer = setTimeout(() => {
			chat.pending.delete(id);
			reject(new Error(`超时: ${type}`));
		}, timeoutMs);
		chat.pending.set(id, {
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
}

/* -------------------------------------------------------------- 进入/退出 */

async function enterSession(session) {
	if (app.entering) return;
	app.entering = true;
	const box = $("messages");
	box.replaceChildren(el("div", "msg note", "正在启动 pi agent…"));
	showView("chat");
	$("chat-title").textContent = sessionTitle(session);
	$("chat-sub").textContent = session.projectLabel ?? "";
	app.chat = {
		key: null,
		label: sessionTitle(session),
		cwd: session.cwd,
		info: { status: "starting", state: {}, label: sessionTitle(session), cwd: session.cwd },
		nodes: new Map(),
		pending: new Map(),
		callCards: new Map(),
		toolResults: new Map(),
	};
	try {
		const { agent } = await api("/api/agents/open", {
			method: "POST",
			body: JSON.stringify({ sessionPath: session.path, cwd: session.cwd, copy: Boolean(session.copy) }),
		});
		app.chat.key = agent.key;
		app.chat.info = { ...agent, label: sessionTitle(session), sourcePath: session.path };
		// 把 agent key 放进 URL：刷新页面/复制链接都能回到同一个会话
		history.pushState({ view: "chat" }, "", chatUrl(agent.key));
		await attachToBridge(agent.key);
		loadRunning();
	} catch (err) {
		box.replaceChildren(el("div", "msg err", `打开失败：${err.message}`));
	} finally {
		app.entering = false;
	}
}

/** 连上某个已在运行的 agent：建 WS + 拉历史 + 拉状态 */
async function attachToBridge(key) {
	connectWs(key);
	updateStatus();
	const recent = await rpc("recent", {}, 30_000).catch(() => ({ messages: [] }));
	renderChatEntries((recent.messages ?? []).filter((m) => m.message));
	const state = await rpc("refresh_state", {}, 20_000).catch(() => null);
	if (state) {
		app.chat.info.state = state.state;
		app.chat.info.stats = state.stats;
	}
	updateStatus();
}

/** 通过 ?a=<agentKey> 回到一个已经打开的会话（刷新/分享链接） */
async function enterAgentKey(key) {
	try {
		const { agents } = await api("/api/agents");
		const info = agents.find((a) => a.key === key);
		if (!info) {
			showView("home");
			history.replaceState(null, "", chatUrl(null));
			toast("该会话已关闭");
			return;
		}
		const label = info.state?.sessionName || "会话";
		showView("chat");
		app.chat = {
			key,
			label,
			cwd: info.cwd,
			info: { ...info, label },
			nodes: new Map(),
			pending: new Map(),
			callCards: new Map(),
			toolResults: new Map(),
		};
		history.replaceState({ view: "chat" }, "", chatUrl(key));
		$("chat-title").textContent = label;
		$("chat-sub").textContent = info.cwd ?? "";
		await attachToBridge(key);
	} catch (err) {
		showView("home");
		toast(err.message);
	}
}

function leaveChat({ closeProcess = false } = {}) {
	const chat = app.chat;
	if (!chat) return;
	if (chat.ws) {
		chat.ws.onclose = null;
		chat.ws.close();
	}
	app.chat = null;
	if (closeProcess && chat.key) {
		api(`/api/agents/${encodeURIComponent(chat.key)}/close`, { method: "POST" }).catch(() => {});
	}
	if (location.search.includes("a=")) history.replaceState(null, "", chatUrl(null));
	showView("home");
	loadRunning();
}

/* --------------------------------------------------------------- 菜单功能 */

function menuSheet() {
	const isBridge = app.chat?.info?.mode === "bridge";
	openSheet(isBridge ? "会话操作（已连终端）" : "会话操作", (body) => {
		const grid = el("div", "grid");
		const items = [
			["⟳", "同步", () => syncChat()],
			["🎛", "模型", () => modelSheet()],
			["🧠", "思考", () => thinkingSheet()],
			["✎", "重命名", () => renameSheet()],
			["▣", "压缩", () => compactChat()],
			["📊", "统计", () => statsSheet()],
			["＋", "新会话", () => newSessionHere()],
			["⧉", "开副本", () => openCopy()],
			["📤", "导出", () => exportHtml()],
			["ℹ️", "信息", () => infoSheet()],
			// 桥接模式下不会杀掉终端的 pi，只是断开手机的连接
			["⏏", isBridge ? "断开连接" : "关闭进程", () => closeProcessConfirm()],
			["⚠️", "中断任务", () => abortRun()],
		];
		// 在 App 内才有的入口：改电脑地址 / 重新扫描
		if (IN_APP) {
			items.push(["🔌", "连接设置", () => window.PiPocketNative.openSettings()]);
			items.push(["↻", "重连", () => window.PiPocketNative.reconnect()]);
		}
		for (const [icon, label, fn] of items) {
			const b = el("button", "grid-item" + (label.includes("中断") ? " danger" : ""));
			b.append(el("span", null, icon), el("span", null, label));
			b.addEventListener("click", () => {
				closeSheet();
				fn();
			});
			grid.append(b);
		}
		body.append(grid);
	});
}

async function syncChat() {
	try {
		const recent = await rpc("recent", {}, 30_000);
		renderChatEntries((recent.messages ?? []).filter((m) => m.type === "message" || m.message));
		const state = await rpc("refresh_state", {}, 20_000);
		app.chat.info.state = state.state;
		app.chat.info.stats = state.stats;
		updateStatus();
		toast("已同步");
	} catch (err) {
		toast(err.message);
	}
}

async function modelSheet() {
	try {
		const { models } = await rpc("get_available_models");
		const current = app.chat.info.state?.model;
		openSheet("选择模型", (body) => {
			for (const m of models.slice(0, 60)) {
				const id = `${m.provider}/${m.id}`;
				const item = el("div", "list-item" + (id === current ? " active" : ""));
				const left = el("div");
				left.append(el("div", null, m.id));
				left.append(el("small", null, `${m.provider} · ctx ${fmtNum(m.contextWindow)}${m.reasoning ? " · 推理" : ""}`));
				item.append(left, el("span", null, id === current ? "✓" : ""));
				item.addEventListener("click", async () => {
					try {
						await rpc("set_model", { provider: m.provider, modelId: m.id });
						await rpc("refresh_state").then((s) => {
							app.chat.info.state = s.state;
							updateStatus();
						});
						closeSheet();
						toast(`已切换到 ${id}`);
					} catch (e) {
						toast(e.message);
					}
				});
				body.append(item);
			}
		});
	} catch (err) {
		toast(err.message);
	}
}

async function thinkingSheet() {
	try {
		const { levels } = await rpc("get_available_thinking_levels");
		const current = app.chat.info.state?.thinkingLevel;
		openSheet("思考等级", (body) => {
			for (const lv of levels) {
				const item = el("div", "list-item" + (lv === current ? " active" : ""));
				item.append(el("div", null, lv), el("span", null, lv === current ? "✓" : ""));
				item.addEventListener("click", async () => {
					try {
						await rpc("set_thinking_level", { level: lv });
						const s = await rpc("refresh_state");
						app.chat.info.state = s.state;
						updateStatus();
						closeSheet();
					} catch (e) {
						toast(e.message);
					}
				});
				body.append(item);
			}
		});
	} catch (err) {
		toast(err.message);
	}
}

function renameSheet() {
	openSheet("重命名会话", (body) => {
		const field = el("div", "field");
		const input = el("input");
		input.value = app.chat.info.state?.sessionName ?? "";
		input.placeholder = "给这个会话起个名字";
		field.append(input);
		const btn = el("button", "btn primary", "保存");
		btn.style.marginTop = "12px";
		btn.addEventListener("click", async () => {
			try {
				await rpc("set_session_name", { name: input.value.trim() });
				const s = await rpc("refresh_state");
				app.chat.info.state = s.state;
				app.chat.label = input.value.trim() || app.chat.label;
				updateStatus();
				closeSheet();
				toast("已保存");
				loadCatalog();
			} catch (e) {
				toast(e.message);
			}
		});
		body.append(field, btn);
	});
}

async function compactChat() {
	if (!(await confirmDialog("压缩上下文", "把较早的对话总结掉以释放上下文空间？", "压缩"))) return;
	toast("正在压缩…");
	try {
		const r = await rpc("compact", {}, 180_000);
		toast(`压缩完成：${fmtNum(r?.tokensBefore)} → ${fmtNum(r?.estimatedTokensAfter)}`);
		syncChat();
	} catch (err) {
		toast(err.message);
	}
}

async function statsSheet() {
	try {
		const s = await rpc("get_session_stats");
		openSheet("会话统计", (body) => {
			const rows = [
				["消息数", `${s.userMessages} 用户 / ${s.assistantMessages} 助手`],
				["工具调用", `${s.toolCalls}`],
				["总 tokens", fmtNum(s.tokens?.total)],
				["输入 / 输出", `${fmtNum(s.tokens?.input)} / ${fmtNum(s.tokens?.output)}`],
				["缓存读 / 写", `${fmtNum(s.tokens?.cacheRead)} / ${fmtNum(s.tokens?.cacheWrite)}`],
				["花费", s.cost != null ? `$${Number(s.cost).toFixed(4)}` : "—"],
				["上下文占用", s.contextUsage?.percent != null ? `${Math.round(s.contextUsage.percent)}%（${fmtNum(s.contextUsage.tokens)}）` : "—"],
				["上下文窗口", s.contextUsage?.contextWindow ? fmtNum(s.contextUsage.contextWindow) : "—"],
				["会话文件", s.sessionFile ?? "—"],
				["会话 ID", s.sessionId ?? "—"],
			];
			for (const [k, v] of rows) {
				const row = el("div", "kv");
				row.append(el("span", "k", k), el("span", "v", String(v)));
				body.append(row);
			}
		});
	} catch (err) {
		toast(err.message);
	}
}

async function exportHtml() {
	try {
		const r = await rpc("export_html", {}, 60_000);
		openSheet("导出完成", (body) => {
			body.append(el("p", null, "HTML 已生成在电脑上："));
			const p = el("div", "kv");
			p.append(el("span", "v", r.path ?? ""));
			body.append(p);
		});
	} catch (err) {
		toast(err.message);
	}
}

function infoSheet() {
	openSheet("连接信息", (body) => {
		const info = app.chat.info;
		const rows = [
			["工作目录", prettyCwd(info.cwd) || "—"],
			["会话文件", info.sessionPath ?? "—"],
			[
				"来源会话",
				info.sourcePath && info.sourcePath !== info.sessionPath ? info.sourcePath : "（同一个文件）",
			],
			["会话 ID", info.sessionId ?? "—"],
			[
				"进入方式",
				{ bridge: "连到终端的 pi", resume: "续接原会话", copy: "副本会话", new: "全新会话" }[info.mode] ??
					info.mode,
			],
			...(info.mode === "bridge"
				? [["终端 pi 进程", info.pid ? `pid ${info.pid}` : "—"]]
				: []),
			["运行状态", info.status],
			["最后错误", info.lastError ?? "—"],
			["手机地址", location.host],
			["服务端 CLI", app.health?.runtime?.cli ?? "—"],
		];
		for (const [k, v] of rows) {
			const row = el("div", "kv");
			row.append(el("span", "k", k), el("span", "v", String(v)));
			body.append(row);
		}
	});
}

async function newSessionHere() {
	if (!(await confirmDialog("新建会话", `在 ${app.chat.cwd} 新建一个会话，并关闭当前会话进程？`, "新建"))) return;
	await openNew({ cwd: app.chat.cwd, forceNewName: true });
}

function swapToAgentPlaceholder() {}

/** 把当前对话切到另一个 agent 进程上 */
async function swapToAgent({ body, label, note }) {
	const oldKey = app.chat?.key;
	const { agent } = await api("/api/agents/open", { method: "POST", body: JSON.stringify(body) });
	if (oldKey && oldKey !== agent.key) {
		api(`/api/agents/${encodeURIComponent(oldKey)}/close`, { method: "POST" }).catch(() => {});
	}
	const chat = app.chat;
	if (chat.ws) {
		chat.ws.onclose = null;
		chat.ws.close();
	}
	app.chat = {
		key: agent.key,
		label,
		cwd: agent.cwd,
		info: { ...agent, label },
		nodes: new Map(),
		pending: new Map(),
		callCards: new Map(),
		toolResults: new Map(),
	};
	history.replaceState({ view: "chat" }, "", chatUrl(agent.key));
	$("chat-title").textContent = label;
	$("chat-sub").textContent = agent.cwd ?? "";
	$("messages").replaceChildren(el("div", "msg note", note));
	await attachToBridge(agent.key);
	loadRunning();
	return agent;
}

/** 用当前会话的副本（fork 到新文件）继续，不碰原会话 */
async function openCopy() {
	const info = app.chat?.info;
	const source = info?.sourcePath ?? info?.sessionPath;
	if (!source) return toast("当前会话还没有文件");
	if (
		!(await confirmDialog(
			"另开副本",
			"把当前会话复制成一个新会话后继续（原会话文件不会被改动），适合原会话还开在电脑终端里。",
			"开副本",
		))
	)
		return;
	try {
		const box = $("messages");
		box.replaceChildren(el("div", "msg note", "正在创建副本…"));
		const agent = await swapToAgent({
			body: { sessionPath: source, cwd: info.cwd, copy: true },
			label: (app.chat?.label ?? "会话") + "（副本）",
			note: "已创建副本，历史已带过来",
		});
		toast(`副本会话：${agent.sessionPath ?? ""}`.slice(0, 60));
	} catch (err) {
		$("messages").replaceChildren(el("div", "msg err", `创建副本失败：${err.message}`));
	}
}

async function openNew({ cwd, forceNewName = false }) {
	try {
		$("messages").replaceChildren(el("div", "msg note", "正在新建会话…"));
		const agent = await swapToAgent({
			body: { cwd, forceNew: true },
			label: "新会话",
			note: `已在 ${cwd} 新建会话`,
		});
		if (forceNewName) toast("已新建会话");
		return agent;
	} catch (err) {
		$("messages").replaceChildren(el("div", "msg err", `新建失败：${err.message}`));
	}
}

async function closeProcessConfirm() {
	const isBridge = app.chat?.info?.mode === "bridge";
	const ok = isBridge
		? await confirmDialog(
				"断开与终端的连接",
				"只是手机不再连这个会话；终端里的 pi 和你的任务都不受影响。",
				"断开",
		  )
		: await confirmDialog("关闭 agent 进程", "释放电脑上的这个 pi 进程（会话文件保留）。", "关闭");
	if (!ok) return;
	const key = app.chat.key;
	api(`/api/agents/${encodeURIComponent(key)}/close`, { method: "POST" }).catch(() => {});
	toast(isBridge ? "已断开，终端 pi 继续运行" : "已关闭，会话文件已保留");
	history.back();
}

async function abortRun() {
	try {
		await rpc("abort", {}, 30_000);
		toast("已请求中断");
	} catch (err) {
		toast(err.message);
	}
}

/* ------------------------------------------------------------ 首页交互 */

function newSessionDialog(prefillCwd) {
	openSheet("新建会话", (body) => {
		const wrap = el("div", "field");
		const label = el("div", "k", "工作目录（电脑上的绝对路径）");
		const input = el("input");
		input.value = prefillCwd || localStorage.getItem("pi-pocket-last-cwd") || "";
		input.placeholder = "/Users/you/project";
		wrap.append(label, input);
		const shortcut = el("div", "list-item");
		shortcut.append(el("div", null, `使用当前会话目录（${app.catalog.sessions[0]?.projectLabel ?? "无"}）`));
		shortcut.addEventListener("click", () => {
			if (app.catalog.sessions[0]) input.value = app.catalog.sessions[0].cwd;
		});
		const btn = el("button", "btn primary", "创建并进入");
		btn.style.marginTop = "12px";
		btn.addEventListener("click", async () => {
			const cwd = input.value.trim();
			if (!cwd) return toast("请填写目录");
			localStorage.setItem("pi-pocket-last-cwd", cwd);
			closeSheet();
			showView("chat");
			app.chat = {
				key: null,
				label: "新会话",
				cwd,
				info: { status: "starting", state: {}, cwd },
				nodes: new Map(),
				pending: new Map(),
				callCards: new Map(),
				toolResults: new Map(),
			};
			history.pushState({ view: "chat" }, "", chatUrl(null));
			$("chat-title").textContent = "新会话";
			$("chat-sub").textContent = cwd;
			await openNew({ cwd, forceNewName: true });
		});
		body.append(wrap, shortcut, btn);
	});
}

function bindHome() {
	$("btn-refresh").addEventListener("click", async () => {
		await loadCatalog();
		await loadRunning();
		toast("已刷新");
	});
	$("search").addEventListener("input", (e) => {
		app.search = e.target.value;
		renderHome();
	});
	$("btn-new-here").addEventListener("click", () => {
		newSessionDialog(app.catalog.sessions[0]?.cwd ?? "");
	});
	$("btn-new-dir").addEventListener("click", () => newSessionDialog());
}

/* ------------------------------------------------------------ 对话交互 */

function bindChat() {
	$("btn-back").addEventListener("click", () => history.back());
	$("btn-menu").addEventListener("click", menuSheet);
	$("sheet-close").addEventListener("click", closeSheet);
	$("sheet").addEventListener("click", (e) => {
		if (e.target.id === "sheet") closeSheet();
	});
	$("confirm").addEventListener("click", (e) => {
		if (e.target.id === "confirm") $("confirm").classList.add("hidden");
	});

	const input = $("input");
	const autosize = () => {
		input.style.height = "auto";
		input.style.height = Math.min(140, input.scrollHeight) + "px";
	};
	input.addEventListener("input", autosize);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			sendMessage();
		}
	});
	$("btn-send").addEventListener("click", sendMessage);
	$("btn-stop").addEventListener("click", abortRun);

	const box = $("messages");
	box.addEventListener("scroll", () => {
		app.stick = nearBottom(box);
		if (app.stick) {
			// 恢复跟随
		}
	});
}

async function sendMessage() {
	const input = $("input");
	const text = input.value.trim();
	if (!text || !app.chat) return;
	input.value = "";
	input.style.height = "auto";
	const busy = app.chat.info.status === "streaming";
	try {
		if (busy) {
			if (!(await confirmDialog("agent 正在生成", "要插话（steer）打断当前思路吗？", "插话"))) {
				input.value = text;
				return;
			}
				await rpc("steer", { message: text }, 30_000);
			toast("已插入指令");
		} else {
			await rpc("prompt", { message: text }, 30_000);
			app.chat.info.status = "streaming";
			updateStatus();
		}
		app.stick = true;
		const box = $("messages");
		box.scrollTop = box.scrollHeight;
	} catch (err) {
		input.value = text;
		toast(err.message);
	}
}

/* ------------------------------------------------------------ 启动/导航 */

window.addEventListener("popstate", () => {
	if (app.chat) leaveChat({ closeProcess: false });
	else showView("home");
});

window.addEventListener("beforeunload", () => {
	if (app.chat?.ws) app.chat.ws.close();
});

bindHome();
bindChat();
showView("home");

loadCatalog()
	.then(loadRunning)
	.then(() => {
		if (bootKey) enterAgentKey(bootKey);
	});
setInterval(() => {
	if (!app.chat) loadRunning();
}, 15_000);
