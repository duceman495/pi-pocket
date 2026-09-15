/**
 * 会话目录：扫描 ~/.pi/agent/sessions 下所有项目的会话，按项目分组。
 */
import { homedir } from "node:os";
import { basename, dirname, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** 给项目目录取一个人类可读的名字 */
export function prettyProjectName(cwd) {
	if (!cwd) return "未知目录";
	const home = homedir();
	if (cwd === home) return "~ (主目录)";
	if (cwd.startsWith(home + sep)) return "~/" + cwd.slice(home.length + 1);
	const parts = cwd.split(sep).filter(Boolean);
	return parts.length <= 2 ? cwd : "…/" + parts.slice(-2).join("/");
}

function projectName(cwd) {
	if (!cwd) return "未知目录";
	if (cwd === homedir()) return "~";
	const b = basename(cwd);
	return b || cwd;
}

/** 截断首条消息用于列表预览 */
function preview(text, max = 90) {
	if (!text) return "";
	const flat = String(text).replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * @returns {Promise<{projects: Array, sessions: Array}>}
 */
export async function listCatalog() {
	let sessions = [];
	try {
		sessions = await SessionManager.listAll();
	} catch (err) {
		sessions = [];
	}

	const rows = sessions.map((info) => {
		const cwd = info.cwd || "";
		return {
			path: info.path,
			id: info.id,
			name: info.name ?? null,
			cwd,
			projectName: projectName(cwd),
			projectLabel: prettyProjectName(cwd),
			created: info.created?.toISOString?.() ?? null,
			modified: info.modified?.toISOString?.() ?? null,
			messageCount: info.messageCount ?? 0,
			preview: preview(info.firstMessage || info.allMessagesText || ""),
			parentSessionPath: info.parentSessionPath ?? null,
		};
	});

	rows.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));

	const byCwd = new Map();
	for (const row of rows) {
		const key = row.cwd || "(unknown)";
		if (!byCwd.has(key)) {
			byCwd.set(key, {
				cwd: key,
				name: row.projectName,
				label: row.projectLabel,
				count: 0,
				latestModified: null,
				sessions: [],
			});
		}
		const project = byCwd.get(key);
		project.count += 1;
		if (!project.latestModified || (row.modified ?? "") > project.latestModified) {
			project.latestModified = row.modified;
		}
		project.sessions.push(row);
	}

	const projects = [...byCwd.values()].sort((a, b) =>
		(b.latestModified ?? "").localeCompare(a.latestModified ?? ""),
	);

	return { projects, sessions: rows };
}

/** 从 session 文件路径推断 cwd（文件在 --encoded-path-- 目录下） */
export function cwdFromSessionPath(sessionPath) {
	const dir = basename(dirname(sessionPath));
	if (!dir.startsWith("--") || !dir.endsWith("--")) return null;
	const inner = dir.slice(2, -2);
	return "/" + inner.replace(/-/g, "/");
}
