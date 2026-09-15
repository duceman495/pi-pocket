#!/usr/bin/env node
/**
 * 生成一套「合成的」pi 会话数据，用于录演示截图/录屏。
 *
 * 为什么要这样：真实会话里带着项目名、内网 IP、私人对话内容，不适合放进公开仓库的截图。
 * 这里用 pi 官方的 session JSONL 格式编一份假的，然后用 PI_CODING_AGENT_DIR 指过去，
 * 起一个临时的 Pi Pocket 服务来截图，你的真实数据完全不参与。
 *
 * 用法：
 *   node tools/demo-data.mjs            # 生成到 /tmp/pi-pocket-demo
 *   PI_CODING_AGENT_DIR=/tmp/pi-pocket-demo/agent node server.mjs --port=8899
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 演示用的「工作目录」必须在磁盘上真实存在，否则 pi 进程起不来（spawn cwd 不存在会报 ENOENT）。
// 放在 ~/pi-pocket-demo 下：界面里显示成 ~/pi-pocket-demo/xxx，不会暴露用户名。
const DEMO_ROOT = process.env.PI_POCKET_DEMO_ROOT ?? join(homedir(), "pi-pocket-demo");
const OUT = join(DEMO_ROOT, ".state");
const AGENT_DIR = join(OUT, "agent");
const SESSIONS = join(AGENT_DIR, "sessions");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(SESSIONS, { recursive: true });

let idSeq = 0;
const uid = () => (++idSeq).toString(16).padStart(8, "0");
const ts = (min) => new Date(Date.UTC(2026, 0, 15, 9, min, 0)).toISOString();

// 用能对上 pi 内置模型目录的 id，否则界面状态条会显示 unknown/unknown
const MODEL = { provider: "demo", modelId: "demo-model" };

function newSession(cwd, startMin) {
	const entries = [];
	let parent = null;
	const push = (e) => {
		const id = uid();
		entries.push({ id, parentId: parent, timestamp: ts(startMin + entries.length), ...e });
		parent = id;
		return id;
	};

	push({ type: "model_change", provider: MODEL.provider, modelId: MODEL.modelId });
	push({ type: "thinking_level_change", thinkingLevel: "medium" });

	return {
		entries,
		push,
		user(text) {
			push({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
		},
		thinking(text) {
			return text;
		},
		assistant(blocks) {
			push({
				type: "message",
				message: {
					role: "assistant",
					content: blocks,
					api: "anthropic-messages",
					provider: MODEL.provider,
					model: MODEL.modelId,
					usage: { input: 4210, output: 318, cacheRead: 2048, cacheWrite: 0, totalTokens: 6576, cost: { input: 0.0126, output: 0.0048, cacheRead: 0.0006, cacheWrite: 0, total: 0.018 } },
					stopReason: blocks.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
					timestamp: Date.now(),
				},
			});
		},
		toolResult(toolCallId, toolName, text, isError = false) {
			push({ type: "message", message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: Date.now() } });
		},
		write(cwdPath) {
			const path = join(SESSIONS, "--" + cwdPath.slice(1).replace(/\//g, "-") + "--");
			mkdirSync(path, { recursive: true });
			const header = { type: "session", version: 3, id: uid() + uid(), timestamp: ts(startMin), cwd };
			const file = join(path, `${ts(startMin).replace(/[:.]/g, "-")}_${uid()}${uid()}.jsonl`);
			writeFileSync(file, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
			return file;
		},
	};
}

/* ------------------------------- 假项目 1 ------------------------------- */

