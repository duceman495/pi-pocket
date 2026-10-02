/* 自动生成，请勿手改：由 public/app.js 经 esbuild --target=chrome69 降级而来，供旧版 Android WebView 使用。改代码请改 app.js 后执行 npm run build:legacy */
var _a, _b;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => String(s != null ? s : "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function md(text) {
  if (!text) return "";
  const blocks = [];
  let src = String(text).replace(/\r\n/g, "\n");
  src = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre><code data-lang="${esc(lang.trim())}">${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\0B${blocks.length - 1}\0`;
  });
  src = esc(src);
  src = src.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  src = src.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  src = src.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  src = src.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
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
  const diff = (now - d.getTime()) / 1e3;
  if (diff < 60) return "\u521A\u521A";
  if (diff < 3600) return `${Math.floor(diff / 60)} \u5206\u949F\u524D`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} \u5C0F\u65F6\u524D`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} \u5929\u524D`;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}
function fmtNum(n) {
  if (n == null) return "\u2014";
  if (n < 1e3) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(1) + "k";
  return (n / 1e6).toFixed(2) + "M";
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
function confirmDialog(title, message, okLabel = "\u786E\u5B9A") {
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
const params = new URLSearchParams(location.search);
const TOKEN = (_b = (_a = params.get("token")) != null ? _a : localStorage.getItem("pi-pocket-token")) != null ? _b : "";
if (params.get("token")) localStorage.setItem("pi-pocket-token", params.get("token"));
function chatUrl(agentKey) {
  const p = new URLSearchParams();
  if (TOKEN) p.set("token", TOKEN);
  if (agentKey) p.set("a", agentKey);
  const q = p.toString();
  return location.pathname + (q ? `?${q}` : "");
}
const bootKey = params.get("a");
const IN_APP = typeof window.PiPocketNative !== "undefined";
const app = {
  health: null,
  catalog: { projects: [], sessions: [] },
  running: /* @__PURE__ */ new Map(),
  // key -> agent snapshot
  chat: null,
  // { key, ws, info, entries, nodes, streaming }
  stick: true,
  search: "",
  entering: false
};
async function api(path, opts = {}) {
  var _a2, _b2;
  const res = await fetch(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...TOKEN ? { "x-pi-pocket-token": TOKEN } : {},
      ...(_a2 = opts.headers) != null ? _a2 : {}
    }
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error((_b2 = data.error) != null ? _b2 : `HTTP ${res.status}`);
  return data;
}
function sessionTitle(s) {
  var _a2;
  if (s.name) return s.name;
  const p = (_a2 = s.preview) == null ? void 0 : _a2.trim();
  if (!p) return "(\u7A7A\u4F1A\u8BDD)";
  return p.length > 60 ? p.slice(0, 60) + "\u2026" : p;
}
function bridgeBanner() {
  var _a2, _b2;
  const b = (_a2 = app.health) == null ? void 0 : _a2.bridge;
  if (!(b == null ? void 0 : b.available)) return null;
  const alreadyOpen = [...app.running.values()].some((a) => a.mode === "bridge");
  if (alreadyOpen) return null;
  const box = el("div", "bridge-card");
  const head = el("div", "bridge-head");
  head.append(el("span", "badge live", "\u7EC8\u7AEF pi \u6B63\u5728\u8FD0\u884C"), el("span", "dim", `pid ${(_b2 = b.pid) != null ? _b2 : "?"}`));
  box.append(head);
  box.append(el("div", "bridge-cwd", prettyCwd(b.cwd) || b.cwd || "\u2014"));
  box.append(
    el("div", "bridge-hint", "\u63A5\u4E0A\u53BB\u7EE7\u7EED\u804A\u2014\u2014\u548C\u7EC8\u7AEF\u662F\u540C\u4E00\u4E2A agent\uFF0C\u4E24\u8FB9\u663E\u793A\u5B9E\u65F6\u4E00\u81F4")
  );
  box.addEventListener("click", () => enterTerminalSession());
  return box;
}
async function enterTerminalSession() {
  var _a2, _b2;
  const b = (_a2 = app.health) == null ? void 0 : _a2.bridge;
  if (!(b == null ? void 0 : b.available)) return toast("\u7EC8\u7AEF\u91CC\u6CA1\u6709\u53EF\u63A5\u5165\u7684 pi");
  const box = $("messages");
  box.replaceChildren(el("div", "msg note", "\u6B63\u5728\u63A5\u5165\u7EC8\u7AEF\u7684 pi\u2026"));
  showView("chat");
  app.chat = {
    key: null,
    label: "\u7EC8\u7AEF\u4F1A\u8BDD",
    cwd: b.cwd,
    info: { status: "starting", state: {}, cwd: b.cwd, mode: "bridge" },
    nodes: /* @__PURE__ */ new Map(),
    pending: /* @__PURE__ */ new Map(),
    callCards: /* @__PURE__ */ new Map(),
    toolResults: /* @__PURE__ */ new Map()
  };
  history.pushState({ view: "chat" }, "", chatUrl(null));
  try {
    const { agent } = await api("/api/agents/open", {
      method: "POST",
      body: JSON.stringify({ sessionPath: b.sessionFile, cwd: b.cwd })
    });
    app.chat.key = agent.key;
    app.chat.info = { ...agent, label: ((_b2 = agent.state) == null ? void 0 : _b2.sessionName) || "\u7EC8\u7AEF\u4F1A\u8BDD" };
    app.chat.label = app.chat.info.label;
    history.replaceState({ view: "chat" }, "", chatUrl(agent.key));
    await attachToBridge(agent.key);
    loadRunning();
  } catch (err) {
    box.replaceChildren(el("div", "msg err", `\u63A5\u5165\u5931\u8D25\uFF1A${err.message}`));
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
      var _a2, _b2, _c, _d;
      if (!q) return true;
      return ((_a2 = s.name) != null ? _a2 : "").toLowerCase().includes(q) || ((_b2 = s.preview) != null ? _b2 : "").toLowerCase().includes(q) || ((_c = s.projectLabel) != null ? _c : "").toLowerCase().includes(q) || ((_d = s.id) != null ? _d : "").toLowerCase().includes(q);
    });
    if (!sessions.length) continue;
    total += sessions.length;
    const box = el("div", "project");
    const head = el("div", "project-head");
    head.append(
      el("div", "project-name", project.name),
      el("div", "project-path", project.label),
      el("div", "project-count", String(sessions.length))
    );
    box.append(head);
    for (const s of sessions) {
      const runningInfo = app.running.get(s.path);
      const node = el("div", "session" + (runningInfo ? " running" : ""));
      const main = el("div", "session-main");
      const title = el("div", "session-title", sessionTitle(s));
      const prev = el("div", "session-preview", s.preview || "\uFF08\u6CA1\u6709\u6D88\u606F\u9884\u89C8\uFF09");
      const meta = el("div", "session-meta");
      meta.append(el("span", null, fmtTime(s.modified)));
      meta.append(el("span", null, `${s.messageCount} \u6761`));
      if (s.name) meta.append(el("span", "badge", "\u5DF2\u547D\u540D"));
      if (runningInfo) {
        meta.append(
          el("span", "badge live", runningInfo.status === "streaming" ? "\u8FD0\u884C\u4E2D" : "\u5DF2\u6253\u5F00")
        );
      }
      main.append(title, prev, meta);
      const actions = el("div", "session-go");
      const copyBtn = el("span", "ghost-btn", "\u29C9");
      copyBtn.title = "\u526F\u672C\u65B9\u5F0F\u6253\u5F00\uFF08\u4E0D\u78B0\u539F\u4F1A\u8BDD\u6587\u4EF6\uFF09";
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        enterSession({ ...s, copy: true });
      });
      actions.append(copyBtn, el("span", null, "\u203A"));
      node.append(main, actions);
      node.addEventListener("click", () => enterSession(s));
      box.append(node);
    }
    wrap.append(box);
  }
  $("home-empty").classList.toggle("hidden", total > 0);
}
async function loadCatalog() {
  var _a2;
  try {
    const health = await api("/api/health");
    app.health = health;
    app.catalog = await api("/api/catalog");
    $("server-line").textContent = `${location.host}${health.auth ? " \xB7 \u5DF2\u52A0\u5BC6\u94A5" : ""}${((_a2 = health.bridge) == null ? void 0 : _a2.available) ? " \xB7 \u7EC8\u7AEF\u53EF\u63A5\u5165" : ""}`;
    $("banner").classList.add("hidden");
    renderHome();
  } catch (err) {
    $("banner").classList.remove("hidden");
    $("banner").textContent = `\u8FDE\u63A5\u5931\u8D25\uFF1A${err.message}\u3002\u8BF7\u786E\u8BA4\u624B\u673A\u4E0E\u7535\u8111\u5728\u540C\u4E00 Wi-Fi\uFF0C\u4E14\u7535\u8111\u7AEF Pi Pocket \u6B63\u5728\u8FD0\u884C\u3002`;
    $("server-line").textContent = "\u672A\u8FDE\u63A5";
  }
}
async function loadRunning() {
  try {
    const { agents } = await api("/api/agents");
    app.running = new Map(agents.map((a) => [a.key, a]));
    renderHome();
  } catch {
  }
}
function showView(name) {
  $("view-home").classList.toggle("hidden", name !== "home");
  $("view-chat").classList.toggle("hidden", name !== "chat");
}
function entryToNode(entry) {
  var _a2, _b2, _c, _d, _e, _f, _g, _h, _i;
  const msg = entry.message;
  if (!msg) {
    if (entry.type === "compaction") {
      return el("div", "msg note", `\u25A3 \u4E0A\u4E0B\u6587\u5DF2\u538B\u7F29\uFF1A${String((_a2 = entry.summary) != null ? _a2 : "").slice(0, 160)}`);
    }
    if (entry.type === "branch_summary") {
      return el("div", "msg note", `\u2442 \u5206\u652F\u6458\u8981\uFF1A${String((_b2 = entry.summary) != null ? _b2 : "").slice(0, 160)}`);
    }
    if (entry.type === "session_info") return el("div", "msg note", `\u270E \u4F1A\u8BDD\u91CD\u547D\u540D\u4E3A\u300C${entry.name}\u300D`);
    return null;
  }
  if (msg.role === "user") {
    const node = el("div", "msg user");
    const text = typeof msg.content === "string" ? msg.content : ((_c = msg.content) != null ? _c : []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
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
    const card = (_e = (_d = app.chat) == null ? void 0 : _d.callCards) == null ? void 0 : _e.get(msg.toolCallId);
    if (card) {
      setToolResult(card, msg);
      return null;
    }
    return toolCardFromResult(msg);
  }
  if (msg.role === "bashExecution") {
    const node = el("div", "msg assistant");
    node.append(toolCard({ name: "bash", args: { command: msg.command } }, {
      text: (_f = msg.output) != null ? _f : "",
      isError: msg.exitCode !== 0
    }));
    return node;
  }
  if (msg.role === "custom" || entry.type === "custom_message") {
    if (msg.display === false || entry.display === false) return null;
    const customType = (_h = (_g = msg.customType) != null ? _g : entry.customType) != null ? _h : "";
    if (/guidance|system|prompt/i.test(customType)) return null;
    const text = typeof msg.content === "string" ? msg.content : ((_i = msg.content) != null ? _i : []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return text.trim() ? el("div", "msg note", text) : null;
  }
  return null;
}
function renderAssistantContent(node, content) {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content != null ? content : "") }];
  for (const block of blocks) {
    if (block.type === "thinking") {
      const d = el("details", "thinking");
      d.append(el("summary", null, "\u{1F4AD} \u601D\u8003\u8FC7\u7A0B"));
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
function registerCallCard(callId, card) {
  if (!app.chat) return;
  if (app.chat.callCards == null) app.chat.callCards = /* @__PURE__ */ new Map();
  app.chat.callCards.set(callId, card);
}
function toolSummary(name, args = {}) {
  var _a2, _b2, _c, _d, _e, _f;
  const a = args != null ? args : {};
  const pick = (_f = (_e = (_d = (_c = (_b2 = (_a2 = a.command) != null ? _a2 : a.file_path) != null ? _b2 : a.path) != null ? _c : a.pattern) != null ? _d : a.query) != null ? _e : a.url) != null ? _f : a.session_id;
  return pick ? String(pick) : JSON.stringify(a).slice(0, 120);
}
function toolCard(call, result) {
  var _a2;
  const node = el("div", "tool");
  const head = el("div", "tool-head");
  const icon = el("span", "spin", result ? "\u25CF" : "\u25D0");
  head.append(icon, el("span", "tool-name", (_a2 = call.name) != null ? _a2 : "tool"), el("span", "tool-args", toolSummary(call.name, call.arguments)));
  node.append(head);
  const out = el("pre", "tool-out" + ((result == null ? void 0 : result.isError) ? " tool-err" : ""));
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
  var _a2;
  if (!result) return "";
  const content = (_a2 = result.content) != null ? _a2 : [];
  if (typeof content === "string") return content;
  return content.map((c) => c.type === "text" ? c.text : c.type === "image" ? "[\u56FE\u7247]" : "").filter(Boolean).join("\n");
}
function setToolResult(node, result) {
  const text = toolResultText(result);
  const out = node._out;
  out.textContent = text.slice(0, 8e3) + (text.length > 8e3 ? "\n\u2026\uFF08\u5DF2\u622A\u65AD\uFF09" : "");
  out.classList.toggle("tool-err", Boolean(result == null ? void 0 : result.isError));
  out.style.display = text ? "block" : "none";
  const icon = node.querySelector(".spin");
  if (icon) {
    icon.classList.remove("spin");
    icon.textContent = (result == null ? void 0 : result.isError) ? "\u2715" : "\u2713";
  }
}
function toolCardFromResult(msg) {
  var _a2;
  const node = el("div", "tool");
  const head = el("div", "tool-head");
  head.append(
    el("span", null, msg.isError ? "\u2715" : "\u2713"),
    el("span", "tool-name", (_a2 = msg.toolName) != null ? _a2 : "tool"),
    el("span", "tool-args", "(\u7ED3\u679C)")
  );
  const out = el("pre", "tool-out" + (msg.isError ? " tool-err" : ""), toolResultText(msg).slice(0, 8e3));
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
  app.chat.nodes = /* @__PURE__ */ new Map();
  app.chat.callCards = /* @__PURE__ */ new Map();
  app.chat.streaming = null;
  for (const e of entries) appendEntry(e);
  box.scrollTop = box.scrollHeight;
}
function prettyCwd(p) {
  var _a2;
  if (!p) return "";
  const m = String(p).match(/^(\/(?:Users|home)\/[^/]+)(\/.*)?$/);
  return m ? "~" + ((_a2 = m[2]) != null ? _a2 : "") : String(p);
}
function updateStatus() {
  var _a2, _b2, _c, _d, _e, _f;
  const info = ((_a2 = app.chat) == null ? void 0 : _a2.info) || app.chat && app.chat.info;
  if (!info) return;
  const strip = $("status-strip");
  strip.replaceChildren();
  const dot = el("span", "dot" + (info.status === "streaming" ? " streaming" : ""));
  const label = (_b2 = { streaming: "\u751F\u6210\u4E2D", idle: "\u7A7A\u95F2", starting: "\u542F\u52A8\u4E2D", exited: "\u5DF2\u9000\u51FA", error: "\u9519\u8BEF" }[info.status]) != null ? _b2 : info.status;
  strip.append(dot, el("span", null, label));
  if ((_c = info.state) == null ? void 0 : _c.model) strip.append(el("span", null, `\xB7 ${info.state.model}`));
  if ((_d = info.state) == null ? void 0 : _d.thinkingLevel) strip.append(el("span", null, `\xB7 \u601D\u8003:${info.state.thinkingLevel}`));
  const ctx = (_e = info.stats) == null ? void 0 : _e.contextUsage;
  if ((ctx == null ? void 0 : ctx.percent) != null) strip.append(el("span", null, `\xB7 ctx ${Math.round(ctx.percent)}%`));
  if (info.mode === "bridge") {
    strip.append(
      el("span", "badge live", info.connected ? "\u5DF2\u8FDE\u7EC8\u7AEF" : "\u7EC8\u7AEF\u65AD\u5F00")
    );
  } else if (info.mode) {
    strip.append(
      el("span", null, `\xB7 ${info.mode === "new" ? "\u65B0\u4F1A\u8BDD" : info.mode === "copy" ? "\u526F\u672C" : "\u7EED\u63A5"}`)
    );
  }
  $("chat-title").textContent = ((_f = info.state) == null ? void 0 : _f.sessionName) || info.label || "\u4F1A\u8BDD";
  $("chat-sub").textContent = prettyCwd(info.cwd);
  $("btn-stop").classList.toggle("hidden", info.status !== "streaming");
  $("btn-send").classList.toggle("hidden", info.status === "streaming");
}
function handleAgentEvent(ev) {
  var _a2, _b2, _c, _d, _e, _f, _g, _h, _i, _j, _k;
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
    if (ev.type === "piapp_history") {
      const entries = ((_a2 = ev.entries) != null ? _a2 : []).filter((e) => e.message);
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
      if ((msg == null ? void 0 : msg.role) === "assistant") {
        const key = `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const node = el("div", "msg assistant");
        node.dataset.entryId = key;
        const holder = { node, entry: { id: key, message: msg } };
        chat.nodes.set(key, holder);
        box.append(node);
        chat.streaming = { key, node, holder, text: "", thinking: "", tools: /* @__PURE__ */ new Map() };
        if (app.stick) box.scrollTop = box.scrollHeight;
      } else if ((msg == null ? void 0 : msg.role) === "user") {
        const text = typeof msg.content === "string" ? msg.content : ((_b2 = msg.content) != null ? _b2 : []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
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
        chat.streaming.text += (_c = d.delta) != null ? _c : "";
        let body = chat.streaming.node.querySelector(".md:last-of-type");
        if (!body) {
          body = el("div", "md");
          chat.streaming.node.append(body);
        }
        body.innerHTML = md(chat.streaming.text);
        if (app.stick) box.scrollTop = box.scrollHeight;
      } else if (d.type === "thinking_delta") {
        chat.streaming.thinking += (_d = d.delta) != null ? _d : "";
        let det = chat.streaming.node.querySelector("details.thinking");
        if (!det) {
          det = el("details", "thinking");
          det.open = true;
          det.append(el("summary", null, "\u{1F4AD} \u601D\u8003\u8FC7\u7A0B"));
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
      if ((msg == null ? void 0 : msg.role) !== "assistant" || !chat.streaming) break;
      const target = chat.streaming.node;
      target.replaceChildren();
      renderAssistantContent(target, msg.content);
      for (const [callId, result] of (_e = chat.toolResults) != null ? _e : []) {
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
      if (chat.toolResults == null) chat.toolResults = /* @__PURE__ */ new Map();
      chat.toolResults.set(ev.toolCallId, ev.result);
      const card = findToolCard(ev.toolCallId);
      if (card) setToolResult(card, ev.result);
      break;
    }
    case "queue_update":
      chat.info.pending = { steering: (_f = ev.steering) != null ? _f : [], followUp: (_g = ev.followUp) != null ? _g : [] };
      updateStatus();
      break;
    case "compaction_start":
      box.append(el("div", "msg note", `\u25A3 \u6B63\u5728\u538B\u7F29\u4E0A\u4E0B\u6587\uFF08${ev.reason}\uFF09\u2026`));
      break;
    case "compaction_end":
      if (ev.result) box.append(el("div", "msg note", `\u25A3 \u4E0A\u4E0B\u6587\u538B\u7F29\u5B8C\u6210\uFF08${ev.result.tokensBefore} tokens\uFF09`));
      break;
    case "auto_retry_start":
      box.append(el("div", "msg note", `\u21BB \u81EA\u52A8\u91CD\u8BD5 ${ev.attempt}/${ev.maxAttempts}\uFF1A${(_h = ev.errorMessage) != null ? _h : ""}`));
      break;
    case "extension_error":
      box.append(el("div", "msg note", `\u26A0 \u6269\u5C55\u9519\u8BEF\uFF1A${(_i = ev.error) != null ? _i : ""}`));
      break;
    case "turn_end": {
      const usage = (_j = ev.message) == null ? void 0 : _j.usage;
      if (usage) {
        chat.info.stats = { ...(_k = chat.info.stats) != null ? _k : {}, lastUsage: usage };
        updateStatus();
      }
      break;
    }
    default:
      break;
  }
}
function findToolCard(callId) {
  var _a2, _b2, _c, _d, _e;
  if (!callId) return null;
  const registered = (_b2 = (_a2 = app.chat) == null ? void 0 : _a2.callCards) == null ? void 0 : _b2.get(callId);
  if (registered) return registered;
  if ((_e = (_d = (_c = app.chat) == null ? void 0 : _c.streaming) == null ? void 0 : _d.tools) == null ? void 0 : _e.has(callId)) return app.chat.streaming.tools.get(callId);
  return document.querySelector(`[data-call-id="${CSS.escape(callId)}"]`);
}
function connectWs(key) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?key=${encodeURIComponent(key)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ""}`;
  const ws = new WebSocket(url);
  app.chat.ws = ws;
  app.chat.pending = /* @__PURE__ */ new Map();
  app.chat.toolResults = /* @__PURE__ */ new Map();
  app.chat.wsReady = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("WebSocket \u8FDE\u63A5\u5931\u8D25"));
  });
  app.chat.wsReady.catch(() => {
  });
  ws.onmessage = (e) => {
    var _a2, _b2, _c, _d;
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
      $("messages").append(el("div", "msg note", "\u26A0 agent \u8FDB\u7A0B\u5DF2\u9000\u51FA"));
    } else if (msg.type === "fatal") {
      toast(msg.error);
      leaveChat({ closeProcess: false });
    } else if (msg.type === "response") {
      const pending = (_a2 = app.chat.pending) == null ? void 0 : _a2.get(msg.id);
      if (pending) {
        app.chat.pending.delete(msg.id);
        msg.success ? pending.resolve((_b2 = msg.data) != null ? _b2 : {}) : pending.reject(new Error((_c = msg.error) != null ? _c : "\u547D\u4EE4\u5931\u8D25"));
      } else if (msg.success === false) {
        toast((_d = msg.error) != null ? _d : "\u547D\u4EE4\u5931\u8D25");
      }
    }
  };
  ws.onclose = () => {
    var _a2;
    if (((_a2 = app.chat) == null ? void 0 : _a2.ws) === ws) {
      app.chat.ws = null;
      const box = $("messages");
      box.append(el("div", "msg note", "\u26A0 \u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF0C\u70B9\u83DC\u5355\u91CC\u7684\u300C\u540C\u6B65\u300D\u6216\u91CD\u65B0\u8FDB\u5165\u53EF\u6062\u590D"));
    }
  };
}
async function rpc(type, payload = {}, timeoutMs = 6e4) {
  var _a2;
  const chat = app.chat;
  if (!chat) throw new Error("\u672A\u8FDB\u5165\u4F1A\u8BDD");
  let ws = chat.ws;
  if (!ws || chat.wsReady && ws.readyState === WebSocket.CONNECTING) {
    ws = await ((_a2 = chat.wsReady) != null ? _a2 : Promise.reject(new Error("\u672A\u8FDE\u63A5")));
  }
  if (ws.readyState !== WebSocket.OPEN) throw new Error("\u672A\u8FDE\u63A5");
  return new Promise((resolve, reject) => {
    const id = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      chat.pending.delete(id);
      reject(new Error(`\u8D85\u65F6: ${type}`));
    }, timeoutMs);
    chat.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      }
    });
    ws.send(JSON.stringify({ id, type, ...payload }));
  });
}
async function enterSession(session) {
  var _a2;
  if (app.entering) return;
  app.entering = true;
  const box = $("messages");
  box.replaceChildren(el("div", "msg note", "\u6B63\u5728\u542F\u52A8 pi agent\u2026"));
  showView("chat");
  $("chat-title").textContent = sessionTitle(session);
  $("chat-sub").textContent = (_a2 = session.projectLabel) != null ? _a2 : "";
  app.chat = {
    key: null,
    label: sessionTitle(session),
    cwd: session.cwd,
    info: { status: "starting", state: {}, label: sessionTitle(session), cwd: session.cwd },
    nodes: /* @__PURE__ */ new Map(),
    pending: /* @__PURE__ */ new Map(),
    callCards: /* @__PURE__ */ new Map(),
    toolResults: /* @__PURE__ */ new Map()
  };
  try {
    const { agent } = await api("/api/agents/open", {
      method: "POST",
      body: JSON.stringify({ sessionPath: session.path, cwd: session.cwd, copy: Boolean(session.copy) })
    });
    app.chat.key = agent.key;
    app.chat.info = { ...agent, label: sessionTitle(session), sourcePath: session.path };
    history.pushState({ view: "chat" }, "", chatUrl(agent.key));
    await attachToBridge(agent.key);
    loadRunning();
  } catch (err) {
    box.replaceChildren(el("div", "msg err", `\u6253\u5F00\u5931\u8D25\uFF1A${err.message}`));
  } finally {
    app.entering = false;
  }
}
async function attachToBridge(key) {
  var _a2;
  connectWs(key);
  updateStatus();
  const recent = await rpc("recent", {}, 3e4).catch(() => ({ messages: [] }));
  renderChatEntries(((_a2 = recent.messages) != null ? _a2 : []).filter((m) => m.message));
  const state = await rpc("refresh_state", {}, 2e4).catch(() => null);
  if (state) {
    app.chat.info.state = state.state;
    app.chat.info.stats = state.stats;
  }
  updateStatus();
}
async function enterAgentKey(key) {
  var _a2, _b2;
  try {
    const { agents } = await api("/api/agents");
    const info = agents.find((a) => a.key === key);
    if (!info) {
      showView("home");
      history.replaceState(null, "", chatUrl(null));
      toast("\u8BE5\u4F1A\u8BDD\u5DF2\u5173\u95ED");
      return;
    }
    const label = ((_a2 = info.state) == null ? void 0 : _a2.sessionName) || "\u4F1A\u8BDD";
    showView("chat");
    app.chat = {
      key,
      label,
      cwd: info.cwd,
      info: { ...info, label },
      nodes: /* @__PURE__ */ new Map(),
      pending: /* @__PURE__ */ new Map(),
      callCards: /* @__PURE__ */ new Map(),
      toolResults: /* @__PURE__ */ new Map()
    };
    history.replaceState({ view: "chat" }, "", chatUrl(key));
    $("chat-title").textContent = label;
    $("chat-sub").textContent = (_b2 = info.cwd) != null ? _b2 : "";
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
    api(`/api/agents/${encodeURIComponent(chat.key)}/close`, { method: "POST" }).catch(() => {
    });
  }
  if (location.search.includes("a=")) history.replaceState(null, "", chatUrl(null));
  showView("home");
  loadRunning();
}
function menuSheet() {
  var _a2, _b2;
  const isBridge = ((_b2 = (_a2 = app.chat) == null ? void 0 : _a2.info) == null ? void 0 : _b2.mode) === "bridge";
  openSheet(isBridge ? "\u4F1A\u8BDD\u64CD\u4F5C\uFF08\u5DF2\u8FDE\u7EC8\u7AEF\uFF09" : "\u4F1A\u8BDD\u64CD\u4F5C", (body) => {
    const grid = el("div", "grid");
    const items = [
      ["\u27F3", "\u540C\u6B65", () => syncChat()],
      ["\u{1F39B}", "\u6A21\u578B", () => modelSheet()],
      ["\u{1F9E0}", "\u601D\u8003", () => thinkingSheet()],
      ["\u270E", "\u91CD\u547D\u540D", () => renameSheet()],
      ["\u25A3", "\u538B\u7F29", () => compactChat()],
      ["\u{1F4CA}", "\u7EDF\u8BA1", () => statsSheet()],
      ["\uFF0B", "\u65B0\u4F1A\u8BDD", () => newSessionHere()],
      ["\u29C9", "\u5F00\u526F\u672C", () => openCopy()],
      ["\u{1F4E4}", "\u5BFC\u51FA", () => exportHtml()],
      ["\u2139\uFE0F", "\u4FE1\u606F", () => infoSheet()],
      // 桥接模式下不会杀掉终端的 pi，只是断开手机的连接
      ["\u23CF", isBridge ? "\u65AD\u5F00\u8FDE\u63A5" : "\u5173\u95ED\u8FDB\u7A0B", () => closeProcessConfirm()],
      ["\u26A0\uFE0F", "\u4E2D\u65AD\u4EFB\u52A1", () => abortRun()]
    ];
    if (IN_APP) {
      items.push(["\u{1F50C}", "\u8FDE\u63A5\u8BBE\u7F6E", () => window.PiPocketNative.openSettings()]);
      items.push(["\u21BB", "\u91CD\u8FDE", () => window.PiPocketNative.reconnect()]);
    }
    for (const [icon, label, fn] of items) {
      const b = el("button", "grid-item" + (label.includes("\u4E2D\u65AD") ? " danger" : ""));
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
  var _a2;
  try {
    const recent = await rpc("recent", {}, 3e4);
    renderChatEntries(((_a2 = recent.messages) != null ? _a2 : []).filter((m) => m.type === "message" || m.message));
    const state = await rpc("refresh_state", {}, 2e4);
    app.chat.info.state = state.state;
    app.chat.info.stats = state.stats;
    updateStatus();
    toast("\u5DF2\u540C\u6B65");
  } catch (err) {
    toast(err.message);
  }
}
async function modelSheet() {
  var _a2;
  try {
    const { models } = await rpc("get_available_models");
    const current = (_a2 = app.chat.info.state) == null ? void 0 : _a2.model;
    openSheet("\u9009\u62E9\u6A21\u578B", (body) => {
      for (const m of models.slice(0, 60)) {
        const id = `${m.provider}/${m.id}`;
        const item = el("div", "list-item" + (id === current ? " active" : ""));
        const left = el("div");
        left.append(el("div", null, m.id));
        left.append(el("small", null, `${m.provider} \xB7 ctx ${fmtNum(m.contextWindow)}${m.reasoning ? " \xB7 \u63A8\u7406" : ""}`));
        item.append(left, el("span", null, id === current ? "\u2713" : ""));
        item.addEventListener("click", async () => {
          try {
            await rpc("set_model", { provider: m.provider, modelId: m.id });
            await rpc("refresh_state").then((s) => {
              app.chat.info.state = s.state;
              updateStatus();
            });
            closeSheet();
            toast(`\u5DF2\u5207\u6362\u5230 ${id}`);
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
  var _a2;
  try {
    const { levels } = await rpc("get_available_thinking_levels");
    const current = (_a2 = app.chat.info.state) == null ? void 0 : _a2.thinkingLevel;
    openSheet("\u601D\u8003\u7B49\u7EA7", (body) => {
      for (const lv of levels) {
        const item = el("div", "list-item" + (lv === current ? " active" : ""));
        item.append(el("div", null, lv), el("span", null, lv === current ? "\u2713" : ""));
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
  openSheet("\u91CD\u547D\u540D\u4F1A\u8BDD", (body) => {
    var _a2, _b2;
    const field = el("div", "field");
    const input = el("input");
    input.value = (_b2 = (_a2 = app.chat.info.state) == null ? void 0 : _a2.sessionName) != null ? _b2 : "";
    input.placeholder = "\u7ED9\u8FD9\u4E2A\u4F1A\u8BDD\u8D77\u4E2A\u540D\u5B57";
    field.append(input);
    const btn = el("button", "btn primary", "\u4FDD\u5B58");
    btn.style.marginTop = "12px";
    btn.addEventListener("click", async () => {
      try {
        await rpc("set_session_name", { name: input.value.trim() });
        const s = await rpc("refresh_state");
        app.chat.info.state = s.state;
        app.chat.label = input.value.trim() || app.chat.label;
        updateStatus();
        closeSheet();
        toast("\u5DF2\u4FDD\u5B58");
        loadCatalog();
      } catch (e) {
        toast(e.message);
      }
    });
    body.append(field, btn);
  });
}
async function compactChat() {
  if (!await confirmDialog("\u538B\u7F29\u4E0A\u4E0B\u6587", "\u628A\u8F83\u65E9\u7684\u5BF9\u8BDD\u603B\u7ED3\u6389\u4EE5\u91CA\u653E\u4E0A\u4E0B\u6587\u7A7A\u95F4\uFF1F", "\u538B\u7F29")) return;
  toast("\u6B63\u5728\u538B\u7F29\u2026");
  try {
    const r = await rpc("compact", {}, 18e4);
    toast(`\u538B\u7F29\u5B8C\u6210\uFF1A${fmtNum(r == null ? void 0 : r.tokensBefore)} \u2192 ${fmtNum(r == null ? void 0 : r.estimatedTokensAfter)}`);
    syncChat();
  } catch (err) {
    toast(err.message);
  }
}
async function statsSheet() {
  try {
    const s = await rpc("get_session_stats");
    openSheet("\u4F1A\u8BDD\u7EDF\u8BA1", (body) => {
      var _a2, _b2, _c, _d, _e, _f, _g, _h, _i;
      const rows = [
        ["\u6D88\u606F\u6570", `${s.userMessages} \u7528\u6237 / ${s.assistantMessages} \u52A9\u624B`],
        ["\u5DE5\u5177\u8C03\u7528", `${s.toolCalls}`],
        ["\u603B tokens", fmtNum((_a2 = s.tokens) == null ? void 0 : _a2.total)],
        ["\u8F93\u5165 / \u8F93\u51FA", `${fmtNum((_b2 = s.tokens) == null ? void 0 : _b2.input)} / ${fmtNum((_c = s.tokens) == null ? void 0 : _c.output)}`],
        ["\u7F13\u5B58\u8BFB / \u5199", `${fmtNum((_d = s.tokens) == null ? void 0 : _d.cacheRead)} / ${fmtNum((_e = s.tokens) == null ? void 0 : _e.cacheWrite)}`],
        ["\u82B1\u8D39", s.cost != null ? `$${Number(s.cost).toFixed(4)}` : "\u2014"],
        ["\u4E0A\u4E0B\u6587\u5360\u7528", ((_f = s.contextUsage) == null ? void 0 : _f.percent) != null ? `${Math.round(s.contextUsage.percent)}%\uFF08${fmtNum(s.contextUsage.tokens)}\uFF09` : "\u2014"],
        ["\u4E0A\u4E0B\u6587\u7A97\u53E3", ((_g = s.contextUsage) == null ? void 0 : _g.contextWindow) ? fmtNum(s.contextUsage.contextWindow) : "\u2014"],
        ["\u4F1A\u8BDD\u6587\u4EF6", (_h = s.sessionFile) != null ? _h : "\u2014"],
        ["\u4F1A\u8BDD ID", (_i = s.sessionId) != null ? _i : "\u2014"]
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
    const r = await rpc("export_html", {}, 6e4);
    openSheet("\u5BFC\u51FA\u5B8C\u6210", (body) => {
      var _a2;
      body.append(el("p", null, "HTML \u5DF2\u751F\u6210\u5728\u7535\u8111\u4E0A\uFF1A"));
      const p = el("div", "kv");
      p.append(el("span", "v", (_a2 = r.path) != null ? _a2 : ""));
      body.append(p);
    });
  } catch (err) {
    toast(err.message);
  }
}
function infoSheet() {
  openSheet("\u8FDE\u63A5\u4FE1\u606F", (body) => {
    var _a2, _b2, _c, _d, _e, _f, _g;
    const info = app.chat.info;
    const rows = [
      ["\u5DE5\u4F5C\u76EE\u5F55", prettyCwd(info.cwd) || "\u2014"],
      ["\u4F1A\u8BDD\u6587\u4EF6", (_a2 = info.sessionPath) != null ? _a2 : "\u2014"],
      [
        "\u6765\u6E90\u4F1A\u8BDD",
        info.sourcePath && info.sourcePath !== info.sessionPath ? info.sourcePath : "\uFF08\u540C\u4E00\u4E2A\u6587\u4EF6\uFF09"
      ],
      ["\u4F1A\u8BDD ID", (_b2 = info.sessionId) != null ? _b2 : "\u2014"],
      [
        "\u8FDB\u5165\u65B9\u5F0F",
        (_c = { bridge: "\u8FDE\u5230\u7EC8\u7AEF\u7684 pi", resume: "\u7EED\u63A5\u539F\u4F1A\u8BDD", copy: "\u526F\u672C\u4F1A\u8BDD", new: "\u5168\u65B0\u4F1A\u8BDD" }[info.mode]) != null ? _c : info.mode
      ],
      ...info.mode === "bridge" ? [["\u7EC8\u7AEF pi \u8FDB\u7A0B", info.pid ? `pid ${info.pid}` : "\u2014"]] : [],
      ["\u8FD0\u884C\u72B6\u6001", info.status],
      ["\u6700\u540E\u9519\u8BEF", (_d = info.lastError) != null ? _d : "\u2014"],
      ["\u624B\u673A\u5730\u5740", location.host],
      ["\u670D\u52A1\u7AEF CLI", (_g = (_f = (_e = app.health) == null ? void 0 : _e.runtime) == null ? void 0 : _f.cli) != null ? _g : "\u2014"]
    ];
    for (const [k, v] of rows) {
      const row = el("div", "kv");
      row.append(el("span", "k", k), el("span", "v", String(v)));
      body.append(row);
    }
  });
}
async function newSessionHere() {
  if (!await confirmDialog("\u65B0\u5EFA\u4F1A\u8BDD", `\u5728 ${app.chat.cwd} \u65B0\u5EFA\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u5E76\u5173\u95ED\u5F53\u524D\u4F1A\u8BDD\u8FDB\u7A0B\uFF1F`, "\u65B0\u5EFA")) return;
  await openNew({ cwd: app.chat.cwd, forceNewName: true });
}
function swapToAgentPlaceholder() {
}
async function swapToAgent({ body, label, note }) {
  var _a2, _b2;
  const oldKey = (_a2 = app.chat) == null ? void 0 : _a2.key;
  const { agent } = await api("/api/agents/open", { method: "POST", body: JSON.stringify(body) });
  if (oldKey && oldKey !== agent.key) {
    api(`/api/agents/${encodeURIComponent(oldKey)}/close`, { method: "POST" }).catch(() => {
    });
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
    nodes: /* @__PURE__ */ new Map(),
    pending: /* @__PURE__ */ new Map(),
    callCards: /* @__PURE__ */ new Map(),
    toolResults: /* @__PURE__ */ new Map()
  };
  history.replaceState({ view: "chat" }, "", chatUrl(agent.key));
  $("chat-title").textContent = label;
  $("chat-sub").textContent = (_b2 = agent.cwd) != null ? _b2 : "";
  $("messages").replaceChildren(el("div", "msg note", note));
  await attachToBridge(agent.key);
  loadRunning();
  return agent;
}
async function openCopy() {
  var _a2, _b2, _c, _d, _e;
  const info = (_a2 = app.chat) == null ? void 0 : _a2.info;
  const source = (_b2 = info == null ? void 0 : info.sourcePath) != null ? _b2 : info == null ? void 0 : info.sessionPath;
  if (!source) return toast("\u5F53\u524D\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u6587\u4EF6");
  if (!await confirmDialog(
    "\u53E6\u5F00\u526F\u672C",
    "\u628A\u5F53\u524D\u4F1A\u8BDD\u590D\u5236\u6210\u4E00\u4E2A\u65B0\u4F1A\u8BDD\u540E\u7EE7\u7EED\uFF08\u539F\u4F1A\u8BDD\u6587\u4EF6\u4E0D\u4F1A\u88AB\u6539\u52A8\uFF09\uFF0C\u9002\u5408\u539F\u4F1A\u8BDD\u8FD8\u5F00\u5728\u7535\u8111\u7EC8\u7AEF\u91CC\u3002",
    "\u5F00\u526F\u672C"
  ))
    return;
  try {
    const box = $("messages");
    box.replaceChildren(el("div", "msg note", "\u6B63\u5728\u521B\u5EFA\u526F\u672C\u2026"));
    const agent = await swapToAgent({
      body: { sessionPath: source, cwd: info.cwd, copy: true },
      label: ((_d = (_c = app.chat) == null ? void 0 : _c.label) != null ? _d : "\u4F1A\u8BDD") + "\uFF08\u526F\u672C\uFF09",
      note: "\u5DF2\u521B\u5EFA\u526F\u672C\uFF0C\u5386\u53F2\u5DF2\u5E26\u8FC7\u6765"
    });
    toast(`\u526F\u672C\u4F1A\u8BDD\uFF1A${(_e = agent.sessionPath) != null ? _e : ""}`.slice(0, 60));
  } catch (err) {
    $("messages").replaceChildren(el("div", "msg err", `\u521B\u5EFA\u526F\u672C\u5931\u8D25\uFF1A${err.message}`));
  }
}
async function openNew({ cwd, forceNewName = false }) {
  try {
    $("messages").replaceChildren(el("div", "msg note", "\u6B63\u5728\u65B0\u5EFA\u4F1A\u8BDD\u2026"));
    const agent = await swapToAgent({
      body: { cwd, forceNew: true },
      label: "\u65B0\u4F1A\u8BDD",
      note: `\u5DF2\u5728 ${cwd} \u65B0\u5EFA\u4F1A\u8BDD`
    });
    if (forceNewName) toast("\u5DF2\u65B0\u5EFA\u4F1A\u8BDD");
    return agent;
  } catch (err) {
    $("messages").replaceChildren(el("div", "msg err", `\u65B0\u5EFA\u5931\u8D25\uFF1A${err.message}`));
  }
}
async function closeProcessConfirm() {
  var _a2, _b2;
  const isBridge = ((_b2 = (_a2 = app.chat) == null ? void 0 : _a2.info) == null ? void 0 : _b2.mode) === "bridge";
  const ok = isBridge ? await confirmDialog(
    "\u65AD\u5F00\u4E0E\u7EC8\u7AEF\u7684\u8FDE\u63A5",
    "\u53EA\u662F\u624B\u673A\u4E0D\u518D\u8FDE\u8FD9\u4E2A\u4F1A\u8BDD\uFF1B\u7EC8\u7AEF\u91CC\u7684 pi \u548C\u4F60\u7684\u4EFB\u52A1\u90FD\u4E0D\u53D7\u5F71\u54CD\u3002",
    "\u65AD\u5F00"
  ) : await confirmDialog("\u5173\u95ED agent \u8FDB\u7A0B", "\u91CA\u653E\u7535\u8111\u4E0A\u7684\u8FD9\u4E2A pi \u8FDB\u7A0B\uFF08\u4F1A\u8BDD\u6587\u4EF6\u4FDD\u7559\uFF09\u3002", "\u5173\u95ED");
  if (!ok) return;
  const key = app.chat.key;
  api(`/api/agents/${encodeURIComponent(key)}/close`, { method: "POST" }).catch(() => {
  });
  toast(isBridge ? "\u5DF2\u65AD\u5F00\uFF0C\u7EC8\u7AEF pi \u7EE7\u7EED\u8FD0\u884C" : "\u5DF2\u5173\u95ED\uFF0C\u4F1A\u8BDD\u6587\u4EF6\u5DF2\u4FDD\u7559");
  history.back();
}
async function abortRun() {
  try {
    await rpc("abort", {}, 3e4);
    toast("\u5DF2\u8BF7\u6C42\u4E2D\u65AD");
  } catch (err) {
    toast(err.message);
  }
}
function newSessionDialog(prefillCwd) {
  openSheet("\u65B0\u5EFA\u4F1A\u8BDD", (body) => {
    var _a2, _b2;
    const wrap = el("div", "field");
    const label = el("div", "k", "\u5DE5\u4F5C\u76EE\u5F55\uFF08\u7535\u8111\u4E0A\u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF09");
    const input = el("input");
    input.value = prefillCwd || localStorage.getItem("pi-pocket-last-cwd") || "";
    input.placeholder = "/Users/you/project";
    wrap.append(label, input);
    const shortcut = el("div", "list-item");
    shortcut.append(el("div", null, `\u4F7F\u7528\u5F53\u524D\u4F1A\u8BDD\u76EE\u5F55\uFF08${(_b2 = (_a2 = app.catalog.sessions[0]) == null ? void 0 : _a2.projectLabel) != null ? _b2 : "\u65E0"}\uFF09`));
    shortcut.addEventListener("click", () => {
      if (app.catalog.sessions[0]) input.value = app.catalog.sessions[0].cwd;
    });
    const btn = el("button", "btn primary", "\u521B\u5EFA\u5E76\u8FDB\u5165");
    btn.style.marginTop = "12px";
    btn.addEventListener("click", async () => {
      const cwd = input.value.trim();
      if (!cwd) return toast("\u8BF7\u586B\u5199\u76EE\u5F55");
      localStorage.setItem("pi-pocket-last-cwd", cwd);
      closeSheet();
      showView("chat");
      app.chat = {
        key: null,
        label: "\u65B0\u4F1A\u8BDD",
        cwd,
        info: { status: "starting", state: {}, cwd },
        nodes: /* @__PURE__ */ new Map(),
        pending: /* @__PURE__ */ new Map(),
        callCards: /* @__PURE__ */ new Map(),
        toolResults: /* @__PURE__ */ new Map()
      };
      history.pushState({ view: "chat" }, "", chatUrl(null));
      $("chat-title").textContent = "\u65B0\u4F1A\u8BDD";
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
    toast("\u5DF2\u5237\u65B0");
  });
  $("search").addEventListener("input", (e) => {
    app.search = e.target.value;
    renderHome();
  });
  $("btn-new-here").addEventListener("click", () => {
    var _a2, _b2;
    newSessionDialog((_b2 = (_a2 = app.catalog.sessions[0]) == null ? void 0 : _a2.cwd) != null ? _b2 : "");
  });
  $("btn-new-dir").addEventListener("click", () => newSessionDialog());
}
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
      if (!await confirmDialog("agent \u6B63\u5728\u751F\u6210", "\u8981\u63D2\u8BDD\uFF08steer\uFF09\u6253\u65AD\u5F53\u524D\u601D\u8DEF\u5417\uFF1F", "\u63D2\u8BDD")) {
        input.value = text;
        return;
      }
      await rpc("steer", { message: text }, 3e4);
      toast("\u5DF2\u63D2\u5165\u6307\u4EE4");
    } else {
      await rpc("prompt", { message: text }, 3e4);
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
window.addEventListener("popstate", () => {
  if (app.chat) leaveChat({ closeProcess: false });
  else showView("home");
});
window.addEventListener("beforeunload", () => {
  var _a2;
  if ((_a2 = app.chat) == null ? void 0 : _a2.ws) app.chat.ws.close();
});
bindHome();
bindChat();
showView("home");
loadCatalog().then(loadRunning).then(() => {
  if (bootKey) enterAgentKey(bootKey);
});
setInterval(() => {
  if (!app.chat) loadRunning();
}, 15e3);