function projectAurora() {
	const cwd = join(DEMO_ROOT, "aurora-api");
	mkdirSync(cwd, { recursive: true });
	const s = newSession(cwd, 40);
	s.user("帮我看下 src/auth/session.ts，用户登录后偶尔会拿到过期的 token，怀疑是刷新逻辑的问题");

	s.assistant([
		{ type: "thinking", thinking: "先读文件，重点看 refresh 的并发处理。如果有多个请求同时触发刷新，可能会有竞态。" },
		{ type: "toolCall", id: "call_a1", name: "read", arguments: { path: "src/auth/session.ts" } },
		{ type: "toolCall", id: "call_a2", name: "grep", arguments: { pattern: "refreshToken|refreshPromise", path: "src/auth" } },
	]);
	s.toolResult("call_a1", "read", "export async function getSession(): Promise<Session> {\n  const s = await store.load();\n  if (s && s.expiresAt > Date.now()) return s;\n  return refresh(s);   // ← 并发调用时会被打多次\n}\n");
	s.toolResult("call_a2", "grep", "src/auth/session.ts:12:  return refresh(s);\nsrc/auth/refresh.ts:8: export async function refresh(s) { ... }");

	s.assistant([
		{ type: "text", text: "找到了。`getSession()` 在 token 过期时直接调 `refresh()`，**没有做并发去重**——同时进来的 N 个请求会各自发起一次刷新，后返回的那个会用旧的 refresh token 把新的覆盖掉，表现就是「偶尔拿到过期 token」。\n\n修法是让同一时刻只跑一次刷新，其余请求等同一个 Promise：" },
		{ type: "toolCall", id: "call_a3", name: "edit", arguments: { path: "src/auth/session.ts", old_string: "  return refresh(s);", new_string: "  refreshInFlight ??= refresh(s).finally(() => { refreshInFlight = null; });\n  return refreshInFlight;" } },
	]);
	s.toolResult("call_a3", "edit", "已修改 src/auth/session.ts（+2 −1）");

	s.assistant([
		{ type: "text", text: "改完了，两处关键点：\n\n1. `refreshInFlight` 缓存进行中的刷新，并发请求共享同一个 Promise\n2. `.finally()` 保证失败也能清空，否则一次网络抖动会让后续请求永远拿到 rejected 的 Promise\n\n跑一下测试确认：" },
		{ type: "toolCall", id: "call_a4", name: "bash", arguments: { command: "npm test -- auth" } },
	]);
	s.toolResult("call_a4", "bash", "PASS  src/auth/session.test.ts\n  ✓ 并发 10 次 getSession 只触发一次 refresh (12 ms)\n  ✓ refresh 失败后可重试\n\nTests: 2 passed, 2 total");

	s.user("不错。这个并发去重的模式项目里别的地方也能用吧？");
	s.assistant([
		{ type: "text", text: "能。凡是「读缓存 → 未命中 → 回源」这类逻辑都适用，比如 `src/config/loader.ts` 和 `src/db/pool.ts` 里的初始化。共同点是初始化开销大、又不希望并发重复执行。\n\n不过要注意两点：\n\n- **成功结果要缓存住**，不能只在 in-flight 期间共享，否则每次都回源\n- **失败不要缓存**（或者只缓存极短时间），不然一次故障会持续放大\n\n要我把这两个地方也一起改了吗？" },
	]);
	return s.write(cwd);
}

/* ------------------------------- 假项目 2 ------------------------------- */

function projectDocs() {
	const cwd = join(DEMO_ROOT, "tech-notes");
	mkdirSync(cwd, { recursive: true });
	const s = newSession(cwd, 40);

	s.user("帮我把这篇「为什么我们放弃了单体仓库」的开头改得更有钩子，现在太平了");
	s.assistant([
		{ type: "text", text: "现在开头是「随着团队规模增长，我们逐渐意识到单体仓库带来的问题」——这句话的问题是**结论先行但毫无张力**，读者不知道「问题」是什么，也就没有读下去的理由。\n\n三个改法，按攻击性递增：\n\n> **A（场景切入）**\n> 那天下午 CI 排到了 47 号。我们盯着队列，突然意识到：改一行文案，也要等四十分钟。\n\n> **B（数字反差）**\n> 仓库 12 GB，日均 clone 次数 340 次，而其中 91% 的人只碰三个目录。\n\n> **C（反常识）**\n> 我们放弃单体仓库，不是因为「太大了」——而是因为它开始替我们做技术决策。\n\n我推荐 C，因为它把话题从「工具选型」抬到了「组织与架构的边界」，后面正文展开才不会散。" },
	]);
	return s.write(cwd);
}

function mkdirAndWrite() {}

// 注意顺序：sessions 列表按文件 mtime 倒序，最后写的排最前。
// aurora-api 内容最丰富（思考/工具/编辑/测试），放在最前面方便截图和自检。
projectDocs();
projectAurora();

// 写一个占位模型配置：只为让截图上状态条显示出一个像样的模型名，
// baseUrl 指向不可达端口，不存在被误用去发请求的可能。
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify(
		{
			providers: {
				demo: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "demo-placeholder",
					models: [{ id: "demo-model", name: "Demo Model", reasoning: true }],
				},
			},
		},
		null,
		2,
	) + "\n",
);

console.log(`合成演示数据已生成：`);
console.log(`  工作目录  ${DEMO_ROOT}/aurora-api, ${DEMO_ROOT}/tech-notes`);
console.log(`  会话数据  ${SESSIONS}`);
console.log(`\n用法：\n  PI_CODING_AGENT_DIR=${AGENT_DIR} node server.mjs --port=8899\n`);
