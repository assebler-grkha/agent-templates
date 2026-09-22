#!/usr/bin/env node
import { createRequire, isBuiltin } from "node:module";
import fs, { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { Command, Option } from "commander";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execSync, spawn, spawnSync } from "node:child_process";
import os, { tmpdir } from "node:os";
import pc from "picocolors";
import wcwidth from "wcwidth";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML, { parse } from "yaml";
import { z } from "zod/v4";
import crypto, { randomUUID } from "node:crypto";
import { confirm, isCancel, multiselect, select, text } from "@clack/prompts";
import micromatch from "micromatch";
import ts from "typescript";
import { parse as parse$1 } from "smol-toml";
import * as readline from "node:readline";
import { Writable } from "node:stream";
//#region src/agents/providers.ts
const PROVIDER_PROBE_TIMEOUT_MS = 1200;
const PROVIDERS = [
	{
		id: "codex",
		label: "Codex",
		bin: "codex",
		loginCommand: {
			command: "codex",
			args: ["login"]
		},
		loginHint: "Run `codex login` or configure Codex the way you normally use it.",
		buildArgs: (prompt) => [
			"exec",
			"--json",
			prompt
		]
	},
	{
		id: "claude",
		label: "Claude Code",
		bin: "claude",
		authCheck: {
			command: "claude",
			args: ["auth", "status"],
			okExitCodes: [0]
		},
		loginCommand: {
			command: "claude",
			args: ["auth", "login"]
		},
		loginHint: "Run `claude auth login`.",
		buildArgs: (prompt, opts) => [
			"-p",
			"--output-format",
			"stream-json",
			"--max-turns",
			String(opts.maxTurns),
			prompt
		]
	},
	{
		id: "opencode",
		label: "OpenCode",
		bin: "opencode",
		loginCommand: {
			command: "opencode",
			args: ["auth", "login"]
		},
		loginHint: "Run `opencode auth login`.",
		buildArgs: (prompt) => ["run", prompt]
	}
];
const providerIds = () => PROVIDERS.map((provider) => provider.id);
const commandExists = (bin) => {
	const result = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
		encoding: "utf-8",
		timeout: PROVIDER_PROBE_TIMEOUT_MS
	});
	return !result.error && result.status === 0;
};
const readVersion = (bin) => {
	const result = spawnSync(bin, ["--version"], {
		encoding: "utf-8",
		timeout: PROVIDER_PROBE_TIMEOUT_MS
	});
	if (result.error || result.status !== 0) return null;
	return (result.stdout || result.stderr).trim().split("\n")[0]?.trim() || null;
};
const checkAuth = (provider) => {
	if (!provider.authCheck) return null;
	const result = spawnSync(provider.authCheck.command, provider.authCheck.args, {
		encoding: "utf-8",
		timeout: PROVIDER_PROBE_TIMEOUT_MS
	});
	return (provider.authCheck.okExitCodes ?? [0]).includes(result.status ?? 1);
};
const getProviderStatuses = () => PROVIDERS.map((provider) => {
	const installed = commandExists(provider.bin);
	const authenticated = installed ? checkAuth(provider) : false;
	return {
		provider,
		installed,
		authenticated,
		version: installed ? readVersion(provider.bin) : null,
		authHint: installed && authenticated === false ? provider.loginHint : null
	};
});
const resolveProvider = (selection, statuses = getProviderStatuses()) => {
	if (selection !== "auto") return statuses.find((status) => status.provider.id === selection) ?? null;
	return statuses.find((status) => status.installed && status.authenticated !== false) ?? statuses.find((status) => status.installed) ?? null;
};
//#endregion
//#region src/agents/provider-preference.ts
const agentProviderPreferencePath = (root) => path.join(root, ".aislop", "agent", "provider.json");
const isProviderId = (value) => typeof value === "string" && providerIds().includes(value);
const readAgentProviderPreference = (root) => {
	const file = agentProviderPreferencePath(root);
	if (!fs.existsSync(file)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!isProviderId(parsed.provider)) return null;
		return {
			provider: parsed.provider,
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
		};
	} catch {
		return null;
	}
};
const writeAgentProviderPreference = (root, provider, date = /* @__PURE__ */ new Date()) => {
	const preference = {
		provider,
		updatedAt: date.toISOString()
	};
	const file = agentProviderPreferencePath(root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(preference, null, 2)}\n`, "utf-8");
	return preference;
};
const clearAgentProviderPreference = (root) => {
	const file = agentProviderPreferencePath(root);
	if (!fs.existsSync(file)) return false;
	fs.unlinkSync(file);
	return true;
};
const resolveAgentProviderSelection = (input) => {
	const preference = readAgentProviderPreference(input.root);
	if (input.explicit) return {
		selection: input.requested,
		source: "cli",
		preference
	};
	if (preference) return {
		selection: preference.provider,
		source: "preference",
		preference
	};
	return {
		selection: input.requested,
		source: "auto",
		preference: null
	};
};
//#endregion
//#region src/utils/subprocess.ts
const DEFAULT_CHUNK_MAX_FILES = 200;
const DEFAULT_CHUNK_MAX_CHARS = 25e3;
const chunkFilePaths = (filePaths, maxFiles = DEFAULT_CHUNK_MAX_FILES, maxChars = DEFAULT_CHUNK_MAX_CHARS) => {
	const chunks = [];
	let current = [];
	let currentChars = 0;
	for (const filePath of filePaths) {
		const addedChars = filePath.length + 1;
		if (current.length > 0 && (current.length >= maxFiles || currentChars + addedChars > maxChars)) {
			chunks.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(filePath);
		currentChars += addedChars;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
};
const killProcessTree = (child) => {
	if (process.platform === "win32") {
		if (child.pid === void 0) {
			child.kill("SIGTERM");
			return;
		}
		spawn("taskkill", [
			"/pid",
			String(child.pid),
			"/T",
			"/F"
		], {
			stdio: "ignore",
			windowsHide: true
		}).once("error", () => {});
		return;
	}
	if (child.pid === void 0) {
		child.kill("SIGTERM");
		setTimeout(() => child.kill("SIGKILL"), 1e3).unref();
		return;
	}
	const pid = child.pid;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, 1e3).unref();
};
const activeChildren = /* @__PURE__ */ new Set();
const killActiveChildren = () => {
	for (const child of activeChildren) killProcessTree(child);
	activeChildren.clear();
};
const createOutputCapture = () => {
	const tempDir = mkdtempSync(path.join(tmpdir(), "aislop-"));
	const stdoutPath = path.join(tempDir, "stdout.log");
	const stderrPath = path.join(tempDir, "stderr.log");
	let outFd;
	try {
		outFd = openSync(stdoutPath, "w");
		const errFd = openSync(stderrPath, "w");
		return {
			tempDir,
			stdoutPath,
			stderrPath,
			outFd,
			errFd
		};
	} catch (error) {
		if (outFd !== void 0) try {
			closeSync(outFd);
		} catch {}
		try {
			rmSync(tempDir, {
				recursive: true,
				force: true
			});
		} catch {}
		throw error;
	}
};
const isMissingToolError = (error) => error instanceof Error && error.code === "ENOENT";
const warnSubprocessFailure = (tool, error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`aislop: ${tool} failed to run and was skipped: ${message}`);
};
const runSubprocess = (command, args, options = {}) => {
	return new Promise((resolve, reject) => {
		let capture;
		try {
			capture = createOutputCapture();
		} catch (error) {
			reject(/* @__PURE__ */ new Error(`Failed to prepare output capture for ${command}: ${error.message}`));
			return;
		}
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				...options.env
			},
			stdio: [
				"ignore",
				capture.outFd,
				capture.errFd
			],
			windowsHide: true,
			detached: process.platform !== "win32"
		});
		activeChildren.add(child);
		let cleanedUp = false;
		const cleanup = () => {
			if (cleanedUp) return {
				stdout: "",
				stderr: ""
			};
			cleanedUp = true;
			activeChildren.delete(child);
			closeSync(capture.outFd);
			closeSync(capture.errFd);
			const stdout = readFileSync(capture.stdoutPath, "utf-8").trim();
			const stderr = readFileSync(capture.stderrPath, "utf-8").trim();
			try {
				rmSync(capture.tempDir, {
					recursive: true,
					force: true
				});
			} catch {}
			return {
				stdout,
				stderr
			};
		};
		let settled = false;
		let timer;
		const finalize = (callback) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			callback();
		};
		if (options.timeout && options.timeout > 0) {
			timer = setTimeout(() => {
				setImmediate(() => {
					if (settled) return;
					if (child.exitCode !== null || child.signalCode !== null) return;
					killProcessTree(child);
					finalize(() => reject(/* @__PURE__ */ new Error(`Command timed out after ${options.timeout}ms: ${command}`)));
				});
			}, options.timeout);
			timer.unref();
		}
		child.once("error", (error) => {
			cleanup();
			finalize(() => {
				const wrapped = /* @__PURE__ */ new Error(`Failed to run ${command}: ${error.message}`);
				if (error.code) wrapped.code = error.code;
				reject(wrapped);
			});
		});
		child.once("close", (code) => {
			const { stdout, stderr } = cleanup();
			finalize(() => resolve({
				stdout,
				stderr,
				exitCode: code
			}));
		});
	});
};
const isToolInstalled = async (tool) => {
	try {
		const command = process.platform === "win32" ? "where.exe" : "which";
		const result = await runSubprocess(command, [tool]);
		return result.exitCode === 0 && result.stdout.length > 0;
	} catch {
		return false;
	}
};
//#endregion
//#region src/agents/worktree.ts
const timestamp = () => (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const readDirty = async (gitRoot) => {
	return (await runSubprocess("git", ["status", "--porcelain"], { cwd: gitRoot })).stdout.trim().length > 0;
};
const splitNull = (value) => value.split("\0").filter(Boolean);
const unique = (values) => [...new Set(values)];
const parseStatusPaths = (stdout) => {
	const records = splitNull(stdout);
	const paths = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? "";
		const status = record.slice(0, 2);
		const filePath = record.slice(3);
		if (!filePath) continue;
		paths.push(filePath);
		if (status.includes("R") || status.includes("C")) index += 1;
	}
	return unique(paths);
};
const readUntrackedFiles = async (cwd) => {
	const result = await runSubprocess("git", [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z"
	], { cwd });
	if (result.exitCode !== 0) return [];
	return splitNull(result.stdout);
};
const runGit$1 = async (cwd, args, timeout) => {
	const result = await runSubprocess("git", args, {
		cwd,
		timeout
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed.`);
	return result.stdout;
};
const readDiffIncludingUntracked = async (cwd, args, timeout) => {
	const untrackedFiles = await readUntrackedFiles(cwd);
	const cached = await runGit$1(cwd, [
		"diff",
		"--cached",
		...args
	], timeout);
	if (untrackedFiles.length === 0) return [cached, await runGit$1(cwd, ["diff", ...args], timeout)].filter(Boolean).join("\n");
	await runGit$1(cwd, [
		"add",
		"--intent-to-add",
		"--",
		...untrackedFiles
	], timeout);
	try {
		return [cached, await runGit$1(cwd, ["diff", ...args], timeout)].filter(Boolean).join("\n");
	} finally {
		await runGit$1(cwd, [
			"reset",
			"--",
			...untrackedFiles
		], timeout);
	}
};
const readGitState = async (cwd) => {
	const root = await runSubprocess("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (root.exitCode !== 0 || !root.stdout) throw new Error("aislop agent needs to run inside a git repository.");
	const gitRoot = root.stdout.trim();
	const [branch, head, status, gitCommonDir] = await Promise.all([
		runSubprocess("git", ["branch", "--show-current"], { cwd: gitRoot }),
		runSubprocess("git", [
			"rev-parse",
			"--short",
			"HEAD"
		], { cwd: gitRoot }),
		runSubprocess("git", ["status", "--porcelain"], { cwd: gitRoot }),
		runSubprocess("git", ["rev-parse", "--git-common-dir"], { cwd: gitRoot })
	]);
	const commonDir = gitCommonDir.stdout.trim();
	const nativeRoot = fs.realpathSync.native(gitRoot);
	return {
		root: nativeRoot,
		gitCommonDir: path.isAbsolute(commonDir) ? commonDir : path.resolve(nativeRoot, commonDir),
		branch: branch.stdout.trim() || null,
		head: head.stdout.trim(),
		dirty: status.stdout.trim().length > 0
	};
};
const ensureLocalAislopExclude = (gitCommonDir) => {
	const excludePath = path.join(gitCommonDir, "info", "exclude");
	fs.mkdirSync(path.dirname(excludePath), { recursive: true });
	const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
	const missingEntries = [
		".aislop/worktrees/",
		".aislop/agent/sessions/",
		".aislop/agent/logs/",
		".aislop/agent/monitors/",
		".aislop/agent/provider.json"
	].filter((entry) => !existing.split("\n").includes(entry));
	if (missingEntries.length === 0) return;
	const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	fs.appendFileSync(excludePath, `${prefix}# aislop local agent sessions and worktrees\n${missingEntries.join("\n")}\n`, "utf-8");
};
const prepareAgentLocalState = async (cwd) => {
	const state = await readGitState(cwd);
	ensureLocalAislopExclude(state.gitCommonDir);
	return { root: state.root };
};
const readAgentRoot = async (cwd) => {
	return { root: (await readGitState(cwd)).root };
};
const createAgentWorktree = async (cwd, opts) => {
	const state = await readGitState(cwd);
	ensureLocalAislopExclude(state.gitCommonDir);
	state.dirty = await readDirty(state.root);
	if (opts.inPlace) return {
		state,
		worktree: {
			originalRoot: state.root,
			path: state.root,
			name: "current",
			created: false
		}
	};
	if (state.dirty) throw new Error("Current worktree has uncommitted changes. Commit/stash them, or rerun with --in-place if you want aislop agent to edit here.");
	const name = `agent-${timestamp()}-${process.pid}`;
	const worktreeRoot = path.join(state.root, ".aislop", "worktrees");
	const worktreePath = path.join(worktreeRoot, name);
	fs.mkdirSync(worktreeRoot, { recursive: true });
	const result = await runSubprocess("git", [
		"worktree",
		"add",
		"--detach",
		worktreePath,
		"HEAD"
	], {
		cwd: state.root,
		timeout: 6e4
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Failed to create git worktree.");
	return {
		state,
		worktree: {
			originalRoot: state.root,
			path: worktreePath,
			name,
			created: true
		}
	};
};
const removeAgentWorktree = async (worktree) => {
	if (!worktree.created) return;
	await runSubprocess("git", [
		"worktree",
		"remove",
		"--force",
		worktree.path
	], {
		cwd: worktree.originalRoot,
		timeout: 6e4
	});
};
const diffNameOnly = async (cwd) => {
	const result = await runSubprocess("git", [
		"status",
		"--porcelain=v1",
		"-z"
	], { cwd });
	if (result.exitCode !== 0) return [];
	return parseStatusPaths(result.stdout);
};
const parseNumstatValue = (value) => {
	if (value === "-") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};
const diffNumstat = async (cwd) => {
	const stdout = await readDiffIncludingUntracked(cwd, ["--numstat"]);
	const stats = /* @__PURE__ */ new Map();
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const [rawAdditions, rawDeletions, ...pathParts] = line.split("	");
		const filePath = pathParts.join("	");
		if (!filePath) continue;
		const additions = parseNumstatValue(rawAdditions ?? "");
		const deletions = parseNumstatValue(rawDeletions ?? "");
		const existing = stats.get(filePath);
		stats.set(filePath, {
			filePath,
			additions: existing?.additions === null || additions === null ? null : (existing?.additions ?? 0) + additions,
			deletions: existing?.deletions === null || deletions === null ? null : (existing?.deletions ?? 0) + deletions,
			binary: existing?.binary === true || additions === null || deletions === null
		});
	}
	return stats;
};
const readBinaryDiff = async (cwd) => {
	const patch = await readDiffIncludingUntracked(cwd, ["--binary"], 6e4);
	return patch.length > 0 ? `${patch}\n` : patch;
};
//#endregion
//#region src/ui/theme.ts
const TRUECOLOR = {
	accent: (s) => `\x1B[38;2;34;197;94m${s}\x1B[39m`,
	accentDim: (s) => `\x1B[38;2;22;163;74m${s}\x1B[39m`,
	fg: (s) => s,
	muted: (s) => `\x1B[38;2;113;113;122m${s}\x1B[39m`,
	danger: (s) => `\x1B[38;2;239;68;68m${s}\x1B[39m`,
	warn: (s) => `\x1B[38;2;234;179;8m${s}\x1B[39m`,
	info: (s) => `\x1B[38;2;56;189;248m${s}\x1B[39m`,
	section: (s) => `\x1B[1;34m${s}\x1B[0m`,
	success: (s) => `\x1B[38;2;34;197;94m${s}\x1B[39m`,
	bold: pc.bold,
	dim: pc.dim
};
const C256 = {
	accent: (s) => `\x1B[38;5;10m${s}\x1B[39m`,
	accentDim: (s) => `\x1B[38;5;22m${s}\x1B[39m`,
	fg: (s) => s,
	muted: (s) => `\x1B[38;5;244m${s}\x1B[39m`,
	danger: (s) => `\x1B[38;5;9m${s}\x1B[39m`,
	warn: (s) => `\x1B[38;5;11m${s}\x1B[39m`,
	info: (s) => `\x1B[38;5;14m${s}\x1B[39m`,
	section: (s) => `\x1B[1;34m${s}\x1B[0m`,
	success: (s) => `\x1B[38;5;10m${s}\x1B[39m`,
	bold: pc.bold,
	dim: pc.dim
};
const identity = (s) => s;
const NONE = {
	accent: identity,
	accentDim: identity,
	fg: identity,
	muted: identity,
	danger: identity,
	warn: identity,
	info: identity,
	section: identity,
	success: identity,
	bold: identity,
	dim: identity
};
const detectMode = (tty, env) => {
	if (env.NO_COLOR) return "none";
	if (env.FORCE_COLOR === "0") return "none";
	if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return env.FORCE_COLOR === "3" ? "truecolor" : "256";
	if (!tty) return "none";
	if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
	return "256";
};
const createTheme = (opts = {}) => {
	const env = opts.env ?? process.env;
	const tty = opts.tty ?? Boolean(process.stdout.isTTY);
	const requested = opts.color ?? "auto";
	const mode = requested === "auto" ? detectMode(tty, env) : requested;
	return {
		mode,
		paint: mode === "truecolor" ? TRUECOLOR : mode === "256" ? C256 : NONE
	};
};
const style$1 = (theme, token, text) => theme.paint[token](text);
const theme = createTheme();
//#endregion
//#region src/ui/brand.ts
const AISLOP_COMMAND_TOKEN = /(?<![.\w/-])aislop(?![\w/-])/g;
const highlightAislop = (text, theme, baseToken) => {
	let lastIndex = 0;
	let out = "";
	for (const match of text.matchAll(AISLOP_COMMAND_TOKEN)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			const chunk = text.slice(lastIndex, index);
			out += baseToken ? style$1(theme, baseToken, chunk) : chunk;
		}
		out += style$1(theme, "accent", match[0]);
		lastIndex = index + match[0].length;
	}
	if (lastIndex === 0) return baseToken ? style$1(theme, baseToken, text) : text;
	const tail = text.slice(lastIndex);
	return out + (baseToken ? style$1(theme, baseToken, tail) : tail);
};
//#endregion
//#region src/ui/width.ts
const ANSI_RE$1 = new RegExp(`\\[[0-9;]*m`, "g");
const stripAnsi$1 = (s) => s.replace(ANSI_RE$1, "");
const stringWidth = (s) => {
	const bare = stripAnsi$1(s);
	let total = 0;
	for (const ch of bare) {
		const w = wcwidth(ch.codePointAt(0) ?? 0);
		total += w > 0 ? w : 1;
	}
	return total;
};
const padEnd = (s, target, fill = " ") => {
	const w = stringWidth(s);
	if (w >= target) return s;
	return s + fill.repeat(target - w);
};
const truncate = (s, max, ellipsis = "…") => {
	if (stringWidth(s) <= max) return s;
	const limit = Math.max(0, max - stringWidth(ellipsis));
	let out = "";
	let w = 0;
	for (const ch of s) {
		const cw = wcwidth(ch.codePointAt(0) ?? 0);
		if (w + cw > limit) break;
		out += ch;
		w += cw;
	}
	return out + ellipsis;
};
//#endregion
//#region src/ui/display.ts
const renderDisplaySection = (label, deps = {}) => {
	return style$1(deps.theme ?? theme, "section", label);
};
const renderDisplayRows = (rows, options = {}) => {
	if (rows.length === 0) return [];
	const t = options.theme ?? theme;
	const indent = " ".repeat(options.indent ?? 3);
	const labelWidth = options.labelWidth ?? Math.max(...rows.map((row) => row.label.length));
	return rows.map((row) => {
		const label = style$1(t, "muted", padEnd(row.label, labelWidth));
		const value = highlightAislop(row.value, t, row.valueToken);
		return `${indent}${label}  ${value}`;
	});
};
const renderDisplayStatusItems = (items, options = {}) => {
	const t = options.theme ?? theme;
	const itemIndent = " ".repeat(options.itemIndent ?? 1);
	const labelWidth = options.labelWidth ?? Math.max(0, ...items.flatMap((item) => item.rows.map((row) => row.label.length)));
	const rowOptions = {
		theme: t,
		indent: options.indent ?? 3,
		labelWidth: labelWidth > 0 ? labelWidth : void 0
	};
	const lines = [];
	for (const [index, item] of items.entries()) {
		lines.push(`${itemIndent}${item.marker} ${style$1(t, "bold", item.label)}`);
		lines.push(...renderDisplayRows(item.rows, rowOptions));
		if (options.itemGap !== false && index < items.length - 1) lines.push("");
	}
	return lines;
};
const renderDisplayCommandRows = (rows, options = {}) => renderDisplayRows(rows.map((row) => ({
	label: row.label,
	value: row.command
})), options);
//#endregion
//#region src/ui/header.ts
const TAGLINE = "the quality gate for agentic coding";
const renderHeader = (input, _deps = {}) => {
	const t = _deps.theme ?? theme;
	const sep = style$1(t, "accent", "·");
	const brand = style$1(t, "accent", "aislop");
	const version = style$1(t, "accentDim", input.version);
	const showBrand = input.brand !== false;
	const brandLine = ` ${brand} ${version}  ${sep}  ${TAGLINE}`;
	if (input.command === "--bare") return showBrand ? `${brandLine}\n\n` : "";
	const contextParts = [input.command, ...input.context].filter((p) => p && p.length > 0);
	const subLine = contextParts.length > 0 ? ` ${contextParts.map((p, i) => i === 0 ? style$1(t, "fg", p) : style$1(t, "muted", p)).join(`  ${sep}  `)}` : "";
	if (!showBrand) return subLine ? `${subLine}\n\n` : "";
	return subLine ? `${brandLine}\n\n${subLine}\n\n` : `${brandLine}\n\n`;
};
//#endregion
//#region src/ui/symbols.ts
const TTY = {
	stepActive: "◇",
	stepDone: "◆",
	rail: "│",
	railEnd: "└",
	bullet: "●",
	hint: "→",
	pass: "✓",
	fail: "✗",
	warn: "!",
	pending: "•",
	engineActive: "⏵",
	neutral: "─"
};
const PLAIN = {
	stepActive: "*",
	stepDone: "*",
	rail: "|",
	railEnd: "+",
	bullet: "-",
	hint: "->",
	pass: "[ok]",
	fail: "[x]",
	warn: "[!]",
	pending: "-",
	engineActive: ">",
	neutral: "-"
};
const createSymbols = (opts = {}) => opts.plain ? PLAIN : TTY;
const isPlain = () => process.env.THEME === "plain" || Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;
const symbols = createSymbols({ plain: isPlain() });
//#endregion
//#region src/ui/logger.ts
/**
* Render a single accent-green `→` hint line, consistent across every command.
* Callers typically do: `process.stdout.write(renderHintLine("Run ..."))`.
*/
const renderHintLine = (hint, deps = {}) => {
	const t = deps.theme ?? theme;
	return ` ${style$1(t, "accent", (deps.symbols ?? symbols).hint)} ${highlightAislop(hint, t)}\n`;
};
const createLogger = (deps = {}) => {
	const t = deps.theme ?? theme;
	const s = deps.symbols ?? symbols;
	const write = deps.write ?? ((out) => process.stdout.write(out));
	const line = (glyph, token, msg) => {
		write(` ${style$1(t, token, glyph)} ${highlightAislop(msg, t)}\n`);
	};
	return {
		success: (msg) => line(s.pass, "success", msg),
		error: (msg) => line(s.fail, "danger", msg),
		warn: (msg) => line(s.warn, "warn", msg),
		info: (msg) => line(s.bullet, "info", msg),
		hint: (msg) => line(s.hint, "accent", msg),
		muted: (msg) => write(` ${highlightAislop(msg, t, "muted")}\n`),
		step: (msg) => line(s.stepActive, "accent", msg),
		break: () => write("\n"),
		raw: (msg) => write(`${msg}\n`)
	};
};
const log = createLogger();
//#endregion
//#region src/version.ts
const APP_VERSION = "0.16.1-agentic";
//#endregion
//#region src/commands/agent-connect.ts
const commandText = (status) => [status.provider.loginCommand.command, ...status.provider.loginCommand.args].join(" ");
const resolveConnectProvider = (selection, statuses = getProviderStatuses()) => {
	if (selection === "auto") return resolveProvider(selection, statuses);
	return statuses.find((status) => status.provider.id === selection) ?? null;
};
const renderConnectPlan = (status) => {
	const state = status.installed ? status.authenticated === false ? "installed, auth needed" : "installed" : "not installed";
	return [
		renderDisplaySection("Plan"),
		...renderDisplayRows([
			{
				label: "Provider",
				value: status.provider.label
			},
			{
				label: "State",
				value: state
			},
			...status.version ? [{
				label: "Version",
				value: status.version
			}] : [],
			{
				label: "Command",
				value: commandText(status)
			}
		], {
			indent: 3,
			labelWidth: 8
		}),
		""
	].join("\n");
};
const agentConnectCommand = async (provider, options) => {
	process.stdout.write(renderHeader({
		version: APP_VERSION,
		command: "Agent connect",
		context: [provider]
	}));
	const selected = resolveConnectProvider(provider);
	if (!selected) {
		log.error(`Unknown provider. Use one of: auto, ${providerIds().join(", ")}.`);
		process.exitCode = 1;
		return;
	}
	if (options.dryRun) {
		process.stdout.write(renderConnectPlan(selected));
		return;
	}
	if (!selected.installed) {
		log.error(`${selected.provider.label} is not installed on PATH.`);
		log.muted(`Install ${selected.provider.bin}, then run \`${commandText(selected)}\`.`);
		process.exitCode = 1;
		return;
	}
	if (selected.authenticated === true) {
		log.success(`${selected.provider.label} is already connected.`);
		if (selected.version) log.muted(selected.version);
		return;
	}
	log.raw(`Running ${style$1(theme, "bold", commandText(selected))}`);
	const result = spawnSync(selected.provider.loginCommand.command, selected.provider.loginCommand.args, {
		stdio: "inherit",
		env: process.env
	});
	if (result.error || result.status !== 0) {
		log.error(result.error?.message || `${selected.provider.label} connect command exited ${result.status ?? "unknown"}.`);
		process.exitCode = result.status ?? 1;
		return;
	}
	const refreshed = resolveConnectProvider(selected.provider.id);
	if (refreshed?.authenticated === false) {
		log.warn(`${selected.provider.label} still reports auth as incomplete.`);
		log.muted(refreshed.provider.loginHint);
		return;
	}
	log.success(`${selected.provider.label} connect command finished.`);
	log.muted("Run `aislop agent providers` to inspect local provider status.");
	log.muted(`Set it as the repo default with \`aislop agent use ${selected.provider.id}\`.`);
};
//#endregion
//#region src/agents/session.ts
const pad$1 = (value) => String(value).padStart(2, "0");
const buildAgentSessionId = (date = /* @__PURE__ */ new Date(), pid = process.pid) => [
	`${date.getFullYear()}${pad$1(date.getMonth() + 1)}${pad$1(date.getDate())}`,
	`${pad$1(date.getHours())}${pad$1(date.getMinutes())}${pad$1(date.getSeconds())}`,
	String(pid)
].join("-");
const summarizeAgentFinding = (diagnostic) => ({
	filePath: diagnostic.filePath,
	rule: diagnostic.rule,
	engine: diagnostic.engine,
	severity: diagnostic.severity,
	message: diagnostic.message,
	line: diagnostic.line,
	column: diagnostic.column,
	fixable: diagnostic.fixable
});
const createAgentSessionRecorder = (root, options = {}) => {
	const id = options.id ?? buildAgentSessionId(options.date, options.pid);
	const sessionDir = path.join(root, ".aislop", "agent", "sessions");
	const sessionPath = path.join(sessionDir, `${id}.jsonl`);
	fs.mkdirSync(sessionDir, { recursive: true });
	const append = (type, payload = {}) => {
		const event = {
			type,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			sessionId: id,
			...payload
		};
		fs.appendFileSync(sessionPath, `${JSON.stringify(event)}\n`, "utf-8");
	};
	return {
		id,
		path: sessionPath,
		append
	};
};
//#endregion
//#region src/commands/agent-background.ts
const cliPath$2 = () => {
	const arg = process.argv[1];
	if (arg && fs.existsSync(arg)) return arg;
	return path.resolve("dist/cli.js");
};
const addFlag$1 = (args, flag, enabled) => {
	if (enabled) args.push(flag);
};
const addOption$1 = (args, flag, value) => {
	if (value === void 0 || value === "") return;
	args.push(flag, String(value));
};
const buildBackgroundAgentArgs = (directory, options) => {
	const args = ["agent", directory];
	addOption$1(args, "--provider", options.provider);
	addOption$1(args, "--target-score", options.targetScore);
	addOption$1(args, "--max-turns", options.maxTurns);
	addOption$1(args, "--limit", options.limit);
	addFlag$1(args, "--in-place", options.inPlace);
	addFlag$1(args, "--apply", options.apply);
	addFlag$1(args, "--yes", options.yes);
	addFlag$1(args, "--no-fix", options.noFix);
	addFlag$1(args, "--commit", options.commit && !options.pr);
	addFlag$1(args, "--pr", options.pr);
	addOption$1(args, "--branch", options.branch);
	addOption$1(args, "--base", options.base);
	addOption$1(args, "--commit-message", options.commitMessage);
	addOption$1(args, "--title", options.prTitle);
	addFlag$1(args, "--ready", options.ready);
	addFlag$1(args, "--no-keep-worktree", !options.keepWorktree);
	addFlag$1(args, "--cleanup", options.cleanup);
	return args;
};
const launchAgentInBackground = async (directory, options) => {
	if (options.apply && !options.yes) throw new Error("Background apply cannot prompt. Re-run with `--apply --yes`.");
	const { root } = await prepareAgentLocalState(directory);
	const session = createAgentSessionRecorder(root);
	const logDir = path.join(root, ".aislop", "agent", "logs");
	fs.mkdirSync(logDir, { recursive: true });
	const logPath = path.join(logDir, `${session.id}.log`);
	const logFd = fs.openSync(logPath, "a");
	session.append("session.queued", {
		mode: "background",
		root,
		requestedDirectory: path.resolve(directory),
		providerSelection: options.provider,
		providerSource: options.providerSource,
		providerPreference: options.providerPreference,
		targetScore: options.targetScore,
		maxTurns: options.maxTurns,
		limit: options.limit,
		logPath,
		publish: {
			commit: options.commit,
			pr: options.pr,
			branch: options.branch,
			base: options.base,
			ready: options.ready
		}
	});
	const child = spawn(process.execPath, [cliPath$2(), ...buildBackgroundAgentArgs(directory, options)], {
		cwd: root,
		detached: true,
		env: {
			...process.env,
			AISLOP_AGENT_BACKGROUND: "1",
			AISLOP_AGENT_SESSION_ID: session.id,
			AISLOP_NO_TELEMETRY: "1",
			AISLOP_NO_UPDATE_NOTIFIER: "1",
			NO_COLOR: "1"
		},
		stdio: [
			"ignore",
			logFd,
			logFd
		]
	});
	child.unref();
	fs.closeSync(logFd);
	session.append("background.started", {
		pid: child.pid,
		logPath
	});
	return {
		sessionId: session.id,
		transcriptPath: session.path,
		logPath,
		pid: child.pid
	};
};
const renderBackgroundLaunch = (launch) => {
	process.stdout.write(`${[
		renderDisplaySection("Background session"),
		...renderDisplayRows([
			{
				label: "Session",
				value: launch.sessionId
			},
			...launch.pid ? [{
				label: "PID",
				value: String(launch.pid)
			}] : [],
			{
				label: "Transcript",
				value: launch.transcriptPath
			},
			{
				label: "Log",
				value: launch.logPath
			}
		]),
		"",
		renderDisplaySection("Next"),
		...renderDisplayCommandRows([{
			label: "Inspect",
			command: `aislop agent show ${launch.sessionId}`
		}, {
			label: "List",
			command: "aislop agent sessions"
		}]),
		""
	].join("\n")}`);
};
//#endregion
//#region src/agents/prompt.ts
const CONTEXT_LINES$1 = 3;
const MAX_DIAGNOSTICS_PER_FILE$1 = 6;
const MAX_FILES$1 = 12;
const priority = (diagnostic) => {
	if (diagnostic.severity === "error") return 0;
	if (diagnostic.severity === "warning") return 1;
	return 2;
};
const selectAgentFindings = (diagnostics, limit) => diagnostics.filter((diagnostic) => diagnostic.severity !== "info").sort((a, b) => {
	const severityDelta = priority(a) - priority(b);
	if (severityDelta !== 0) return severityDelta;
	if (a.fixable !== b.fixable) return a.fixable ? 1 : -1;
	return a.filePath.localeCompare(b.filePath);
}).slice(0, Math.max(1, limit));
const groupByFile$1 = (diagnostics) => {
	const groups = /* @__PURE__ */ new Map();
	for (const diagnostic of diagnostics) {
		const list = groups.get(diagnostic.filePath) ?? [];
		list.push(diagnostic);
		groups.set(diagnostic.filePath, list);
	}
	return [...groups.entries()].map(([filePath, items]) => ({
		filePath,
		diagnostics: items
	})).slice(0, MAX_FILES$1);
};
const snippetFor = (rootDirectory, diagnostic) => {
	if (diagnostic.line <= 0) return null;
	const absolutePath = path.resolve(rootDirectory, diagnostic.filePath);
	let content;
	try {
		content = fs.readFileSync(absolutePath, "utf-8");
	} catch {
		return null;
	}
	const lines = content.split("\n");
	const start = Math.max(0, diagnostic.line - 1 - CONTEXT_LINES$1);
	const end = Math.min(lines.length, diagnostic.line + CONTEXT_LINES$1);
	const out = [];
	for (let index = start; index < end; index += 1) {
		const lineNumber = index + 1;
		const marker = lineNumber === diagnostic.line ? ">" : " ";
		out.push(`${marker} ${String(lineNumber).padStart(4)} | ${lines[index]}`);
	}
	return out.join("\n");
};
const buildRepairPrompt = (input) => {
	const groups = groupByFile$1(input.findings);
	const lines = [
		"You are repairing AI slop findings in a local git worktree.",
		"",
		`Current aislop score: ${input.score == null ? "not scored" : `${input.score}/100`}`,
		`Target score: ${input.targetScore}/100`,
		`Turn budget: ${input.maxTurns}`,
		"",
		"Hard constraints:",
		"- Make the smallest code changes that improve the findings below.",
		"- Do not change public APIs, exports, database schemas, or test expectations unless a finding directly requires it.",
		"- Do not delete tests.",
		"- Do not add dependencies unless the existing project already clearly expects them.",
		"- If a finding looks like a false positive, leave the code alone and mention it in your final summary.",
		"- Run the relevant local verification command if it is obvious and cheap.",
		"",
		"aislop findings to repair:",
		""
	];
	for (const group of groups) {
		lines.push(`## ${group.filePath}`);
		for (const diagnostic of group.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE$1)) {
			const location = diagnostic.line > 0 ? `:${diagnostic.line}` : "";
			lines.push(`- ${diagnostic.severity.toUpperCase()} ${diagnostic.rule}${location}: ${diagnostic.message}`);
			if (diagnostic.help) lines.push(`  Help: ${diagnostic.help}`);
			const snippet = snippetFor(input.rootDirectory, diagnostic);
			if (snippet) {
				lines.push("```");
				lines.push(snippet);
				lines.push("```");
			}
		}
		lines.push("");
	}
	if (input.findings.length === 0) lines.push("No findings were supplied. Inspect the codebase for obvious AI slop only if needed.");
	lines.push("After editing, stop and summarize what changed and what you intentionally skipped.");
	return lines.join("\n");
};
//#endregion
//#region src/agents/publish.ts
const defaultBranchSuffix = () => (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const normalizeBranchName = (raw) => {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/\/+/g, "/").replace(/^-+|-+$/g, "").replace(/^\/+|\/+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 120) : `aislop/agent-${defaultBranchSuffix()}`;
};
const defaultBranchName = () => `aislop/agent-${defaultBranchSuffix()}`;
const runGit = async (cwd, args) => {
	const result = await runSubprocess("git", args, {
		cwd,
		timeout: 9e4
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	return result.stdout;
};
const currentBranch = async (cwd) => {
	const result = await runSubprocess("git", ["branch", "--show-current"], { cwd });
	if (result.exitCode !== 0) return null;
	return result.stdout.trim() || null;
};
const resolveBaseBranch = async (cwd, fallback) => {
	const remote = await runSubprocess("git", [
		"remote",
		"show",
		"origin"
	], {
		cwd,
		timeout: 3e4
	});
	if (remote.exitCode === 0) {
		const branch = remote.stdout.split("\n").find((entry) => entry.trim().startsWith("HEAD branch:"))?.split(":").slice(1).join(":").trim();
		if (branch) return branch;
	}
	return fallback ?? "main";
};
const ensureBranch = async (cwd, branch) => {
	if (await currentBranch(cwd) === branch) return;
	await runGit(cwd, [
		"switch",
		"-c",
		branch
	]);
};
const ensureGh = async () => {
	if ((await runSubprocess("gh", ["--version"], { timeout: 1e4 })).exitCode !== 0) throw new Error("Creating a PR requires the GitHub CLI. Install and authenticate `gh`, then retry.");
};
const buildPrBody = (input) => {
	const score = `${input.beforeScore ?? "not scored"} -> ${input.afterScore ?? "not scored"}`;
	return [
		"This PR was generated locally by `aislop agent`.",
		"",
		"## Summary",
		"",
		`- Provider: ${input.providerId}`,
		`- Score: ${score}`,
		`- Files changed: ${input.changedFiles.length}`,
		"",
		"## Changed files",
		"",
		...input.changedFiles.map((file) => `- ${file}`),
		"",
		"## Verification",
		"",
		"- `aislop scan --json`",
		"",
		"Review before merging. The deterministic scan is the gate; the provider only proposed the patch."
	].join("\n");
};
const publishAgentDiff = async (input) => {
	if (!input.options.commit && !input.options.pr) return null;
	if (input.changedFiles.length === 0) return null;
	const branch = normalizeBranchName(input.options.branch ?? defaultBranchName());
	await ensureBranch(input.cwd, branch);
	await runGit(input.cwd, ["add", "-A"]);
	if ((await runSubprocess("git", [
		"diff",
		"--cached",
		"--quiet"
	], { cwd: input.cwd })).exitCode === 0) return null;
	await runGit(input.cwd, [
		"commit",
		"-m",
		input.options.commitMessage,
		"-m",
		"Generated by aislop agent."
	]);
	const commitSha = (await runGit(input.cwd, [
		"rev-parse",
		"--short",
		"HEAD"
	])).trim();
	if (!input.options.pr) return {
		branch,
		commitSha,
		pushed: false,
		prUrl: null
	};
	await ensureGh();
	const base = input.options.base ?? await resolveBaseBranch(input.cwd, input.originalBranch);
	await runGit(input.cwd, [
		"push",
		"-u",
		"origin",
		branch
	]);
	const args = [
		"pr",
		"create",
		"--base",
		base,
		"--head",
		branch,
		"--title",
		input.options.prTitle ?? input.options.commitMessage,
		"--body",
		buildPrBody(input)
	];
	if (!input.options.ready) args.push("--draft");
	const pr = await runSubprocess("gh", args, {
		cwd: input.cwd,
		timeout: 9e4
	});
	if (pr.exitCode !== 0) throw new Error(pr.stderr || pr.stdout || "Failed to create pull request with gh.");
	return {
		branch,
		commitSha,
		pushed: true,
		prUrl: pr.stdout.trim() || null
	};
};
//#endregion
//#region src/agents/session-activity.ts
const createUsageTotals = () => ({
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	totalTokens: 0
});
const createSessionStats = () => ({
	providerPasses: 0,
	toolCalls: 0,
	outputEvents: 0
});
const mergeProviderUsage = (totals, usage) => {
	const inputTokens = Math.max(totals.inputTokens, usage.inputTokens ?? 0);
	const cachedInputTokens = Math.max(totals.cachedInputTokens, usage.cachedInputTokens ?? 0);
	const outputTokens = Math.max(totals.outputTokens, usage.outputTokens ?? 0);
	const totalTokens = Math.max(totals.totalTokens, usage.totalTokens ?? inputTokens + cachedInputTokens + outputTokens);
	const costUsd = usage.costUsd === void 0 ? totals.costUsd : Math.max(totals.costUsd ?? 0, usage.costUsd);
	return {
		inputTokens,
		cachedInputTokens,
		outputTokens,
		totalTokens,
		...costUsd !== void 0 ? { costUsd } : {}
	};
};
const abbreviateTokens = (n) => {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
	return String(n);
};
const formatUsageTotals = (usage) => {
	if (usage.totalTokens === 0 && usage.costUsd === void 0) return "unknown";
	const tokens = [
		`${abbreviateTokens(usage.totalTokens)} total`,
		`${abbreviateTokens(usage.inputTokens)} in`,
		`${abbreviateTokens(usage.outputTokens)} out`
	];
	if (usage.cachedInputTokens > 0) tokens.push(`${abbreviateTokens(usage.cachedInputTokens)} cached`);
	if (usage.costUsd !== void 0) tokens.push(`$${usage.costUsd.toFixed(2)}`);
	return tokens.join(" / ");
};
const formatToolCalls = (count) => `${count.toLocaleString()} tool call${count === 1 ? "" : "s"}`;
const isProviderToolLine = (line) => Boolean(line?.startsWith("exec: ") || line?.startsWith("tool: "));
const formatDiffStat = (file) => {
	if (file.binary) return "binary";
	if (typeof file.additions === "number" || typeof file.deletions === "number") return `+${file.additions ?? 0} -${file.deletions ?? 0}`;
	return "changed";
};
const createChangedFileTracker = (input) => {
	const files = /* @__PURE__ */ new Map();
	let timer;
	let pending = false;
	const noteFile = (filePath, source, stat) => {
		const absolute = path.join(input.cwd, filePath);
		const updatedAt = ((fs.existsSync(absolute) ? fs.statSync(absolute) : null)?.mtime ?? /* @__PURE__ */ new Date()).toISOString();
		const prior = files.get(filePath);
		const additions = stat?.additions ?? prior?.additions;
		const deletions = stat?.deletions ?? prior?.deletions;
		const binary = stat?.binary ?? prior?.binary;
		if (prior?.updatedAt === updatedAt && prior.source === source && prior.additions === additions && prior.deletions === deletions && prior.binary === binary) return;
		const next = {
			filePath,
			updatedAt,
			source,
			...additions !== void 0 ? { additions } : {},
			...deletions !== void 0 ? { deletions } : {},
			...binary !== void 0 ? { binary } : {}
		};
		files.set(filePath, next);
		input.session?.append("file.changed", next);
		input.onChange([...files.values()]);
	};
	const refresh = async (source = "git diff") => {
		if (pending) return [...files.values()];
		pending = true;
		try {
			const stats = await diffNumstat(input.cwd);
			for (const filePath of await diffNameOnly(input.cwd)) noteFile(filePath, source, stats.get(filePath));
			return [...files.values()];
		} finally {
			pending = false;
		}
	};
	const start = () => {
		if (timer) return;
		timer = setInterval(() => {
			refresh("git diff");
		}, 1e3);
		timer.unref();
	};
	const stop = async () => {
		if (timer) {
			clearInterval(timer);
			timer = void 0;
		}
		return refresh("git diff");
	};
	return {
		noteFile,
		refresh,
		start,
		stop,
		files: () => [...files.values()]
	};
};
//#endregion
//#region src/agents/session-state.ts
const ACTIVITY_CAP = 200;
const EDITS_CAP = 8;
const buildInitialState = (init) => ({
	model: null,
	scoreStart: null,
	score: null,
	findingsRemaining: null,
	filesChanged: /* @__PURE__ */ new Set(),
	filesEdited: /* @__PURE__ */ new Set(),
	passes: 0,
	toolCalls: 0,
	tokens: {
		in: 0,
		out: 0,
		cached: 0,
		total: 0
	},
	startedAt: Date.now(),
	worktree: null,
	branch: null,
	activity: [],
	recentEdits: [],
	steps: [],
	files: [],
	actions: [],
	usage: null,
	estimatedTokens: 0,
	phase: "starting",
	pendingDecision: null,
	summary: null,
	...init
});
const activeStepIndex = (steps) => {
	for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i].status === "running") return i;
	return -1;
};
const createEmitter = (subscribers) => {
	return () => {
		for (const fn of subscribers) fn();
	};
};
const createCoreMethods = ({ state, subscribers, emit }) => ({
	getState: () => state,
	subscribe(fn) {
		subscribers.add(fn);
		return () => {
			subscribers.delete(fn);
		};
	},
	update(patch) {
		Object.assign(state, typeof patch === "function" ? patch(state) : patch);
		emit();
	}
});
const createActivityMethods = ({ state, emit }) => ({
	pushActivity(line) {
		state.activity.push(line);
		if (state.activity.length > ACTIVITY_CAP) state.activity.splice(0, state.activity.length - ACTIVITY_CAP);
		emit();
	},
	recordEdit(file, at = Date.now()) {
		state.filesChanged.add(file);
		state.filesEdited.add(file);
		state.recentEdits.push({
			file,
			at
		});
		if (state.recentEdits.length > EDITS_CAP) state.recentEdits.splice(0, state.recentEdits.length - EDITS_CAP);
		emit();
	},
	setFiles(files) {
		state.files = files;
		for (const file of files) state.filesChanged.add(file.filePath);
		emit();
	}
});
const createProgressMethods = ({ state, emit }) => ({
	addTokens(delta) {
		const t = state.tokens;
		state.tokens = {
			in: t.in + (delta.in ?? 0),
			out: t.out + (delta.out ?? 0),
			cached: t.cached + (delta.cached ?? 0),
			total: t.total + (delta.total ?? 0)
		};
		emit();
	},
	incPass() {
		state.passes += 1;
		emit();
	},
	addStep(label) {
		state.steps.push({
			status: "running",
			label
		});
		emit();
	},
	completeStep(status, label) {
		const index = activeStepIndex(state.steps);
		if (index >= 0) state.steps[index] = {
			status,
			label
		};
		else state.steps.push({
			status,
			label
		});
		emit();
	},
	setActiveStepLabel(label) {
		const index = activeStepIndex(state.steps);
		if (index >= 0) {
			state.steps[index] = {
				...state.steps[index],
				label
			};
			emit();
		}
	},
	setUsage(usage) {
		state.usage = usage;
		state.estimatedTokens = 0;
		state.tokens = {
			...state.tokens,
			total: usage.totalTokens,
			in: usage.inputTokens
		};
		emit();
	},
	setEstimatedTokens(tokens) {
		if (state.usage) return;
		state.estimatedTokens = tokens;
		emit();
	}
});
const createDecisionMethods = ({ state, emit }) => ({
	askDecision(question, options) {
		return new Promise((resolve) => {
			state.pendingDecision = {
				question,
				options,
				resolve: (value) => {
					state.pendingDecision = null;
					state.phase = "running";
					emit();
					resolve(value);
				}
			};
			state.phase = "awaiting-decision";
			emit();
		});
	},
	finish(summary) {
		state.summary = summary;
		state.phase = "done";
		emit();
	}
});
const createSessionState = (init) => {
	const state = buildInitialState(init);
	const subscribers = /* @__PURE__ */ new Set();
	const deps = {
		state,
		subscribers,
		emit: createEmitter(subscribers)
	};
	return {
		...createCoreMethods(deps),
		...createActivityMethods(deps),
		...createProgressMethods(deps),
		...createDecisionMethods(deps)
	};
};
//#endregion
//#region src/ui/agent-tui.ts
const parseScore = (value) => {
	const n = Number.parseInt(value.trim(), 10);
	return Number.isNaN(n) ? null : n;
};
const unwrapShell = (cmd) => {
	const match = cmd.match(/-l?c\s+(['"])([\s\S]*)\1\s*$/);
	return match ? match[2] : cmd;
};
const classify = (line) => {
	for (const kind of [
		"assistant",
		"tool",
		"exec"
	]) if (line.startsWith(`${kind}: `)) {
		const text = line.slice(kind.length + 2);
		return {
			kind,
			text: kind === "exec" ? unwrapShell(text) : text
		};
	}
	return {
		kind: "event",
		text: line
	};
};
var AgentTui = class {
	store;
	write;
	tty;
	handle = null;
	streamedChars = 0;
	constructor(options) {
		this.write = options.write ?? ((s) => process.stdout.write(s));
		this.tty = options.tty ?? Boolean(process.stdout.isTTY);
		this.store = createSessionState({
			provider: options.provider,
			providerSource: options.source,
			targetRepo: options.directory,
			targetScore: options.targetScore
		});
	}
	ensureMounted() {
		if (!this.tty || this.handle) return;
		this.handle = import("./mount-C3QQL4Et.js").then((m) => m.mountAgentTui(this.store));
	}
	setActions(actions) {
		this.store.update({ actions: actions.filter((action) => action.trim().length > 0) });
	}
	start(label) {
		this.store.addStep(label);
		this.ensureMounted();
	}
	complete(step) {
		this.store.completeStep(step.status, step.label);
		if (!this.tty) this.write(` ${step.label}\n`);
	}
	setActiveLabel(label) {
		this.store.setActiveStepLabel(label);
	}
	setMetric(label, value) {
		const text = value == null ? "" : String(value);
		if (label === "Score") {
			const [start, end] = text.split("->").map((part) => part.trim());
			this.store.update({
				scoreStart: parseScore(start ?? ""),
				score: parseScore(end ?? "")
			});
		} else if (label === "Remaining") this.store.update({ findingsRemaining: parseScore(text) });
		else if (label === "Pass") this.store.update({ passes: parseScore(text) ?? 0 });
		else if (label === "Worktree") this.store.update({ worktree: text || null });
	}
	setUsage(usage) {
		this.store.setUsage(usage);
	}
	appendLog(source, line) {
		this.streamedChars += line.length;
		this.store.setEstimatedTokens(Math.round(this.streamedChars / 4));
		const entry = classify(line);
		if (entry.kind === "event") return;
		if (this.store.getState().activity.slice(-6).some((a) => a.kind === entry.kind && a.text === entry.text)) return;
		this.store.pushActivity({
			...entry,
			at: Date.now()
		});
		if (!this.tty) this.write(`   ${source.padEnd(8)} ${line}\n`);
	}
	setFiles(files) {
		this.store.setFiles(files.map((file) => ({
			filePath: file.filePath,
			additions: file.additions,
			deletions: file.deletions,
			binary: file.binary
		})));
	}
	async askDecision(question, options) {
		return this.store.askDecision(question, options);
	}
	async finish(opts) {
		this.store.finish({
			scoreStart: this.store.getState().scoreStart,
			score: this.store.getState().score,
			passes: this.store.getState().passes,
			findingsRemaining: this.store.getState().findingsRemaining,
			changedFiles: [...this.store.getState().filesChanged],
			worktree: this.store.getState().worktree,
			sessionId: null
		});
		await this.close();
		if (!this.tty) this.write(` ${opts.footer}\n`);
	}
	async abort() {
		this.store.update({ phase: "error" });
		await this.close();
	}
	async close() {
		const pending = this.handle;
		this.handle = null;
		if (!pending) return;
		await (await pending).close();
	}
};
//#endregion
//#region src/commands/agent-local-cli.ts
const cliPath$1 = () => {
	const arg = process.argv[1];
	if (arg && fs.existsSync(arg)) return arg;
	return path.resolve("dist/cli.js");
};
const runSelf = (args, cwd) => {
	const result = spawnSync(process.execPath, [cliPath$1(), ...args], {
		cwd,
		encoding: "utf-8",
		env: {
			...process.env,
			AISLOP_NO_TELEMETRY: "1",
			AISLOP_NO_UPDATE_NOTIFIER: "1",
			NO_COLOR: "1"
		},
		maxBuffer: 50 * 1024 * 1024
	});
	return {
		exitCode: result.status,
		stdout: result.stdout,
		stderr: result.stderr
	};
};
const scanJson = (cwd) => {
	const result = runSelf([
		"scan",
		".",
		"--json"
	], cwd);
	if (!result.stdout.trim()) throw new Error(result.stderr || "aislop scan did not produce JSON output.");
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`Failed to parse aislop scan output: ${error instanceof Error ? error.message : String(error)}`);
	}
};
const runSafeFix = (cwd) => {
	const result = runSelf([
		"fix",
		".",
		"--safe"
	], cwd);
	if (result.exitCode !== 0 && result.stderr.trim()) log.warn(result.stderr.trim().split("\n")[0] ?? "Safe fix reported a non-zero exit.");
};
const applyDiff = async (root, patch) => {
	const child = spawnSync("git", [
		"apply",
		"--index",
		"--whitespace=nowarn",
		"-"
	], {
		cwd: root,
		input: patch,
		encoding: "utf-8",
		maxBuffer: 50 * 1024 * 1024
	});
	if (child.status !== 0) throw new Error(child.stderr || child.stdout || "Failed to apply agent diff.");
};
//#endregion
//#region src/agents/provider-metadata.ts
const isObject$2 = (value) => typeof value === "object" && value !== null;
const asNumber$2 = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
function parseJsonObject$1(line) {
	const trimmed = line.trim();
	if (trimmed.charCodeAt(0) !== 123) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return isObject$2(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function tokenValue(value, names) {
	for (const name of names) {
		const matched = asNumber$2(value[name]);
		if (matched !== null) return matched;
	}
	return null;
}
function usageFrom(value) {
	if (!isObject$2(value)) return null;
	const inputTokens = tokenValue(value, [
		"input_tokens",
		"inputTokens",
		"prompt_tokens",
		"promptTokens"
	]);
	const cacheReadTokenValue = tokenValue(value, ["cache_read_input_tokens", "cacheReadInputTokens"]);
	const cacheCreationTokenValue = tokenValue(value, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
	const cacheReadTokens = cacheReadTokenValue ?? 0;
	const cacheCreationTokens = cacheCreationTokenValue ?? 0;
	const cachedInputTokens = tokenValue(value, ["cached_input_tokens", "cachedInputTokens"]) ?? (cacheReadTokenValue !== null || cacheCreationTokenValue !== null ? cacheReadTokens + cacheCreationTokens : null);
	const outputTokens = tokenValue(value, [
		"output_tokens",
		"outputTokens",
		"completion_tokens",
		"completionTokens"
	]);
	const directTotalTokens = tokenValue(value, ["total_tokens", "totalTokens"]);
	const costUsd = tokenValue(value, [
		"cost_usd",
		"total_cost_usd",
		"costUsd",
		"totalCostUsd"
	]);
	if (!(inputTokens !== null || cachedInputTokens !== null || outputTokens !== null || directTotalTokens !== null) && costUsd === null) return null;
	const totalTokens = directTotalTokens ?? [
		inputTokens,
		cachedInputTokens,
		outputTokens
	].filter((item) => item !== null).reduce((sum, item) => sum + item, 0);
	return {
		inputTokens: inputTokens ?? 0,
		cachedInputTokens: cachedInputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		totalTokens,
		...costUsd !== null ? { costUsd } : {}
	};
}
const messageFrom$1 = (event) => isObject$2(event.message) ? event.message : isObject$2(event.item) ? event.item : null;
function collectUsage(event) {
	const topLevelCost = tokenValue(event, [
		"cost_usd",
		"total_cost_usd",
		"costUsd",
		"totalCostUsd"
	]);
	const sources = [
		event.usage,
		event.token_usage,
		event.tokenUsage,
		event.metrics,
		event.context_window,
		event.contextWindow,
		event,
		messageFrom$1(event)?.usage,
		messageFrom$1(event)?.metrics
	];
	for (const source of sources) {
		const usage = usageFrom(source);
		if (!usage) continue;
		return {
			...usage,
			...usage.costUsd === void 0 && topLevelCost !== null ? { costUsd: topLevelCost } : {}
		};
	}
	return null;
}
function collectFilePaths(value, files) {
	if (typeof value === "string") {
		if (/^(?:\.{0,2}\/)?[\w@./ -]+\.[A-Za-z0-9]{1,8}$/.test(value) && !value.includes("\n")) files.add(value.trim());
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectFilePaths(item, files);
		return;
	}
	if (!isObject$2(value)) return;
	for (const key of [
		"file",
		"path",
		"filePath",
		"filename",
		"target_file",
		"targetFile"
	]) collectFilePaths(value[key], files);
	if (isObject$2(value.item)) collectFilePaths(value.item, files);
	if (isObject$2(value.message)) collectFilePaths(value.message, files);
}
function extractProviderOutputMetadata(line) {
	const event = parseJsonObject$1(line);
	if (!event) return { files: [] };
	const files = /* @__PURE__ */ new Set();
	collectFilePaths(event, files);
	const usage = collectUsage(event);
	return {
		...usage ? { usage } : {},
		files: [...files]
	};
}
//#endregion
//#region src/agents/provider-output.ts
const isObject$1 = (value) => typeof value === "object" && value !== null;
const asString$2 = (value) => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const compact = (value, limit = 180) => value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
const parseJsonObject = (line) => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return isObject$1(parsed) ? parsed : null;
	} catch {
		return null;
	}
};
const textFromContent = (content) => {
	if (typeof content === "string") return asString$2(content);
	if (!Array.isArray(content)) return null;
	const text = content.map((item) => {
		if (typeof item === "string") return item;
		if (!isObject$1(item)) return "";
		return asString$2(item.text) ?? asString$2(item.content) ?? "";
	}).filter(Boolean).join(" ");
	return asString$2(text);
};
const toolNameFromContent = (content) => {
	if (!Array.isArray(content)) return null;
	for (const item of content) {
		if (!isObject$1(item)) continue;
		const type = asString$2(item.type);
		if (type?.includes("tool")) return asString$2(item.name) ?? type;
	}
	return null;
};
const messageFrom = (event) => isObject$1(event.message) ? event.message : isObject$1(event.item) ? event.item : null;
const formatProviderOutputLine = (line) => {
	const raw = asString$2(line);
	if (!raw) return null;
	const event = parseJsonObject(raw);
	if (!event) return compact(raw);
	const type = asString$2(event.type);
	const subtype = asString$2(event.subtype);
	const message = messageFrom(event);
	const messageContent = message ? textFromContent(message.content) : null;
	const eventContent = textFromContent(event.content);
	const directText = asString$2(event.text) ?? asString$2(event.message);
	const toolName = toolNameFromContent(message?.content) ?? toolNameFromContent(event.content) ?? asString$2(event.name) ?? asString$2(message?.name);
	const command = asString$2(event.command) ?? asString$2(message?.command);
	if (messageContent) return compact(`assistant: ${messageContent}`);
	if (eventContent) return compact(`assistant: ${eventContent}`);
	if (directText) return compact(`${type ?? "message"}: ${directText}`);
	if (command) return compact(`exec: ${command}`);
	if (toolName) return compact(`tool: ${toolName}`);
	if (type === "system" && subtype === "init") return "session initialized";
	if (type === "result") return compact(`result: ${subtype ?? "completed"}`);
	if (type?.startsWith("session.")) return compact(type.replace(".", " "));
	if (type) return compact(`event: ${subtype ? `${type}/${subtype}` : type}`);
	return compact(raw);
};
//#endregion
//#region src/agents/provider-runner.ts
var ProviderExitError = class extends Error {
	providerId;
	exitCode;
	name = "ProviderExitError";
	constructor(providerId, providerLabel, exitCode) {
		super(exitCode === null ? `${providerLabel} exited without reporting a status code.` : `${providerLabel} exited with code ${exitCode}.`);
		this.providerId = providerId;
		this.exitCode = exitCode;
	}
};
const runProvider = (provider, input) => new Promise((resolve, reject) => {
	const child = spawn(provider.bin, provider.buildArgs(input.prompt, { maxTurns: input.maxTurns }), {
		cwd: input.cwd,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		env: {
			...process.env,
			NO_COLOR: "1"
		}
	});
	const flushLine = (stream) => {
		let buffer = "";
		return (chunk) => {
			buffer += chunk.toString("utf-8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trimEnd();
				buffer = buffer.slice(newline + 1);
				if (line.trim().length > 0) input.onEvent?.({
					stream,
					line
				});
				newline = buffer.indexOf("\n");
			}
		};
	};
	child.stdout?.on("data", flushLine("stdout"));
	child.stderr?.on("data", flushLine("stderr"));
	child.once("error", (error) => reject(error));
	child.once("close", (code) => {
		if (code === 0) {
			resolve(code);
			return;
		}
		reject(new ProviderExitError(provider.id, provider.label, code));
	});
});
//#endregion
//#region src/commands/agent-types.ts
const summarizeAgentScan = (scan) => ({
	score: scan.score,
	label: scan.label,
	diagnostics: scan.diagnostics.length,
	summary: scan.summary
});
//#endregion
//#region src/commands/agent-session-steps.ts
const plural = (count, singular, pluralLabel = `${singular}s`) => `${count.toLocaleString()} ${count === 1 ? singular : pluralLabel}`;
const runProviderStep = async (input) => {
	if (input.findings.length === 0) {
		input.session.append("provider.skipped", {
			reason: "no_selected_findings",
			provider: input.selected.provider.id
		});
		return;
	}
	input.stats.providerPasses = Math.max(input.stats.providerPasses, input.pass);
	input.tui.setMetric("Pass", input.pass);
	input.tui.start(`Pass ${input.pass}: running ${input.selected.provider.label}`);
	input.tui.setMetric("Tokens", "waiting");
	const prompt = buildRepairPrompt({
		rootDirectory: input.worktreePath,
		findings: input.findings,
		score: input.score,
		targetScore: input.options.targetScore,
		maxTurns: input.options.maxTurns
	});
	input.session.append("provider.started", {
		provider: input.selected.provider.id,
		label: input.selected.provider.label,
		pass: input.pass,
		score: input.score,
		targetScore: input.options.targetScore,
		findings: input.findings.length,
		maxTurns: input.options.maxTurns
	});
	input.tui.setActiveLabel(`Pass ${input.pass}: ${input.selected.provider.label} is editing`);
	input.tracker.start();
	let exitCode = null;
	let passToolCalls = 0;
	let passOutputEvents = 0;
	try {
		exitCode = await runProvider(input.selected.provider, {
			cwd: input.worktreePath,
			prompt,
			maxTurns: input.options.maxTurns,
			onEvent: (event) => {
				passOutputEvents += 1;
				input.stats.outputEvents += 1;
				const displayLine = formatProviderOutputLine(event.line);
				if (displayLine) {
					input.tui.appendLog(input.selected.provider.id, displayLine);
					if (isProviderToolLine(displayLine)) {
						passToolCalls += 1;
						input.stats.toolCalls += 1;
						input.tui.setMetric("Tools", input.stats.toolCalls);
					}
				}
				const metadata = extractProviderOutputMetadata(event.line);
				if (metadata.usage) {
					Object.assign(input.usage, mergeProviderUsage(input.usage, metadata.usage));
					input.tui.setMetric("Tokens", formatUsageTotals(input.usage));
					input.tui.setUsage({
						inputTokens: input.usage.inputTokens,
						totalTokens: input.usage.totalTokens,
						costUsd: input.usage.costUsd
					});
					input.session.append("provider.usage", {
						provider: input.selected.provider.id,
						usage: input.usage
					});
				}
				for (const filePath of metadata.files) {
					const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(input.worktreePath, filePath);
					const relativePath = path.relative(input.diffRoot, absolutePath);
					input.tracker.noteFile(relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath) ? relativePath : filePath, `${input.selected.provider.id} output`);
				}
				input.session.append("provider.output", {
					provider: input.selected.provider.id,
					stream: event.stream,
					line: event.line,
					displayLine
				});
			}
		});
	} catch (error) {
		input.session.append("provider.failed", {
			provider: input.selected.provider.id,
			pass: input.pass,
			message: error instanceof Error ? error.message : String(error)
		});
		input.tui.complete({
			status: "failed",
			label: `Pass ${input.pass}: ${input.selected.provider.label} failed`
		});
		throw error;
	} finally {
		await input.tracker.stop();
	}
	input.session.append("provider.finished", {
		provider: input.selected.provider.id,
		pass: input.pass,
		exitCode,
		toolCalls: passToolCalls,
		outputEvents: passOutputEvents
	});
	const toolSuffix = passToolCalls > 0 ? ` · ${formatToolCalls(passToolCalls)}` : "";
	input.tui.complete({
		status: exitCode === 0 ? "done" : "warn",
		label: exitCode === 0 ? `Pass ${input.pass}: ${input.selected.provider.label} finished${toolSuffix}` : `Pass ${input.pass}: ${input.selected.provider.label} finished with exit ${exitCode ?? "unknown"}${toolSuffix}`
	});
};
const actionableFindings = (scan) => scan.diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
const needsAnotherPass = (scan) => actionableFindings(scan).length > 0;
const actionsForSession = (input) => {
	const actions = [];
	const remaining = actionableFindings(input.scan).length;
	if (remaining > 0) actions.push(`Continue: ${remaining} actionable finding${remaining === 1 ? "" : "s"} remain; target is ${input.options.targetScore}/100`);
	if (input.changedFiles.length > 0 && !input.options.inPlace) actions.push("Apply: accept the reviewed diff back into the original worktree");
	if (input.changedFiles.length > 0) actions.push(`Review: ${input.changedFiles.length} changed file${input.changedFiles.length === 1 ? "" : "s"}`);
	return actions;
};
const verifyDiff = async (tui, cwd, before, options, session, pass, passStartScore) => {
	tui.start(`Pass ${pass}: verifying diff`);
	const after = scanJson(cwd);
	const changedFiles = await diffNameOnly(cwd);
	tui.setMetric("Score", `${before.score ?? "not scored"} -> ${after.score ?? "not scored"}`);
	tui.setMetric("Changes", changedFiles.length);
	tui.setMetric("Remaining", actionableFindings(after).length);
	tui.setActions(actionsForSession({
		scan: after,
		changedFiles,
		options
	}));
	session.append("diff.verified", {
		pass,
		scoreBefore: passStartScore,
		scan: summarizeAgentScan(after),
		changedFiles
	});
	tui.complete({
		status: (after.score ?? 0) >= (before.score ?? 0) && changedFiles.length > 0 ? "done" : "warn",
		label: `Pass ${pass} verified · ${passStartScore ?? "not scored"} -> ${after.score ?? "not scored"} · ${plural(changedFiles.length, "file")} changed`
	});
	return {
		after,
		changedFiles
	};
};
const maybeContinueSession = async (input) => {
	if (!needsAnotherPass(input.scan)) return false;
	const findings = selectAgentFindings(input.scan.diagnostics, input.options.limit);
	if (findings.length === 0 || !process.stdin.isTTY) return false;
	const remaining = actionableFindings(input.scan).length;
	input.session.append("continue.prompted", {
		nextPass: input.nextPass,
		score: input.scan.score,
		diagnostics: input.scan.diagnostics.length,
		actionableFindings: remaining,
		targetScore: input.options.targetScore
	});
	const accepted = await input.tui.askDecision(`Next step for pass ${input.nextPass}`, [{
		value: "continue",
		label: `Run pass ${input.nextPass} (${findings.length} selected findings)`
	}, {
		value: "stop",
		label: "Stop and review/apply current diff"
	}]) === "continue";
	input.session.append(accepted ? "continue.accepted" : "continue.skipped", {
		nextPass: input.nextPass,
		score: input.scan.score,
		diagnostics: input.scan.diagnostics.length,
		actionableFindings: remaining,
		selectedFindings: findings.length
	});
	return accepted;
};
const maybeApplyDiff = async (input) => {
	if (input.changedFiles.length === 0 || input.worktreePath === input.originalRoot) return false;
	if (input.options.apply && input.options.yes) {
		await applyDiff(input.originalRoot, await readBinaryDiff(input.worktreePath));
		return true;
	}
	if (!process.stdin.isTTY) return false;
	input.session.append("apply.prompted", {
		changedFiles: input.changedFiles.length,
		editedFiles: input.files.length || input.changedFiles.length
	});
	if (await input.tui.askDecision(`Next step for ${plural(input.changedFiles.length, "changed file")}`, [{
		value: "apply",
		label: `Apply changes to ${path.basename(input.originalRoot)}`
	}, {
		value: "review",
		label: "Keep worktree for review"
	}]) !== "apply") {
		input.session.append("apply.declined");
		return false;
	}
	await applyDiff(input.originalRoot, await readBinaryDiff(input.worktreePath));
	return true;
};
//#endregion
//#region src/utils/paths.ts
/** Normalize an OS path to forward-slash (POSIX) separators. */
const toPosix = (p) => p.split(path.sep).join("/");
/** path.relative, normalized to POSIX separators (stable across OSes). */
const relativePosix = (from, to) => toPosix(path.relative(from, to));
const stripWindowsNamespace = (filePath) => {
	if (filePath.startsWith("\\\\?\\UNC\\")) return `\\\\${filePath.slice(8)}`;
	return filePath.startsWith("\\\\?\\") ? filePath.slice(4) : filePath;
};
const projectRelativePosix = (rootDirectory, filePath) => {
	if (process.platform === "win32") {
		const normalizedRoot = stripWindowsNamespace(rootDirectory);
		const normalizedFile = stripWindowsNamespace(filePath);
		return (path.win32.isAbsolute(normalizedFile) ? path.win32.relative(normalizedRoot, normalizedFile) : normalizedFile).split(path.win32.sep).join("/");
	}
	return path.isAbsolute(filePath) ? relativePosix(rootDirectory, filePath) : toPosix(filePath);
};
//#endregion
//#region src/commands/agent-display-path.ts
const displayAgentPath = (root, target) => {
	const relative = path.relative(root, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return target;
	return toPosix(relative);
};
//#endregion
//#region src/commands/agent-session-summary.ts
const providerSourceLabel = (options) => {
	if (options.providerSource === "cli") return "--provider flag";
	if (options.providerSource === "preference") return `saved local default (${options.providerPreference ?? options.provider})`;
	return "auto-detect installed provider";
};
const actionableCount = (scan) => scan.diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length;
const coloredDiffStat = (file) => {
	if (file.binary) return pc.dim("binary");
	if (typeof file.additions === "number" || typeof file.deletions === "number") return `${pc.green(`+${file.additions ?? 0}`)} ${pc.red(`-${file.deletions ?? 0}`)}`;
	return pc.dim("changed");
};
const editedFileLine = (file) => `${file.filePath} · ${coloredDiffStat(file)}`;
const printAgentSessionSummary = (input) => {
	const editedFileCount = input.fileActivity.length || input.changedFiles.length;
	const statsByFile = new Map(input.fileActivity.map((file) => [file.filePath, file]));
	log.break();
	process.stdout.write(`${[
		renderDisplaySection("Agent summary"),
		...renderDisplayRows([
			{
				label: "Provider",
				value: input.provider.provider.label
			},
			{
				label: "Source",
				value: providerSourceLabel(input.options)
			},
			{
				label: "Session",
				value: input.session.id
			},
			{
				label: "Transcript",
				value: displayAgentPath(input.originalRoot, input.session.path)
			},
			{
				label: "Score",
				value: `${input.before.score ?? "not scored"} -> ${input.after.score ?? "not scored"}`
			},
			{
				label: "Remaining",
				value: `${actionableCount(input.after)} actionable findings`
			},
			{
				label: "Passes",
				value: String(input.stats.providerPasses)
			},
			{
				label: "Tools",
				value: formatToolCalls(input.stats.toolCalls)
			},
			{
				label: "Tokens",
				value: formatUsageTotals(input.usage)
			},
			{
				label: "Files edited",
				value: String(editedFileCount)
			},
			{
				label: "Changed",
				value: String(input.changedFiles.length)
			},
			...input.worktreePath !== input.originalRoot ? [{
				label: "Worktree",
				value: displayAgentPath(input.originalRoot, input.worktreePath)
			}] : []
		], {
			indent: 3,
			labelWidth: 12
		}),
		""
	].join("\n")}`);
	if (input.changedFiles.length === 0) {
		log.muted("No files changed.");
		return;
	}
	process.stdout.write(`${renderDisplaySection("Changed files")}\n`);
	for (const file of input.changedFiles.slice(0, 12)) {
		const stat = statsByFile.get(file);
		process.stdout.write(` - ${stat ? editedFileLine(stat) : file}\n`);
	}
	if (input.changedFiles.length > 12) process.stdout.write(` - ...and ${input.changedFiles.length - 12} more\n`);
	if (input.fileActivity.length > 0) {
		process.stdout.write(`\n${renderDisplaySection("File activity")}\n`);
		for (const file of input.fileActivity.slice(-8)) process.stdout.write(` - ${editedFileLine(file)}\n`);
		if (input.fileActivity.length > 8) process.stdout.write(` - ...and ${input.fileActivity.length - 8} more\n`);
	}
	if (input.applied) log.success("Applied diff to the original worktree.");
	if (input.published) {
		log.success(`Committed ${input.published.commitSha} on ${input.published.branch}.`);
		if (input.published.prUrl) log.success(`Opened PR: ${input.published.prUrl}`);
	} else if (!input.applied && input.worktreePath !== input.originalRoot) process.stdout.write(`\n${[
		renderDisplaySection("Next"),
		...renderDisplayRows([{
			label: "Review",
			value: displayAgentPath(input.originalRoot, input.worktreePath)
		}]),
		...renderDisplayCommandRows([{
			label: "Apply",
			command: `aislop agent apply ${input.session.id}`
		}]),
		""
	].join("\n")}`);
};
//#endregion
//#region src/commands/agent-session.ts
const scoreDelta = (before, after) => typeof before === "number" && typeof after === "number" ? after - before : void 0;
const resolveAgentSessionCwd = (created, requestedDirectory) => {
	const relative = path.relative(created.state.root, requestedDirectory);
	const outsideRoot = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	if (relative.length === 0 || outsideRoot) return created.worktree.path;
	return path.resolve(created.worktree.path, relative);
};
const prepareWorktree = async (tui, resolvedDir, options) => {
	tui.start("Preparing local session");
	const created = await createAgentWorktree(resolvedDir, { inPlace: options.inPlace });
	tui.setMetric("Worktree", created.worktree.created ? path.relative(created.state.root, created.worktree.path) : "current");
	tui.complete({
		status: "done",
		label: created.worktree.created ? `Created worktree ${path.relative(created.state.root, created.worktree.path)}` : "Using current worktree"
	});
	return created;
};
const scanBaseline = (tui, cwd) => {
	tui.start("Scanning baseline");
	const scan = scanJson(cwd);
	tui.setMetric("Score", `${scan.score ?? "not scored"} -> ...`);
	tui.setMetric("Findings", scan.diagnostics.length);
	tui.complete({
		status: scan.summary.errors > 0 ? "warn" : "done",
		label: `Baseline ${scan.score ?? "not scored"} / 100 · ${scan.diagnostics.length} findings`
	});
	return scan;
};
const runSafeFixStep = (tui, cwd, options) => {
	if (options.noFix) return;
	tui.start("Applying deterministic safe fixes");
	runSafeFix(cwd);
	tui.complete({
		status: "done",
		label: "Safe fixer finished"
	});
};
const selectFindings = (tui, cwd, limit, pass) => {
	tui.start(`Pass ${pass}: selecting findings`);
	const findings = selectAgentFindings(scanJson(cwd).diagnostics, limit);
	tui.setMetric("Selected", findings.length);
	tui.complete({
		status: findings.length > 0 ? "done" : "skipped",
		label: findings.length > 0 ? `Pass ${pass}: selected ${findings.length} finding${findings.length === 1 ? "" : "s"}` : "No remaining agent findings"
	});
	return findings;
};
const runAgentSession = async (selected, resolvedDir, options, started) => {
	const tui = new AgentTui({
		provider: selected.provider.label,
		source: providerSourceLabel(options),
		directory: resolvedDir,
		mode: options.inPlace ? "current worktree" : "isolated git worktree",
		targetScore: options.targetScore
	});
	let created;
	let session;
	let changedFiles = [];
	let applied = false;
	let published = null;
	try {
		created = await prepareWorktree(tui, resolvedDir, options);
		const sessionCwd = resolveAgentSessionCwd(created, resolvedDir);
		session = createAgentSessionRecorder(created.state.root, { id: process.env.AISLOP_AGENT_SESSION_ID });
		const usage = createUsageTotals();
		const tracker = createChangedFileTracker({
			cwd: created.worktree.path,
			session,
			onChange: (files) => {
				tui.setFiles(files);
			}
		});
		tui.setMetric("Session", session.id);
		const stats = createSessionStats();
		session.append("session.started", {
			root: created.state.root,
			requestedDirectory: resolvedDir,
			background: process.env.AISLOP_AGENT_BACKGROUND === "1",
			providerSelection: options.provider,
			providerSource: options.providerSource,
			providerPreference: options.providerPreference,
			provider: selected.provider.id,
			providerLabel: selected.provider.label,
			providerVersion: selected.version,
			mode: options.inPlace ? "in_place" : "isolated_worktree",
			targetScore: options.targetScore,
			maxTurns: options.maxTurns,
			limit: options.limit,
			publish: {
				commit: options.commit,
				pr: options.pr,
				branch: options.branch,
				base: options.base,
				ready: options.ready
			}
		});
		session.append("worktree.prepared", {
			path: created.worktree.path,
			sessionCwd,
			created: created.worktree.created,
			branch: created.state.branch,
			head: created.state.head
		});
		const before = scanBaseline(tui, sessionCwd);
		session.append("scan.baseline", summarizeAgentScan(before));
		runSafeFixStep(tui, sessionCwd, options);
		await tracker.refresh("safe fix");
		const afterFix = scanJson(sessionCwd);
		tui.setMetric("Score", `${before.score ?? "not scored"} -> ${afterFix.score ?? "not scored"}`);
		session.append(options.noFix ? "fix.safe.skipped" : "fix.safe.finished", { scan: summarizeAgentScan(afterFix) });
		let pass = 1;
		const findings = selectFindings(tui, sessionCwd, options.limit, pass);
		session.append("findings.selected", {
			pass,
			count: findings.length,
			findings: findings.map(summarizeAgentFinding)
		});
		if (findings.length === 0 && tracker.files().length === 0) {
			session.append("session.completed", {
				durationMs: Math.round(performance.now() - started),
				scoreBefore: before.score,
				scoreAfter: afterFix.score,
				reason: "no_agent_findings"
			});
			const atTarget = (afterFix.score ?? 0) >= options.targetScore;
			await tui.finish({ footer: `Score ${afterFix.score ?? "?"}/100 · nothing to repair` });
			log.success(atTarget ? `Already at ${afterFix.score ?? "?"}/100 — nothing to do.` : `Score ${afterFix.score ?? "?"}/100. No agent-fixable findings; run \`aislop fix\` for any auto-fixable issues.`);
			return {
				agent_result: "no_agent_findings",
				score_before: before.score,
				score_after: afterFix.score,
				score_delta: scoreDelta(before.score, afterFix.score),
				changed_files: tracker.files().length,
				provider_passes: 0,
				tool_calls: 0,
				output_events: 0,
				total_tokens: 0,
				cost_usd: 0,
				applied: false,
				published: false,
				target_met: atTarget
			};
		}
		await runProviderStep({
			tui,
			session,
			selected,
			worktreePath: sessionCwd,
			diffRoot: created.worktree.path,
			findings,
			score: afterFix.score,
			options,
			usage,
			stats,
			tracker,
			pass
		});
		let verified = await verifyDiff(tui, sessionCwd, before, options, session, pass, afterFix.score);
		while (await maybeContinueSession({
			tui,
			session,
			scan: verified.after,
			changedFiles: verified.changedFiles,
			options,
			usage,
			stats,
			files: tracker.files(),
			nextPass: pass + 1,
			originalRoot: created.state.root
		})) {
			pass += 1;
			const passStartScore = verified.after.score;
			const nextFindings = selectFindings(tui, sessionCwd, options.limit, pass);
			session.append("findings.selected", {
				pass,
				count: nextFindings.length,
				findings: nextFindings.map(summarizeAgentFinding),
				source: "continue"
			});
			await runProviderStep({
				tui,
				session,
				selected,
				worktreePath: sessionCwd,
				diffRoot: created.worktree.path,
				findings: nextFindings,
				score: verified.after.score,
				options,
				usage,
				stats,
				tracker,
				pass
			});
			verified = await verifyDiff(tui, sessionCwd, before, options, session, pass, passStartScore);
		}
		changedFiles = verified.changedFiles;
		applied = await maybeApplyDiff({
			options,
			changedFiles,
			worktreePath: created.worktree.path,
			originalRoot: created.state.root,
			tui,
			session,
			usage,
			stats,
			files: tracker.files()
		});
		session.append(applied ? "diff.applied" : "diff.apply_skipped", {
			applyRequested: options.apply,
			changedFiles: changedFiles.length
		});
		if (changedFiles.length > 0 && (options.commit || options.pr)) {
			tui.start(options.pr ? "Creating local branch and PR" : "Creating local commit");
			session.append("publish.started", {
				commit: options.commit,
				pr: options.pr,
				branch: options.branch,
				base: options.base,
				ready: options.ready
			});
			published = await publishAgentDiff({
				cwd: created.worktree.path,
				originalBranch: created.state.branch,
				providerId: selected.provider.id,
				beforeScore: before.score,
				afterScore: verified.after.score,
				changedFiles,
				options: {
					commit: options.commit,
					pr: options.pr,
					branch: options.branch,
					base: options.base,
					commitMessage: options.commitMessage,
					prTitle: options.prTitle,
					ready: options.ready
				}
			});
			session.append(published ? "publish.finished" : "publish.skipped", { result: published });
			tui.complete({
				status: published ? "done" : "skipped",
				label: published?.prUrl ? `Opened PR ${published.prUrl}` : published ? `Committed ${published.commitSha}` : "No commit created"
			});
		} else if (options.commit || options.pr) session.append("publish.skipped", {
			reason: "no_changed_files",
			commit: options.commit,
			pr: options.pr
		});
		session.append("session.completed", {
			durationMs: Math.round(performance.now() - started),
			scoreBefore: before.score,
			scoreAfter: verified.after.score,
			changedFiles: changedFiles.length,
			providerPasses: stats.providerPasses,
			toolCalls: stats.toolCalls,
			outputEvents: stats.outputEvents,
			totalTokens: usage.totalTokens,
			costUsd: usage.costUsd,
			applied,
			published: Boolean(published)
		});
		await tui.finish({ footer: `Done · ${selected.provider.id} · ${Math.round(performance.now() - started)}ms` });
		printAgentSessionSummary({
			before,
			after: verified.after,
			changedFiles,
			applied,
			published,
			provider: selected,
			options,
			session,
			worktreePath: created.worktree.path,
			originalRoot: created.state.root,
			usage,
			stats,
			fileActivity: tracker.files()
		});
		return {
			agent_result: "completed",
			score_before: before.score,
			score_after: verified.after.score,
			score_delta: scoreDelta(before.score, verified.after.score),
			changed_files: changedFiles.length,
			provider_passes: stats.providerPasses,
			tool_calls: stats.toolCalls,
			output_events: stats.outputEvents,
			total_tokens: usage.totalTokens,
			cost_usd: usage.costUsd,
			applied,
			published: Boolean(published),
			target_met: verified.after.score !== null && verified.after.score >= options.targetScore
		};
	} catch (error) {
		session?.append("session.failed", { message: error instanceof Error ? error.message : String(error) });
		await tui.abort();
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return { agent_result: "failed" };
	} finally {
		const safeToCleanup = changedFiles.length === 0 || applied || Boolean(published) || options.cleanup;
		if (created?.worktree.created && !options.keepWorktree && safeToCleanup && process.exitCode !== 1) {
			await removeAgentWorktree(created.worktree);
			session?.append("worktree.removed", { path: created.worktree.path });
		}
	}
};
//#endregion
//#region src/commands/agent.ts
const providerSourceText$2 = (options) => {
	if (options.providerSource === "cli") return "--provider flag";
	if (options.providerSource === "preference") return `saved local default (${options.providerPreference ?? options.provider})`;
	return "auto-detect installed provider";
};
const loginCommandText = (status) => [status.provider.loginCommand.command, ...status.provider.loginCommand.args].join(" ");
const guideNoProvider = (statuses) => {
	const anyInstalled = statuses.some((status) => status.installed);
	log.error(anyInstalled ? "No coding agent is ready to run." : "No coding agent is installed. `aislop agent` drives Codex, Claude Code, or OpenCode.");
	for (const status of statuses) {
		const state = !status.installed ? "not installed" : status.authenticated === false ? `installed · sign in with \`${loginCommandText(status)}\`` : "ready";
		log.muted(`  ${status.provider.label.padEnd(12)} ${state}`);
	}
	log.muted("Set one up, then re-run. `aislop agent connect` walks through it too.");
};
const resolveReadyProvider = async (provider) => {
	let selected = resolveProvider(provider);
	if (!selected || !selected.installed) {
		guideNoProvider(getProviderStatuses());
		process.exitCode = 1;
		return null;
	}
	if (selected.authenticated === false) {
		if (!process.stdin.isTTY) {
			log.error(`${selected.provider.label} is installed but not signed in.`);
			log.muted(selected.provider.loginHint);
			process.exitCode = 1;
			return null;
		}
		log.muted(`${selected.provider.label} is not signed in — connecting…`);
		await agentConnectCommand(selected.provider.id, { dryRun: false });
		selected = resolveProvider(selected.provider.id);
		if (!selected || selected.authenticated === false) {
			process.exitCode = 1;
			return null;
		}
	}
	return selected;
};
const renderDryRun = (selected, resolvedDir, options) => {
	process.stdout.write(`${[
		renderDisplaySection("Dry run"),
		...renderDisplayRows([
			{
				label: "Provider",
				value: selected.provider.label
			},
			{
				label: "Source",
				value: providerSourceText$2(options)
			},
			{
				label: "Directory",
				value: resolvedDir
			},
			{
				label: "Mode",
				value: options.inPlace ? "current worktree" : "isolated git worktree"
			},
			...options.background ? [{
				label: "Run",
				value: "background session"
			}] : [],
			{
				label: "Target",
				value: `${options.targetScore}/100`
			},
			...options.commit || options.pr ? [{
				label: "Publish",
				value: options.pr ? "commit + draft PR" : "commit only"
			}, {
				label: "Commit",
				value: options.commitMessage
			}] : []
		], {
			indent: 3,
			labelWidth: 9
		}),
		""
	].join("\n")}`);
};
const providerTelemetry = (selected, options) => ({
	provider: selected.provider.id,
	provider_source: options.providerSource
});
const agentCommand = async (directory, options) => {
	const started = performance.now();
	const resolvedDir = path.resolve(directory);
	let root;
	try {
		root = (await readAgentRoot(resolvedDir)).root;
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return { agent_result: "no_git_root" };
	}
	const providerChoice = resolveAgentProviderSelection({
		root,
		requested: options.provider,
		explicit: options.providerSource === "cli"
	});
	const resolvedOptions = {
		...options,
		provider: providerChoice.selection,
		providerSource: providerChoice.source,
		providerPreference: providerChoice.preference?.provider
	};
	process.stdout.write(renderHeader({
		version: APP_VERSION,
		command: "Agent session",
		context: [providerChoice.source === "preference" ? `${providerChoice.selection} default` : providerChoice.selection === "auto" ? "auto provider" : providerChoice.selection]
	}));
	if (providerChoice.source === "preference") log.muted(`Using saved provider preference: ${providerChoice.selection}.`);
	const selected = await resolveReadyProvider(resolvedOptions.provider);
	if (!selected) return { agent_result: "provider_unavailable" };
	if (resolvedOptions.dryRun) {
		renderDryRun(selected, resolvedDir, resolvedOptions);
		return {
			agent_result: "dry_run",
			...providerTelemetry(selected, resolvedOptions)
		};
	}
	if (resolvedOptions.background) try {
		renderBackgroundLaunch(await launchAgentInBackground(resolvedDir, resolvedOptions));
		return {
			agent_result: "background_started",
			...providerTelemetry(selected, resolvedOptions)
		};
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return {
			agent_result: "failed",
			...providerTelemetry(selected, resolvedOptions)
		};
	}
	const result = await runAgentSession(selected, resolvedDir, resolvedOptions, started);
	return result ? {
		...result,
		...providerTelemetry(selected, resolvedOptions)
	} : null;
};
//#endregion
//#region src/commands/agent-plan.ts
const readGitPlanState = async (directory) => {
	const rootResult = await runSubprocess("git", ["rev-parse", "--show-toplevel"], { cwd: path.resolve(directory) });
	if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) throw new Error("aislop agent plan needs to run inside a git repository.");
	const root = rootResult.stdout.trim();
	const [branch, head, status] = await Promise.all([
		runSubprocess("git", ["branch", "--show-current"], { cwd: root }),
		runSubprocess("git", [
			"rev-parse",
			"--short",
			"HEAD"
		], { cwd: root }),
		runSubprocess("git", ["status", "--porcelain"], { cwd: root })
	]);
	return {
		root,
		branch: branch.stdout.trim() || null,
		head: head.stdout.trim(),
		dirty: status.stdout.trim().length > 0
	};
};
const buildAgentPlanBlockers = (input) => {
	const blockers = [];
	if (!input.provider || !input.provider.installed) blockers.push(`No usable provider found. Installed providers: ${getProviderStatuses().filter((status) => status.installed).map((status) => status.provider.id).join(", ") || "none"}.`);
	else if (input.provider.authenticated === false) blockers.push(`${input.provider.provider.label} is installed but not authenticated.`);
	if (!input.options.inPlace && input.git.dirty) blockers.push("Isolated worktree mode needs a clean checkout. Commit/stash changes or use --in-place.");
	if (input.options.background && input.options.apply && !input.options.yes) blockers.push("Background apply cannot prompt. Use --apply --yes.");
	return blockers;
};
const providerText$1 = (provider) => {
	if (!provider) return "none selected";
	const state = provider.installed ? provider.authenticated === false ? "auth needed" : "ready" : "not installed";
	return `${provider.provider.label} (${state}${provider.version ? `, ${provider.version}` : ""})`;
};
const providerSourceText$1 = (options) => {
	if (options.providerSource === "cli") return "--provider flag";
	if (options.providerSource === "preference") return `saved local default (${options.providerPreference ?? options.provider})`;
	return "auto-detect installed provider";
};
const actionRows = (plan) => {
	const rows = [
		{
			label: "Worktree",
			value: plan.options.inPlace ? "edit current checkout" : "create isolated git worktree"
		},
		{
			label: "Safe fixes",
			value: plan.options.noFix ? "skip" : "run before provider handoff"
		},
		{
			label: "Provider",
			value: plan.findings.length === 0 || (plan.scan.score ?? 0) >= plan.options.targetScore ? "skip; target already met or no selected findings" : `run ${plan.provider?.provider.label ?? "selected provider"} with ${plan.findings.length} finding${plan.findings.length === 1 ? "" : "s"}`
		},
		{
			label: "Session",
			value: plan.options.background ? "background transcript" : "foreground streaming session"
		},
		{
			label: "Apply",
			value: plan.options.apply ? "apply verified diff back to original checkout" : "leave diff in worktree"
		},
		{
			label: "Publish",
			value: plan.options.pr ? `commit, push, and open ${plan.options.ready ? "ready" : "draft"} PR` : plan.options.commit ? "commit on an agent branch" : "no commit or PR"
		}
	];
	if (plan.options.commit || plan.options.pr) {
		rows.push({
			label: "Commit message",
			value: plan.options.commitMessage
		});
		if (plan.options.branch) rows.push({
			label: "Branch",
			value: plan.options.branch
		});
		if (plan.options.base) rows.push({
			label: "Base",
			value: plan.options.base
		});
		if (plan.options.prTitle) rows.push({
			label: "PR title",
			value: plan.options.prTitle
		});
	}
	return rows;
};
const findingLine = (diagnostic) => `${diagnostic.filePath}:${diagnostic.line} ${diagnostic.rule} (${diagnostic.severity})`;
const renderAgentPlan = (plan) => {
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: "Agent plan",
			context: [plan.options.provider]
		}).trimEnd(),
		"",
		renderDisplaySection("Context"),
		...renderDisplayRows([
			{
				label: "Directory",
				value: plan.directory
			},
			{
				label: "Repo",
				value: plan.git.root
			},
			{
				label: "Branch",
				value: `${plan.git.branch ?? "detached"} @ ${plan.git.head || "unknown"}`
			},
			{
				label: "Checkout",
				value: plan.git.dirty ? "dirty" : "clean"
			},
			{
				label: "Provider",
				value: providerText$1(plan.provider)
			},
			{
				label: "Source",
				value: providerSourceText$1(plan.options)
			},
			{
				label: "Score",
				value: `${plan.scan.score ?? "not scored"} / 100 (${plan.scan.diagnostics.length} findings)`
			},
			{
				label: "Target",
				value: `${plan.options.targetScore} / 100`
			}
		], {
			indent: 3,
			labelWidth: 9
		}),
		"",
		renderDisplaySection("Actions"),
		...renderDisplayRows(actionRows(plan), {
			indent: 3,
			labelWidth: 14
		})
	];
	if (plan.findings.length > 0) {
		lines.push("", renderDisplaySection("Selected findings"));
		for (const finding of plan.findings.slice(0, 8)) lines.push(` - ${findingLine(finding)}`);
		if (plan.findings.length > 8) lines.push(` - ...and ${plan.findings.length - 8} more`);
	} else lines.push("", renderDisplaySection("Selected findings"), " - none");
	lines.push("", renderDisplaySection(plan.blockers.length > 0 ? "Blockers" : "Ready"), ...plan.blockers.length > 0 ? plan.blockers.map((blocker) => ` - ${blocker}`) : [" - No blockers found."], "", renderDisplaySection("Notes"), ...renderDisplayRows([{
		label: "False positives",
		value: "provider prompt asks the agent to leave likely false positives unchanged and explain why."
	}], {
		indent: 3,
		labelWidth: 15
	}));
	return `${lines.join("\n")}\n`;
};
const agentPlanCommand = async (directory, options) => {
	try {
		const requestedDirectory = path.resolve(directory);
		const git = await readGitPlanState(directory);
		const providerChoice = resolveAgentProviderSelection({
			root: git.root,
			requested: options.provider,
			explicit: options.providerSource === "cli"
		});
		const resolvedOptions = {
			...options,
			provider: providerChoice.selection,
			providerSource: providerChoice.source,
			providerPreference: providerChoice.preference?.provider
		};
		const statuses = getProviderStatuses();
		const provider = resolveProvider(resolvedOptions.provider, statuses);
		const scan = scanJson(requestedDirectory);
		const plan = {
			directory: requestedDirectory,
			git,
			provider,
			scan,
			findings: selectAgentFindings(scan.diagnostics, resolvedOptions.limit),
			options: resolvedOptions,
			blockers: buildAgentPlanBlockers({
				git,
				provider,
				options: resolvedOptions
			})
		};
		process.stdout.write(renderAgentPlan(plan));
		if (!provider) log.muted(`Supported providers: ${providerIds().join(", ")}`);
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
//#endregion
//#region src/commands/agent-providers.ts
const providerState = (status) => {
	if (!status.installed) return "not installed";
	if (status.authenticated === false) return "installed, auth needed";
	return "ready";
};
const providerStatusItem = (status) => {
	const marker = status.installed ? status.authenticated === false ? style$1(theme, "warn", "!") : style$1(theme, "success", "✓") : style$1(theme, "muted", "·");
	const rows = [{
		label: "Status",
		value: providerState(status)
	}];
	if (status.version) rows.push({
		label: "Version",
		value: status.version
	});
	if (status.authHint) rows.push({
		label: "Auth",
		value: status.authHint
	});
	rows.push({
		label: "Connect",
		value: `aislop agent connect ${status.provider.id}`
	});
	return {
		marker,
		label: status.provider.label,
		rows
	};
};
const renderAgentProviders = (input = {}) => {
	const statuses = input.statuses ?? getProviderStatuses();
	const defaultProvider = input.preference ? `${statuses.find((status) => status.provider.id === input.preference)?.provider.label ?? input.preference} (${input.preference})` : "auto";
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: "Agent providers",
			context: ["local"]
		}).trimEnd(),
		"",
		renderDisplaySection("Default"),
		...renderDisplayRows([{
			label: "Provider",
			value: defaultProvider
		}]),
		"",
		renderDisplaySection("Providers"),
		...renderDisplayStatusItems(statuses.map(providerStatusItem), { labelWidth: 7 })
	];
	lines.push("", renderDisplaySection("Actions"), ...renderDisplayCommandRows([{
		label: "Switch",
		command: `aislop agent --provider <${providerIds().join("|")}|auto>`
	}, {
		label: "Save",
		command: "aislop agent use <provider|auto>"
	}], { indent: 3 }));
	return `${lines.join("\n")}\n`;
};
const agentProvidersCommand = async () => {
	let preference = null;
	try {
		const { root } = await prepareAgentLocalState(process.cwd());
		preference = readAgentProviderPreference(root)?.provider ?? null;
	} catch {
		preference = null;
	}
	process.stdout.write(renderAgentProviders({ preference }));
};
//#endregion
//#region src/commands/agent-use.ts
const isAgentProviderSelection = (value) => value === "auto" || providerIds().includes(value);
const providerLabel$1 = (provider) => {
	return getProviderStatuses().find((item) => item.provider.id === provider)?.provider.label ?? provider;
};
const renderCurrentPreference = (root) => {
	const preference = readAgentProviderPreference(root);
	if (!preference) return [
		renderDisplaySection("Default"),
		...renderDisplayRows([{
			label: "Provider",
			value: "auto"
		}]),
		"",
		renderDisplaySection("Next"),
		...renderDisplayCommandRows([{
			label: "Set",
			command: "aislop agent use codex|claude|opencode"
		}]),
		""
	].join("\n");
	const rows = [
		{
			label: "Provider",
			value: `${providerLabel$1(preference.provider)} (${preference.provider})`
		},
		{
			label: "Preference",
			value: displayAgentPath(root, agentProviderPreferencePath(root))
		},
		...preference.updatedAt ? [{
			label: "Updated",
			value: preference.updatedAt
		}] : []
	];
	return `${[
		renderDisplaySection("Default"),
		...renderDisplayRows(rows),
		""
	].join("\n")}`;
};
const warnIfProviderNeedsSetup = (provider) => {
	const status = getProviderStatuses().find((item) => item.provider.id === provider);
	if (!status) return;
	if (!status.installed) {
		log.warn(`${status.provider.label} is not installed on PATH yet.`);
		log.muted(`Install ${status.provider.bin}, then run \`aislop agent connect ${provider}\`.`);
		return;
	}
	if (status.authenticated === false) {
		log.warn(`${status.provider.label} is installed but not authenticated.`);
		log.muted(status.provider.loginHint);
	}
};
const agentUseCommand = async (provider, options) => {
	try {
		const { root } = await prepareAgentLocalState(options.root);
		process.stdout.write(renderHeader({
			version: APP_VERSION,
			command: "Agent provider",
			context: [provider ?? "current"]
		}));
		if (!provider) {
			process.stdout.write(renderCurrentPreference(root));
			return;
		}
		if (!isAgentProviderSelection(provider)) {
			log.error(`Unknown provider. Use one of: auto, ${providerIds().join(", ")}.`);
			process.exitCode = 1;
			return;
		}
		if (provider === "auto") {
			if (options.dryRun) {
				process.stdout.write(`${[
					renderDisplaySection("Dry run"),
					...renderDisplayRows([{
						label: "Change",
						value: "clear saved provider preference"
					}]),
					""
				].join("\n")}`);
				return;
			}
			const cleared = clearAgentProviderPreference(root);
			log.success(cleared ? "Default provider cleared. Agent runs will auto-detect a local provider." : "Default provider is already auto.");
			return;
		}
		if (options.dryRun) {
			process.stdout.write(`${[
				renderDisplaySection("Dry run"),
				...renderDisplayRows([{
					label: "Provider",
					value: `${providerLabel$1(provider)} (${provider})`
				}, {
					label: "Preference",
					value: displayAgentPath(root, agentProviderPreferencePath(root))
				}]),
				""
			].join("\n")}`);
			return;
		}
		const preference = writeAgentProviderPreference(root, provider);
		log.success(`Default provider set to ${providerLabel$1(provider)} (${provider}).`);
		process.stdout.write(`${renderDisplayRows([{
			label: "Preference",
			value: displayAgentPath(root, agentProviderPreferencePath(root))
		}, ...preference.updatedAt ? [{
			label: "Updated",
			value: preference.updatedAt
		}] : []]).join("\n")}\n`);
		warnIfProviderNeedsSetup(provider);
		log.muted("Override once with `aislop agent --provider <provider>`.");
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
//#endregion
//#region src/config/defaults.ts
const DEFAULT_CONFIG = {
	version: 1,
	exclude: [
		"node_modules",
		".git",
		"dist",
		"build",
		"coverage"
	],
	include: [],
	engines: {
		format: true,
		lint: true,
		"code-quality": true,
		"ai-slop": true,
		architecture: false,
		security: true
	},
	quality: {
		maxFunctionLoc: 80,
		maxFileLoc: 400,
		maxNesting: 5,
		maxParams: 6
	},
	lint: {
		typecheck: false,
		expoDoctor: false,
		csharp: {
			projectEvaluation: false,
			jb: true,
			roslynator: true,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: ["InconsistentNaming"]
		},
		cpp: {
			cppcheck: true,
			clangTidy: true,
			cppcheckEnable: "warning,performance,portability",
			jb: false,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: []
		}
	},
	security: {
		audit: true,
		auditTimeout: 25e3
	},
	scoring: {
		weights: {
			format: .3,
			lint: .6,
			"code-quality": .8,
			"ai-slop": 1,
			architecture: 1,
			security: 1.5
		},
		thresholds: {
			good: 75,
			ok: 50
		},
		smoothing: 5,
		maxPerRule: 40
	},
	ci: {
		failBelow: 70,
		format: "json"
	},
	telemetry: { enabled: true },
	rules: {}
};
const GITHUB_WORKFLOW_DIR = ".github/workflows";
const GITHUB_WORKFLOW_FILE = "aislop.yml";
const DEFAULT_GITHUB_WORKFLOW_YAML = `name: aislop

on:
  push:
    branches: [main]
  pull_request:

jobs:
  quality-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: scanaislop/aislop@v1
        with:
          version: latest
`;
const DEFAULT_RULES_YAML = `# Architecture rules (BYO)
# Uncomment and customize to enforce your project's conventions.
#
# rules:
#   - name: no-axios
#     type: forbid_import
#     match: "axios"
#     severity: error
#
#   - name: controller-no-db
#     type: forbid_import_from_path
#     from: "src/controllers/**"
#     forbid: "src/db/**"
#     severity: error
`;
//#endregion
//#region src/config/extends.ts
const MAX_DEPTH$1 = 5;
const MAX_CONFIG_BYTES = 1024 * 1024;
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const deepMerge = (...sources) => {
	const result = {};
	for (const source of sources) for (const key of Object.keys(source)) {
		const a = result[key];
		const b = source[key];
		result[key] = isPlainObject(a) && isPlainObject(b) ? deepMerge(a, b) : b;
	}
	return result;
};
const findGitRoot = (startDir) => {
	let current = path.resolve(startDir);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
};
const isPathInside = (candidate, root) => {
	const rel = path.relative(root, candidate);
	return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
};
const resolveExtendsRef = (ref, fromDir) => {
	if (ref.startsWith("http://") || ref.startsWith("https://")) throw new Error(`URL-based extends not yet supported: ${ref}`);
	if (path.isAbsolute(ref)) throw new Error(`Absolute extends paths are not allowed: ${ref}`);
	if (/^\.\.?[/\\]/.test(ref)) return path.resolve(fromDir, ref);
	throw new Error(`Package-name extends not yet supported: ${ref} (use a relative path for now)`);
};
const normalizeExtends = (raw) => {
	if (raw === void 0 || raw === null) return [];
	if (typeof raw === "string") return [raw];
	if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) return raw;
	throw new Error("`extends` must be a string or array of strings");
};
const assertReadableConfigFile = (configPath, state) => {
	let realPath;
	try {
		realPath = fs.realpathSync(configPath);
	} catch {
		throw new Error(`extends target not found: ${path.resolve(configPath)}`);
	}
	if (!isPathInside(realPath, state.rootDir)) throw new Error(`extends target must stay within ${state.rootDir}: ${realPath}`);
	const stats = fs.statSync(realPath);
	if (!stats.isFile()) throw new Error(`extends target must be a regular file: ${realPath}`);
	if (stats.size > state.maxBytes) throw new Error(`extends target is too large (${stats.size} bytes): ${realPath}`);
	return realPath;
};
const loadConfigChainInner = (configPath, state, depth) => {
	if (depth > MAX_DEPTH$1) throw new Error(`extends depth exceeded ${MAX_DEPTH$1} (cycle or runaway chain): ${configPath}`);
	const absPath = assertReadableConfigFile(configPath, state);
	if (state.visited.has(absPath)) throw new Error(`circular extends detected: ${absPath}`);
	const nextState = {
		...state,
		visited: new Set(state.visited).add(absPath)
	};
	const raw = fs.readFileSync(absPath, "utf-8");
	const parsed = YAML.parse(raw) ?? {};
	const refs = normalizeExtends(parsed.extends);
	const fromDir = path.dirname(absPath);
	const parents = refs.map((ref) => {
		const parentPath = resolveExtendsRef(ref, fromDir);
		return loadConfigChainInner(parentPath, nextState, depth + 1);
	});
	const { extends: _drop, ...own } = parsed;
	return deepMerge(...parents, own);
};
const loadConfigChain = (configPath, options = {}) => {
	const configDir = path.dirname(path.resolve(configPath));
	const rootDir = path.resolve(options.rootDir ?? findGitRoot(configDir) ?? configDir);
	return loadConfigChainInner(configPath, {
		rootDir: fs.realpathSync(rootDir),
		maxBytes: options.maxBytes ?? MAX_CONFIG_BYTES,
		visited: /* @__PURE__ */ new Set()
	}, 0);
};
//#endregion
//#region src/config/schema.ts
const DEFAULT_WEIGHTS = {
	format: .3,
	lint: .6,
	"code-quality": .8,
	"ai-slop": 1,
	architecture: 1,
	security: 1.5
};
const EnginesSchema = z.object({
	format: z.boolean().default(true),
	lint: z.boolean().default(true),
	"code-quality": z.boolean().default(true),
	"ai-slop": z.boolean().default(true),
	architecture: z.boolean().default(false),
	security: z.boolean().default(true)
});
const QualitySchema = z.object({
	maxFunctionLoc: z.number().positive().default(80),
	maxFileLoc: z.number().positive().default(400),
	maxNesting: z.number().positive().default(5),
	maxParams: z.number().positive().default(6)
});
const CsharpLintSchema = z.object({
	projectEvaluation: z.boolean().default(false),
	jb: z.boolean().default(true),
	roslynator: z.boolean().default(true),
	jbSeverityFloor: z.enum([
		"ERROR",
		"WARNING",
		"SUGGESTION",
		"HINT"
	]).default("WARNING"),
	jbExcludeTypes: z.array(z.string()).default(() => ["InconsistentNaming"]),
	jbProjects: z.string().optional()
});
const CppLintSchema = z.object({
	cppcheck: z.boolean().default(true),
	clangTidy: z.boolean().default(true),
	cppcheckEnable: z.string().default("warning,performance,portability"),
	jb: z.boolean().default(false),
	jbProjects: z.string().optional(),
	jbSeverityFloor: z.enum([
		"ERROR",
		"WARNING",
		"SUGGESTION",
		"HINT"
	]).default("WARNING"),
	jbExcludeTypes: z.array(z.string()).default(() => [])
});
const LintConfigSchema = z.object({
	typecheck: z.boolean().default(false),
	/**
	* Expo Doctor can evaluate Expo project configuration files. Keep it
	* disabled by default so scans do not execute code from untrusted repos.
	*/
	expoDoctor: z.boolean().default(false),
	csharp: CsharpLintSchema.default(() => ({
		projectEvaluation: false,
		jb: true,
		roslynator: true,
		jbSeverityFloor: "WARNING",
		jbExcludeTypes: ["InconsistentNaming"]
	})),
	cpp: CppLintSchema.default(() => ({
		cppcheck: true,
		clangTidy: true,
		cppcheckEnable: "warning,performance,portability",
		jb: false,
		jbSeverityFloor: "WARNING",
		jbExcludeTypes: []
	}))
});
const SecurityConfigSchema = z.object({
	audit: z.boolean().default(true),
	auditTimeout: z.number().positive().default(25e3)
});
const ThresholdsSchema = z.object({
	good: z.number().default(75),
	ok: z.number().default(50)
});
const ScoringSchema = z.object({
	weights: z.record(z.string(), z.number()).default(DEFAULT_WEIGHTS),
	thresholds: ThresholdsSchema.default(() => ({
		good: 75,
		ok: 50
	})),
	smoothing: z.number().nonnegative().default(5),
	maxPerRule: z.number().positive().default(40)
});
const CiSchema = z.object({
	failBelow: z.number().default(70),
	format: z.enum(["json"]).default("json")
});
const TelemetrySchema = z.object({ enabled: z.boolean().default(true) });
const RuleSeverityOverride = z.enum([
	"error",
	"warning",
	"off"
]);
const RulesSchema = z.record(z.string(), RuleSeverityOverride).default(() => ({}));
const AislopConfigSchema = z.object({
	version: z.number().default(1),
	engines: EnginesSchema.default(() => ({
		format: true,
		lint: true,
		"code-quality": true,
		"ai-slop": true,
		architecture: false,
		security: true
	})),
	quality: QualitySchema.default(() => ({
		maxFunctionLoc: 80,
		maxFileLoc: 400,
		maxNesting: 5,
		maxParams: 6
	})),
	lint: LintConfigSchema.default(() => ({
		typecheck: false,
		expoDoctor: false,
		csharp: {
			projectEvaluation: false,
			jb: true,
			roslynator: true,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: ["InconsistentNaming"]
		},
		cpp: {
			cppcheck: true,
			clangTidy: true,
			cppcheckEnable: "warning,performance,portability",
			jb: false,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: []
		}
	})),
	security: SecurityConfigSchema.default(() => ({
		audit: true,
		auditTimeout: 25e3
	})),
	scoring: ScoringSchema.default(() => ({
		weights: { ...DEFAULT_WEIGHTS },
		thresholds: {
			good: 75,
			ok: 50
		},
		smoothing: 5,
		maxPerRule: 40
	})),
	ci: CiSchema.default(() => ({
		failBelow: 70,
		format: "json"
	})),
	telemetry: TelemetrySchema.default(() => ({ enabled: true })),
	rules: RulesSchema,
	exclude: z.array(z.string()).default(() => [
		"node_modules",
		".git",
		"dist",
		"build",
		"coverage"
	]),
	include: z.array(z.string()).default(() => [])
});
const defaults = AislopConfigSchema.parse({});
/**
* Pre-merge scoring weights so partial overrides extend the defaults
* rather than replacing them entirely (z.record replaces by default).
*/
const preMergeWeights = (raw) => {
	const scoring = raw.scoring;
	if (!scoring) return;
	const userWeights = scoring.weights;
	if (!userWeights || typeof userWeights !== "object") return;
	scoring.weights = {
		...DEFAULT_WEIGHTS,
		...userWeights
	};
};
const parseConfig = (raw) => {
	if (!raw || typeof raw !== "object") return defaults;
	try {
		const input = raw;
		preMergeWeights(input);
		return AislopConfigSchema.parse(input);
	} catch {
		return defaults;
	}
};
//#endregion
//#region src/config/index.ts
const CONFIG_DIR = ".aislop";
const CONFIG_FILE = "config.yml";
const RULES_FILE = "rules.yml";
const findConfigDir = (startDir, stopAt) => {
	let current = path.resolve(startDir);
	const boundary = stopAt ? path.resolve(stopAt) : null;
	while (true) {
		const candidate = path.join(current, CONFIG_DIR);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		if (boundary && current === boundary) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
};
const loadConfig = (directory) => {
	const configDir = findConfigDir(directory);
	if (!configDir) return DEFAULT_CONFIG;
	const configPath = path.join(configDir, CONFIG_FILE);
	if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
	try {
		return parseConfig(loadConfigChain(configPath));
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		process.stderr.write(`  ⚠ Failed to parse ${configPath}: ${msg}\n  ⚠ Using default configuration.\n`);
		return DEFAULT_CONFIG;
	}
};
//#endregion
//#region src/telemetry/env.ts
const ALLOWED_OVERRIDE = /* @__PURE__ */ new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"npx",
	"homebrew",
	"pip",
	"pipx",
	"direct",
	"unknown"
]);
const normalizePath = (path) => path.replaceAll("\\", "/").toLowerCase();
const entryScriptPath = (argv) => {
	const candidate = argv[1] ?? "";
	if (candidate.length === 0) return "";
	const normalized = normalizePath(candidate);
	if (candidate.endsWith(".js") || normalized.includes("node_modules") || normalized.includes("/cellar/") || normalized.includes("/pipx/") || normalized.includes("site-packages")) return candidate;
	return "";
};
const pathLooksHomebrew = (path) => {
	const normalized = normalizePath(path);
	return normalized.includes("/cellar/aislop/") || normalized.includes("/homebrew/") && normalized.includes("/aislop/") || normalized.includes("/opt/homebrew/") && normalized.includes("/libexec/") && normalized.includes("/aislop/");
};
const pathLooksPipx = (path) => normalizePath(path).includes("/pipx/");
const pathLooksDirect = (path, env) => {
	const normalized = normalizePath(path);
	if (!normalized.includes("node_modules")) return false;
	if (normalized.includes("/_npx/")) return false;
	return !(Boolean(env.npm_execpath) || Boolean(env.npm_command) || Boolean(env.npm_lifecycle_event) || Boolean(env.npm_config_user_agent));
};
const detectNodePackageManager = (env) => {
	const execPath = env.npm_execpath ?? "";
	if (execPath.includes("npx") || execPath.includes("_npx") || env.npm_command === "npx" || env.npm_lifecycle_event === "npx") return "npx";
	const userAgent = env.npm_config_user_agent ?? "";
	if (userAgent.startsWith("pnpm/")) return "pnpm";
	if (userAgent.startsWith("yarn/")) return "yarn";
	if (userAgent.startsWith("bun/")) return "bun";
	if (userAgent.startsWith("npm/")) return "npm";
	if (execPath.includes("pnpm")) return "pnpm";
	if (execPath.includes("yarn")) return "yarn";
	if (execPath.includes("bun")) return "bun";
	if (execPath.includes("npm")) return "npm";
	return null;
};
const detectInstallChannel = (env = process.env, argv = process.argv) => {
	const override = env.AISLOP_INSTALL_CHANNEL?.trim().toLowerCase();
	if (override && ALLOWED_OVERRIDE.has(override)) return override;
	const scriptPath = entryScriptPath(argv);
	const probePaths = [scriptPath, env.npm_execpath ?? ""].filter((path) => path.length > 0);
	for (const path of probePaths) if (pathLooksHomebrew(path)) return "homebrew";
	for (const path of probePaths) if (pathLooksPipx(path)) return "pipx";
	const nodePackageManager = detectNodePackageManager(env);
	if (nodePackageManager != null) return nodePackageManager;
	if (scriptPath.length > 0 && pathLooksDirect(scriptPath, env)) return "direct";
	return "unknown";
};
const CI_ENV_KEYS = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"TRAVIS",
	"BUILDKITE",
	"DRONE",
	"TEAMCITY_VERSION",
	"TF_BUILD"
];
const isCiEnv = (env = process.env) => CI_ENV_KEYS.some((k) => {
	const v = env[k];
	return v === "true" || v === "1" || v != null && v.length > 0 && k !== "CI";
}) || env.CI === "true" || env.CI === "1";
const fileCountBucket = (count) => {
	if (count < 10) return "0-10";
	if (count < 50) return "10-50";
	if (count < 100) return "50-100";
	if (count < 500) return "100-500";
	if (count < 1e3) return "500-1000";
	return "1000+";
};
const scoreBucket = (score) => {
	if (score >= 75) return "75-100";
	if (score >= 50) return "50-75";
	if (score >= 25) return "25-50";
	return "0-25";
};
//#endregion
//#region src/telemetry/identity.ts
const FILE_BASENAME = "install_id";
const resolveInstallIdPath = (homedir = os.homedir(), env = process.env) => {
	if (process.platform === "linux" && env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "aislop", FILE_BASENAME);
	return path.join(homedir, ".aislop", FILE_BASENAME);
};
const ensureInstallId = (idPath = resolveInstallIdPath()) => {
	if (fs.existsSync(idPath)) {
		const existing = fs.readFileSync(idPath, "utf-8").trim();
		if (existing.length > 0) return {
			installId: existing,
			created: false
		};
	}
	const dir = path.dirname(idPath);
	fs.mkdirSync(dir, { recursive: true });
	const installId = randomUUID();
	const tmpPath = `${idPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${installId}\n`, { mode: 384 });
	try {
		fs.renameSync(tmpPath, idPath);
		return {
			installId,
			created: true
		};
	} catch {
		fs.rmSync(tmpPath, { force: true });
		return {
			installId: fs.readFileSync(idPath, "utf-8").trim(),
			created: false
		};
	}
};
//#endregion
//#region src/telemetry/redaction.ts
const SAFE_PROPERTY_NAMES = /* @__PURE__ */ new Set([
	"aislop_version",
	"node_version",
	"os",
	"arch",
	"schema_version",
	"anonymous_install_id",
	"package_manager",
	"is_ci",
	"command",
	"language_summary",
	"lang_typescript",
	"lang_javascript",
	"lang_python",
	"lang_java",
	"file_count_bucket",
	"exit_code",
	"duration_ms",
	"error_kind",
	"score",
	"score_bucket",
	"finding_count",
	"error_count",
	"warning_count",
	"fixable_count",
	"fix_steps",
	"fix_resolved",
	"fix_score_delta",
	"score_before",
	"score_after",
	"changed_files",
	"provider_passes",
	"tool_calls",
	"output_events",
	"total_tokens",
	"cost_usd",
	"applied",
	"published",
	"target_met",
	"engine_format_issues",
	"engine_format_ms",
	"engine_lint_issues",
	"engine_lint_ms",
	"engine_code_quality_issues",
	"engine_code_quality_ms",
	"engine_ai_slop_issues",
	"engine_ai_slop_ms",
	"engine_architecture_issues",
	"engine_architecture_ms",
	"engine_security_issues",
	"engine_security_ms",
	"tool",
	"ok",
	"agent",
	"provider",
	"provider_source",
	"target_score",
	"max_turns",
	"finding_limit",
	"worktree_mode",
	"apply_requested",
	"dry_run",
	"background",
	"no_fix",
	"publish_mode",
	"ready_pr",
	"keep_worktree",
	"cleanup_requested",
	"confirmed_noninteractive",
	"provider_supplied",
	"result_limit",
	"custom_root",
	"interval_ms",
	"debounce_ms",
	"once",
	"repair",
	"force",
	"session_supplied",
	"monitor_supplied",
	"agent_result",
	"score_delta"
]);
const redactProperties = (props) => {
	const clean = {};
	const dropped = [];
	for (const [key, value] of Object.entries(props)) {
		if (value === void 0) continue;
		if (SAFE_PROPERTY_NAMES.has(key)) clean[key] = value;
		else dropped.push(key);
	}
	return {
		clean,
		dropped
	};
};
//#endregion
//#region src/telemetry/client.ts
const POSTHOG_HOST = process.env.AISLOP_POSTHOG_HOST ?? "https://eu.i.posthog.com";
const POSTHOG_KEY = process.env.AISLOP_POSTHOG_KEY ?? "phc_eY2cOMFva9q24GrWeOuvuVIOhCIdjOALxeAR3ItrqbJ";
const SCHEMA_VERSION = "v2";
const REQUEST_TIMEOUT_MS$1 = 3e3;
const isTelemetryDisabled = (config) => {
	const env = process.env;
	if (env.AISLOP_NO_TELEMETRY === "1" || env.DO_NOT_TRACK === "1") return true;
	if (config?.enabled === false) return true;
	if (config?.enabled === true) return false;
	if (env.CI === "true" || env.CI === "1") return true;
	return false;
};
const isDebug = () => process.env.AISLOP_TELEMETRY_DEBUG === "1";
const pendingRequests = /* @__PURE__ */ new Set();
let cachedInstallId = null;
let installCreated = false;
const baseProperties = (installId) => ({
	aislop_version: APP_VERSION,
	node_version: process.version,
	os: os.platform(),
	arch: os.arch(),
	schema_version: SCHEMA_VERSION,
	anonymous_install_id: installId,
	package_manager: detectInstallChannel(),
	is_ci: isCiEnv()
});
const track = (input) => {
	if (isTelemetryDisabled(input.config)) return { installCreated: false };
	if (cachedInstallId == null) {
		const ensured = ensureInstallId(resolveInstallIdPath());
		cachedInstallId = ensured.installId;
		installCreated = ensured.created;
	}
	const { clean, dropped } = redactProperties({
		...baseProperties(cachedInstallId),
		...input.properties
	});
	if (isDebug()) {
		const compact = JSON.stringify({
			event: input.event,
			properties: clean
		});
		process.stderr.write(`[telemetry] ${compact}\n`);
		if (dropped.length > 0) for (const key of dropped) process.stderr.write(`[telemetry] dropped non-allowlisted property: ${key}\n`);
	}
	if (process.env.AISLOP_TELEMETRY_DRY_RUN === "1") return { installCreated };
	const payload = {
		api_key: POSTHOG_KEY,
		event: input.event,
		distinct_id: cachedInstallId,
		properties: clean,
		timestamp: (/* @__PURE__ */ new Date()).toISOString()
	};
	const request = fetch(`${POSTHOG_HOST}/capture/`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS$1)
	}).then(() => {}).catch(() => {}).finally(() => {
		pendingRequests.delete(request);
	});
	pendingRequests.add(request);
	return { installCreated };
};
const flushTelemetry = async (timeoutMs) => {
	if (pendingRequests.size === 0) return;
	const all = Promise.all(pendingRequests);
	if (timeoutMs == null) {
		await all;
		return;
	}
	await Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
};
//#endregion
//#region src/telemetry/language.ts
const ALL_LANGUAGES = [
	"typescript",
	"javascript",
	"python",
	"java",
	"csharp",
	"cpp"
];
const buildLanguageProperties = (detected) => {
	const present = new Set(detected);
	const summary = [...present].filter((l) => ALL_LANGUAGES.includes(l));
	summary.sort();
	return {
		language_summary: summary.join(","),
		lang_typescript: present.has("typescript"),
		lang_javascript: present.has("javascript"),
		lang_python: present.has("python"),
		lang_java: present.has("java"),
		lang_csharp: present.has("csharp"),
		lang_cpp: present.has("cpp")
	};
};
//#endregion
//#region src/telemetry/events.ts
const buildCommandStartedProps = (input) => {
	const props = {
		...input.properties,
		command: input.command
	};
	if (input.languages) Object.assign(props, buildLanguageProperties(input.languages));
	if (typeof input.fileCount === "number") props.file_count_bucket = fileCountBucket(input.fileCount);
	return props;
};
const ENGINE_KEY_MAP = {
	format: "engine_format",
	lint: "engine_lint",
	"code-quality": "engine_code_quality",
	"ai-slop": "engine_ai_slop",
	architecture: "engine_architecture",
	security: "engine_security"
};
const flattenEngineStats = (issues, timings) => {
	const out = {};
	for (const [engine, count] of Object.entries(issues)) {
		const key = ENGINE_KEY_MAP[engine];
		if (key != null && typeof count === "number") out[`${key}_issues`] = count;
	}
	for (const [engine, ms] of Object.entries(timings)) {
		const key = ENGINE_KEY_MAP[engine];
		if (key != null && typeof ms === "number") out[`${key}_ms`] = Math.round(ms);
	}
	return out;
};
const buildCommandCompletedProps = (input) => {
	const props = {
		...input.startProps,
		...input.properties,
		exit_code: input.exitCode,
		duration_ms: Math.round(input.durationMs)
	};
	if (input.errorKind) props.error_kind = input.errorKind;
	if (typeof input.score === "number") {
		props.score = input.score;
		props.score_bucket = scoreBucket(input.score);
	}
	if (typeof input.findingCount === "number") props.finding_count = input.findingCount;
	if (typeof input.errorCount === "number") props.error_count = input.errorCount;
	if (typeof input.warningCount === "number") props.warning_count = input.warningCount;
	if (typeof input.fixableCount === "number") props.fixable_count = input.fixableCount;
	if (input.engineIssues && input.engineTimings) Object.assign(props, flattenEngineStats(input.engineIssues, input.engineTimings));
	if (typeof input.fixSteps === "number") props.fix_steps = input.fixSteps;
	if (typeof input.fixResolved === "number") props.fix_resolved = input.fixResolved;
	if (typeof input.fixScoreDelta === "number") props.fix_score_delta = input.fixScoreDelta;
	return props;
};
const buildHookScanCompletedProps = (input) => {
	const props = {
		agent: input.agent,
		score: input.score,
		score_bucket: scoreBucket(input.score),
		finding_count: input.findingCount,
		file_count_bucket: fileCountBucket(input.fileCount)
	};
	if (typeof input.scoreDelta === "number") props.score_delta = input.scoreDelta;
	return props;
};
const errorKindFromException = (error) => {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	if (message.includes("timeout") || message.includes("timed out")) return "timeout";
	if (message.includes("invalid config") || message.includes("config_invalid")) return "config_invalid";
	if (message.includes("engine") && message.includes("crash")) return "engine_crash";
	return "unknown";
};
//#endregion
//#region src/telemetry/lifecycle.ts
const STARTED_FLUSH_TIMEOUT_MS = 100;
const withCommandLifecycle = async (start, run) => {
	const startProps = buildCommandStartedProps({
		command: start.command,
		languages: start.languages,
		fileCount: start.fileCount,
		properties: start.properties
	});
	track({
		event: "cli_command_started",
		properties: startProps,
		config: start.config
	});
	await flushTelemetry(STARTED_FLUSH_TIMEOUT_MS);
	const startedAt = performance.now();
	try {
		const result = await run();
		const durationMs = performance.now() - startedAt;
		track({
			event: "cli_command_completed",
			properties: buildCommandCompletedProps({
				startProps,
				exitCode: result.exitCode,
				durationMs,
				score: result.score ?? void 0,
				findingCount: result.findingCount,
				errorCount: result.errorCount,
				warningCount: result.warningCount,
				fixableCount: result.fixableCount,
				engineIssues: result.engineIssues,
				engineTimings: result.engineTimings,
				fixSteps: result.fixSteps,
				fixResolved: result.fixResolved,
				fixScoreDelta: result.fixScoreDelta,
				properties: result.properties
			}),
			config: start.config
		});
		await flushTelemetry();
		return result;
	} catch (error) {
		track({
			event: "cli_command_completed",
			properties: buildCommandCompletedProps({
				startProps,
				exitCode: 1,
				durationMs: performance.now() - startedAt,
				errorKind: errorKindFromException(error)
			}),
			config: start.config
		});
		await flushTelemetry();
		throw error;
	}
};
//#endregion
//#region src/cli/agent-command-options.ts
const parseInteger = (value) => Number.parseInt(value, 10);
const AGENT_OPTIONS = [
	{
		flag: "--provider <provider>",
		description: "provider to use: auto, codex, claude, opencode",
		defaultValue: "auto"
	},
	{
		flag: "--target-score <score>",
		description: "score to converge toward",
		parser: parseInteger,
		defaultValue: 90
	},
	{
		flag: "--max-turns <n>",
		description: "maximum provider turns for one repair attempt",
		parser: parseInteger,
		defaultValue: 4
	},
	{
		flag: "--limit <n>",
		description: "maximum findings to hand to the provider",
		parser: parseInteger,
		defaultValue: 8
	},
	{
		flag: "--in-place",
		description: "edit the current worktree instead of creating an isolated git worktree"
	},
	{
		flag: "--apply",
		description: "apply the accepted diff back to the original worktree"
	},
	{
		flag: "-y, --yes",
		description: "skip confirmation prompts for --apply"
	},
	{
		flag: "--dry-run",
		description: "print the selected provider and plan without running it"
	},
	{
		flag: "--background",
		description: "start the agent in the background and return immediately"
	},
	{
		flag: "--no-fix",
		description: "skip deterministic safe fixes before provider handoff"
	},
	{
		flag: "--commit",
		description: "commit the verified diff on an agent branch"
	},
	{
		flag: "--pr",
		description: "push the agent branch and open a draft pull request"
	},
	{
		flag: "--branch <name>",
		description: "branch name for --commit or --pr"
	},
	{
		flag: "--base <branch>",
		description: "base branch for --pr"
	},
	{
		flag: "--commit-message <message>",
		description: "commit message for --commit or --pr",
		defaultValue: "chore(aislop): repair AI slop findings"
	},
	{
		flag: "--title <title>",
		description: "pull request title for --pr"
	},
	{
		flag: "--ready",
		description: "open a ready-for-review PR instead of a draft"
	},
	{
		flag: "--no-keep-worktree",
		description: "remove the generated worktree when it is safe to do so"
	},
	{
		flag: "--cleanup",
		description: "remove the generated worktree even when a diff remains"
	}
];
const addAgentOptions = (command) => {
	for (const option of AGENT_OPTIONS) if (option.parser) command.option(option.flag, option.description, option.parser, option.defaultValue);
	else if (option.defaultValue !== void 0) command.option(option.flag, option.description, option.defaultValue);
	else command.option(option.flag, option.description);
};
const MONITOR_AGENT_OPTIONS = [
	"--provider <provider>",
	"--target-score <score>",
	"--max-turns <n>",
	"--limit <n>",
	"--in-place",
	"--dry-run",
	"--no-fix"
];
const addMonitorOptions = (command) => {
	for (const option of AGENT_OPTIONS) {
		if (!MONITOR_AGENT_OPTIONS.includes(option.flag)) continue;
		if (option.parser) command.option(option.flag, option.description, option.parser, option.defaultValue);
		else if (option.defaultValue !== void 0) command.option(option.flag, option.description, option.defaultValue);
		else command.option(option.flag, option.description);
	}
	command.option("--repair", "run bounded local repair sessions when scans miss the target");
	command.option("--background", "start the monitor in the background and return immediately");
	command.option("--interval <ms>", "poll interval for git changes", parseInteger, 5e3);
	command.option("--debounce <ms>", "quiet period before reacting to a change", parseInteger, 1500);
	command.option("--once", "run one monitor cycle and exit");
};
const providerSourceFrom = (command) => command.getOptionValueSourceWithGlobals("provider") === "default" ? "auto" : "cli";
const TELEMETRY_PROVIDERS = /* @__PURE__ */ new Set([
	"auto",
	"codex",
	"claude",
	"opencode"
]);
const telemetryProvider = (provider) => {
	if (!provider) return "none";
	return TELEMETRY_PROVIDERS.has(provider) ? provider : "unknown";
};
const exitCodeFromProcess = () => {
	const code = process.exitCode;
	if (typeof code === "number") return code;
	if (typeof code === "string") {
		const parsed = Number.parseInt(code, 10);
		return Number.isFinite(parsed) ? parsed : 1;
	}
	return 0;
};
const withAgentLifecycle = async (command, configDirectory, properties, run) => {
	await withCommandLifecycle({
		command,
		config: loadConfig(configDirectory).telemetry,
		properties
	}, async () => {
		const completionProperties = await run();
		return {
			exitCode: exitCodeFromProcess(),
			properties: completionProperties ?? void 0
		};
	});
};
const agentTelemetryProperties = (options) => ({
	provider: telemetryProvider(options.provider),
	provider_source: options.providerSource,
	target_score: options.targetScore,
	max_turns: options.maxTurns,
	finding_limit: options.limit,
	worktree_mode: options.inPlace ? "current" : "isolated",
	apply_requested: options.apply,
	dry_run: options.dryRun,
	background: options.background,
	no_fix: options.noFix,
	publish_mode: options.pr ? "pr" : options.commit ? "commit" : "none",
	ready_pr: options.ready,
	keep_worktree: options.keepWorktree,
	cleanup_requested: options.cleanup,
	confirmed_noninteractive: options.yes
});
const monitorTelemetryProperties = (options) => ({
	...agentTelemetryProperties(options),
	interval_ms: options.interval,
	debounce_ms: options.debounce,
	once: options.once,
	repair: options.repair
});
const agentOptionsFromFlags = (flags, command) => ({
	provider: flags.provider ?? "auto",
	providerSource: providerSourceFrom(command),
	targetScore: flags.targetScore ?? 90,
	maxTurns: flags.maxTurns ?? 4,
	limit: flags.limit ?? 8,
	inPlace: Boolean(flags.inPlace),
	apply: Boolean(flags.apply),
	yes: Boolean(flags.yes),
	dryRun: Boolean(flags.dryRun),
	background: Boolean(flags.background),
	noFix: flags.fix === false,
	commit: Boolean(flags.commit) || Boolean(flags.pr),
	pr: Boolean(flags.pr),
	branch: flags.branch,
	base: flags.base,
	commitMessage: flags.commitMessage ?? "chore(aislop): repair AI slop findings",
	prTitle: flags.title,
	ready: Boolean(flags.ready),
	keepWorktree: flags.keepWorktree !== false,
	cleanup: Boolean(flags.cleanup)
});
//#endregion
//#region src/agents/monitor-store.ts
const pad = (value) => String(value).padStart(2, "0");
const buildAgentMonitorId = (date = /* @__PURE__ */ new Date(), pid = process.pid) => [
	"monitor",
	`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
	`${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
	String(pid)
].join("-");
const agentMonitorDir = (root) => path.join(root, ".aislop", "agent", "monitors");
const agentMonitorPath = (root, id) => path.join(agentMonitorDir(root), `${id}.json`);
const writeAgentMonitorRecord = (root, record) => {
	const file = agentMonitorPath(root, record.id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
};
const updateAgentMonitorRecord = (root, id, update) => {
	const file = agentMonitorPath(root, id);
	const record = readAgentMonitorRecord(file);
	if (!record) return null;
	const updated = update(record);
	writeAgentMonitorRecord(root, updated);
	return updated;
};
const readAgentMonitorRecord = (file) => {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!parsed.id || !parsed.root || !parsed.startedAt || !parsed.logPath) return null;
		return parsed;
	} catch {
		return null;
	}
};
const isProcessRunning = (pid) => {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const summarizeAgentMonitor = (file, record) => ({
	...record,
	path: file,
	status: record.stoppedAt ? "stopped" : isProcessRunning(record.pid) ? "running" : "exited"
});
const appendAgentMonitorCycle = (root, id, cycle, limit = 8) => updateAgentMonitorRecord(root, id, (record) => ({
	...record,
	recentCycles: [...record.recentCycles ?? [], cycle].slice(-Math.max(1, limit))
}));
const monitorFiles = (root) => {
	const dir = agentMonitorDir(root);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => path.join(dir, file));
};
const listAgentMonitors = (root, options = {}) => monitorFiles(root).map((file) => {
	const record = readAgentMonitorRecord(file);
	return record ? summarizeAgentMonitor(file, record) : null;
}).filter((summary) => summary !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, options.limit ?? 10);
const resolveAgentMonitorPath = (root, monitor) => {
	const files = monitorFiles(root).sort((a, b) => b.localeCompare(a));
	if (!monitor) return files[0] ?? null;
	if (fs.existsSync(monitor)) return monitor;
	const direct = agentMonitorPath(root, monitor);
	if (fs.existsSync(direct)) return direct;
	const matches = files.filter((file) => path.basename(file, ".json").startsWith(monitor));
	return matches.length === 1 ? matches[0] : null;
};
//#endregion
//#region src/commands/agent-session-root.ts
const resolveAgentGitRoot = async (directory) => {
	const result = await runSubprocess("git", ["rev-parse", "--show-toplevel"], { cwd: path.resolve(directory) });
	if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error("Agent sessions need to be read from inside a git repository.");
	return result.stdout.trim();
};
//#endregion
//#region src/commands/agent-monitor-lifecycle.ts
const statusMarker$1 = (status) => {
	if (status === "running") return style$1(theme, "info", "*");
	if (status === "stopped") return style$1(theme, "warn", "!");
	return style$1(theme, "muted", ".");
};
const modeText = (monitor) => monitor.repair ? "repair" : "watch";
const latestCycle = (monitor) => monitor.recentCycles?.at(-1);
const cycleSummaryText = (monitor) => {
	const cycle = latestCycle(monitor);
	if (!cycle) return "no cycles yet";
	return `${cycle.score === null ? "not scored" : `${cycle.score}/100`}, ${cycle.diagnostics} finding${cycle.diagnostics === 1 ? "" : "s"}`;
};
const monitorStatusItem = (monitor) => ({
	marker: statusMarker$1(monitor.status),
	label: monitor.id,
	rows: [
		{
			label: "Status",
			value: monitor.status
		},
		{
			label: "Mode",
			value: modeText(monitor)
		},
		{
			label: "Provider",
			value: monitor.provider
		},
		{
			label: "Started",
			value: monitor.startedAt
		},
		{
			label: "PID",
			value: String(monitor.pid ?? "n/a")
		},
		{
			label: "Interval",
			value: `${monitor.interval}ms`
		},
		{
			label: "Latest",
			value: cycleSummaryText(monitor)
		}
	]
});
const changedFilesText$1 = (files) => {
	if (files.length === 0) return "no git changes";
	const preview = files.slice(0, 4).join(", ");
	return files.length > 4 ? `${preview}, +${files.length - 4} more` : preview;
};
const renderAgentMonitorList = (input) => {
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: "Agent monitors",
			context: ["local"]
		}).trimEnd(),
		"",
		renderDisplaySection("Monitors")
	];
	if (input.monitors.length === 0) {
		lines.push(" No local agent monitors yet.");
		lines.push("", renderDisplaySection("Next"), ...renderDisplayCommandRows([{
			label: "Start",
			command: "aislop agent monitor --background"
		}]));
		return `${lines.join("\n")}\n`;
	}
	lines.push(...renderDisplayStatusItems(input.monitors.map(monitorStatusItem), { labelWidth: 8 }));
	lines.push("", renderDisplaySection("Next"), ...renderDisplayCommandRows([{
		label: "Details",
		command: "aislop agent monitor show <monitor>"
	}]));
	return `${lines.join("\n")}\n`;
};
const renderAgentMonitorShow = (monitor) => {
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: "Agent monitor",
			context: [monitor.id]
		}).trimEnd(),
		"",
		renderDisplaySection("Details"),
		...renderDisplayRows([
			{
				label: "Status",
				value: monitor.status
			},
			{
				label: "Mode",
				value: modeText(monitor)
			},
			{
				label: "Provider",
				value: monitor.provider
			},
			{
				label: "Source",
				value: monitor.providerSource
			},
			{
				label: "Root",
				value: monitor.root
			},
			{
				label: "Directory",
				value: monitor.requestedDirectory
			},
			{
				label: "Started",
				value: monitor.startedAt
			},
			{
				label: "PID",
				value: String(monitor.pid ?? "n/a")
			},
			{
				label: "Interval",
				value: `${monitor.interval}ms`
			},
			{
				label: "Debounce",
				value: `${monitor.debounce}ms`
			},
			{
				label: "Target",
				value: `${monitor.targetScore} / 100`
			},
			{
				label: "Limit",
				value: String(monitor.limit)
			},
			{
				label: "Record",
				value: monitor.path
			},
			{
				label: "Log",
				value: monitor.logPath
			},
			...monitor.stoppedAt ? [{
				label: "Stopped",
				value: monitor.stoppedAt
			}] : [],
			...monitor.signal ? [{
				label: "Signal",
				value: monitor.signal
			}] : []
		], {
			indent: 3,
			labelWidth: 9
		})
	];
	if (monitor.recentCycles?.length) {
		lines.push("", renderDisplaySection("Recent cycles"));
		for (const cycle of monitor.recentCycles.slice(-6)) {
			const score = cycle.score === null ? "not scored" : `${cycle.score}/100`;
			lines.push(` - ${cycle.timestamp}: ${score}, ${cycle.diagnostics} finding${cycle.diagnostics === 1 ? "" : "s"}, ${changedFilesText$1(cycle.changedFiles)}`);
			if (cycle.repaired) lines.push("   repair session triggered");
		}
	}
	return `${lines.join("\n")}\n`;
};
const readMonitorSummary = (root, monitor) => {
	const monitorPath = resolveAgentMonitorPath(root, monitor);
	if (!monitorPath) throw new Error(monitor ? `No matching agent monitor: ${monitor}` : "No agent monitors found.");
	const record = readAgentMonitorRecord(monitorPath);
	if (!record) throw new Error(`Could not read agent monitor record: ${monitorPath}`);
	return summarizeAgentMonitor(monitorPath, record);
};
const agentMonitorListCommand = async (directory, options) => {
	try {
		const root = await resolveAgentGitRoot(directory);
		process.stdout.write(renderAgentMonitorList({
			root,
			monitors: listAgentMonitors(root, options)
		}));
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
const agentMonitorShowCommand = async (monitor, options) => {
	try {
		const root = await resolveAgentGitRoot(options.root);
		process.stdout.write(renderAgentMonitorShow(readMonitorSummary(root, monitor)));
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
const stopAgentMonitor = async (root, monitor, options) => {
	const summary = readMonitorSummary(root, monitor);
	if (summary.status === "stopped") throw new Error(`Agent monitor ${summary.id} is already stopped.`);
	const signal = options.force ? "SIGKILL" : "SIGTERM";
	if (!!isProcessRunning(summary.pid) && summary.pid) signalMonitorProcess(summary.pid, signal);
	const updated = {
		...summary,
		stoppedAt: (/* @__PURE__ */ new Date()).toISOString(),
		signal
	};
	writeAgentMonitorRecord(root, updated);
	return summarizeAgentMonitor(summary.path, updated);
};
const signalMonitorProcess = (pid, signal) => {
	if (process.platform !== "win32") try {
		process.kill(-pid, signal);
		return;
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
	process.kill(pid, signal);
};
const agentMonitorStopCommand = async (monitor, options) => {
	try {
		const root = await resolveAgentGitRoot(options.root);
		const stopped = await stopAgentMonitor(root, monitor, { force: options.force });
		process.stdout.write(`${[
			renderDisplaySection("Stopped monitor"),
			...renderDisplayRows([
				{
					label: "Monitor",
					value: stopped.id
				},
				...stopped.pid ? [{
					label: "PID",
					value: String(stopped.pid)
				}] : [],
				{
					label: "Signal",
					value: stopped.signal ?? (options.force ? "SIGKILL" : "SIGTERM")
				},
				{
					label: "Status",
					value: stopped.status
				}
			]),
			"",
			renderDisplaySection("Next"),
			...renderDisplayCommandRows([{
				label: "Inspect",
				command: `aislop agent monitor show ${stopped.id}`
			}]),
			""
		].join("\n")}`);
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
//#endregion
//#region src/ui/rail.ts
const glyphFor = (status, s) => {
	switch (status) {
		case "done": return {
			glyph: s.stepDone,
			token: "accent"
		};
		case "active": return {
			glyph: s.stepActive,
			token: "accent"
		};
		case "warn": return {
			glyph: s.warn,
			token: "warn"
		};
		case "failed": return {
			glyph: s.fail,
			token: "danger"
		};
		case "skipped": return {
			glyph: s.neutral,
			token: "muted"
		};
	}
};
const renderRailStep = (step, deps = {}) => {
	const t = deps.theme ?? theme;
	const s = deps.symbols ?? symbols;
	const rail = style$1(t, "accentDim", s.rail);
	const { glyph, token } = glyphFor(step.status, s);
	const lines = [` ${style$1(t, token, glyph)} ${step.label}`];
	for (const note of step.notes ?? []) lines.push(` ${rail} ${style$1(t, "accent", s.hint)} ${highlightAislop(note, t)}`);
	return `${lines.join("\n")}\n`;
};
/**
* Render a single vertical rail connector line — used between steps and
* between the last step and the footer.
*/
const renderRailConnector = (deps = {}) => {
	return ` ${style$1(deps.theme ?? theme, "accentDim", (deps.symbols ?? symbols).rail)}\n`;
};
/**
* Render the rail-end footer line ("└  <footer text>").
*/
const renderRailFooter = (footer, deps = {}) => {
	const t = deps.theme ?? theme;
	return ` ${style$1(t, "accentDim", (deps.symbols ?? symbols).railEnd)}  ${highlightAislop(footer, t)}\n`;
};
const renderRail = (input, deps = {}) => {
	const t = deps.theme ?? theme;
	const s = deps.symbols ?? symbols;
	const rail = style$1(t, "accentDim", s.rail);
	const railEnd = style$1(t, "accentDim", s.railEnd);
	const lines = [];
	input.steps.forEach((step, i) => {
		const { glyph, token } = glyphFor(step.status, s);
		lines.push(` ${style$1(t, token, glyph)} ${step.label}`);
		for (const note of step.notes ?? []) lines.push(` ${rail} ${style$1(t, "accent", s.hint)} ${highlightAislop(note, t)}`);
		if (i < input.steps.length - 1) lines.push(` ${rail}`);
	});
	if (input.footer !== void 0) {
		if (input.steps.length > 0) lines.push(` ${rail}`);
		lines.push(` ${railEnd}  ${highlightAislop(input.footer, t)}`);
	}
	return `\n${lines.join("\n")}\n`;
};
//#endregion
//#region src/ui/live-rail.ts
const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏"
];
var LiveRail = class {
	frame = 0;
	activeLabel = null;
	timer;
	write;
	tty;
	theme;
	symbols;
	hasEmittedStep = false;
	constructor(deps = {}) {
		this.write = deps.write ?? ((s) => process.stdout.write(s));
		this.tty = deps.tty ?? Boolean(process.stdout.isTTY);
		this.theme = deps.theme ?? theme;
		this.symbols = deps.symbols ?? symbols;
	}
	/** Begin a new step. Emits the active-line and starts animating if TTY. */
	start(label) {
		this.activeLabel = label;
		if (this.tty) {
			this.drawActive();
			this.timer = setInterval(() => {
				this.frame += 1;
				this.drawActive(true);
			}, 80);
			this.timer.unref();
		}
	}
	/** Resolve the active step with its final state. */
	complete(step) {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
		if (this.tty && this.activeLabel !== null) this.write("\x1B[1F\x1B[2K");
		if (!this.hasEmittedStep) this.write("\n");
		else this.write(renderRailConnector({
			theme: this.theme,
			symbols: this.symbols
		}));
		this.write(renderRailStep(step, {
			theme: this.theme,
			symbols: this.symbols
		}));
		this.activeLabel = null;
		this.hasEmittedStep = true;
	}
	/** Emit the footer. Call after the last complete(). */
	finish(opts) {
		if (!this.hasEmittedStep) this.write("\n");
		this.write(renderRailConnector({
			theme: this.theme,
			symbols: this.symbols
		}));
		this.write(renderRailFooter(opts.footer, {
			theme: this.theme,
			symbols: this.symbols
		}));
	}
	/**
	* Update the label of the currently active step in place. Use this to
	* announce long sub-operations (e.g. "Dependency audit fixes · running
	* pnpm install — can take a minute") so the user knows what aislop is
	* doing. No-op if there is no active step.
	*/
	setActiveLabel(label) {
		if (this.activeLabel === null) return;
		this.activeLabel = label;
		if (this.tty) this.drawActive(true);
	}
	/** Abort the active step without emitting a final row. Rare — use if a fatal error happens mid-step. */
	abort() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
		if (this.tty && this.activeLabel !== null) this.write("\x1B[1F\x1B[2K");
		this.activeLabel = null;
	}
	drawActive(redraw = false) {
		if (!this.tty || this.activeLabel === null) return;
		if (redraw) this.write("\x1B[1F\x1B[2K");
		const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
		this.write(` ${style$1(this.theme, "info", glyph)} ${this.activeLabel}…\n`);
	}
};
//#endregion
//#region src/commands/agent-monitor-background.ts
const cliPath = () => {
	const arg = process.argv[1];
	if (arg && fs.existsSync(arg)) return arg;
	return path.resolve("dist/cli.js");
};
const addFlag = (args, flag, enabled) => {
	if (enabled) args.push(flag);
};
const addOption = (args, flag, value) => {
	if (value === void 0 || value === "") return;
	args.push(flag, String(value));
};
const buildBackgroundMonitorArgs = (directory, options) => {
	const args = [
		"agent",
		"monitor",
		directory
	];
	addOption(args, "--provider", options.provider);
	addOption(args, "--target-score", options.targetScore);
	addOption(args, "--max-turns", options.maxTurns);
	addOption(args, "--limit", options.limit);
	addFlag(args, "--in-place", options.inPlace);
	addFlag(args, "--no-fix", options.noFix);
	addFlag(args, "--repair", options.repair);
	addOption(args, "--interval", options.interval);
	addOption(args, "--debounce", options.debounce);
	return args;
};
const launchMonitorInBackground = async (directory, options) => {
	const { root } = await prepareAgentLocalState(directory);
	const monitorId = buildAgentMonitorId();
	const logDir = path.join(root, ".aislop", "agent", "logs");
	fs.mkdirSync(logDir, { recursive: true });
	const logPath = path.join(logDir, `${monitorId}.log`);
	const logFd = fs.openSync(logPath, "a");
	writeAgentMonitorRecord(root, {
		id: monitorId,
		root,
		requestedDirectory: path.resolve(directory),
		startedAt: (/* @__PURE__ */ new Date()).toISOString(),
		provider: options.provider,
		providerSource: options.providerSource,
		providerPreference: options.providerPreference,
		repair: options.repair,
		inPlace: options.inPlace,
		interval: options.interval,
		debounce: options.debounce,
		targetScore: options.targetScore,
		maxTurns: options.maxTurns,
		limit: options.limit,
		noFix: options.noFix,
		logPath,
		recentCycles: []
	});
	const child = spawn(process.execPath, [cliPath(), ...buildBackgroundMonitorArgs(directory, options)], {
		cwd: root,
		detached: true,
		env: {
			...process.env,
			AISLOP_AGENT_MONITOR_BACKGROUND: "1",
			AISLOP_AGENT_MONITOR_ID: monitorId,
			AISLOP_NO_TELEMETRY: "1",
			AISLOP_NO_UPDATE_NOTIFIER: "1",
			NO_COLOR: "1"
		},
		stdio: [
			"ignore",
			logFd,
			logFd
		]
	});
	child.unref();
	fs.closeSync(logFd);
	updateAgentMonitorRecord(root, monitorId, (current) => ({
		...current,
		pid: child.pid
	}));
	return {
		monitorId,
		recordPath: agentMonitorPath(root, monitorId),
		logPath,
		pid: child.pid
	};
};
const renderMonitorBackgroundLaunch = (launch) => {
	process.stdout.write(`${[
		renderDisplaySection("Background monitor"),
		...renderDisplayRows([
			{
				label: "Monitor",
				value: launch.monitorId
			},
			...launch.pid ? [{
				label: "PID",
				value: String(launch.pid)
			}] : [],
			{
				label: "Record",
				value: launch.recordPath
			},
			{
				label: "Log",
				value: launch.logPath
			}
		]),
		"",
		renderDisplaySection("Next"),
		...renderDisplayCommandRows([{
			label: "Inspect",
			command: `aislop agent monitor show ${launch.monitorId}`
		}, {
			label: "List",
			command: "aislop agent monitor list"
		}]),
		""
	].join("\n")}`);
};
//#endregion
//#region src/commands/agent-monitor.ts
const sleep$1 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parseGitStatusPaths = (stdout) => stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => {
	return (line.match(/^[ MADRCU?!]{1,2}\s+(.+)$/)?.[1] ?? line.slice(3)).replace(/^.* -> /, "").trim();
}).filter(Boolean);
const readGitChangeSnapshot = async (root) => {
	const result = await runSubprocess("git", [
		"status",
		"--porcelain=v1",
		"--untracked-files=normal"
	], { cwd: root });
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Failed to read git status.");
	return {
		signature: result.stdout,
		files: parseGitStatusPaths(result.stdout)
	};
};
const providerSourceText = (options) => {
	if (options.providerSource === "cli") return "--provider flag";
	if (options.providerSource === "preference") return `saved local default (${options.providerPreference ?? options.provider})`;
	return "auto-detect installed provider";
};
const providerLabel = (provider) => provider ? `${provider.provider.label}${provider.version ? ` (${provider.version})` : ""}` : "none selected";
const shouldMonitorRepair = (input) => input.repair && input.inPlace && input.findings > 0 && (input.score === null || input.score < input.targetScore);
const updateMonitorDebounceState = (input) => {
	if (input.next.signature === input.current.signature) return {
		current: input.current,
		pending: null,
		changedAt: 0,
		detected: false,
		settled: null
	};
	if (input.pending?.signature !== input.next.signature) {
		if (input.debounce <= 0) return {
			current: input.next,
			pending: null,
			changedAt: 0,
			detected: true,
			settled: input.next
		};
		return {
			current: input.current,
			pending: input.next,
			changedAt: input.now,
			detected: true,
			settled: null
		};
	}
	if (input.now - input.changedAt >= input.debounce) return {
		current: input.pending,
		pending: null,
		changedAt: 0,
		detected: false,
		settled: input.pending
	};
	return {
		current: input.current,
		pending: input.pending,
		changedAt: input.changedAt,
		detected: false,
		settled: null
	};
};
const changedFilesText = (files) => {
	if (files.length === 0) return "no git changes";
	const preview = files.slice(0, 4).join(", ");
	return files.length > 4 ? `${preview}, +${files.length - 4} more` : preview;
};
const recordMonitorCycle = (input) => {
	const monitorId = process.env.AISLOP_AGENT_MONITOR_ID;
	if (!monitorId) return;
	appendAgentMonitorCycle(input.root, monitorId, {
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		reason: input.reason,
		score: input.scan.score,
		diagnostics: input.scan.diagnostics.length,
		findings: input.findings,
		changedFiles: input.changedFiles.slice(0, 12),
		repaired: input.repaired,
		targetMet: input.scan.score !== null && input.scan.score >= input.targetScore
	});
};
const renderMonitorIntro = (input) => {
	process.stdout.write(renderHeader({
		version: APP_VERSION,
		command: "Agent monitor",
		context: [input.options.repair ? "repair" : "watch"]
	}));
	process.stdout.write(`${[
		renderDisplaySection("Settings"),
		...renderDisplayRows([
			{
				label: "Root",
				value: input.root
			},
			{
				label: "Provider",
				value: providerLabel(input.provider)
			},
			{
				label: "Source",
				value: providerSourceText(input.options)
			},
			{
				label: "Mode",
				value: input.options.repair ? "repair on failing scans" : "scan and report"
			},
			{
				label: "Edit target",
				value: input.options.inPlace ? "current worktree" : "none"
			},
			{
				label: "Interval",
				value: `${input.options.interval}ms`
			},
			{
				label: "Debounce",
				value: `${input.options.debounce}ms`
			}
		], {
			indent: 3,
			labelWidth: 11
		}),
		""
	].join("\n")}`);
	if (!input.options.repair) log.muted("Repair is off. Add `--repair --in-place` to run bounded local repairs.");
	else if (!input.options.inPlace) log.warn("Repair mode needs `--in-place` before it can edit the watched checkout.");
};
const resolveMonitorProvider = (root, options) => {
	const providerChoice = resolveAgentProviderSelection({
		root,
		requested: options.provider,
		explicit: options.providerSource === "cli"
	});
	const resolvedOptions = {
		...options,
		provider: providerChoice.selection,
		providerSource: providerChoice.source,
		providerPreference: providerChoice.preference?.provider
	};
	return {
		options: resolvedOptions,
		provider: resolveProvider(resolvedOptions.provider, getProviderStatuses())
	};
};
const assertCanRepair = (provider, options) => {
	if (!options.repair) return;
	if (!options.inPlace) throw new Error("Monitor repair edits the watched checkout. Re-run with `--repair --in-place`.");
	if (!provider || !provider.installed) throw new Error("Monitor repair needs an installed provider. Run `aislop agent providers`.");
	if (provider.authenticated === false) throw new Error(`${provider.provider.label} is installed but not authenticated.`);
};
const runMonitorCycle = async (input) => {
	const rail = new LiveRail();
	rail.start(`Scanning ${input.reason}`);
	const scan = scanJson(input.directory);
	const findings = selectAgentFindings(scan.diagnostics, input.options.limit);
	rail.complete({
		status: scan.summary.errors > 0 ? "warn" : "done",
		label: `Score ${scan.score ?? "not scored"} / 100 · ${scan.diagnostics.length} findings · ${changedFilesText(input.snapshot.files)}`
	});
	if (!shouldMonitorRepair({
		repair: input.options.repair,
		inPlace: input.options.inPlace,
		score: scan.score,
		targetScore: input.options.targetScore,
		findings: findings.length
	})) {
		rail.finish({ footer: findings.length === 0 || (scan.score ?? 0) >= input.options.targetScore ? "Monitor idle · target met" : "Monitor idle · repair disabled" });
		recordMonitorCycle({
			root: input.root,
			reason: input.reason,
			scan,
			findings: findings.length,
			changedFiles: input.snapshot.files,
			repaired: false,
			targetScore: input.options.targetScore
		});
		return {
			scan,
			findings: findings.length,
			changedFiles: input.snapshot.files,
			repaired: false
		};
	}
	rail.finish({ footer: "Monitor triggering repair session" });
	await runAgentSession(input.provider, input.directory, input.options, performance.now());
	recordMonitorCycle({
		root: input.root,
		reason: input.reason,
		scan,
		findings: findings.length,
		changedFiles: input.snapshot.files,
		repaired: true,
		targetScore: input.options.targetScore
	});
	return {
		scan,
		findings: findings.length,
		changedFiles: input.snapshot.files,
		repaired: true
	};
};
const monitorOnce = async (input) => {
	const snapshot = await readGitChangeSnapshot(input.root);
	return await runMonitorCycle({
		...input,
		snapshot,
		reason: snapshot.files.length > 0 ? "current changes" : "current checkout"
	});
};
const monitorLoop = async (input) => {
	let current = await readGitChangeSnapshot(input.root);
	await runMonitorCycle({
		...input,
		snapshot: current,
		reason: current.files.length > 0 ? "current changes" : "current checkout"
	});
	let pending = null;
	let changedAt = 0;
	for (;;) {
		const next = await readGitChangeSnapshot(input.root);
		const update = updateMonitorDebounceState({
			current,
			pending,
			changedAt,
			next,
			now: Date.now(),
			debounce: input.options.debounce
		});
		current = update.current;
		pending = update.pending;
		changedAt = update.changedAt;
		if (update.detected) log.info(`Change detected: ${changedFilesText(next.files)}`);
		if (update.settled) await runMonitorCycle({
			...input,
			snapshot: update.settled,
			reason: "settled changes"
		});
		await sleep$1(Math.max(500, input.options.interval));
	}
};
const agentMonitorCommand = async (directory, options) => {
	try {
		const requestedDirectory = path.resolve(directory);
		const { root } = await prepareAgentLocalState(requestedDirectory);
		const resolved = resolveMonitorProvider(root, options);
		renderMonitorIntro({
			root,
			provider: resolved.provider,
			options: resolved.options
		});
		if (resolved.options.dryRun) return;
		assertCanRepair(resolved.provider, resolved.options);
		if (resolved.options.background) return renderMonitorBackgroundLaunch(await launchMonitorInBackground(requestedDirectory, resolved.options));
		if (resolved.options.once) {
			await monitorOnce({
				root,
				directory: requestedDirectory,
				provider: resolved.provider,
				options: resolved.options
			});
			return;
		}
		await monitorLoop({
			root,
			directory: requestedDirectory,
			provider: resolved.provider,
			options: resolved.options
		});
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
//#endregion
//#region src/cli/agent-monitor-command.ts
const registerMonitorRunCommand = (monitor) => {
	monitor.action(async (directory = ".", _flags, command) => {
		const flags = command.optsWithGlobals();
		const options = {
			...agentOptionsFromFlags(flags, command),
			interval: flags.interval ?? 5e3,
			debounce: flags.debounce ?? 1500,
			once: Boolean(flags.once),
			repair: Boolean(flags.repair)
		};
		await withAgentLifecycle("agent_monitor", directory, monitorTelemetryProperties(options), async () => {
			await agentMonitorCommand(directory, options);
		});
	});
};
const registerMonitorListCommand = (monitor) => {
	monitor.command("list [directory]").description("List local background agent monitors").option("--limit <n>", "maximum monitors to show", parseInteger, 10).action(async (directory = ".", _flags, command) => {
		const flags = command.optsWithGlobals();
		await withAgentLifecycle("agent_monitor_list", directory, { result_limit: flags.limit ?? 10 }, async () => {
			await agentMonitorListCommand(directory, { limit: flags.limit ?? 10 });
		});
	});
};
const registerMonitorShowCommand = (monitor) => {
	monitor.command("show [monitor]").description("Show a background agent monitor record").option("--root <directory>", "git repository to read monitors from", ".").action(async (monitorId, _flags, command) => {
		const root = command.optsWithGlobals().root ?? ".";
		await withAgentLifecycle("agent_monitor_show", root, {
			monitor_supplied: monitorId !== void 0,
			custom_root: root !== "."
		}, async () => {
			await agentMonitorShowCommand(monitorId, { root });
		});
	});
};
const registerMonitorStopCommand = (monitor) => {
	monitor.command("stop [monitor]").description("Stop a running background agent monitor").option("--root <directory>", "git repository to read monitors from", ".").option("--force", "send SIGKILL instead of SIGTERM").action(async (monitorId, _flags, command) => {
		const flags = command.optsWithGlobals();
		const root = flags.root ?? ".";
		await withAgentLifecycle("agent_monitor_stop", root, {
			monitor_supplied: monitorId !== void 0,
			custom_root: root !== ".",
			force: Boolean(flags.force)
		}, async () => {
			await agentMonitorStopCommand(monitorId, {
				root,
				force: Boolean(flags.force)
			});
		});
	});
};
const registerAgentMonitorSubcommands = (agent) => {
	const monitor = agent.command("monitor [directory]").description("Watch local git changes and stream scan or repair cycles");
	addMonitorOptions(monitor);
	registerMonitorRunCommand(monitor);
	registerMonitorListCommand(monitor);
	registerMonitorShowCommand(monitor);
	registerMonitorStopCommand(monitor);
};
//#endregion
//#region src/agents/session-store.ts
const agentSessionDir = (root) => path.join(root, ".aislop", "agent", "sessions");
const isObject = (value) => typeof value === "object" && value !== null;
const asString$1 = (value) => typeof value === "string" ? value : null;
const asNumber$1 = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const latestTimestamp = (events) => events.at(-1)?.timestamp ?? null;
const readAgentSessionEvents = (sessionPath) => {
	const raw = fs.readFileSync(sessionPath, "utf-8").trim();
	if (!raw) return [];
	const events = [];
	for (const line of raw.split("\n")) try {
		events.push(JSON.parse(line));
	} catch {
		break;
	}
	return events;
};
const isTerminalAgentSession = (events) => events.some((event) => event.type === "session.completed" || event.type === "session.failed" || event.type === "background.stopped");
const summarizeAgentSession = (sessionPath, events) => {
	const id = path.basename(sessionPath, ".jsonl");
	const started = events.find((event) => event.type === "session.started");
	const queued = events.find((event) => event.type === "session.queued");
	const kickoff = started ?? queued;
	const completed = events.find((event) => event.type === "session.completed");
	const failed = events.find((event) => event.type === "session.failed");
	const stopped = events.find((event) => event.type === "background.stopped");
	const backgroundStarted = [...events].reverse().find((event) => event.type === "background.started");
	const worktree = events.find((event) => event.type === "worktree.prepared");
	const baseline = events.find((event) => event.type === "scan.baseline");
	const applied = events.find((event) => event.type === "diff.applied");
	const verified = [...events].reverse().find((event) => event.type === "diff.verified");
	const verifiedScan = isObject(verified?.scan) ? verified.scan : null;
	const usage = [...events].reverse().find((event) => event.type === "provider.usage");
	const usagePayload = isObject(usage?.usage) ? usage.usage : null;
	const providerFinished = events.filter((event) => event.type === "provider.finished");
	const inferredPasses = Math.max(0, ...providerFinished.map((event) => asNumber$1(event.pass) ?? 0));
	const summedToolCalls = providerFinished.reduce((sum, event) => sum + (asNumber$1(event.toolCalls) ?? 0), 0);
	const summedOutputEvents = providerFinished.reduce((sum, event) => sum + (asNumber$1(event.outputEvents) ?? 0), 0);
	const status = failed ? "failed" : stopped ? "stopped" : completed ? "completed" : events.length > 0 ? "running" : "unknown";
	return {
		id,
		path: sessionPath,
		startedAt: kickoff?.timestamp ?? events[0]?.timestamp ?? null,
		endedAt: completed?.timestamp ?? failed?.timestamp ?? stopped?.timestamp ?? latestTimestamp(events),
		status,
		provider: asString$1(started?.provider) ?? asString$1(queued?.providerSelection),
		providerLabel: asString$1(started?.providerLabel),
		mode: asString$1(kickoff?.mode),
		worktreePath: asString$1(worktree?.path),
		backgroundPid: asNumber$1(backgroundStarted?.pid),
		logPath: asString$1(backgroundStarted?.logPath) ?? asString$1(queued?.logPath),
		scoreBefore: asNumber$1(completed?.scoreBefore) ?? asNumber$1(baseline?.score),
		scoreAfter: asNumber$1(completed?.scoreAfter) ?? asNumber$1(verifiedScan?.score),
		changedFiles: asNumber$1(completed?.changedFiles),
		totalTokens: asNumber$1(completed?.totalTokens) ?? asNumber$1(usagePayload?.totalTokens),
		costUsd: asNumber$1(completed?.costUsd) ?? asNumber$1(usagePayload?.costUsd),
		providerPasses: asNumber$1(completed?.providerPasses) ?? (inferredPasses > 0 ? inferredPasses : null),
		toolCalls: asNumber$1(completed?.toolCalls) ?? (summedToolCalls > 0 ? summedToolCalls : null),
		outputEvents: asNumber$1(completed?.outputEvents) ?? (summedOutputEvents > 0 ? summedOutputEvents : null),
		applied: completed?.applied === true || Boolean(applied),
		published: completed?.published === true
	};
};
const listAgentSessionFiles = (root) => {
	const dir = agentSessionDir(root);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl")).map((file) => path.join(dir, file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
};
const listAgentSessions = (root, options = {}) => listAgentSessionFiles(root).slice(0, options.limit ?? 10).map((sessionPath) => summarizeAgentSession(sessionPath, readAgentSessionEvents(sessionPath)));
const resolveAgentSessionPath = (root, session) => {
	const files = listAgentSessionFiles(root);
	if (!session) return files[0] ?? null;
	if (fs.existsSync(session)) return session;
	const direct = path.join(agentSessionDir(root), `${session}.jsonl`);
	if (fs.existsSync(direct)) return direct;
	const matches = files.filter((file) => path.basename(file, ".jsonl").startsWith(session));
	return matches.length === 1 ? matches[0] : null;
};
//#endregion
//#region src/commands/agent-apply.ts
const asString = (value) => typeof value === "string" && value.length > 0 ? value : null;
const isInside = (base, target) => {
	const relative = path.relative(base, target);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
};
const displayPath = (base, target) => isInside(base, target) ? toPosix(path.relative(base, target)) || "." : target;
const appendApplyEvent = (sessionPath, sessionId, payload) => {
	fs.appendFileSync(sessionPath, `${JSON.stringify({
		type: "diff.applied",
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		sessionId,
		source: "agent apply",
		...payload
	})}\n`, "utf-8");
};
const resolveAgentApplyTarget = (input) => {
	const sessionId = path.basename(input.sessionPath, ".jsonl");
	const kickoff = input.events.find((event) => event.type === "session.started" || event.type === "session.queued");
	const targetRoot = asString(kickoff?.root) ?? input.root;
	const worktree = [...input.events].reverse().find((event) => event.type === "worktree.prepared");
	const worktreePath = asString(worktree?.path);
	if (!worktreePath) throw new Error("This session does not have an isolated worktree to apply.");
	const alreadyApplied = input.events.some((event) => event.type === "diff.applied");
	const worktreeRemoved = input.events.some((event) => event.type === "worktree.removed" && asString(event.path) === worktreePath);
	if (worktreePath === targetRoot) throw new Error("This session already ran in the current worktree; there is no later diff to apply.");
	return {
		sessionId,
		sessionPath: input.sessionPath,
		targetRoot,
		worktreePath,
		worktreeRemoved,
		alreadyApplied
	};
};
const renderAgentApplyPreview = (preview) => {
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: "Agent apply",
			context: [preview.target.sessionId]
		}).trimEnd(),
		"",
		renderDisplaySection("Patch"),
		...renderDisplayRows([
			{
				label: "Session",
				value: displayPath(preview.target.targetRoot, preview.target.sessionPath)
			},
			{
				label: "Target",
				value: preview.target.targetRoot
			},
			{
				label: "Worktree",
				value: preview.target.worktreePath
			},
			{
				label: "Bytes",
				value: String(preview.patchBytes)
			},
			{
				label: "Changed",
				value: String(preview.changedFiles.length)
			}
		], { indent: 3 })
	];
	if (preview.changedFiles.length > 0) {
		lines.push("", renderDisplaySection("Files"));
		for (const file of preview.changedFiles.slice(0, 12)) lines.push(` - ${file}`);
		if (preview.changedFiles.length > 12) lines.push(` - ...and ${preview.changedFiles.length - 12} more`);
	}
	lines.push("", renderDisplaySection("Next"), ...renderDisplayRows([{
		label: "Apply",
		value: preview.dryRun ? "rerun without --dry-run" : "patch target worktree index"
	}]));
	return `${lines.join("\n")}\n`;
};
const agentApplyCommand = async (session, options) => {
	try {
		const root = await resolveAgentGitRoot(options.root);
		const sessionPath = resolveAgentSessionPath(root, session);
		if (!sessionPath) throw new Error(session ? `No matching agent session: ${session}` : "No agent sessions found.");
		const events = readAgentSessionEvents(sessionPath);
		const target = resolveAgentApplyTarget({
			root,
			sessionPath,
			events
		});
		if (target.alreadyApplied) throw new Error("This session diff has already been applied.");
		if (target.worktreeRemoved) throw new Error("This session worktree was removed; there is no diff to apply.");
		if (!fs.existsSync(target.worktreePath)) throw new Error(`Session worktree no longer exists: ${target.worktreePath}`);
		const [changedFiles, patch] = await Promise.all([diffNameOnly(target.worktreePath), readBinaryDiff(target.worktreePath)]);
		if (changedFiles.length === 0 || patch.trim().length === 0) throw new Error("This session worktree has no diff to apply.");
		const preview = {
			target,
			changedFiles,
			patchBytes: Buffer.byteLength(patch),
			dryRun: options.dryRun
		};
		process.stdout.write(renderAgentApplyPreview(preview));
		if (options.dryRun) return;
		const shouldApply = options.yes || await confirm({
			message: `Apply ${changedFiles.length} file change${changedFiles.length === 1 ? "" : "s"} from ${target.sessionId} to ${path.basename(target.targetRoot)}?`,
			initialValue: false
		});
		if (isCancel(shouldApply)) {
			log.warn("Apply cancelled. Worktree left for review.");
			return;
		}
		if (!shouldApply) {
			log.warn("Apply skipped. Worktree left for review.");
			return;
		}
		await applyDiff(target.targetRoot, patch);
		appendApplyEvent(sessionPath, target.sessionId, {
			applyRequested: true,
			changedFiles: changedFiles.length,
			files: changedFiles,
			targetRoot: target.targetRoot,
			worktreePath: target.worktreePath
		});
		log.success(`Applied ${changedFiles.length} file change${changedFiles.length === 1 ? "" : "s"} from ${target.sessionId}.`);
		log.muted(`Inspect with \`aislop agent show ${target.sessionId}\`.`);
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
//#endregion
//#region src/commands/agent-session-review.ts
const asObject = (value) => typeof value === "object" && value !== null ? value : null;
const asNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const selectedCount = (events) => {
	const event = events.find((item) => item.type === "findings.selected");
	return asNumber(event?.count);
};
const verifiedDiagnostics = (events) => {
	const event = events.find((item) => item.type === "diff.verified");
	const scan = asObject(event?.scan);
	return asNumber(scan?.diagnostics);
};
const providerOutcome = (events) => {
	const skipped = events.find((item) => item.type === "provider.skipped");
	if (skipped) return `skipped (${skipped.reason ?? "not needed"})`;
	const finished = [...events].reverse().find((item) => item.type === "provider.finished");
	if (finished) {
		const pass = asNumber(finished.pass);
		const tools = asNumber(finished.toolCalls);
		const exitCode = asNumber(finished.exitCode);
		const exitText = exitCode === 0 || exitCode === null ? "finished" : `finished with exit ${exitCode}`;
		return [
			pass === null ? "provider" : `pass ${pass}`,
			exitText,
			tools === null ? null : formatToolCalls(tools)
		].filter(Boolean).join(" · ");
	}
	return events.find((item) => item.type === "provider.started") ? "running" : "not started";
};
const applyOutcome = (events, summary) => {
	if (summary.applied) return "applied";
	return events.find((item) => item.type === "diff.apply_skipped") ? "not applied" : "not requested";
};
const publishOutcome = (events, summary) => {
	if (summary.published) return "published";
	const skipped = events.find((item) => item.type === "publish.skipped");
	if (skipped) return `skipped (${skipped.reason ?? "not needed"})`;
	return events.some((item) => item.type === "publish.started") ? "started" : "not requested";
};
const usageOutcome = (summary) => {
	if (summary.totalTokens === null && summary.costUsd === null) return "n/a";
	const parts = [];
	if (summary.totalTokens !== null) parts.push(`${summary.totalTokens.toLocaleString()} tokens`);
	if (summary.costUsd !== null) parts.push(`$${summary.costUsd.toFixed(4)}`);
	return parts.join(" / ");
};
const providerNotes = (events) => events.filter((event) => event.type === "provider.output" && typeof event.line === "string").map((event) => typeof event.displayLine === "string" ? event.displayLine : formatProviderOutputLine(String(event.line)) ?? "").filter((line) => /false positive|intentional|skip|skipped|ignore/i.test(line)).slice(-4);
const renderAgentSessionReview = (input) => {
	const selected = selectedCount(input.events);
	const remaining = verifiedDiagnostics(input.events);
	const lines = [renderDisplaySection("Review summary"), ...renderDisplayRows([
		{
			label: "Score",
			value: `${input.summary.scoreBefore ?? "n/a"} -> ${input.summary.scoreAfter ?? "n/a"}`
		},
		{
			label: "Selected",
			value: String(selected ?? "n/a")
		},
		{
			label: "Remaining",
			value: String(remaining ?? "n/a")
		},
		{
			label: "Changed",
			value: String(input.summary.changedFiles ?? 0)
		},
		{
			label: "Usage",
			value: usageOutcome(input.summary)
		},
		{
			label: "Passes",
			value: String(input.summary.providerPasses ?? "n/a")
		},
		{
			label: "Tools",
			value: input.summary.toolCalls === null ? "n/a" : formatToolCalls(input.summary.toolCalls)
		},
		{
			label: "Provider",
			value: providerOutcome(input.events)
		},
		{
			label: "Apply",
			value: applyOutcome(input.events, input.summary)
		},
		{
			label: "Publish",
			value: publishOutcome(input.events, input.summary)
		}
	], {
		indent: 3,
		labelWidth: 9
	})];
	const notes = providerNotes(input.events);
	if (notes.length > 0) {
		lines.push("", renderDisplaySection("Provider notes"));
		for (const note of notes) lines.push(` - ${note.length > 180 ? `${note.slice(0, 177)}...` : note}`);
	}
	return lines;
};
//#endregion
//#region src/commands/agent-sessions.ts
const statusMarker = (status) => {
	if (status === "completed") return style$1(theme, "success", "✓");
	if (status === "failed") return style$1(theme, "danger", "x");
	if (status === "stopped") return style$1(theme, "warn", "!");
	if (status === "running") return style$1(theme, "info", "*");
	return style$1(theme, "muted", ".");
};
const scoreText = (summary) => {
	if (summary.scoreBefore === null && summary.scoreAfter === null) return "score n/a";
	return `${summary.scoreBefore ?? "n/a"} -> ${summary.scoreAfter ?? "n/a"}`;
};
const changedText = (summary) => {
	const count = summary.changedFiles ?? 0;
	return `${count} file${count === 1 ? "" : "s"}`;
};
const usageText = (summary) => {
	if (summary.totalTokens === null && summary.costUsd === null) return "tokens n/a";
	const parts = [];
	if (summary.totalTokens !== null) parts.push(`${summary.totalTokens.toLocaleString()} tokens`);
	if (summary.costUsd !== null) parts.push(`$${summary.costUsd.toFixed(4)}`);
	return parts.join(" / ");
};
const providerText = (summary) => summary.providerLabel ?? summary.provider ?? "unknown provider";
const passText = (summary) => summary.providerPasses === null ? "passes n/a" : String(summary.providerPasses);
const toolText = (summary) => summary.toolCalls === null ? "tools n/a" : formatToolCalls(summary.toolCalls);
const sessionStatusItem = (root, session) => ({
	marker: statusMarker(session.status),
	label: session.id,
	rows: [
		{
			label: "Status",
			value: session.status
		},
		{
			label: "Provider",
			value: providerText(session)
		},
		{
			label: "Score",
			value: scoreText(session)
		},
		{
			label: "Changed",
			value: changedText(session)
		},
		{
			label: "Usage",
			value: usageText(session)
		},
		{
			label: "Passes",
			value: passText(session)
		},
		{
			label: "Tools",
			value: toolText(session)
		},
		{
			label: "Started",
			value: session.startedAt ?? "unknown time"
		},
		{
			label: "Record",
			value: path.relative(root, session.path)
		}
	]
});
const renderAgentSessionList = (input) => {
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: "Agent sessions",
			context: [path.basename(input.root)]
		}).trimEnd(),
		"",
		renderDisplaySection("Sessions")
	];
	if (input.sessions.length === 0) {
		lines.push(" No local agent sessions yet.");
		lines.push("", renderDisplaySection("Next"), ...renderDisplayCommandRows([{
			label: "Create",
			command: "aislop agent"
		}]));
		return `${lines.join("\n")}\n`;
	}
	lines.push(...renderDisplayStatusItems(input.sessions.map((session) => sessionStatusItem(input.root, session)), { labelWidth: 8 }));
	lines.push("", renderDisplaySection("Next"), ...renderDisplayCommandRows([{
		label: "Details",
		command: "aislop agent show <session>"
	}], { indent: 3 }));
	return `${lines.join("\n")}\n`;
};
const eventLine = (event) => {
	if (event.type === "session.queued") return `queued background run with ${event.providerSelection ?? "auto"} provider`;
	if (event.type === "background.started") return `background process started${event.pid ? ` pid ${event.pid}` : ""}`;
	if (event.type === "background.stopped") return `background process stopped${event.signal ? ` with ${event.signal}` : ""}`;
	if (event.type === "session.started") return `started ${event.providerLabel ?? event.provider ?? "provider"} in ${event.mode ?? "session"} mode`;
	if (event.type === "worktree.prepared") return `worktree ${event.created ? "created" : "selected"} ${event.path ?? ""}`.trim();
	if (event.type === "scan.baseline") return `baseline scan score ${event.score ?? "n/a"} with ${event.diagnostics ?? "n/a"} findings`;
	if (event.type === "fix.safe.finished") return "safe fixes finished";
	if (event.type === "fix.safe.skipped") return "safe fixes skipped";
	if (event.type === "findings.selected") return `pass ${event.pass ?? "?"} selected ${event.count ?? 0} findings`;
	if (event.type === "provider.started") return `pass ${event.pass ?? "?"} provider started with ${event.findings ?? 0} findings`;
	if (event.type === "provider.skipped") return `provider skipped${event.reason ? `: ${event.reason}` : ""}`;
	if (event.type === "provider.finished") {
		const exitCode = event.exitCode === 0 ? "finished" : `finished with exit ${event.exitCode ?? "unknown"}`;
		const tools = typeof event.toolCalls === "number" ? ` · ${formatToolCalls(event.toolCalls)}` : "";
		return `pass ${event.pass ?? "?"} provider ${exitCode}${tools}`;
	}
	if (event.type === "diff.verified") {
		const files = Array.isArray(event.changedFiles) ? event.changedFiles.length : 0;
		const score = typeof event.scoreBefore === "number" && typeof event.scan === "object" && event.scan !== null ? ` · ${event.scoreBefore} -> ${event.scan.score ?? "n/a"}` : "";
		return `pass ${event.pass ?? "?"} diff verified${score} · ${files} changed file${files === 1 ? "" : "s"}`;
	}
	if (event.type === "diff.applied") return "diff applied to original worktree";
	if (event.type === "diff.apply_skipped") return "diff apply skipped";
	if (event.type === "publish.started") return event.pr ? "publish started for PR" : "publish started";
	if (event.type === "publish.finished") return "publish finished";
	if (event.type === "publish.skipped") return `publish skipped${event.reason ? `: ${event.reason}` : ""}`;
	if (event.type === "session.completed") return "session completed";
	if (event.type === "session.failed") return `session failed: ${event.message ?? "unknown error"}`;
	if (event.type === "worktree.removed") return "worktree removed";
	return null;
};
const changedFilesFrom = (events) => {
	const event = [...events].reverse().find((item) => item.type === "diff.verified");
	return Array.isArray(event?.changedFiles) ? event.changedFiles.filter((file) => typeof file === "string") : [];
};
const editedFilesFrom = (events) => {
	const latestByFile = /* @__PURE__ */ new Map();
	for (const event of events) {
		if (event.type !== "file.changed" || typeof event.filePath !== "string") continue;
		latestByFile.set(event.filePath, event);
	}
	return [...latestByFile.values()].map((event) => {
		return `${event.filePath} · ${formatDiffStat({
			additions: typeof event.additions === "number" ? event.additions : null,
			deletions: typeof event.deletions === "number" ? event.deletions : null,
			binary: event.binary === true
		})}`;
	});
};
const selectedFindingsFrom = (events) => {
	const event = events.find((item) => item.type === "findings.selected");
	if (!Array.isArray(event?.findings)) return [];
	return event.findings.filter((finding) => typeof finding === "object" && finding !== null).map((finding) => `${finding.filePath ?? "unknown"}:${finding.line ?? 0} ${finding.rule ?? ""}`.trim());
};
const providerOutputFrom = (events) => events.filter((event) => event.type === "provider.output" && typeof event.line === "string").map((event) => typeof event.displayLine === "string" ? event.displayLine : formatProviderOutputLine(String(event.line)) ?? "").filter(Boolean);
const renderAgentSessionShow = (input) => {
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: "Agent session",
			context: [input.summary.id]
		}).trimEnd(),
		"",
		renderDisplaySection("Details"),
		...renderDisplayRows([
			{
				label: "Status",
				value: input.summary.status
			},
			{
				label: "Provider",
				value: providerText(input.summary)
			},
			{
				label: "Score",
				value: scoreText(input.summary)
			},
			{
				label: "Changed",
				value: changedText(input.summary)
			},
			{
				label: "Usage",
				value: usageText(input.summary)
			},
			{
				label: "Passes",
				value: passText(input.summary)
			},
			{
				label: "Tools",
				value: toolText(input.summary)
			},
			{
				label: "Started",
				value: input.summary.startedAt ?? "unknown"
			},
			{
				label: "Transcript",
				value: displayAgentPath(input.root, input.summary.path)
			},
			...input.summary.worktreePath ? [{
				label: "Worktree",
				value: displayAgentPath(input.root, input.summary.worktreePath)
			}] : [],
			...input.summary.backgroundPid ? [{
				label: "PID",
				value: String(input.summary.backgroundPid)
			}] : [],
			...input.summary.logPath ? [{
				label: "Log",
				value: input.summary.logPath
			}] : []
		], {
			indent: 3,
			labelWidth: 10
		})
	];
	lines.push("", ...renderAgentSessionReview({
		summary: input.summary,
		events: input.events
	}));
	lines.push("", renderDisplaySection("Timeline"));
	for (const event of input.events) {
		const line = eventLine(event);
		if (line) lines.push(` - ${event.timestamp}: ${line}`);
	}
	const findings = selectedFindingsFrom(input.events);
	if (findings.length > 0) {
		lines.push("", renderDisplaySection("Selected findings"));
		for (const finding of findings.slice(0, 8)) lines.push(` - ${finding}`);
		if (findings.length > 8) lines.push(` - ...and ${findings.length - 8} more`);
	}
	const changedFiles = changedFilesFrom(input.events);
	if (changedFiles.length > 0) {
		lines.push("", renderDisplaySection("Changed files"));
		for (const file of changedFiles.slice(0, 12)) lines.push(` - ${file}`);
		if (changedFiles.length > 12) lines.push(` - ...and ${changedFiles.length - 12} more`);
	}
	const editedFiles = editedFilesFrom(input.events);
	if (editedFiles.length > 0) {
		lines.push("", renderDisplaySection("File activity"));
		for (const file of editedFiles.slice(0, 12)) lines.push(` - ${file}`);
		if (editedFiles.length > 12) lines.push(` - ...and ${editedFiles.length - 12} more`);
	}
	const output = providerOutputFrom(input.events);
	if (output.length > 0) {
		lines.push("", renderDisplaySection("Provider output"));
		for (const line of output.slice(-8)) lines.push(`   ${line.length > 180 ? `${line.slice(0, 177)}...` : line}`);
	}
	return `${lines.join("\n")}\n`;
};
const agentSessionsCommand = async (directory, options) => {
	try {
		const root = await resolveAgentGitRoot(directory);
		process.stdout.write(renderAgentSessionList({
			root,
			sessions: listAgentSessions(root, options)
		}));
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
const agentShowCommand = async (session, options) => {
	try {
		const root = await resolveAgentGitRoot(options.root);
		const sessionPath = resolveAgentSessionPath(root, session);
		if (!sessionPath) throw new Error(session ? `No matching agent session: ${session}` : "No agent sessions found.");
		const events = readAgentSessionEvents(sessionPath);
		process.stdout.write(renderAgentSessionShow({
			root,
			events,
			summary: summarizeAgentSession(sessionPath, events)
		}));
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
//#endregion
//#region src/commands/agent-stop.ts
const backgroundPidFromEvents = (events) => {
	for (const event of [...events].reverse()) if (event.type === "background.started" && typeof event.pid === "number") return event.pid;
	return null;
};
const isProcessAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
};
const sendSignal = (pid, signal) => {
	if (process.platform !== "win32") try {
		process.kill(-pid, signal);
		return;
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
	process.kill(pid, signal);
};
const stopAgentSession = async (root, session, options) => {
	const sessionPath = resolveAgentSessionPath(root, session);
	if (!sessionPath) throw new Error(session ? `No matching agent session: ${session}` : "No agent sessions found.");
	const events = readAgentSessionEvents(sessionPath);
	const summary = summarizeAgentSession(sessionPath, events);
	if (summary.status !== "running") throw new Error(`Agent session ${summary.id} is ${summary.status}; nothing to stop.`);
	const pid = backgroundPidFromEvents(events);
	if (!pid) throw new Error(`Agent session ${summary.id} does not have a background process id.`);
	const signal = options.force ? "SIGKILL" : "SIGTERM";
	const recorder = createAgentSessionRecorder(root, { id: summary.id });
	recorder.append("background.stop_requested", {
		pid,
		signal
	});
	const alreadyExited = !isProcessAlive(pid);
	if (!alreadyExited) sendSignal(pid, signal);
	recorder.append("background.stopped", {
		pid,
		signal,
		alreadyExited
	});
	return {
		sessionId: summary.id,
		pid,
		signal,
		alreadyExited
	};
};
const renderAgentStopResult = (result) => {
	process.stdout.write(`${[
		renderDisplaySection("Stopped session"),
		...renderDisplayRows([
			{
				label: "Session",
				value: result.sessionId
			},
			{
				label: "PID",
				value: String(result.pid)
			},
			{
				label: "Signal",
				value: result.signal
			}
		]),
		""
	].join("\n")}`);
	if (result.alreadyExited) {
		log.warn("Process was already gone; marked the session stopped.");
		return;
	}
	log.success("Stop signal sent.");
	process.stdout.write(`${[
		renderDisplaySection("Next"),
		...renderDisplayCommandRows([{
			label: "Inspect",
			command: `aislop agent show ${result.sessionId}`
		}]),
		""
	].join("\n")}`);
};
const agentStopCommand = async (session, options) => {
	try {
		const root = await resolveAgentGitRoot(options.root);
		renderAgentStopResult(await stopAgentSession(root, session, { force: options.force }));
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
//#endregion
//#region src/commands/agent-watch.ts
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compactLine = (line) => line.length > 180 ? `${line.slice(0, 177)}...` : line;
const renderAgentWatchEvent = (event) => {
	if (event.type === "provider.output" && typeof event.line === "string") {
		const line = typeof event.displayLine === "string" ? event.displayLine : formatProviderOutputLine(event.line);
		if (!line) return null;
		return `${style$1(theme, "muted", String(event.provider ?? "provider").padEnd(8))} ${style$1(theme, "dim", compactLine(line))}`;
	}
	if (event.type === "session.queued") return `queued background run with ${event.providerSelection ?? "auto"} provider`;
	if (event.type === "background.started") return `background process started${event.pid ? ` pid ${event.pid}` : ""}`;
	if (event.type === "background.stopped") return `background process stopped${event.signal ? ` with ${event.signal}` : ""}`;
	if (event.type === "session.started") return `started ${event.providerLabel ?? event.provider ?? "provider"} in ${event.mode ?? "session"} mode`;
	if (event.type === "worktree.prepared") return `worktree ${event.created ? "created" : "selected"} ${event.path ?? ""}`.trim();
	if (event.type === "scan.baseline") return `baseline score ${event.score ?? "n/a"} with ${event.diagnostics ?? "n/a"} findings`;
	if (event.type === "fix.safe.finished") return "safe fixes finished";
	if (event.type === "fix.safe.skipped") return "safe fixes skipped";
	if (event.type === "findings.selected") return `pass ${event.pass ?? "?"} selected ${event.count ?? 0} findings`;
	if (event.type === "provider.started") return `pass ${event.pass ?? "?"} provider started with ${event.findings ?? 0} findings`;
	if (event.type === "provider.skipped") return `provider skipped${event.reason ? `: ${event.reason}` : ""}`;
	if (event.type === "provider.finished") {
		const exitCode = event.exitCode === 0 ? "finished" : `finished with exit ${event.exitCode ?? "unknown"}`;
		const tools = typeof event.toolCalls === "number" ? ` · ${formatToolCalls(event.toolCalls)}` : "";
		return `pass ${event.pass ?? "?"} provider ${exitCode}${tools}`;
	}
	if (event.type === "diff.verified") {
		const files = Array.isArray(event.changedFiles) ? event.changedFiles.length : 0;
		return `pass ${event.pass ?? "?"} diff verified with ${files} changed file${files === 1 ? "" : "s"}`;
	}
	if (event.type === "diff.applied") return "diff applied to original worktree";
	if (event.type === "diff.apply_skipped") return "diff apply skipped";
	if (event.type === "publish.started") return event.pr ? "publish started for PR" : "publish started";
	if (event.type === "publish.finished") return "publish finished";
	if (event.type === "publish.skipped") return `publish skipped${event.reason ? `: ${event.reason}` : ""}`;
	if (event.type === "session.completed") return "session completed";
	if (event.type === "session.failed") return `session failed: ${event.message ?? "unknown error"}`;
	if (event.type === "worktree.removed") return "worktree removed";
	return null;
};
const renderAgentWatchSnapshot = (input) => {
	const summary = summarizeAgentSession(input.sessionPath, input.events);
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: "Agent watch",
			context: [summary.id]
		}).trimEnd(),
		"",
		renderDisplaySection("Details"),
		...renderDisplayRows([
			{
				label: "Status",
				value: summary.status
			},
			{
				label: "Provider",
				value: summary.providerLabel ?? summary.provider ?? "unknown provider"
			},
			{
				label: "Transcript",
				value: displayAgentPath(input.root, input.sessionPath)
			}
		], {
			indent: 3,
			labelWidth: 10
		}),
		""
	];
	for (const event of input.events.slice(input.fromIndex ?? 0)) {
		const line = renderAgentWatchEvent(event);
		if (line) lines.push(` ${style$1(theme, "muted", event.timestamp)}  ${line}`);
	}
	if ((input.fromIndex ?? 0) === 0 && isTerminalAgentSession(input.events)) lines.push("", ...renderAgentSessionReview({
		summary,
		events: input.events
	}));
	return `${lines.join("\n")}\n`;
};
const agentWatchCommand = async (session, options) => {
	try {
		const root = await resolveAgentGitRoot(options.root);
		const sessionPath = resolveAgentSessionPath(root, session);
		if (!sessionPath) throw new Error(session ? `No matching agent session: ${session}` : "No agent sessions found.");
		let emitted = 0;
		let printedHeader = false;
		let printedReview = false;
		while (true) {
			const events = readAgentSessionEvents(sessionPath);
			if (!printedHeader) {
				process.stdout.write(renderAgentWatchSnapshot({
					root,
					sessionPath,
					events
				}));
				printedHeader = true;
				emitted = events.length;
				printedReview = isTerminalAgentSession(events);
			} else if (events.length > emitted) {
				for (const event of events.slice(emitted)) {
					const line = renderAgentWatchEvent(event);
					if (line) process.stdout.write(` ${style$1(theme, "muted", event.timestamp)}  ${line}\n`);
				}
				emitted = events.length;
			}
			if (options.once || isTerminalAgentSession(events)) {
				if (!printedReview && emitted > 0 && isTerminalAgentSession(events)) process.stdout.write(`\n${renderAgentSessionReview({
					summary: summarizeAgentSession(sessionPath, events),
					events
				}).join("\n")}\n`);
				return;
			}
			await sleep(Math.max(250, options.interval));
		}
	} catch (error) {
		log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
};
//#endregion
//#region src/cli/agent-session-command.ts
const registerSessionsListCommand = (agent) => {
	agent.command("sessions [directory]").description("List recent local agent sessions").option("--limit <n>", "maximum sessions to show", parseInteger, 10).action(async (directory = ".", _flags, command) => {
		const flags = command.optsWithGlobals();
		await withAgentLifecycle("agent_sessions", directory, { result_limit: flags.limit ?? 10 }, async () => {
			await agentSessionsCommand(directory, { limit: flags.limit ?? 10 });
		});
	});
};
const registerSessionShowCommand = (agent) => {
	agent.command("show [session]").description("Show a local agent session summary and timeline").option("--root <directory>", "git repository to read sessions from", ".").action(async (session, _flags, command) => {
		const root = command.optsWithGlobals().root ?? ".";
		await withAgentLifecycle("agent_show", root, {
			session_supplied: session !== void 0,
			custom_root: root !== "."
		}, async () => {
			await agentShowCommand(session, { root });
		});
	});
};
const registerSessionApplyCommand = (agent) => {
	agent.command("apply [session]").description("Apply a reviewed isolated worktree session back to the repo").option("--root <directory>", "git repository to read sessions from", ".").option("--dry-run", "preview the session diff without applying it").option("-y, --yes", "skip confirmation prompts").action(async (session, _flags, command) => {
		const flags = command.optsWithGlobals();
		const root = flags.root ?? ".";
		await withAgentLifecycle("agent_apply", root, {
			session_supplied: session !== void 0,
			custom_root: root !== ".",
			dry_run: Boolean(flags.dryRun),
			confirmed_noninteractive: Boolean(flags.yes)
		}, async () => {
			await agentApplyCommand(session, {
				root,
				dryRun: Boolean(flags.dryRun),
				yes: Boolean(flags.yes)
			});
		});
	});
};
const registerSessionWatchCommand = (agent) => {
	agent.command("watch [session]").description("Watch a local agent session as it streams").option("--root <directory>", "git repository to read sessions from", ".").option("--interval <ms>", "poll interval while following", parseInteger, 1e3).option("--once", "print the current session events and exit").action(async (session, _flags, command) => {
		const flags = command.optsWithGlobals();
		const root = flags.root ?? ".";
		await withAgentLifecycle("agent_watch", root, {
			session_supplied: session !== void 0,
			custom_root: root !== ".",
			interval_ms: flags.interval ?? 1e3,
			once: Boolean(flags.once)
		}, async () => {
			await agentWatchCommand(session, {
				root,
				interval: flags.interval ?? 1e3,
				once: Boolean(flags.once)
			});
		});
	});
};
const registerSessionStopCommand = (agent) => {
	agent.command("stop [session]").description("Stop a running background agent session").option("--root <directory>", "git repository to read sessions from", ".").option("--force", "send SIGKILL instead of SIGTERM").action(async (session, _flags, command) => {
		const flags = command.optsWithGlobals();
		const root = flags.root ?? ".";
		await withAgentLifecycle("agent_stop", root, {
			session_supplied: session !== void 0,
			custom_root: root !== ".",
			force: Boolean(flags.force)
		}, async () => {
			await agentStopCommand(session, {
				root,
				force: Boolean(flags.force)
			});
		});
	});
};
const registerAgentSessionSubcommands = (agent) => {
	registerSessionsListCommand(agent);
	registerSessionShowCommand(agent);
	registerSessionApplyCommand(agent);
	registerSessionWatchCommand(agent);
	registerSessionStopCommand(agent);
};
//#endregion
//#region src/cli/agent-command.ts
const registerProviderSubcommands = (agent) => {
	agent.command("connect [provider]").description("Connect to a local coding-agent provider using its own CLI auth").option("--dry-run", "print the provider login command without running it").action(async (provider, _flags, command) => {
		const flags = command.optsWithGlobals();
		const selection = provider ?? "auto";
		await withAgentLifecycle("agent_connect", ".", {
			provider: telemetryProvider(selection),
			provider_supplied: provider !== void 0,
			dry_run: Boolean(flags.dryRun)
		}, async () => {
			await agentConnectCommand(selection, { dryRun: Boolean(flags.dryRun) });
		});
	});
	agent.command("providers").description("Show local coding-agent providers and setup hints").action(async () => {
		await withAgentLifecycle("agent_providers", ".", {}, async () => {
			await agentProvidersCommand();
		});
	});
	agent.command("use [provider]").alias("switch").description("Set or show the default local agent provider for this repo").option("--root <directory>", "git repository to store the local provider preference", ".").option("--dry-run", "print the provider preference change without writing").action(async (provider, _flags, command) => {
		const flags = command.optsWithGlobals();
		const root = flags.root ?? ".";
		await withAgentLifecycle("agent_use", root, {
			provider: telemetryProvider(provider),
			provider_supplied: provider !== void 0,
			custom_root: root !== ".",
			dry_run: Boolean(flags.dryRun)
		}, async () => {
			await agentUseCommand(provider, {
				root,
				dryRun: Boolean(flags.dryRun)
			});
		});
	});
};
const registerPlanSubcommand = (agent) => {
	const plan = agent.command("plan [directory]").description("Preview provider, worktree, findings, and publish actions without editing");
	addAgentOptions(plan);
	plan.action(async (directory = ".", _flags, command) => {
		const options = agentOptionsFromFlags(command.optsWithGlobals(), command);
		await withAgentLifecycle("agent_plan", directory, agentTelemetryProperties(options), async () => {
			await agentPlanCommand(directory, options);
		});
	});
};
const registerAgentCommand = (program) => {
	const agent = program.command("agent [directory]").description("Run a local AI slop repair session with Codex, Claude Code, or OpenCode");
	addAgentOptions(agent);
	agent.action(async (directory = ".", _flags, command) => {
		const options = agentOptionsFromFlags(command.optsWithGlobals(), command);
		await withAgentLifecycle("agent", directory, agentTelemetryProperties(options), async () => {
			return await agentCommand(directory, options);
		});
	});
	registerProviderSubcommands(agent);
	registerPlanSubcommand(agent);
	registerAgentMonitorSubcommands(agent);
	registerAgentSessionSubcommands(agent);
};
//#endregion
//#region src/hooks/feedback.ts
const fingerprintFinding = (f) => `${f.file}:${f.line}:${f.ruleId}`;
const MAX_FINDINGS = 20;
const MAX_NEW_SINCE_BASELINE = 10;
const REVIEW_TOP_N = 3;
const toFinding = (d, rootDirectory) => {
	if (d.severity !== "error" && d.severity !== "warning") return null;
	const file = toPosix(path.isAbsolute(d.filePath) ? path.relative(rootDirectory, d.filePath) : d.filePath);
	return {
		ruleId: d.rule,
		severity: d.severity,
		category: d.category,
		file,
		line: d.line,
		col: d.column || void 0,
		message: d.message
	};
};
const buildNextSteps = (findings) => {
	const steps = [];
	const errorCount = findings.filter((f) => f.severity === "error").length;
	if (errorCount > 0) steps.push(`Fix ${errorCount} error${errorCount === 1 ? "" : "s"} before the next turn.`);
	const byFile = /* @__PURE__ */ new Map();
	for (const f of findings) {
		const list = byFile.get(f.file) ?? [];
		list.push(f);
		byFile.set(f.file, list);
	}
	for (const [file, list] of Array.from(byFile.entries()).slice(0, 3)) {
		const lines = list.map((f) => f.line).slice(0, 3).join(", ");
		steps.push(`Address ${list.length} finding${list.length === 1 ? "" : "s"} in ${file} (line${list.length === 1 ? "" : "s"} ${lines}).`);
	}
	return steps;
};
const buildSuggestedActions = (diagnostics, findings, regressed, delta) => {
	const actions = [];
	const fixableDiags = diagnostics.filter((d) => d.fixable);
	if (fixableDiags.length > 0) {
		const ruleIds = Array.from(new Set(fixableDiags.map((d) => d.rule)));
		actions.push({
			id: "run_aislop_fix",
			label: `Run aislop fix to clear ${fixableDiags.length} mechanical finding${fixableDiags.length === 1 ? "" : "s"}.`,
			command: "aislop fix",
			rationale: "These findings have deterministic fixes (formatting, unused imports, trivial comments). Running this before any manual work avoids burning agent tokens on what the CLI handles for free.",
			ruleIds
		});
	}
	const archErrors = findings.filter((f) => f.ruleId.startsWith("arch/") && f.severity === "error");
	if (archErrors.length > 0) actions.push({
		id: "review_finding",
		label: `Review ${archErrors.length} architecture rule violation${archErrors.length === 1 ? "" : "s"} — these can't be auto-fixed.`,
		rationale: "Architecture rules encode intentional project structure decisions. The fix usually means moving code, not editing it.",
		ruleIds: Array.from(new Set(archErrors.map((f) => f.ruleId)))
	});
	if (regressed && typeof delta === "number" && delta <= -5 && fixableDiags.length === 0) {
		const top = findings.filter((f) => f.severity === "error" || f.severity === "warning").slice(0, REVIEW_TOP_N);
		if (top.length > 0) actions.push({
			id: "review_finding",
			label: `Score dropped ${Math.abs(delta)} points — review the top ${top.length} finding${top.length === 1 ? "" : "s"} from this edit.`,
			rationale: "None of these are auto-fixable. Read each one against the source and decide whether the fix is to change the code or to add a justified suppression with a reason.",
			ruleIds: top.map((f) => f.ruleId)
		});
	}
	if (actions.length === 0) actions.push({
		id: "no_action",
		label: typeof delta === "number" ? delta > 0 ? `Score improved by ${delta}. No action needed.` : "Score unchanged. No action needed." : "No findings. No action needed.",
		rationale: "The current scan didn't reveal anything that requires the agent's attention."
	});
	return actions;
};
const buildAccountability = (meta, findings, regressed, newSinceBaseline) => {
	if (!meta?.agent && (!meta?.touchedFiles || meta.touchedFiles.length === 0)) return void 0;
	const touchedFiles = Array.from(new Set(meta.touchedFiles ?? []));
	const newFindingCount = newSinceBaseline?.length ?? findings.length;
	const mustFixBeforeDone = regressed || findings.some((f) => f.severity === "error");
	const reason = mustFixBeforeDone ? regressed ? "Score regressed against the captured baseline. The agent should fix or justify the new findings before finishing." : "Error-severity findings remain in files touched by this agent turn." : "No blocking regression detected for this agent turn.";
	return {
		agent: meta.agent,
		touchedFiles,
		newFindingCount,
		mustFixBeforeDone,
		reason
	};
};
const buildFeedback = (diagnostics, score, rootDirectory, baseline, meta) => {
	const all = diagnostics.map((d) => toFinding(d, rootDirectory)).filter((x) => x !== null);
	const capped = all.slice(0, MAX_FINDINGS);
	const elided = all.length > MAX_FINDINGS ? all.length - MAX_FINDINGS : void 0;
	const counts = {
		error: diagnostics.filter((d) => d.severity === "error").length,
		warning: diagnostics.filter((d) => d.severity === "warning").length,
		fixable: diagnostics.filter((d) => d.fixable).length,
		total: all.length
	};
	const baselineSnapshot = typeof baseline === "number" ? {
		score: baseline,
		findingFingerprints: []
	} : baseline;
	const baselineScore = baselineSnapshot?.score;
	const delta = typeof baselineScore === "number" ? score - baselineScore : void 0;
	const regressed = typeof delta === "number" ? delta < 0 : false;
	let newSinceBaseline;
	if (baselineSnapshot && baselineSnapshot.findingFingerprints.length > 0) {
		const known = new Set(baselineSnapshot.findingFingerprints);
		newSinceBaseline = all.filter((f) => !known.has(fingerprintFinding(f))).slice(0, MAX_NEW_SINCE_BASELINE);
	}
	return {
		schema: "aislop.hook.v2",
		score,
		baseline: baselineScore,
		delta,
		regressed,
		accountability: buildAccountability(meta, capped, regressed, newSinceBaseline),
		counts,
		findings: capped,
		elided,
		newSinceBaseline,
		nextSteps: buildNextSteps(capped),
		suggestedActions: buildSuggestedActions(diagnostics, capped, regressed, delta)
	};
};
//#endregion
//#region src/hooks/io/scan-lock.ts
const LOCK_DIR = ".aislop";
const LOCK_FILE = "hook.lock";
const STALE_MS = 3e4;
const lockPath = (cwd) => path.join(cwd, LOCK_DIR, LOCK_FILE);
const readLock = (target) => {
	try {
		const raw = fs.readFileSync(target, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.pid !== "number" || typeof parsed.ts !== "number") return null;
		return parsed;
	} catch {
		return null;
	}
};
const acquireHookLock = (cwd) => {
	const target = lockPath(cwd);
	const existing = readLock(target);
	if (existing && Date.now() - existing.ts < STALE_MS) return null;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify({
			pid: process.pid,
			ts: Date.now()
		}));
	} catch {
		return null;
	}
	return () => {
		try {
			if (readLock(target)?.pid === process.pid) fs.unlinkSync(target);
		} catch {}
	};
};
const supportedGlobPatterns = (patterns) => patterns.filter((pattern) => pattern.length <= 256);
const normalizeExcludePatterns = (patterns) => patterns.flatMap((pattern) => {
	const trimmed = pattern.trim();
	const withoutProjectPrefix = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
	let end = withoutProjectPrefix.length;
	while (end > 0 && withoutProjectPrefix[end - 1] === "/") end -= 1;
	const normalized = withoutProjectPrefix.slice(0, end);
	if (normalized.length === 0) return [];
	if (normalized.length > 256) return [];
	if (micromatch.scan(normalized).isGlob) return [normalized];
	if (normalized.startsWith(".") && !normalized.includes("/")) return supportedGlobPatterns([`**/${normalized}`, `**/${normalized}/**`]);
	return supportedGlobPatterns([normalized, `${normalized}/**`]);
});
const isPathExcluded = (relativePath, normalizedPatterns) => {
	if (normalizedPatterns.length === 0) return false;
	return micromatch.isMatch(relativePath, normalizedPatterns, { dot: true });
};
const filterExcludedDiagnostics = (diagnostics, rootDirectory, excludePatterns) => {
	if (!excludePatterns || excludePatterns.length === 0) return diagnostics;
	const normalized = normalizeExcludePatterns(excludePatterns);
	if (normalized.length === 0) return diagnostics;
	return diagnostics.filter((diagnostic) => {
		const relativePath = path.isAbsolute(diagnostic.filePath) ? toPosix(path.relative(rootDirectory, diagnostic.filePath)) : toPosix(diagnostic.filePath);
		return !isPathExcluded(relativePath, normalized);
	});
};
//#endregion
//#region src/utils/project-path-safety.ts
const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;
const isWithinDirectory$3 = (rootDirectory, candidate) => {
	const relative = path.relative(rootDirectory, candidate);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
};
const safeProjectFilePath = (candidate, rootDirectory, maxBytes = MAX_PROJECT_CONFIG_BYTES) => {
	try {
		const absoluteRoot = path.resolve(rootDirectory);
		const realRoot = fs.realpathSync(rootDirectory);
		const absolutePath = path.resolve(candidate);
		if (!isWithinDirectory$3(absoluteRoot, absolutePath)) return null;
		const stats = fs.lstatSync(absolutePath);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) return null;
		const realPath = fs.realpathSync(absolutePath);
		return isWithinDirectory$3(realRoot, realPath) ? realPath : null;
	} catch {
		return null;
	}
};
const safeProjectDirectoryPath = (candidate, rootDirectory) => {
	try {
		const absoluteRoot = path.resolve(rootDirectory);
		const realRoot = fs.realpathSync(rootDirectory);
		const absolutePath = path.resolve(candidate);
		if (!isWithinDirectory$3(absoluteRoot, absolutePath)) return null;
		const stats = fs.lstatSync(absolutePath);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
		const realPath = fs.realpathSync(absolutePath);
		return isWithinDirectory$3(realRoot, realPath) ? realPath : null;
	} catch {
		return null;
	}
};
const isRootBoundedTarget = (candidate, rootDirectory) => {
	try {
		const absoluteRoot = path.resolve(rootDirectory);
		const realRoot = fs.realpathSync(rootDirectory);
		const absolutePath = path.resolve(candidate);
		if (!isWithinDirectory$3(absoluteRoot, absolutePath)) return false;
		let existingPath = absolutePath;
		while (!fs.existsSync(existingPath)) {
			const parent = path.dirname(existingPath);
			if (parent === existingPath) return false;
			existingPath = parent;
		}
		const stats = fs.lstatSync(existingPath);
		if (existingPath === absolutePath && stats.isSymbolicLink()) return false;
		return isWithinDirectory$3(realRoot, fs.realpathSync(existingPath));
	} catch {
		return false;
	}
};
//#endregion
//#region src/utils/aislop-ignore.ts
const readAislopIgnorePatterns = (rootDirectory) => {
	const ignorePath = safeProjectFilePath(path.join(rootDirectory, ".aislopignore"), rootDirectory);
	if (!ignorePath) return [];
	try {
		return fs.readFileSync(ignorePath, "utf-8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
	} catch {
		return [];
	}
};
//#endregion
//#region src/utils/generated-files.ts
const AUTO_GENERATED_PATTERNS = [
	/auto-generated/i,
	/@generated/i,
	/DO NOT (?:EDIT|MODIFY)/i,
	/this file (?:is|was) (?:auto-?)?generated/i,
	/automatically generated/i,
	/generated by/i
];
const GENERATED_ARTIFACT_FILE_PATTERNS = [
	/\.min\.(?:js|css|mjs|cjs)$/i,
	/\.bundle\.(?:js|css|mjs|cjs)$/i,
	/(?:^|\/)\.pnp(?:\.loader)?\.[mc]?js$/i
];
const isGeneratedArtifactFile = (filePath) => GENERATED_ARTIFACT_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
const isAutoGenerated = (filePath) => {
	const lower = filePath.split(path.sep).join("/").toLowerCase();
	if (/(?:^|\/)(?:generated|__generated__|auto-generated|metadata\/generated|client-sdk\/.*\/generated|src-tauri\/gen)\//.test(lower)) return true;
	let descriptor;
	try {
		descriptor = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(512);
		const bytesRead = fs.readSync(descriptor, buffer, 0, 512, 0);
		const header = buffer.toString("utf-8", 0, bytesRead);
		if (AUTO_GENERATED_PATTERNS.some((pattern) => pattern.test(header))) return true;
		return /@generated|generated by|do not edit|autogenerated/i.test(header);
	} catch {
		return false;
	} finally {
		if (descriptor !== void 0) fs.closeSync(descriptor);
	}
};
//#endregion
//#region src/utils/git-ignore.ts
const MAX_BUFFER$2 = 50 * 1024 * 1024;
const NOT_IGNORED_ARGUMENTS = [
	"ls-files",
	"--cached",
	"--others",
	"--exclude-standard",
	"-z"
];
const IGNORE_CASE_ARGUMENTS = [
	"config",
	"--type=bool",
	"core.ignorecase"
];
const CHECK_IGNORE_ARGUMENTS = [
	"check-ignore",
	"--stdin",
	"-z"
];
const toProjectPath$1 = (rootDirectory, filePath) => {
	const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDirectory, filePath);
	return path.relative(rootDirectory, absolutePath).split(path.sep).join("/");
};
const foldAsciiCase = (value) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const snapshotByRoot = /* @__PURE__ */ new Map();
const readIgnoreCase = (rootDirectory) => {
	const result = spawnSync("git", IGNORE_CASE_ARGUMENTS, {
		cwd: rootDirectory,
		encoding: "utf-8"
	});
	if (result.error || result.status !== 0) return false;
	return result.stdout.trim() === "true";
};
const buildSnapshot = (rootDirectory) => {
	const result = spawnSync("git", NOT_IGNORED_ARGUMENTS, {
		cwd: rootDirectory,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER$2
	});
	if (result.error || result.status !== 0) return {
		notIgnoredPaths: /* @__PURE__ */ new Set(),
		ignoreCase: false,
		gitInvocationFailed: true
	};
	const ignoreCase = readIgnoreCase(rootDirectory);
	const entries = result.stdout.split("\0").filter((entry) => entry.length > 0).map((entry) => entry.endsWith("/") ? entry.slice(0, -1) : entry);
	return {
		notIgnoredPaths: new Set(ignoreCase ? entries.map(foldAsciiCase) : entries),
		ignoreCase,
		gitInvocationFailed: false
	};
};
const getRootSnapshot = (rootDirectory) => {
	const rootKey = path.resolve(rootDirectory);
	const existing = snapshotByRoot.get(rootKey);
	if (existing) return existing;
	const created = buildSnapshot(rootDirectory);
	snapshotByRoot.set(rootKey, created);
	return created;
};
const embeddedRepositoryAncestor = (snapshot, file) => {
	let ancestor = file;
	for (;;) {
		const slashIndex = ancestor.lastIndexOf("/");
		if (slashIndex === -1) return null;
		ancestor = ancestor.slice(0, slashIndex);
		const key = snapshot.ignoreCase ? foldAsciiCase(ancestor) : ancestor;
		if (snapshot.notIgnoredPaths.has(key)) return ancestor;
	}
};
const ignoredInsideEmbeddedRepository = (rootDirectory, files) => {
	const result = spawnSync("git", CHECK_IGNORE_ARGUMENTS, {
		cwd: rootDirectory,
		encoding: "utf-8",
		input: `${files.join("\0")}\0`,
		maxBuffer: MAX_BUFFER$2
	});
	if (result.error || result.status !== 0 && result.status !== 1) return [];
	return result.stdout.split("\0").filter((file) => file.length > 0);
};
const getIgnoredPaths = (rootDirectory, files) => {
	if (files.length === 0) return /* @__PURE__ */ new Set();
	const snapshot = getRootSnapshot(rootDirectory);
	if (snapshot.gitInvocationFailed) return /* @__PURE__ */ new Set();
	const ignoredPaths = /* @__PURE__ */ new Set();
	const embeddedCandidates = /* @__PURE__ */ new Map();
	for (const file of files) {
		const lookupKey = snapshot.ignoreCase ? foldAsciiCase(file) : file;
		if (snapshot.notIgnoredPaths.has(lookupKey)) continue;
		const ancestor = embeddedRepositoryAncestor(snapshot, file);
		if (!ancestor) {
			ignoredPaths.add(file);
			continue;
		}
		const candidates = embeddedCandidates.get(ancestor) ?? [];
		candidates.push(file);
		embeddedCandidates.set(ancestor, candidates);
	}
	for (const candidates of embeddedCandidates.values()) for (const file of ignoredInsideEmbeddedRepository(rootDirectory, candidates)) ignoredPaths.add(file);
	return ignoredPaths;
};
const resetGitIgnoreSnapshots = () => {
	snapshotByRoot.clear();
};
const dropGitIgnoredPaths = (rootDirectory, absolutePaths) => {
	if (absolutePaths.length === 0) return absolutePaths;
	const relativePaths = absolutePaths.map((absolutePath) => toProjectPath$1(rootDirectory, absolutePath));
	const ignored = getIgnoredPaths(rootDirectory, relativePaths);
	return absolutePaths.filter((_, index) => !ignored.has(relativePaths[index]));
};
//#endregion
//#region src/utils/project-file-list.ts
const MAX_BUFFER$1 = 50 * 1024 * 1024;
const normalizePruneDirectories = (directories) => new Set([...directories].map((directory) => directory.toLowerCase()));
const isInPrunedDirectory = (filePath, pruneDirectories) => {
	const pathSegments = filePath.split("/");
	pathSegments.pop();
	return pathSegments.some((segment) => pruneDirectories.has(segment.toLowerCase()));
};
const enumerateProjectFilesFromDisk = (rootDirectory, pruneDirectories) => {
	const files = [];
	const normalizedPruneDirectories = normalizePruneDirectories(pruneDirectories);
	const walk = (directory) => {
		let entries;
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				let stats;
				try {
					stats = fs.lstatSync(fullPath);
				} catch {
					continue;
				}
				if (stats.isDirectory() && !stats.isSymbolicLink() && !normalizedPruneDirectories.has(entry.name.toLowerCase())) walk(fullPath);
			} else if (entry.isFile()) files.push(path.relative(rootDirectory, fullPath).split(path.sep).join("/"));
		}
	};
	walk(rootDirectory);
	return files;
};
const enumerateProjectFiles = (rootDirectory, pruneDirectories) => {
	const result = spawnSync("git", [
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard"
	], {
		cwd: rootDirectory,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER$1
	});
	if (!result.error && result.status === 0) {
		const normalizedPruneDirectories = normalizePruneDirectories(pruneDirectories);
		return result.stdout.split("\n").filter((file) => file.length > 0).filter((file) => !isInPrunedDirectory(file, normalizedPruneDirectories)).filter((file) => fs.existsSync(path.resolve(rootDirectory, file)));
	}
	return enumerateProjectFilesFromDisk(rootDirectory, pruneDirectories);
};
//#endregion
//#region src/utils/source-file-policy.ts
const SOURCE_EXTENSIONS$1 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".rb",
	".java",
	".php",
	".cs",
	".c",
	".cc",
	".cpp",
	".cxx",
	".h",
	".hh",
	".hpp",
	".hxx"
]);
const EXCLUDED_SOURCE_DIRECTORIES = [
	"node_modules",
	"dist",
	"build",
	".git",
	".agents",
	".pnpm-store",
	".yarn",
	"bower",
	"bower_components",
	"jspm_packages",
	"schemaspy",
	"generated",
	"__generated__",
	"auto-generated",
	"vendor",
	"vendors",
	"_vendor",
	"vendored",
	"third_party",
	"third-party",
	"3rdparty",
	"examples",
	"example",
	"demos",
	"demo",
	"bench",
	"benches",
	"benchmarks",
	"fixtures",
	"fixture",
	"stories",
	"story",
	"storybook",
	"__stories__",
	"samples",
	"sample",
	"tutorials",
	"tutorial",
	"code_samples",
	"code-samples",
	"notebooks",
	"tests",
	"test",
	"testdata",
	"e2e",
	"__tests__",
	"__test__",
	"spec",
	"__mocks__",
	"test_data",
	".next",
	".nuxt",
	".wasp",
	"coverage",
	".turbo",
	"test-outputs",
	".bundle"
];
const NON_PRUNED_TEST_DIRECTORIES = /* @__PURE__ */ new Set([
	"tests",
	"test",
	"__tests__",
	"__test__",
	"spec",
	"__mocks__",
	"test_data",
	"e2e"
]);
const TEST_EXCLUDED_DIRECTORIES = EXCLUDED_SOURCE_DIRECTORIES.filter((directory) => !NON_PRUNED_TEST_DIRECTORIES.has(directory));
const WALK_PRUNE_DIRECTORIES = /* @__PURE__ */ new Set([
	"node_modules",
	".git",
	".pnpm-store",
	".yarn",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	"vendor",
	"vendors",
	"third_party",
	"third-party"
]);
const TEST_FILE_PATTERNS = [
	/(?:^|\/).*\.test\.[^/]+$/i,
	/(?:^|\/).*\.spec\.[^/]+$/i,
	/(?:^|\/).*\.stor(?:y|ies)\.[^/]+$/i,
	/(?:^|\/)test_[^/]+\.(?:py|rb|php|js|jsx|d\.ts|ts|tsx|java)$/i,
	/(?:^|\/)[^/]+_test\.(?:py|go|rb|php|js|jsx|d\.ts|ts|tsx|java)$/i,
	/(?:^|\/)[^/]+Tests?\.cs$/i,
	/(?:^|\/)[^/]+\.Tests?\.cs$/i,
	/(?:^|\/)[^/]*Tests?\/.*\.cs$/i,
	/(?:^|\/)[^/]+_tests?\.(?:c|cc|cpp|cxx)$/i,
	/(?:^|\/)test_[^/]+\.(?:c|cc|cpp|cxx)$/i
];
const toProjectPath = (rootDirectory, filePath) => {
	const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDirectory, filePath);
	return path.relative(rootDirectory, absolutePath).split(path.sep).join("/");
};
const isWithinProject = (relativePath) => relativePath.length > 0 && !relativePath.startsWith("..");
const isSafeRegularProjectFile = (rootDirectory, absolutePath) => {
	try {
		if (!fs.lstatSync(absolutePath).isFile()) return false;
		const realRoot = fs.realpathSync(rootDirectory);
		const realFile = fs.realpathSync(absolutePath);
		const relativePath = path.relative(realRoot, realFile);
		return isWithinProject(relativePath) && !path.isAbsolute(relativePath);
	} catch {
		return false;
	}
};
const hasAllowedSourceExtension = (filePath, extraExtensions) => SOURCE_EXTENSIONS$1.has(path.extname(filePath)) || extraExtensions.has(path.extname(filePath));
const isInExcludedDirectory = (filePath, excludedDirectories) => {
	const normalized = filePath.toLowerCase();
	return excludedDirectories.some((directory) => normalized === directory || normalized.startsWith(`${directory}/`) || normalized.includes(`/${directory}/`));
};
const isExcludedFromScan = (relativePath) => isInExcludedDirectory(relativePath, EXCLUDED_SOURCE_DIRECTORIES) || isGeneratedArtifactFile(relativePath);
const isTestFile$2 = (filePath) => TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
//#endregion
//#region src/utils/source-file-selection.ts
const GENERATED_DECLARATION_DIRECTORIES = /* @__PURE__ */ new Set([
	"generated",
	"__generated__",
	"auto-generated"
]);
const DECLARATION_EXCLUDED_DIRECTORIES = EXCLUDED_SOURCE_DIRECTORIES.filter((directory) => !GENERATED_DECLARATION_DIRECTORIES.has(directory));
const DEPENDENCY_AUDIT_INPUT_FILE_RE = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements(?:\.[\w-]+)?\.txt|pyproject\.toml|Pipfile|Pipfile\.lock|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|[\w.-]+\.csproj|packages\.lock\.json|Directory\.Packages\.props)$/i;
const isDependencyAuditInputFile = (filePath) => DEPENDENCY_AUDIT_INPUT_FILE_RE.test(filePath);
const listProjectFiles = (rootDirectory) => enumerateProjectFiles(rootDirectory, WALK_PRUNE_DIRECTORIES);
const listProjectFilesFromDisk = (rootDirectory) => enumerateProjectFilesFromDisk(rootDirectory, WALK_PRUNE_DIRECTORIES);
const normalizeIncludePatterns = (patterns) => patterns.flatMap((pattern) => {
	const normalized = pattern.trim().replace(/^\.\//, "").replace(/\/$/, "");
	if (normalized === "" || normalized === ".") return ["**"];
	if (normalized.length > 256) return [];
	if (micromatch.scan(normalized).isGlob) return [normalized];
	return supportedGlobPatterns([normalized, `${normalized}/**`]);
});
const createPathMatcher = (patterns) => {
	const matchers = patterns.map((pattern) => micromatch.matcher(pattern, { dot: true }));
	return (filePath) => matchers.some((matches) => matches(filePath));
};
const filterFiles = (rootDirectory, files, options) => {
	const extraExtensions = new Set(options.extraExtensions);
	const normalizedFiles = files.map((file) => {
		const absolutePath = path.isAbsolute(file) ? file : path.resolve(rootDirectory, file);
		return {
			absolutePath,
			relativePath: toProjectPath(rootDirectory, absolutePath)
		};
	}).filter(({ relativePath }) => isWithinProject(relativePath));
	const ignoredPaths = options.respectGitIgnore ? getIgnoredPaths(rootDirectory, normalizedFiles.map(({ relativePath }) => relativePath)) : /* @__PURE__ */ new Set();
	const excludePatterns = normalizeExcludePatterns(options.exclude);
	const includePatterns = normalizeIncludePatterns(options.include);
	const matchesExclude = createPathMatcher(excludePatterns);
	const matchesInclude = createPathMatcher(includePatterns);
	const excludedDirectories = options.testFiles ? TEST_EXCLUDED_DIRECTORIES : EXCLUDED_SOURCE_DIRECTORIES;
	return normalizedFiles.filter(({ absolutePath, relativePath }) => {
		if (!isSafeRegularProjectFile(rootDirectory, absolutePath) || isInExcludedDirectory(relativePath, excludedDirectories) || isTestFile$2(relativePath) !== options.testFiles || isGeneratedArtifactFile(relativePath) || ignoredPaths.has(relativePath)) return false;
		if (includePatterns.length > 0 && !matchesInclude(relativePath)) return false;
		if (matchesExclude(relativePath)) return false;
		return hasAllowedSourceExtension(relativePath, extraExtensions);
	}).map(({ absolutePath }) => absolutePath);
};
const filterProjectFileSet = (rootDirectory, files, options) => filterFiles(rootDirectory, files, {
	...options,
	testFiles: false
});
const filterTestFileSet = (rootDirectory, files, options) => filterFiles(rootDirectory, files, {
	...options,
	extraExtensions: [],
	testFiles: true
});
const createProjectFileFilter = (respectGitIgnore) => (rootDirectory, files, extraExtensions = [], exclude = [], include = []) => filterProjectFileSet(rootDirectory, files, {
	exclude,
	extraExtensions,
	include,
	respectGitIgnore
});
const createTestFileFilter = (respectGitIgnore) => (rootDirectory, files, exclude = [], include = []) => filterTestFileSet(rootDirectory, files, {
	exclude,
	include,
	respectGitIgnore
});
const filterProjectFiles = createProjectFileFilter(true);
const filterTestFiles = createTestFileFilter(true);
const filterEnumeratedProjectFiles = createProjectFileFilter(false);
const filterEnumeratedTestFiles = createTestFileFilter(false);
const filterDependencyAuditFiles = (rootDirectory, files, exclude = [], include = []) => {
	const excludePatterns = normalizeExcludePatterns(exclude);
	const includePatterns = normalizeIncludePatterns(include);
	const matchesExclude = createPathMatcher(excludePatterns);
	const matchesInclude = createPathMatcher(includePatterns);
	return files.map((file) => {
		const absolutePath = path.isAbsolute(file) ? file : path.resolve(rootDirectory, file);
		return {
			absolutePath,
			relativePath: toProjectPath(rootDirectory, absolutePath)
		};
	}).filter(({ relativePath }) => {
		if (!isWithinProject(relativePath) || isInExcludedDirectory(relativePath, EXCLUDED_SOURCE_DIRECTORIES) || isGeneratedArtifactFile(relativePath) || !isDependencyAuditInputFile(relativePath)) return false;
		if (includePatterns.length > 0 && !matchesInclude(relativePath)) return false;
		return !matchesExclude(relativePath);
	}).map(({ absolutePath }) => absolutePath);
};
const filterExplicitFiles = (rootDirectory, files, extraExtensions = []) => {
	const extensions = new Set(extraExtensions);
	return files.map((file) => {
		const absolutePath = path.isAbsolute(file) ? file : path.resolve(rootDirectory, file);
		return {
			absolutePath,
			relativePath: toProjectPath(rootDirectory, absolutePath)
		};
	}).filter(({ absolutePath, relativePath }) => isWithinProject(relativePath) && isSafeRegularProjectFile(rootDirectory, absolutePath) && hasAllowedSourceExtension(relativePath, extensions)).map(({ absolutePath }) => absolutePath);
};
const filterProjectDeclarationFiles = (rootDirectory, files, exclude = [], include = []) => {
	const excludePatterns = normalizeExcludePatterns(exclude);
	const includePatterns = normalizeIncludePatterns(include);
	const matchesExclude = createPathMatcher(excludePatterns);
	const matchesInclude = createPathMatcher(includePatterns);
	return filterExplicitFiles(rootDirectory, files).filter((filePath) => {
		if (!filePath.endsWith(".d.ts")) return false;
		const relativePath = toProjectPath(rootDirectory, filePath);
		if (isTestFile$2(relativePath) || isInExcludedDirectory(relativePath, DECLARATION_EXCLUDED_DIRECTORIES)) return false;
		if (includePatterns.length > 0 && !matchesInclude(relativePath)) return false;
		return !matchesExclude(relativePath);
	});
};
//#endregion
//#region src/utils/source-file-context.ts
const getSourceFilesForRoot = (rootDirectory) => filterProjectFiles(rootDirectory, listProjectFiles(rootDirectory));
const getTestFilesForRoot = (rootDirectory) => filterTestFiles(rootDirectory, listProjectFiles(rootDirectory));
const getSourceFiles = (context) => context.files ? filterExplicitFiles(context.rootDirectory, context.files) : getSourceFilesForRoot(context.rootDirectory);
const getProjectSourceFiles = (context) => {
	if (context.projectFiles) return filterExplicitFiles(context.rootDirectory, context.projectFiles);
	const candidates = listProjectFiles(context.rootDirectory);
	if (context.files && context.files.length > 0) return [...getSourceFilesForRoot(context.rootDirectory), ...filterProjectDeclarationFiles(context.rootDirectory, candidates)];
	return [...getSourceFiles(context), ...filterProjectDeclarationFiles(context.rootDirectory, candidates)];
};
const getTestFiles = (context) => {
	if (context.testFiles) return filterEnumeratedTestFiles(context.rootDirectory, context.testFiles);
	if (context.files) return filterTestFiles(context.rootDirectory, context.files);
	return getTestFilesForRoot(context.rootDirectory);
};
const getSourceFilesWithExtras = (context, extraExtensions) => context.files ? filterExplicitFiles(context.rootDirectory, context.files, extraExtensions) : filterProjectFiles(context.rootDirectory, listProjectFiles(context.rootDirectory), extraExtensions);
//#endregion
//#region src/utils/string-literals.ts
const consumeQuotedString = (content, start, quote) => {
	const len = content.length;
	let i = start + 1;
	while (i < len) {
		const c = content[i];
		if (c === "\\" && i + 1 < len) {
			i += 2;
			continue;
		}
		if (c === quote) return i + 1;
		if (c === "\n") return i;
		i++;
	}
	return i;
};
const runLength = (content, start, character) => {
	let i = start;
	while (content[i] === character) i++;
	return i - start;
};
const consumeInterpolationHole = (content, open, openLength, multiline) => {
	const len = content.length;
	let depth = openLength;
	const contentStart = open + openLength;
	let i = contentStart;
	while (i < len) {
		const c = content[i];
		if (c === "\n" && !multiline) return null;
		if (c === "\"" || c === "$" || c === "@") {
			const nested = csharpStringAt(content, i);
			if (nested) {
				i = nested.resumeAt;
				continue;
			}
		}
		if (c === "'") {
			i = consumeQuotedString(content, i, "'");
			continue;
		}
		if (c === "{" || c === "}") {
			const run = runLength(content, i, c);
			if (c === "}" && depth - run <= 0) return {
				range: {
					start: contentStart,
					end: i
				},
				resumeAt: i + run
			};
			depth += c === "{" ? run : -run;
			i += run;
			continue;
		}
		i++;
	}
	return null;
};
const scanBraceRun = (content, start, multiline) => {
	const run = runLength(content, start, "{");
	const literalEnd = start + run - run % 2;
	if (run % 2 === 0) return {
		hole: null,
		resumeAt: literalEnd
	};
	const hole = consumeInterpolationHole(content, literalEnd, 1, multiline);
	return {
		hole,
		resumeAt: hole?.resumeAt ?? literalEnd + 1
	};
};
const scanRawBraceRun = (content, start, holeLength) => {
	const run = runLength(content, start, "{");
	if (run < holeLength) return {
		hole: null,
		resumeAt: start + run
	};
	const hole = consumeInterpolationHole(content, start + run - holeLength, holeLength, true);
	return {
		hole,
		resumeAt: hole?.resumeAt ?? start + run
	};
};
const consumePlainString = (content, open, interpolated) => {
	const len = content.length;
	const bodyStart = open + 1;
	const interpolationRanges = [];
	let i = bodyStart;
	while (i < len) {
		const c = content[i];
		if (c === "\\" && i + 1 < len) {
			i += 2;
			continue;
		}
		if (c === "\"") return {
			bodyStart,
			bodyEnd: i,
			resumeAt: i + 1,
			interpolationRanges
		};
		if (c === "\n") return {
			bodyStart,
			bodyEnd: i,
			resumeAt: i,
			interpolationRanges
		};
		if (interpolated && c === "{") {
			const brace = scanBraceRun(content, i, false);
			if (brace.hole) interpolationRanges.push(brace.hole.range);
			i = brace.resumeAt;
			continue;
		}
		i++;
	}
	return {
		bodyStart,
		bodyEnd: len,
		resumeAt: len,
		interpolationRanges
	};
};
const consumeVerbatimString = (content, open, interpolated) => {
	const len = content.length;
	const bodyStart = open + 1;
	const interpolationRanges = [];
	let i = bodyStart;
	while (i < len) {
		const c = content[i];
		if (c === "\"") {
			if (content[i + 1] === "\"") {
				i += 2;
				continue;
			}
			return {
				bodyStart,
				bodyEnd: i,
				resumeAt: i + 1,
				interpolationRanges
			};
		}
		if (interpolated && c === "{") {
			const brace = scanBraceRun(content, i, true);
			if (brace.hole) interpolationRanges.push(brace.hole.range);
			i = brace.resumeAt;
			continue;
		}
		i++;
	}
	return {
		bodyStart,
		bodyEnd: len,
		resumeAt: len,
		interpolationRanges
	};
};
const consumeRawString = (content, open, holeLength) => {
	const len = content.length;
	const openLength = runLength(content, open, "\"");
	const bodyStart = open + openLength;
	const interpolationRanges = [];
	let i = bodyStart;
	while (i < len) {
		const c = content[i];
		if (c === "\"") {
			const run = runLength(content, i, "\"");
			if (run >= openLength) return {
				bodyStart,
				bodyEnd: i,
				resumeAt: i + run,
				interpolationRanges
			};
			i += run;
			continue;
		}
		if (holeLength > 0 && c === "{") {
			const brace = scanRawBraceRun(content, i, holeLength);
			if (brace.hole) interpolationRanges.push(brace.hole.range);
			i = brace.resumeAt;
			continue;
		}
		i++;
	}
	return {
		bodyStart,
		bodyEnd: len,
		resumeAt: len,
		interpolationRanges
	};
};
const readPrefix = (content, start) => {
	let i = start;
	let dollars = 0;
	let verbatim = false;
	while (content[i] === "$" || content[i] === "@") {
		if (content[i] === "$") dollars++;
		else verbatim = true;
		i++;
	}
	if (content[i] !== "\"") return null;
	return {
		open: i,
		dollars,
		verbatim
	};
};
const csharpStringAt = (content, start) => {
	const prefix = readPrefix(content, start);
	if (!prefix) return null;
	const { open, dollars, verbatim } = prefix;
	if (verbatim) return consumeVerbatimString(content, open, dollars > 0);
	if (runLength(content, open, "\"") >= 3) return consumeRawString(content, open, dollars);
	return consumePlainString(content, open, dollars > 0);
};
const cppRawStringAt = (content, start) => {
	if (content[start] !== "R" || content[start + 1] !== "\"") return null;
	const delimiterStart = start + 2;
	let openParen = delimiterStart;
	while (openParen < content.length && content[openParen] !== "(") {
		const character = content[openParen];
		if (openParen - delimiterStart >= 16 || content.charCodeAt(openParen) <= 32 || character === "\\" || character === ")") return null;
		openParen++;
	}
	if (content[openParen] !== "(") return null;
	const closing = `)${content.slice(delimiterStart, openParen)}"`;
	const bodyStart = openParen + 1;
	const bodyEnd = content.indexOf(closing, bodyStart);
	if (bodyEnd === -1) return {
		bodyStart,
		bodyEnd: content.length,
		resumeAt: content.length,
		interpolationRanges: []
	};
	return {
		bodyStart,
		bodyEnd,
		resumeAt: bodyEnd + closing.length,
		interpolationRanges: []
	};
};
//#endregion
//#region src/utils/source-masker-cstyle.ts
const maskCSharp = (content, maskStrings) => {
	const out = content.split("");
	const len = content.length;
	let i = 0;
	const mask = (start, end) => {
		for (let k = start; k < end; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < len) {
		const c = content[i];
		const next = content[i + 1];
		if (c === "\"" || c === "$" || c === "@") {
			const span = csharpStringAt(content, i);
			if (span) {
				if (maskStrings) mask(span.bodyStart, span.bodyEnd);
				for (const range of span.interpolationRanges) {
					const expression = maskCSharp(content.slice(range.start, range.end), maskStrings);
					for (let offset = 0; offset < expression.length; offset++) out[range.start + offset] = expression[offset];
				}
				i = span.resumeAt;
				continue;
			}
		}
		if (c === "'") {
			const start = i;
			i = consumeQuotedString(content, i, "'");
			if (maskStrings) mask(start + 1, i - 1);
			continue;
		}
		if (c === "/" && next === "/") {
			const start = i;
			while (i < len && content[i] !== "\n") i++;
			mask(start, i);
			continue;
		}
		if (c === "/" && next === "*") {
			const start = i;
			i += 2;
			while (i < len - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
			if (i < len - 1) i += 2;
			mask(start, i);
			continue;
		}
		i++;
	}
	return out.join("");
};
const maskCStyle = (content, maskStrings) => {
	const out = content.split("");
	const len = content.length;
	let i = 0;
	const mask = (start, end) => {
		for (let k = start; k < end; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < len) {
		const c = content[i];
		const next = content[i + 1];
		const rawString = cppRawStringAt(content, i);
		if (rawString) {
			if (maskStrings) mask(rawString.bodyStart, rawString.bodyEnd);
			i = rawString.resumeAt;
			continue;
		}
		if (c === "\"" || c === "'") {
			const strStart = i;
			i = consumeQuotedString(content, i, c);
			if (maskStrings) mask(strStart + 1, i - 1);
			continue;
		}
		if (c === "`") {
			const strStart = i;
			const end = content.indexOf("`", i + 1);
			i = end === -1 ? len : end + 1;
			if (maskStrings) mask(strStart + 1, i - 1);
			continue;
		}
		if (c === "/" && next === "/") {
			const start = i;
			while (i < len && content[i] !== "\n") i++;
			mask(start, i);
			continue;
		}
		if (c === "/" && next === "*") {
			const start = i;
			i += 2;
			while (i < len - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
			if (i < len - 1) i += 2;
			mask(start, i);
			continue;
		}
		i++;
	}
	return out.join("");
};
//#endregion
//#region src/utils/source-masker-simple.ts
const maskSimple = (content, family, maskStrings) => {
	const out = content.split("");
	const len = content.length;
	let i = 0;
	const mask = (start, end) => {
		for (let k = start; k < end; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < len) {
		const c = content[i];
		const next = content[i + 1];
		if (family === "py" && (c === "\"" || c === "'")) {
			if (content[i + 1] === c && content[i + 2] === c) {
				const triple = c + c + c;
				const end = content.indexOf(triple, i + 3);
				const stop = end === -1 ? len : end + 3;
				if (maskStrings) mask(i + 3, stop - 3);
				i = stop;
				continue;
			}
		}
		if (c === "\"" || c === "'") {
			const strStart = i;
			i = consumeQuotedString(content, i, c);
			if (maskStrings) mask(strStart + 1, i - 1);
			continue;
		}
		if ((family === "py" || family === "rb" || family === "php") && c === "#") {
			const strStart = i;
			while (i < len && content[i] !== "\n") i++;
			mask(strStart, i);
			continue;
		}
		if (family === "php" && c === "/" && next === "/") {
			const strStart = i;
			while (i < len && content[i] !== "\n") i++;
			mask(strStart, i);
			continue;
		}
		if (family === "php" && c === "/" && next === "*") {
			const strStart = i;
			i += 2;
			while (i < len - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
			if (i < len - 1) i += 2;
			mask(strStart, i);
			continue;
		}
		i++;
	}
	return out.join("");
};
//#endregion
//#region src/utils/source-masker.ts
const JS_EXTS$2 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const PY_EXTS = /* @__PURE__ */ new Set([".py"]);
const RB_EXTS = /* @__PURE__ */ new Set([".rb"]);
const PHP_EXTS = /* @__PURE__ */ new Set([".php"]);
const CSHARP_EXTS = /* @__PURE__ */ new Set([".cs"]);
const CPP_EXTS$1 = /* @__PURE__ */ new Set([
	".c",
	".cc",
	".cpp",
	".cxx",
	".h",
	".hh",
	".hpp",
	".hxx"
]);
const C_STYLE_COMMENT_EXTS = /* @__PURE__ */ new Set([".go"]);
const familyForExt = (ext) => {
	if (JS_EXTS$2.has(ext)) return "js";
	if (PY_EXTS.has(ext)) return "py";
	if (RB_EXTS.has(ext)) return "rb";
	if (PHP_EXTS.has(ext)) return "php";
	if (CSHARP_EXTS.has(ext)) return "csharp";
	if (CPP_EXTS$1.has(ext)) return "cstyle";
	if (C_STYLE_COMMENT_EXTS.has(ext)) return "cstyle";
	return "none";
};
const maskStringsAndComments$1 = (content, ext) => {
	const family = familyForExt(ext);
	if (family === "none") return content;
	if (family === "js") return maskJs(content, true);
	if (family === "csharp") return maskCSharp(content, true);
	if (family === "cstyle") return maskCStyle(content, true);
	return maskSimple(content, family, true);
};
const maskComments = (content, ext) => {
	const family = familyForExt(ext);
	if (family === "none") return content;
	if (family === "js") return maskJs(content, false);
	if (family === "csharp") return maskCSharp(content, false);
	if (family === "cstyle") return maskCStyle(content, false);
	return maskSimple(content, family, false);
};
const handleQuotesAndComments = (content, i, tplStack, mask, maskStrings) => {
	const len = content.length;
	const c = content[i];
	const next = content[i + 1];
	if (c === "\"" || c === "'") {
		const strStart = i;
		const end = consumeQuotedString(content, i, c);
		if (maskStrings) mask(strStart + 1, end - 1);
		return {
			handled: true,
			nextI: end
		};
	}
	if (c === "`") {
		const scan = consumeTemplateString(content, i + 1);
		if (maskStrings) mask(i + 1, scan.maskEnd);
		if (scan.openedInterp) tplStack.push(0);
		return {
			handled: true,
			nextI: scan.resumeAt
		};
	}
	if (c === "/" && next === "/") {
		const strStart = i;
		let k = i;
		while (k < len && content[k] !== "\n") k++;
		mask(strStart, k);
		return {
			handled: true,
			nextI: k
		};
	}
	if (c === "/" && next === "*") {
		const strStart = i;
		let k = i + 2;
		while (k < len - 1 && !(content[k] === "*" && content[k + 1] === "/")) k++;
		if (k < len - 1) k += 2;
		mask(strStart, k);
		return {
			handled: true,
			nextI: k
		};
	}
	return {
		handled: false,
		nextI: i
	};
};
const REGEX_PRECEDING_KEYWORDS = /* @__PURE__ */ new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"do",
	"else",
	"yield",
	"await",
	"case",
	"throw"
]);
const regexAllowedAt = (content, slashIndex) => {
	let p = slashIndex - 1;
	while (p >= 0 && (content[p] === " " || content[p] === "	" || content[p] === "\n" || content[p] === "\r")) p--;
	if (p < 0) return true;
	const ch = content[p];
	if (ch === ")" || ch === "]" || ch === "}" || ch === "\"" || ch === "'" || ch === "`") return false;
	if (/[A-Za-z0-9_$]/.test(ch)) {
		let w = p;
		while (w >= 0 && /[A-Za-z0-9_$]/.test(content[w])) w--;
		return REGEX_PRECEDING_KEYWORDS.has(content.slice(w + 1, p + 1));
	}
	return true;
};
const consumeRegex = (content, start) => {
	const len = content.length;
	let i = start + 1;
	let inClass = false;
	while (i < len) {
		const c = content[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "\n") return -1;
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			i++;
			while (i < len && /[a-z]/i.test(content[i])) i++;
			return i;
		}
		i++;
	}
	return -1;
};
const maskJs = (content, maskStrings) => {
	const out = content.split("");
	const len = content.length;
	const tplStack = [];
	let i = 0;
	const mask = (start, end) => {
		for (let k = start; k < end; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < len) {
		const c = content[i];
		if (tplStack.length > 0) {
			if (c === "{") {
				tplStack[tplStack.length - 1]++;
				i++;
				continue;
			}
			if (c === "}") {
				if (tplStack[tplStack.length - 1] === 0) {
					tplStack.pop();
					const scan = consumeTemplateString(content, i + 1);
					if (maskStrings) mask(i + 1, scan.maskEnd);
					if (scan.openedInterp) tplStack.push(0);
					i = scan.resumeAt;
					continue;
				}
				tplStack[tplStack.length - 1]--;
				i++;
				continue;
			}
		}
		if (c === "/" && content[i + 1] !== "/" && content[i + 1] !== "*" && regexAllowedAt(content, i)) {
			const regexEnd = consumeRegex(content, i);
			if (regexEnd !== -1) {
				if (maskStrings) mask(i + 1, regexEnd);
				i = regexEnd;
				continue;
			}
		}
		const handled = handleQuotesAndComments(content, i, tplStack, mask, maskStrings);
		if (handled.handled) {
			i = handled.nextI;
			continue;
		}
		i++;
	}
	return out.join("");
};
const consumeTemplateString = (content, start) => {
	const len = content.length;
	let i = start;
	while (i < len) {
		const c = content[i];
		if (c === "\\" && i + 1 < len) {
			i += 2;
			continue;
		}
		if (c === "`") return {
			maskEnd: i,
			resumeAt: i + 1,
			openedInterp: false
		};
		if (c === "$" && content[i + 1] === "{") return {
			maskEnd: i,
			resumeAt: i + 2,
			openedInterp: true
		};
		i++;
	}
	return {
		maskEnd: i,
		resumeAt: i,
		openedInterp: false
	};
};
//#endregion
//#region src/engines/ai-slop/abstractions.ts
const JS_EXTS$1 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const THIN_WRAPPER_PATTERNS = [
	{
		pattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w[^{]*)?\{\s*\n?\s*return\s+\w+\([^)]*\);\s*\n?\s*\}/g,
		extensions: JS_EXTS$1
	},
	{
		pattern: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\w[^=]*)?\s*=>\s*\w+\([^)]*\);/g,
		extensions: JS_EXTS$1
	},
	{
		pattern: /def\s+(\w+)\s*\([^)]*\)(?:\s*->[^:]*)?:\s*\n\s+return\s+\w+\([^)]*\)\s*$/gm,
		extensions: /* @__PURE__ */ new Set([".py"])
	}
];
const AI_NAMING_PATTERNS = [/(?:helper|util|handler|process|do|handle|execute|perform)_?\d+/i, /(?:data|temp|result|value|item|obj|arr|str|num|val)\d+/];
const FRAMEWORK_METHOD_NAMES = /^(?:setUp|tearDown|setUpClass|tearDownClass|setUpModule|tearDownModule)$/;
const DUNDER_PATTERN = /^__\w+__$/;
const stripParam = (p) => p.trim().split(/[:=]/)[0].trim().replace(/^[*&]+/, "");
const paramNames = (paramsText) => new Set(paramsText.split(",").map(stripParam).filter((p) => p && p !== "self" && p !== "cls"));
const isIdentityForward = (matchText) => {
	const paramsMatch = matchText.match(/\(([^)]*)\)/);
	const innerMatch = matchText.match(/(?:return\s+\w+|=>\s*\w+)\s*\(([^)]*)\)/);
	if (!paramsMatch || !innerMatch) return false;
	const params = paramNames(paramsMatch[1]);
	const args = innerMatch[1].split(",").map((a) => a.trim()).filter((a) => a.length > 0);
	if (args.length === 0) return false;
	return args.every((a) => /^[A-Za-z_$][\w$]*$/.test(a) && params.has(a));
};
const isUseContextWrapper = (matchText) => /\buse\w+/.test(matchText) && /useContext\s*\(/.test(matchText);
const detectThinWrappers = (content, relativePath, ext) => {
	const diagnostics = [];
	const lines = content.split("\n");
	for (const { pattern, extensions } of THIN_WRAPPER_PATTERNS) {
		if (!extensions.has(ext)) continue;
		const regex = new RegExp(pattern.source, pattern.flags);
		for (const match of content.matchAll(regex)) {
			const funcName = match[1];
			const matchText = match[0];
			const lineNumber = content.slice(0, match.index).split("\n").length;
			if (DUNDER_PATTERN.test(funcName)) continue;
			if (FRAMEWORK_METHOD_NAMES.test(funcName)) continue;
			if (lineNumber >= 2) {
				if ((lines[lineNumber - 2]?.trim())?.startsWith("@")) continue;
			}
			if (!isIdentityForward(matchText)) continue;
			if (isUseContextWrapper(matchText)) continue;
			diagnostics.push({
				filePath: relativePath,
				engine: "ai-slop",
				rule: "ai-slop/thin-wrapper",
				severity: "warning",
				message: `Function '${funcName}' is a thin wrapper that only calls another function`,
				help: "Consider calling the inner function directly instead of wrapping it",
				line: lineNumber,
				column: 0,
				category: "AI Slop",
				fixable: false
			});
		}
	}
	return diagnostics;
};
const detectAiNaming = (content, relativePath) => {
	const diagnostics = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const declMatch = lines[i].match(/(?:const|let|var|function|def|func|fn)\s+(\w+)/);
		if (!declMatch) continue;
		const name = declMatch[1];
		if (!AI_NAMING_PATTERNS.some((pattern) => pattern.test(name))) continue;
		diagnostics.push({
			filePath: relativePath,
			engine: "ai-slop",
			rule: "ai-slop/generic-naming",
			severity: "info",
			message: `'${name}' uses generic AI-style naming`,
			help: "Use descriptive names that explain what the code does",
			line: i + 1,
			column: 0,
			category: "AI Slop",
			fixable: false
		});
	}
	return diagnostics;
};
const detectOverAbstraction = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relativePath = relativePosix(context.rootDirectory, filePath);
		const ext = path.extname(filePath);
		const codeOnly = maskComments(content, ext);
		diagnostics.push(...detectThinWrappers(codeOnly, relativePath, ext));
		diagnostics.push(...detectAiNaming(codeOnly, relativePath));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/narrative-comments-patterns.ts
const DECORATIVE_SEPARATOR = /^[-=─━~_*#]{6,}$/;
const DECORATIVE_SECTION_HEADER = /^[-=─━~_*#]{3,}[\s\S]+?[-=─━~_*#]{3,}$/;
const SECTION_HEADER = /^(Phase|Step|Section|Part)\s+\d+[:.-]/i;
const CROSS_REFERENCE_PHRASES = [
	/\bwill then be\b/i,
	/\bused by\b/i,
	/\bcalled from\b/i,
	/\bcalled later\b/i,
	/\bsee (?:above|below|later|earlier)\b/i,
	/\breplaces the\b/i,
	/\bmatches the one\b/i,
	/\bwe moved\b/i,
	/\bwe used to\b/i,
	/\brefactor(?:ed)? from\b/i,
	/\bcombined with\b.*\bthis\b/i
];
const JUSTIFICATION_OPENERS = [
	/^(The idea here|The trick is|This was needed|Originally,?)/i,
	/^This\s+(?:function|method|class|module|component|hook|util|helper|handler|service)\b/i,
	/^It\s+(?:does|handles|takes|returns|processes|reads|writes|sends|fetches|loads|creates|deletes|updates|parses|validates)\b/i,
	/^(?:First|Then|Finally|Next|Lastly|Subsequently),?\s+(?:it|we|the\s+(?:function|method|class))\b/i
];
const EXPLANATORY_OPENERS = /^(Matches|Detects|Represents|Holds|Stores|Tracks|Handles|Manages|Controls|Contains|Captures|Encapsulates|Wraps|Describes)\s+[A-Za-z`'"]/;
const EXPLANATORY_WHY_MARKERS = /\b(?:because|since|otherwise|workaround|caveat|warning|important|assumes?|note:|bug|issue|see\s+(?:issue|above|below)|in\s+prod|in\s+production|breaks?\s+when|fails?\s+when|must\s+run|must\s+be|has\s+to\s+be|hack\s+for|fix\s+for|reason:|to\s+avoid|to\s+ensure|to\s+prevent|in\s+order\s+to|necessary|guarantee[sd]?|prevents?|regardless\s+of|required\s+(?:for|to|by)|for\s+example|e\.g\.|i\.e\.|useful\s+(?:for|when)|intended\s+to|on\s+purpose|by\s+design|ideally|however|although|even\s+though|despite|whereas|unfortunately|trade-?off|first\s+need)\b/i;
const MEANINGFUL_JSDOC_TAGS = /* @__PURE__ */ new Set([
	"deprecated",
	"see",
	"example",
	"type",
	"returns",
	"return",
	"param",
	"throws",
	"typedef",
	"callback",
	"override",
	"template",
	"internal",
	"public",
	"private",
	"protected",
	"experimental",
	"alpha",
	"beta",
	"since",
	"todo",
	"link",
	"license",
	"preserve",
	"swagger",
	"openapi",
	"route",
	"group",
	"summary",
	"description",
	"operationid",
	"response",
	"responses",
	"request",
	"requestbody",
	"security",
	"tag",
	"tags",
	"path",
	"body",
	"query",
	"queryparam",
	"header",
	"headers",
	"produces",
	"accept",
	"middleware",
	"api",
	"apiname",
	"apidefine",
	"apigroup",
	"apiparam",
	"apiquery",
	"apibody",
	"apiheader",
	"apisuccess",
	"apierror",
	"apiexample",
	"apiversion",
	"apidescription",
	"apipermission",
	"apiuse",
	"apiignore",
	"apiprivate",
	"namespace",
	"category"
]);
const SUPPORTED_EXTS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".rb",
	".java",
	".php",
	".cs"
]);
const DECL_START = /^(\s*)(export\s+)?(async\s+)?(const|let|var|function|class|type|interface|enum|abstract\s+class)\s+/;
const EXPORT_DEFAULT = /^\s*export\s+default\b/;
const TS_MEMBER_DECL_START = /^\s*(?:readonly\s+|static\s+|public\s+|private\s+|protected\s+|abstract\s+|override\s+)*[\w$]+\??\s*:/;
const PY_DECL_START = /^\s*(async\s+def|def|class)\s+/;
const GO_DECL_START = /^\s*(func|type|var|const|import)\b/;
const RUST_DECL_START = /^\s*(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|const|static|type|mod)\s+/;
const RUBY_DECL_START = /^\s*(class|module|def)\s+/;
const JAVA_DECL_START = /^\s*(?:public|private|protected|static|final|abstract|sealed|non-sealed|\s)+(?:class|interface|enum|record|@interface|\w[^(){};=]*\s+\w+\s*\()/;
const JAVA_DECL_START_FALLBACK = /^\s*(class|interface|enum|record|@interface)\s+/;
const CSHARP_DECL_START = /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|async|sealed|abstract|virtual|override|partial|readonly|extern|unsafe|file|new)\s+)+(?:class|interface|struct|record|enum|[\w<>[\],.?]+\s+\w+)/;
const CSHARP_DECL_START_FALLBACK = /^\s*(class|interface|struct|record|enum|namespace)\s+/;
const PHP_DECL_START = /^\s*(?:(?:public|private|protected|static|final|abstract|readonly)\s+)*(function|class|interface|trait|enum|const)\s+/;
//#endregion
//#region src/engines/ai-slop/non-production-paths.ts
const DIR_PATTERN = /(?:^|\/)(?:scripts|bin|examples?|demos?|docs?|bench|benches|benchmarks?|fixtures?|templates?|__fixtures__|__mocks__|__tests__|prototypes?|experiments?|vendor|_vendor|vendored|third_party|blib2to3|lib2to3|cli|cli-[\w-]+|[\w-]+-cli)\//i;
const BASENAME_PATTERN = /(?:^|\/)(?:(?:prototype|experiment)(?:[-_.][^/]*)?|(?:benchmark|bench|demo|example|script|seed|migrate|profile|smoke|stress|load|debug|repro)[-_.][^/]*)\.[mc]?[jt]sx?$|(?:^|\/)[^/]+[-_](?:benchmark|bench|demo|example|prototype|experiment)\.[mc]?[jt]sx?$/i;
const isNonProductionPath = (relativePath) => DIR_PATTERN.test(relativePath) || BASENAME_PATTERN.test(relativePath);
/**
* Common bundler, build, and config files where short label comments
* (e.g. "// Vue SFC", "// Build styles") are idiomatic and not AI slop.
* We still want other ai-slop rules (e.g. hallucinated imports, console-leftover)
* to run on them, so we only suppress the noisiest one (trivial-comment) here
* using contextual checks (not a blanket file skip).
*/
const TOOLING_CONFIG_BASENAME = /(?:^|\/)[^/]*?(?:webpack|vite|rollup|rspack|esbuild|tsup|unbuild|babel|postcss|tailwind|prettier|eslint|next|nuxt|svelte|astro|craco|jest|vitest|playwright|karma)\.config\.[^/]+$/i;
const isToolingConfigFile = (relativePath) => TOOLING_CONFIG_BASENAME.test(relativePath);
//#endregion
//#region src/engines/ai-slop/comments.ts
const TRIVIAL_VERB_STEMS = "Import|Defin|Initializ|Setting|Set\\s+up|Setup|Return|Check|Loop|Iterat|Creat|Updat|Delet|Remov|Handl|Get|Fetch|Increment|Decrement|Writ|Runn|Run|Pars|Execut|Extract|Sav|Load|Build|Start|Stopp|Stop|Clean(?:up|\\s+up)?|Configur|Validat|Process|Queue|Fire|Emit|Dispatch|Log|Print|Render";
const TRIVIAL_JS_COMMENT_PATTERNS = [/\/\/\s*This (?:function|method|class|variable|constant) (?:will |is used to |is responsible for )?/i, new RegExp(`\\/\\/\\s*(?:${TRIVIAL_VERB_STEMS})(?:e|es|ing|s)?\\b`, "i")];
const TRIVIAL_PYTHON_COMMENT_PATTERNS = [/^#\s*This (?:function|method|class) (?:will |is used to )?/i, new RegExp(`^#\\s*(?:${TRIVIAL_VERB_STEMS})(?:e|es|ing|s)?\\b`, "i")];
const EXPLANATORY_KEYWORDS = /\b(?:because|since|note|todo|fixme|hack|warn|warning|workaround|caveat|important|assumes?|if|when|unless|until|only|except|otherwise|needs?|must|should|ensure|avoid|prevent|requires?)\b/i;
const COMMENTED_CODE_CHARS = /[({=;}\]>]/;
const MAX_TRIVIAL_COMMENT_LENGTH = 60;
const MIN_TRIVIAL_COMMENT_DENSITY = .02;
const isJsComment = (trimmed) => trimmed.startsWith("//") && !trimmed.startsWith("///") && !trimmed.startsWith("//!");
const isPythonComment = (trimmed) => trimmed.startsWith("#") && !trimmed.startsWith("#!");
const isLineComment = (trimmed) => isJsComment(trimmed) || isPythonComment(trimmed);
const isInMultiLineCommentRun = (lines, index) => {
	const prev = index > 0 ? lines[index - 1].trim() : "";
	const next = index + 1 < lines.length ? lines[index + 1].trim() : "";
	return isLineComment(prev) || isLineComment(next);
};
const getCommentBody = (trimmed) => {
	if (trimmed.startsWith("//")) return trimmed.slice(2).trim();
	if (trimmed.startsWith("#")) return trimmed.slice(1).trim();
	return trimmed;
};
const isTrivialComment = (trimmed, nextLine) => {
	const isJs = isJsComment(trimmed);
	const isPy = isPythonComment(trimmed);
	if (!isJs && !isPy) return false;
	const commentBody = getCommentBody(trimmed);
	if (commentBody.length > MAX_TRIVIAL_COMMENT_LENGTH) return false;
	if (EXPLANATORY_KEYWORDS.test(commentBody)) return false;
	if (commentBody.includes("(") && commentBody.includes(")")) return false;
	if (COMMENTED_CODE_CHARS.test(commentBody)) return false;
	if (nextLine !== void 0 && nextLine.trim() === "") return false;
	if (/[─━═╌╍┄┅│┃]/.test(commentBody)) return false;
	if (/^-{3,}|─{3,}/.test(commentBody)) return false;
	return (isJs ? TRIVIAL_JS_COMMENT_PATTERNS : TRIVIAL_PYTHON_COMMENT_PATTERNS).some((pattern) => pattern.test(trimmed));
};
const declStartForExt = (ext) => {
	switch (ext) {
		case ".go": return [GO_DECL_START];
		case ".rs": return [RUST_DECL_START];
		case ".rb": return [RUBY_DECL_START];
		case ".java": return [JAVA_DECL_START, JAVA_DECL_START_FALLBACK];
		case ".php": return [PHP_DECL_START];
		default: return [];
	}
};
const isCommentLineForExt = (line, ext) => {
	const trimmed = line.trim();
	if (ext === ".rb") return trimmed.startsWith("#") && !trimmed.startsWith("#!");
	if (ext === ".go" || ext === ".rs" || ext === ".java" || ext === ".php") return trimmed.startsWith("//") || trimmed.startsWith("#");
	return false;
};
const isDocCommentForDeclaration = (lines, lineIdx, ext) => {
	const patterns = declStartForExt(ext);
	if (patterns.length === 0) return false;
	for (let j = lineIdx + 1; j < lines.length; j++) {
		const candidate = lines[j];
		if (candidate.trim() === "") continue;
		if (isCommentLineForExt(candidate, ext)) continue;
		return patterns.some((re) => re.test(candidate));
	}
	return false;
};
const isLikelyConfigSectionLabel = (trimmed, nextLine) => {
	if (!nextLine) return false;
	const body = getCommentBody(trimmed).toLowerCase().trim();
	const next = nextLine.trim();
	if (/^(test|use|loader|rules|plugins|resolve|module|build|server|optimizeDeps|defineConfig|config):\s*[[\x7b]/.test(next)) return true;
	if (/\b(test|use|loader)\s*:\s*["'/\x5b]/.test(next)) return true;
	if (/^[a-zA-Z0-9_$-]+\s*:\s*[[\x7b]/.test(next) && body.length < 30) return true;
	if (/^\/\/\s*(Vue|React|Build|Styles|Scripts|Assets|Images|Fonts|Icons)/i.test(trimmed) && /:\s*\x7b/.test(next)) return true;
	return false;
};
const scanFileForTrivialComments = (content, relativePath, ext) => {
	const diagnostics = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const nextLine = i + 1 < lines.length ? lines[i + 1] : void 0;
		if (!isTrivialComment(trimmed, nextLine)) continue;
		if (isInMultiLineCommentRun(lines, i)) continue;
		if (isDocCommentForDeclaration(lines, i, ext)) continue;
		if (isToolingConfigFile(relativePath) && isLikelyConfigSectionLabel(trimmed, nextLine)) continue;
		diagnostics.push({
			filePath: relativePath,
			engine: "ai-slop",
			rule: "ai-slop/trivial-comment",
			severity: "warning",
			message: "Trivial comment that restates the code",
			help: "Remove comments that don't add information beyond what the code already expresses",
			line: i + 1,
			column: 0,
			category: "AI Slop",
			fixable: true
		});
	}
	const codeLineCount = lines.filter((line) => line.trim() !== "").length;
	if (codeLineCount === 0) return [];
	if (diagnostics.length / codeLineCount < MIN_TRIVIAL_COMMENT_DENSITY) return [];
	return diagnostics;
};
const detectTrivialComments = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		if (isAutoGenerated(filePath)) continue;
		const ext = path.extname(filePath);
		const relativePath = relativePosix(context.rootDirectory, filePath);
		if (isNonProductionPath(relativePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		diagnostics.push(...scanFileForTrivialComments(content, relativePath, ext));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/cpp-targets.ts
const CPP_SOURCE_EXTENSIONS = /* @__PURE__ */ new Set([
	".c",
	".cc",
	".cpp",
	".cxx",
	".h",
	".hh",
	".hpp",
	".hxx"
]);
const CPP_IMPL_EXTENSIONS = /* @__PURE__ */ new Set([
	".c",
	".cc",
	".cpp",
	".cxx"
]);
const CPP_ONLY_EXTENSIONS = /* @__PURE__ */ new Set([
	".cc",
	".cpp",
	".cxx",
	".hh",
	".hpp",
	".hxx"
]);
const isCppExtension = (filePath) => CPP_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
const findCppSources = (context) => getSourceFiles(context).filter(isCppExtension);
const hasCppOnlySources = (sources) => sources.some((f) => CPP_ONLY_EXTENSIONS.has(path.extname(f).toLowerCase()));
const canonicalPath$1 = (filePath) => {
	const resolved = path.resolve(filePath).split(path.sep).join("/");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const BUILD_ROOT_MAX_DEPTH = 3;
const BUILD_ROOT_MAX_DIRECTORIES = 512;
const PRUNED_BUILD_SUBDIRS = /* @__PURE__ */ new Set([
	"CMakeFiles",
	"_deps",
	"Testing"
]);
const isPrunedBuildSubdir = (name) => name.startsWith(".") || PRUNED_BUILD_SUBDIRS.has(name);
const isBuildLikeDirName = (name) => name === "build" || name === "out" || name.startsWith("cmake-build");
const hasCompileCommands = (dir) => fs.existsSync(path.join(dir, "compile_commands.json"));
const collectBuildLikeDirs = (root) => {
	const dirs = [];
	try {
		for (const dirent of fs.readdirSync(root, { withFileTypes: true })) if (dirent.isDirectory() && isBuildLikeDirName(dirent.name)) dirs.push(path.join(root, dirent.name));
	} catch {
		return [];
	}
	const explicitBuildDir = path.join(root, "build");
	if (!dirs.includes(explicitBuildDir)) dirs.push(explicitBuildDir);
	return dirs;
};
const scanBuildDirForCompileCommands = (root) => {
	const queue = [{
		dir: root,
		depth: 0
	}];
	const visited = /* @__PURE__ */ new Set([root]);
	while (queue.length > 0 && visited.size <= BUILD_ROOT_MAX_DIRECTORIES) {
		const current = queue.shift();
		if (!current) break;
		if (hasCompileCommands(current.dir)) return current.dir;
		if (current.depth >= BUILD_ROOT_MAX_DEPTH) continue;
		let entries = [];
		try {
			entries = fs.readdirSync(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || isPrunedBuildSubdir(entry.name)) continue;
			const childDir = path.join(current.dir, entry.name);
			if (visited.has(childDir)) continue;
			visited.add(childDir);
			queue.push({
				dir: childDir,
				depth: current.depth + 1
			});
		}
	}
	return null;
};
const findCompileCommandsDir = (context) => {
	const root = context.rootDirectory;
	if (hasCompileCommands(root)) return root;
	for (const buildDir of collectBuildLikeDirs(root)) {
		const found = scanBuildDirForCompileCommands(buildDir);
		if (found) return found;
	}
	return null;
};
const readCompileCommandsFiles = (compileCommandsDir) => {
	try {
		const raw = fs.readFileSync(path.join(compileCommandsDir, "compile_commands.json"), "utf8");
		const entries = JSON.parse(raw);
		if (!Array.isArray(entries)) return [];
		const files = [];
		for (const entry of entries) {
			if (typeof entry?.file !== "string") continue;
			const base = path.isAbsolute(entry.file) || typeof entry.directory !== "string" ? entry.file : path.resolve(entry.directory, entry.file);
			files.push(canonicalPath$1(base));
		}
		return files;
	} catch {
		return [];
	}
};
const filterSourcesInDatabase = (sources, databaseFiles) => {
	if (databaseFiles.length === 0) return sources;
	const inDatabase = new Set(databaseFiles);
	return sources.filter((f) => inDatabase.has(canonicalPath$1(f)));
};
//#endregion
//#region src/engines/ai-slop/cpp-patterns.ts
const HEADER_EXTENSIONS = /* @__PURE__ */ new Set([
	".h",
	".hh",
	".hpp",
	".hxx"
]);
const MAIN_RE = /\bint\s+main\s*\(/;
const NOT_IMPLEMENTED_PATTERN = `not\\s+implemented`;
const NOT_IMPLEMENTED_TEXT = `not implemented`;
const USING_NAMESPACE_STD_PATTERN = [
	"using",
	"namespace",
	"std"
].join("\\s+");
const USING_NAMESPACE_STD_TEXT = [
	"using",
	"namespace",
	"std"
].join(" ");
const DELETE_TOKEN = `delete`;
const STD_PREFIX = `std::`;
const STD_OUT = `${STD_PREFIX}cout`;
const STD_ERR = `${STD_PREFIX}cerr`;
const NULL_TOKEN = `NULL`;
const DEFINE_WORD = `define`;
const DEFINE_TOKEN = `#${DEFINE_WORD}`;
const STD_ENDL = `${STD_PREFIX}endl`;
const LINE_RULES = [
	{
		rule: "ai-slop/cpp-not-implemented",
		regex: /\bthrow\s+std::(?:logic_error|runtime_error)\s*\(\s*"/,
		rawRegex: new RegExp(`\\bthrow\\s+std::(?:logic_error|runtime_error)\\s*\\(\\s*"[^"]*${NOT_IMPLEMENTED_PATTERN}`, "i"),
		message: `Stub throws "${NOT_IMPLEMENTED_TEXT}"`,
		help: "Implement the function or remove the stub before shipping",
		scope: "all"
	},
	{
		rule: "ai-slop/cpp-not-implemented",
		regex: /\bassert\s*\(\s*(?:false|0)\s*&&\s*"/,
		rawRegex: new RegExp(`\\bassert\\s*\\(\\s*(?:false|0)\\s*&&\\s*"[^"]*${NOT_IMPLEMENTED_PATTERN}`, "i"),
		message: `Stub asserts "${NOT_IMPLEMENTED_TEXT}"`,
		help: "Implement the function or remove the stub before shipping",
		scope: "all"
	},
	{
		rule: "ai-slop/cpp-using-namespace-std-in-header",
		regex: new RegExp(`^\\s*${USING_NAMESPACE_STD_PATTERN}\\s*;`),
		message: `\`${USING_NAMESPACE_STD_TEXT};\` at header scope leaks into every includer`,
		help: "Qualify names with std:: or move the using-directive into a .cpp",
		scope: "header"
	},
	{
		rule: "ai-slop/cpp-c-style-cast",
		regex: /\(\s*(?:unsigned\s+|signed\s+|const\s+)?(?:int|char|short|long|float|double|bool|size_t|uint\d+_t|int\d+_t)\s*\*?\s*\)\s*[A-Za-z_(]/,
		message: "C-style cast in C++; prefer static_cast / reinterpret_cast",
		help: "Use a named C++ cast so the intent and safety of the conversion are explicit",
		scope: "cppOnly"
	},
	{
		rule: "ai-slop/cpp-manual-delete",
		regex: new RegExp(`\\b${DELETE_TOKEN}\\s*(?:\\[\\s*\\])?\\s+[A-Za-z_][\\w:.>-]*`),
		message: `Manual ${DELETE_TOKEN}; prefer a smart pointer or RAII container`,
		help: "Own the resource with std::unique_ptr / std::vector so it frees automatically",
		scope: "all"
	},
	{
		rule: "ai-slop/cpp-iostream-leftover",
		regex: new RegExp(`\\b${STD_PREFIX}c(?:out|err)\\b`),
		message: `${STD_OUT} / ${STD_ERR} left in library code`,
		help: "Remove debug output or route it through the project's logging facility",
		scope: "all",
		skipInMain: true
	},
	{
		rule: "ai-slop/cpp-null-literal",
		regex: new RegExp(`\\b${NULL_TOKEN}\\b`),
		message: `${NULL_TOKEN} used in C++; prefer nullptr`,
		help: "nullptr is type-safe and cannot be mistaken for the integer 0 in overload resolution",
		scope: "cppOnly"
	},
	{
		rule: "ai-slop/cpp-define-constant",
		regex: new RegExp(`^\\s*#\\s*${DEFINE_WORD}\\s+[A-Z_]\\w*\\s+[-'"0-9(]`),
		message: `${DEFINE_TOKEN} constant in C++; prefer constexpr / const`,
		help: "A constexpr or const has a type, respects scope, and is visible to the debugger",
		scope: "cppOnly"
	},
	{
		rule: "ai-slop/cpp-endl-in-stream",
		regex: new RegExp(`<<\\s*${STD_ENDL}\\b`),
		message: `${STD_ENDL} flushes the stream on every call; prefer '\\n'`,
		help: "Use '\\n' and flush explicitly (std::flush) only where a flush is actually required",
		scope: "cppOnly"
	}
];
const pushFinding$2 = (out, relPath, rule, lineIndex, message, help) => {
	out.push({
		filePath: relPath,
		engine: "ai-slop",
		rule,
		severity: "warning",
		message,
		help,
		line: lineIndex + 1,
		column: 1,
		category: "AI Slop",
		fixable: false
	});
};
const detectCppPatterns = async (context) => {
	const files = getSourceFiles(context).filter((f) => CPP_SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase()));
	const out = [];
	for (const filePath of files) {
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const ext = path.extname(filePath).toLowerCase();
		const isHeader = HEADER_EXTENSIONS.has(ext);
		const isCppOnly = CPP_ONLY_EXTENSIONS.has(ext);
		const maskedContent = maskStringsAndComments$1(content, ext);
		const commentMaskedLines = maskComments(content, ext).split("\n");
		const hasMain = MAIN_RE.test(maskedContent);
		const relPath = relativePosix(context.rootDirectory, filePath);
		const lines = maskedContent.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			for (const r of LINE_RULES) {
				if (r.scope === "header" && !isHeader) continue;
				if (r.scope === "cppOnly" && !isCppOnly) continue;
				if (r.skipInMain && hasMain) continue;
				if (!r.regex.test(line)) continue;
				if (r.rawRegex && !r.rawRegex.test(commentMaskedLines[i])) continue;
				pushFinding$2(out, relPath, r.rule, i, r.message, r.help);
			}
		}
	}
	return out;
};
//#endregion
//#region src/engines/dotnet-targets.ts
const IGNORED_DIRECTORIES = /* @__PURE__ */ new Set([
	"bin",
	"obj",
	"node_modules",
	".git",
	".vs"
]);
const dropExcludedProjects = (root, projects, excludePatterns) => {
	if (!excludePatterns || excludePatterns.length === 0) return projects;
	const normalized = normalizeExcludePatterns(excludePatterns);
	if (normalized.length === 0) return projects;
	return projects.filter((project) => !isPathExcluded(toPosix(path.relative(root, project)), normalized));
};
const collectCsprojFiles = (root) => {
	const results = [];
	const walk = (directory) => {
		let entries;
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) walk(fullPath);
			} else if (entry.name.endsWith(".csproj")) results.push(fullPath);
		}
	};
	walk(root);
	return results;
};
const findCsprojFiles = (root, excludePatterns) => {
	const results = collectCsprojFiles(root);
	return dropExcludedProjects(root, dropGitIgnoredPaths(root, results), excludePatterns);
};
const emptySelection = () => ({
	targets: [],
	coldProjects: [],
	overCapProjects: []
});
const hasRestoreEvidence = (csprojPath, rootDirectory) => {
	if (fs.existsSync(path.join(path.dirname(csprojPath), "obj", "project.assets.json"))) return true;
	const projectName = path.basename(csprojPath, ".csproj");
	return fs.existsSync(path.join(rootDirectory, "artifacts", "obj", projectName, "project.assets.json"));
};
const selectRestoredProjects = (csprojFiles, rootDirectory) => {
	const restored = [];
	const coldProjects = [];
	for (const csproj of csprojFiles) (hasRestoreEvidence(csproj, rootDirectory) ? restored : coldProjects).push(csproj);
	return {
		targets: restored.slice(0, 32),
		coldProjects,
		overCapProjects: restored.slice(32)
	};
};
const findSolutionOrProjects = (root, solutionExtensions, excludePatterns) => {
	let entries;
	try {
		entries = fs.readdirSync(root);
	} catch {
		return emptySelection();
	}
	let solution;
	for (const extension of solutionExtensions) {
		solution = entries.find((name) => name.endsWith(extension));
		if (solution) break;
	}
	const allProjects = collectCsprojFiles(root);
	const visibleProjects = dropExcludedProjects(root, dropGitIgnoredPaths(root, allProjects), excludePatterns);
	if (solution && visibleProjects.length === allProjects.length) return {
		...emptySelection(),
		targets: dropGitIgnoredPaths(root, [path.join(root, solution)])
	};
	return selectRestoredProjects(visibleProjects, root);
};
const findDotnetTargets = (context) => findSolutionOrProjects(context.rootDirectory, [".sln"], context.excludePatterns);
const findJbTargets = (context) => findSolutionOrProjects(context.rootDirectory, [".sln", ".slnx"], context.excludePatterns);
const projectsSkippedNotice = (selection, rootDirectory) => {
	const skipped = [...selection.coldProjects, ...selection.overCapProjects];
	if (skipped.length === 0) return [];
	const reasons = [];
	if (selection.coldProjects.length > 0) reasons.push(`${selection.coldProjects.length} with no restore evidence (project.assets.json)`);
	if (selection.overCapProjects.length > 0) reasons.push(`${selection.overCapProjects.length} beyond the 32-project cap`);
	return [{
		filePath: toPosix(path.relative(rootDirectory, skipped[0])),
		engine: "lint",
		rule: "dotnet/projects-skipped",
		severity: "info",
		message: `Build-backed C# lint skipped ${skipped.length} project${skipped.length === 1 ? "" : "s"}: ${reasons.join("; ")}`,
		help: "Run `dotnet restore` (or a build) for the projects you want analyzed, or add a root .sln so one solution pass covers them.",
		line: 0,
		column: 0,
		category: "C# Lint",
		fixable: false
	}];
};
//#endregion
//#region src/engines/dotnet-output-type.ts
const PROJECT_SDK_RE = /<Project\s[^>]*\bSdk\s*=\s*"([^"]+)"/i;
const OUTPUT_TYPE_RE = /<OutputType>\s*([^<]+?)\s*<\/OutputType>/i;
const EXE_OUTPUT_TYPES = /* @__PURE__ */ new Set(["exe", "winexe"]);
const EXE_DEFAULT_SDKS = /* @__PURE__ */ new Set([
	"microsoft.net.sdk.web",
	"microsoft.net.sdk.worker",
	"microsoft.net.sdk.blazorwebassembly"
]);
const sdkDefaultsToExe = (sdkAttribute) => sdkAttribute.split(";").map((entry) => entry.trim().split("/")[0].toLowerCase()).some((name) => EXE_DEFAULT_SDKS.has(name));
const readIsExe = (csprojPath) => {
	let xml;
	try {
		xml = fs.readFileSync(csprojPath, "utf-8");
	} catch {
		return false;
	}
	const outputTypeMatch = OUTPUT_TYPE_RE.exec(xml);
	if (outputTypeMatch !== null) return EXE_OUTPUT_TYPES.has(outputTypeMatch[1].trim().toLowerCase());
	const sdkMatch = PROJECT_SDK_RE.exec(xml);
	if (sdkMatch === null) return false;
	return sdkDefaultsToExe(sdkMatch[1]);
};
const buildOutputTypeResolver = (rootDirectory) => {
	const projects = findCsprojFiles(rootDirectory).map((csprojPath) => ({
		directory: path.dirname(path.resolve(csprojPath)),
		isExe: readIsExe(csprojPath)
	}));
	const isExeProject = (csFileAbsolutePath) => {
		const fileDir = path.resolve(csFileAbsolutePath);
		let best = null;
		for (const project of projects) {
			const withSep = project.directory.endsWith(path.sep) ? project.directory : project.directory + path.sep;
			if (fileDir === project.directory || fileDir.startsWith(withSep)) {
				if (best === null || project.directory.length > best.directory.length) best = project;
			}
		}
		return best?.isExe ?? false;
	};
	return { isExeProject };
};
//#endregion
//#region src/engines/ai-slop/csharp-shared.ts
const LINE_COMMENT_RE = /^\s*\/\//;
const CATCH_ONLY_THROW_RE = /\bcatch\b\s*(?:\([^)]*\))?\s*\{\s*throw\s*;\s*\}/;
const pushFinding$1 = (out, relPath, rule, lineIndex, message, help) => {
	out.push({
		filePath: relPath,
		engine: "ai-slop",
		rule,
		severity: "warning",
		message,
		help,
		line: lineIndex + 1,
		column: 1,
		category: "AI Slop",
		fixable: false
	});
};
const buildCatchWindow = (lines, i) => lines.slice(i, i + 5).join(" ").replace(/\s+/g, " ");
const scanLineMatches = (lines, relPath, out, regex, rule, message, help, accept) => {
	for (let i = 0; i < lines.length; i++) {
		if (LINE_COMMENT_RE.test(lines[i])) continue;
		const match = regex.exec(lines[i]);
		if (!match) continue;
		if (accept && !accept(match, i)) continue;
		pushFinding$1(out, relPath, rule, i, message, help);
	}
};
//#endregion
//#region src/engines/ai-slop/csharp-idioms.ts
const IF_LADDER_THRESHOLD = 4;
const BROAD_CATCH_RE = /\bcatch\s*\(\s*(?:System\.)?Exception\b/;
const CATCH_WHEN_FILTER_RE = /\bwhen\b/;
const BROAD_CATCH_EMPTY_RE = /\bcatch\b\s*\(\s*(?:System\.)?Exception\b[^)]*\)\s*\{\s*\}/;
const BROAD_CATCH_VAR_RE = /\bcatch\s*\(\s*(?:System\.)?Exception\s+([A-Za-z_]\w*)\s*\)/;
const CATCH_BODY_OPEN_RE = /\bcatch\s*\([^)]*\)\s*\{/;
const extractBlockBody = (content, openBraceIndex) => {
	let depth = 0;
	for (let i = openBraceIndex; i < content.length; i++) {
		const character = content[i];
		if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth === 0) return content.slice(openBraceIndex + 1, i);
		}
	}
	return null;
};
const broadCatchSurfacesError = (lines, catchLineIndex) => {
	const variableMatch = BROAD_CATCH_VAR_RE.exec(lines[catchLineIndex]);
	if (!variableMatch) return false;
	const content = lines.slice(catchLineIndex).join("\n");
	const openMatch = CATCH_BODY_OPEN_RE.exec(content);
	if (!openMatch) return false;
	const openBraceIndex = openMatch.index + openMatch[0].length - 1;
	const body = extractBlockBody(content, openBraceIndex);
	if (body === null) return false;
	return new RegExp(`\\b${variableMatch[1]}\\b`).test(body);
};
const flagBroadCatch = (source, relPath, out) => {
	const lines = source.code;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().startsWith("//")) continue;
		if (!BROAD_CATCH_RE.test(lines[i])) continue;
		if (CATCH_WHEN_FILTER_RE.test(lines[i])) continue;
		const window = buildCatchWindow(lines, i);
		if (CATCH_ONLY_THROW_RE.test(window)) continue;
		if (BROAD_CATCH_EMPTY_RE.test(window)) continue;
		if (broadCatchSurfacesError(source.raw, i)) continue;
		pushFinding$1(out, relPath, "ai-slop/csharp-broad-catch", i, "`catch (Exception)` catches everything and drops the failure - the specific problems you didn't plan for vanish.", "Catch the specific exception type(s) you can handle and let the rest propagate. At a deliberate boundary, log the caught exception (or add a `when` filter) so the failure stays diagnosable instead of disappearing.");
	}
};
const LINQ_COUNT_RE = /\.Count\s*\(\s*\)\s*(?:==|!=|>=|<=|>|<)\s*\b[01]\b|\b[01]\b\s*(?:==|!=|>=|<=|>|<)\s*[A-Za-z_][\w.]*\.Count\s*\(\s*\)/;
const flagLinqCount = (lines, relPath, out) => {
	scanLineMatches(lines, relPath, out, LINQ_COUNT_RE, "ai-slop/csharp-linq-count", "`.Count()` compared to 0/1 walks the whole sequence just to ask whether any element exists.", "Use `.Any()` (or `!collection.Any()` for the empty check) instead of `.Count() > 0` / `.Count() == 0`.");
};
const INDEX_FOR_RE = /\bfor\s*\(\s*(?:int|long|uint|nint|var)\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*[A-Za-z_][\w.]*\.(?:Length|Count)\b[^;]*;\s*\1\s*(?:\+\+|\+=\s*1)/;
const extractLoopBody = (lines, forLineIndex) => {
	const content = lines.slice(forLineIndex).join("\n");
	const forIndex = content.search(/\bfor\s*\(/);
	if (forIndex === -1) return null;
	let depth = 0;
	let i = content.indexOf("(", forIndex);
	for (; i < content.length; i++) if (content[i] === "(") depth += 1;
	else if (content[i] === ")") {
		depth -= 1;
		if (depth === 0) {
			i += 1;
			break;
		}
	}
	while (i < content.length && /\s/.test(content[i])) i += 1;
	if (content[i] === "{") return extractBlockBody(content, i);
	const semicolon = content.indexOf(";", i);
	return semicolon === -1 ? content.slice(i) : content.slice(i, semicolon + 1);
};
const indexUsedOnlyForElementAccess = (lines, forLineIndex, indexName) => {
	const body = extractLoopBody(lines, forLineIndex);
	if (body === null) return true;
	const withoutSubscripts = body.replace(new RegExp(`\\[\\s*${indexName}\\s*\\]`, "g"), "");
	return !new RegExp(`\\b${indexName}\\b`).test(withoutSubscripts);
};
const flagIndexLoop = (lines, relPath, out) => {
	scanLineMatches(lines, relPath, out, INDEX_FOR_RE, "ai-slop/csharp-index-loop", "Index `for` loop over `.Length`/`.Count` is usually clearer as `foreach`.", "Use `foreach (var item in collection)` when you don't need the index. If the index itself is used, ignore this.", (match, i) => indexUsedOnlyForElementAccess(lines, i, match[1]));
};
const IF_LADDER_BRANCH_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*==\s*(?:"[^"]*"|'[^']*'|[\w.]+)\s*\)/;
const ELSE_IF_RE = /\belse\s+if\b/;
const flagIfLadder = (lines, relPath, out) => {
	let chainVariable = null;
	let count = 0;
	let startLine = 0;
	const finalize = () => {
		if (chainVariable !== null && count >= IF_LADDER_THRESHOLD) pushFinding$1(out, relPath, "ai-slop/csharp-if-ladder", startLine, `${count} repeated if/else-if branches dispatch on \`${chainVariable}\`.`, "Use a `switch` (or a lookup/handler map) when each branch compares the same value against a constant.");
		chainVariable = null;
		count = 0;
	};
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().startsWith("//")) continue;
		const match = IF_LADDER_BRANCH_RE.exec(lines[i]);
		if (!match) continue;
		const variable = match[1];
		if (ELSE_IF_RE.test(lines[i]) && chainVariable === variable) {
			count++;
			continue;
		}
		finalize();
		chainVariable = variable;
		count = 1;
		startLine = i;
	}
	finalize();
};
const LOOP_HEADER_RE = /\b(?:for|foreach|while)\s*\(|\bdo\b/;
const STRING_CONCAT_RE = /(\w+)\s*\+=\s*[^;]*"/;
const flagStringConcatInLoop = (source, relPath, out) => {
	let braceDepth = 0;
	const loopBodyDepths = [];
	let pendingLoop = false;
	for (let i = 0; i < source.code.length; i++) {
		const code = source.code[i];
		if (loopBodyDepths.length > 0) {
			const match = STRING_CONCAT_RE.exec(code);
			if (match) pushFinding$1(out, relPath, "ai-slop/csharp-string-concat-in-loop", i, `\`${match[1]} += ...\` inside a loop reallocates the whole string each iteration (O(n^2)).`, "Build the result with a `StringBuilder` (append in the loop, `.ToString()` after) instead of `+=` concatenation.");
		}
		if (LOOP_HEADER_RE.test(code)) pendingLoop = true;
		let openedBrace = false;
		for (const char of code) if (char === "{") {
			braceDepth++;
			openedBrace = true;
			if (pendingLoop) {
				loopBodyDepths.push(braceDepth);
				pendingLoop = false;
			}
		} else if (char === "}") {
			const idx = loopBodyDepths.indexOf(braceDepth);
			if (idx !== -1) loopBodyDepths.splice(idx, 1);
			if (braceDepth > 0) braceDepth--;
		}
		if (pendingLoop && !openedBrace && code.includes(";")) pendingLoop = false;
	}
};
//#endregion
//#region src/engines/ai-slop/csharp-patterns.ts
const CSHARP_EXTENSIONS = /* @__PURE__ */ new Set([".cs"]);
const NOT_IMPLEMENTED_RE = /\bthrow\s+new\s+NotImplementedException\s*\(/;
const ASYNC_VOID_RE = /\basync\s+void\s+(\w+)\s*\(/;
const EVENT_HANDLER_NAME_RE = /^(?:On[A-Z]|.*Handler$|.*_\w+$)/;
const EVENT_ARGS_RE = /\bEventArgs\b/;
const SYNC_OVER_ASYNC_RE = /\.(?:Result\b|Wait\s*\(\s*\)|GetAwaiter\s*\(\s*\)\s*\.\s*GetResult\s*\(\s*\))/;
const SYNC_INTENT_LOOKBACK = 2;
const TRIVIAL_SUMMARY_RE = /^(?:gets?(?:\s+or\s+sets?)?|sets?|the|a|an)\b[\w\s]*\.?$/i;
const EXPLANATORY_KEYWORDS_RE = /\b(?:because|since|so that|note|todo|fixme|hack|warn|caveat|important|assumes?|e\.g\.|i\.e\.|when|unless|must|avoid)\b/i;
const SUMMARY_INLINE_RE = /<summary>\s*(.*?)\s*<\/summary>/i;
const hasIntentComment$2 = (lines, lineIndex) => {
	for (let j = lineIndex - 1; j >= Math.max(0, lineIndex - SYNC_INTENT_LOOKBACK); j--) if (LINE_COMMENT_RE.test(lines[j])) return true;
	return false;
};
const inlineSummaryText = (line) => {
	const trimmed = line.trim();
	if (!trimmed.startsWith("///")) return null;
	const match = SUMMARY_INLINE_RE.exec(trimmed);
	return match ? match[1].trim() : null;
};
const flagRedundantDoc = (lines, relPath, out) => {
	for (let i = 0; i < lines.length; i++) {
		const summary = inlineSummaryText(lines[i]);
		if (summary === null || summary.length === 0) continue;
		if (EXPLANATORY_KEYWORDS_RE.test(summary)) continue;
		if (!TRIVIAL_SUMMARY_RE.test(summary)) continue;
		pushFinding$1(out, relPath, "ai-slop/csharp-redundant-doc-comment", i, "XML-doc summary restates the member name without adding information.", "Delete the doc comment, or replace boilerplate (\"Gets or sets the X\") with the *why*: constraints, units, invariants a reader can't infer from the signature.");
	}
};
const PRAGMA_DISABLE_RE = /#pragma\s+warning\s+disable\b/;
const PRAGMA_RESTORE_RE = /#pragma\s+warning\s+restore\b/;
const SUPPRESS_MESSAGE_RE = /\bSuppressMessage\s*\(/;
const JUSTIFICATION_RE = /Justification\s*=\s*"([^"]*)"/i;
const PLACEHOLDER_JUSTIFICATION_RE = /^(?:<pending>|pending|todo|)$/i;
const hasTrailingComment = (line) => line.includes("//");
const precededByComment = (lines, lineIndex) => {
	for (let j = lineIndex - 1; j >= 0; j--) {
		const trimmed = lines[j].trim();
		if (trimmed === "") continue;
		return trimmed.startsWith("//");
	}
	return false;
};
const flagSuppressedWarnings = (source, relPath, out) => {
	for (let i = 0; i < source.code.length; i++) {
		const line = source.code[i];
		const rawLine = source.raw[i];
		if (line.trim().startsWith("//")) continue;
		if (PRAGMA_DISABLE_RE.test(line) && !PRAGMA_RESTORE_RE.test(line)) {
			if (hasTrailingComment(rawLine) || precededByComment(source.raw, i)) continue;
			pushFinding$1(out, relPath, "ai-slop/csharp-suppressed-warning", i, "`#pragma warning disable` suppresses the warning without saying why.", "Fix the underlying warning. If suppression is genuinely justified, add a `//` comment naming the reason (and prefer a scoped disable/restore over a file-wide one).");
			continue;
		}
		if (SUPPRESS_MESSAGE_RE.test(line)) {
			const match = JUSTIFICATION_RE.exec(rawLine);
			if (match !== null && !PLACEHOLDER_JUSTIFICATION_RE.test(match[1].trim())) continue;
			pushFinding$1(out, relPath, "ai-slop/csharp-suppressed-warning", i, "`[SuppressMessage]` has no real Justification - it hides the analyzer finding.", "Fix the underlying issue, or fill Justification with the actual reason the suppression is safe (not the `<Pending>` placeholder).");
		}
	}
};
const flagEmptyCatchRethrow = (lines, relPath, out) => {
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim().startsWith("//")) continue;
		if (!/\bcatch\b/.test(lines[i])) continue;
		const window = buildCatchWindow(lines, i);
		if (!CATCH_ONLY_THROW_RE.test(window)) continue;
		pushFinding$1(out, relPath, "ai-slop/csharp-empty-catch-rethrow", i, "`catch (...) { throw; }` catches and immediately rethrows - it does nothing but add noise.", "Remove the try/catch if you're not handling the exception; use `finally` for cleanup, or `throw new ...(..., ex)` to add context.");
	}
};
const NULL_FORGIVING_RE = /[\w)\]]!(?=[\s.;,)\]}]|$)/;
const flagNullForgiving = (lines, relPath, out) => {
	scanLineMatches(lines, relPath, out, NULL_FORGIVING_RE, "ai-slop/csharp-null-forgiving", "The null-forgiving `!` silences the nullable warning without proving the value is non-null.", "Handle the null case (guard, `??`, or throw with context) instead of asserting non-null. Use `!` only when non-null is provable, and say why.");
};
const DEBUG_TRACE_RE = /\b(?:Debug|Trace)\.(?:Write|WriteLine|WriteIf|WriteLineIf)\s*\(/;
const CONSOLE_OUT_RE = /\bConsole\.(?:Write|WriteLine)\s*\(/;
const CONSOLE_ERROR_RE = /\bConsole\.Error\b/;
const WORKER_MARKER_RE = /^\s*\/\/\s*aislop-worker\b/;
const isWorkerFile = (lines) => lines.some((line) => WORKER_MARKER_RE.test(line));
const flagConsoleLeftover = (input, out) => {
	const { source, relPath, absolutePath, outputTypes } = input;
	if (isNonProductionPath(relPath)) return;
	scanLineMatches(source.code, relPath, out, DEBUG_TRACE_RE, "ai-slop/csharp-console-leftover", "Debug/Trace output left in shipped code is usually a leftover.", "Remove the diagnostic write, or route it through the project's logger.");
	if (outputTypes.isExeProject(absolutePath)) return;
	if (isWorkerFile(source.raw)) return;
	scanLineMatches(source.code, relPath, out, CONSOLE_OUT_RE, "ai-slop/csharp-console-leftover", "`Console.Write*` in a library writes to stdout - almost always a leftover.", "Remove it or route through the project's logger. (In a console app, or a file marked `// aislop-worker`, this rule doesn't fire.)", (_match, i) => !CONSOLE_ERROR_RE.test(source.code[i]));
};
const detectCSharpPatterns = async (context) => {
	const diagnostics = [];
	const files = getSourceFiles(context);
	const outputTypes = buildOutputTypeResolver(context.rootDirectory);
	for (const filePath of files) {
		if (!CSHARP_EXTENSIONS.has(path.extname(filePath))) continue;
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relPath = relativePosix(context.rootDirectory, filePath);
		const source = {
			code: maskStringsAndComments$1(content, ".cs").split("\n"),
			raw: content.split("\n")
		};
		scanLineMatches(source.code, relPath, diagnostics, NOT_IMPLEMENTED_RE, "ai-slop/csharp-not-implemented", "`throw new NotImplementedException()` is almost certainly a stub the agent forgot to fill in.", "Implement the method, or if the work is genuinely deferred, file a ticket and reference it in a comment so it doesn't ship invisibly.");
		scanLineMatches(source.code, relPath, diagnostics, ASYNC_VOID_RE, "ai-slop/csharp-async-void", "`async void` can't be awaited and its exceptions crash the process. Use `async Task` unless this is an event handler.", "Return `Task` so callers can await and observe exceptions. If it must be `void` (event handler), name it accordingly and guarantee it can't throw.", (match, i) => !EVENT_HANDLER_NAME_RE.test(match[1]) && !EVENT_ARGS_RE.test(source.code[i]));
		scanLineMatches(source.code, relPath, diagnostics, SYNC_OVER_ASYNC_RE, "ai-slop/csharp-sync-over-async", "Blocking on a Task with `.Result`/`.Wait()`/`.GetAwaiter().GetResult()` risks deadlock and burns a thread.", "`await` the task instead. If you genuinely have a completed task and must block, add a short comment naming the invariant so this isn't read as accidental sync-over-async.", (_match, i) => !hasIntentComment$2(source.raw, i));
		flagRedundantDoc(source.raw, relPath, diagnostics);
		flagSuppressedWarnings(source, relPath, diagnostics);
		flagEmptyCatchRethrow(source.code, relPath, diagnostics);
		flagNullForgiving(source.code, relPath, diagnostics);
		flagConsoleLeftover({
			source,
			relPath,
			absolutePath: filePath,
			outputTypes
		}, diagnostics);
		flagBroadCatch(source, relPath, diagnostics);
		flagLinqCount(source.code, relPath, diagnostics);
		flagIndexLoop(source.code, relPath, diagnostics);
		flagIfLadder(source.code, relPath, diagnostics);
		flagStringConcatInLoop(source, relPath, diagnostics);
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/dead-pattern-diagnostic.ts
const slop = (filePath, line, rule, severity, message, help, fixable) => ({
	filePath,
	engine: "ai-slop",
	rule,
	severity,
	message,
	help,
	line,
	column: 0,
	category: "AI Slop",
	fixable
});
//#endregion
//#region src/engines/ai-slop/dead-pattern-languages.ts
const JS_EXTENSIONS$5 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
//#endregion
//#region src/engines/ai-slop/dead-pattern-console.ts
const CONSOLE_CALL_PATTERN = /\bconsole\.(log|debug|info|trace|dir|table)\s*\(/;
const LOGGER_FILE_PATTERN = /(?:^|\/)(?:logger|logging|log)\.[^/]+$/i;
const CLI_ENTRYPOINT_PATTERN = /(?:^|\/)(?:cli|cli[-_.][^/]*|[^/]+[-_]cli)\.[mc]?[jt]sx?$/i;
const ENTRYPOINT_GUARD_PATTERN = /\b(?:import\.meta\.main|require\.main\s*===\s*module)\b/;
const OPERATIONAL_LOG_PATTERN = /\bconsole\.(?:log|info)\s*\(\s*(?:`|["'])\s*\[[^\]\n]{1,48}\]/;
const DEBUG_SIGNAL_PATTERN = /\b(?:debug|dbg|trace|dump|inspect|todo|tmp|temp|remove\s+me|leftover|here|checkpoint)\b/i;
const shouldFlagConsoleCall = (trimmed) => {
	const match = CONSOLE_CALL_PATTERN.exec(trimmed);
	if (!match) return false;
	const method = match[1];
	if (method === "trace" || method === "dir" || method === "table") return true;
	if (method === "debug") return DEBUG_SIGNAL_PATTERN.test(trimmed) || !OPERATIONAL_LOG_PATTERN.test(trimmed);
	if (method === "info" || method === "log") {
		if (/console\.log\(\s*JSON\.stringify\b/.test(trimmed)) return false;
		if (OPERATIONAL_LOG_PATTERN.test(trimmed)) return false;
		return true;
	}
	return false;
};
const detectConsoleLeftovers = (content, relativePath, ext) => {
	if (!JS_EXTENSIONS$5.has(ext)) return [];
	if (LOGGER_FILE_PATTERN.test(relativePath)) return [];
	if (isNonProductionPath(relativePath) || CLI_ENTRYPOINT_PATTERN.test(relativePath)) return [];
	if (content.startsWith("#!")) return [];
	if (ENTRYPOINT_GUARD_PATTERN.test(content)) return [];
	const diagnostics = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
		if (shouldFlagConsoleCall(trimmed)) diagnostics.push(slop(relativePath, i + 1, "ai-slop/console-leftover", "warning", "console.log/debug/info statement left in production code", "Remove debugging console statements or replace with a proper logger", true));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/dead-pattern-unsafe.ts
const asAnyPattern = new RegExp(`\\bas\\s+any\\b`);
const doubleAssertPattern = new RegExp(`\\bas\\s+unknown\\s+as\\s+`);
const unsafeTypeDiagnostic = (filePath, line, finding) => slop(filePath, line, finding.rule, finding.severity, finding.message, finding.help, false);
const detectUnsafeTypePatterns = (content, relativePath, ext) => {
	if (ext !== ".ts" && ext !== ".tsx") return [];
	if (isNonProductionPath(relativePath)) return [];
	const diagnostics = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (/\/\/\s*@ts-(?:ignore|expect-error)/.test(trimmed) || /\/\*\s*@ts-(?:ignore|expect-error)/.test(trimmed)) diagnostics.push(unsafeTypeDiagnostic(relativePath, i + 1, {
			rule: "ai-slop/ts-directive",
			severity: "info",
			message: "@ts-ignore/@ts-expect-error suppresses type checking — review if still needed",
			help: "Fix the underlying type issue instead of suppressing the error"
		}));
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
		if (/\bRegExp\b|new\s+RegExp|\/.*\\b/.test(trimmed)) continue;
		if (/["'`].*\\b.*["'`]/.test(trimmed)) continue;
		if (asAnyPattern.test(trimmed)) diagnostics.push(unsafeTypeDiagnostic(relativePath, i + 1, {
			rule: "ai-slop/unsafe-type-assertion",
			severity: "warning",
			message: `'as any' bypasses type safety`,
			help: "Use a proper type or a more specific assertion"
		}));
		if (doubleAssertPattern.test(trimmed)) {
			if (!(/\.query[(<]/.test(trimmed) || /result\[0\]/.test(trimmed) || /rows\s/.test(trimmed))) diagnostics.push(unsafeTypeDiagnostic(relativePath, i + 1, {
				rule: "ai-slop/double-type-assertion",
				severity: "warning",
				message: `Double type assertion (as unknown as X) bypasses type checking`,
				help: "Refactor to avoid needing a double assertion. If this is an ORM query return, consider a typed wrapper function"
			}));
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/dead-patterns.ts
const BRACE_EXTENSIONS = /* @__PURE__ */ new Set([
	...JS_EXTENSIONS$5,
	".cs",
	...CPP_SOURCE_EXTENSIONS
]);
const PREPROCESSOR_EXTENSIONS = /* @__PURE__ */ new Set([".cs", ...CPP_SOURCE_EXTENSIONS]);
const PREPROCESSOR_DIRECTIVE_PATTERN = /^#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/;
const TODO_PATTERN = new RegExp(`\\b(?:${[
	"TODO",
	"FIXME",
	"HACK",
	"XXX"
].join("|")})\\b[:\\s]|\\b(?:${[
	"TEMP",
	"PLACEHOLDER",
	"STUB"
].join("|")})[:\\s]`);
const TODO_TRACKING_RE = /https?:\/\/|#\d+|\bgh-\d+\b|\b[A-Z][A-Z0-9]+-\d+\b|\b(?:issue|ticket|jira)\b|\bAGENT:(?:MOCK|STUB|HARDCODE|TEMP)\b/i;
const isBlockCloserAfterReturn = (line) => line.startsWith("}") || line.startsWith("};") || line.startsWith("),") || line.startsWith(");") || line.startsWith("],") || line.startsWith("]);");
const isPreprocessorAlternativeBranch = (nextLine, ext) => PREPROCESSOR_EXTENSIONS.has(ext) && PREPROCESSOR_DIRECTIVE_PATTERN.test(nextLine);
const BARE_ELSE_PATTERN = /^else\s*$/;
const isGuardedSingleLineExit = (lines, lineIndex) => {
	const contextLines = [];
	for (let i = lineIndex - 1; i >= 0 && contextLines.length < 16; i--) {
		const trimmed = lines[i].trim();
		if (!trimmed || trimmed.startsWith("//")) continue;
		if (BARE_ELSE_PATTERN.test(trimmed)) return true;
		contextLines.unshift(trimmed);
		if (/^(?:if|else\s+if|for|while|foreach)\b/.test(trimmed) || /^}\s*else\s+if\b/.test(trimmed)) break;
		if (/;\s*$/.test(trimmed)) break;
	}
	const control = contextLines.join(" ");
	return /(?:^|[}\s])(?:if|else\s+if|for|while|foreach)\s*\(/.test(control) && !/{\s*$/.test(control);
};
const isPropertyNoopAssignment = (trimmed) => /^(?:[\w$]+\.)+[\w$]+\s*=\s*(?:function\s*)?\([^)]*\)\s*(?:=>)?\s*\{\s*\}\s*;?$/.test(trimmed);
const detectTodoStubs = (content, relativePath) => {
	const diagnostics = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed.startsWith("//") && !trimmed.startsWith("#") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")) continue;
		if (TODO_PATTERN.test(trimmed)) {
			if (TODO_TRACKING_RE.test(trimmed)) continue;
			diagnostics.push(slop(relativePath, i + 1, "ai-slop/todo-stub", "info", "Unresolved TODO/stub comment without agent tracking", "Resolve the TODO or track it with '// AGENT:STUB [scope]: reason' or '// AGENT:MOCK [scope]: reason'", false));
		}
	}
	return diagnostics;
};
const UNMARKED_MOCK_PATTERN = /^\s*(?:export\s+)?(?:const|let|var)\s+((?:mock|dummy|fake|sample|stub|demo|placeholder)[A-Za-z0-9_]*|[A-Za-z0-9_]*(?:Mock|Dummy|Fake|Sample|Stub|Demo|Placeholder)|test(?:Data|Users?|Items?|List|Payload|Tasks?))\b\s*[:=]/;
const detectUnmarkedMocks = (content, relativePath) => {
	if (isNonProductionPath(relativePath)) return [];
	const diagnostics = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
		if (UNMARKED_MOCK_PATTERN.test(line)) {
			const prevLine = i > 0 ? lines[i - 1].trim() : "";
			if (!line.includes("AGENT:MOCK") && !prevLine.includes("AGENT:MOCK")) diagnostics.push(slop(relativePath, i + 1, "ai-slop/unmarked-debt", "info", "Unmarked mock data variable in production source code", "Tag with '// AGENT:MOCK [scope]: reason -> real_service' or connect real service", false));
		}
	}
	return diagnostics;
};
const detectDeadCodePatterns = (content, relativePath, ext) => {
	const diagnostics = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const nextLine = i + 1 < lines.length ? lines[i + 1]?.trim() : void 0;
		if (BRACE_EXTENSIONS.has(ext) && /^(?:return|throw)\b/.test(trimmed) && trimmed.endsWith(";") && nextLine && nextLine.length > 0 && !isGuardedSingleLineExit(lines, i) && !isBlockCloserAfterReturn(nextLine) && !isPreprocessorAlternativeBranch(nextLine, ext) && !nextLine.startsWith("//") && !nextLine.startsWith("/*") && !nextLine.startsWith("case ") && !nextLine.startsWith("default:") && !nextLine.startsWith("if ") && !nextLine.startsWith("if(") && !nextLine.startsWith("else")) diagnostics.push(slop(relativePath, i + 2, "ai-slop/unreachable-code", "warning", "Code after return/throw statement is unreachable", "Remove the unreachable code or restructure the control flow", false));
		if (/\bif\s*\(\s*(?:false|true|0|1)\s*\)/.test(trimmed) && !trimmed.startsWith("//") && !trimmed.startsWith("*") && !/["'`].*\bif\s*\(/.test(trimmed) && !/\/.*\bif\s*\(/.test(trimmed.replace(/\/\/.*$/, ""))) diagnostics.push(slop(relativePath, i + 1, "ai-slop/constant-condition", "warning", "Conditional with a constant value — likely debugging leftover", "Remove the constant condition or replace with proper logic", false));
		if (JS_EXTENSIONS$5.has(ext) && /(?:function\s+\w+\s*\([^)]*\)|=>\s*)\s*\{\s*\}\s*;?\s*$/.test(trimmed) && !trimmed.startsWith("interface") && !trimmed.startsWith("type ") && !isPropertyNoopAssignment(trimmed)) diagnostics.push(slop(relativePath, i + 1, "ai-slop/empty-function", "info", "Empty function body — possible stub or unfinished implementation", "Implement the function body or add a comment explaining why it's empty", false));
	}
	return diagnostics;
};
const detectDeadPatterns = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const ext = path.extname(filePath);
		const relativePath = relativePosix(context.rootDirectory, filePath);
		const codeOnly = maskComments(content, ext);
		diagnostics.push(...detectConsoleLeftovers(codeOnly, relativePath, ext));
		diagnostics.push(...detectTodoStubs(content, relativePath));
		diagnostics.push(...detectDeadCodePatterns(codeOnly, relativePath, ext));
		diagnostics.push(...detectUnsafeTypePatterns(content, relativePath, ext));
		diagnostics.push(...detectUnmarkedMocks(content, relativePath));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/defensive-patterns.ts
const JS_TS_EXTENSIONS$1 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const TS_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".tsx"]);
const COERCION_CTORS = {
	string: "String",
	number: "Number",
	boolean: "Boolean"
};
const scriptKindFor$1 = (ext) => {
	switch (ext) {
		case ".tsx": return ts.ScriptKind.TSX;
		case ".jsx": return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs": return ts.ScriptKind.JS;
		default: return ts.ScriptKind.TS;
	}
};
const lineFor$1 = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
const makeDiagnostic = (filePath, line, rule, message, help) => ({
	filePath,
	engine: "ai-slop",
	rule,
	severity: "warning",
	message,
	help,
	line,
	column: 0,
	category: "AI Slop",
	fixable: false
});
const isFunctionNode = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
const primitiveKindOf = (node) => {
	if (!node) return null;
	switch (node.kind) {
		case ts.SyntaxKind.StringKeyword: return "string";
		case ts.SyntaxKind.NumberKeyword: return "number";
		case ts.SyntaxKind.BooleanKeyword: return "boolean";
		default: return null;
	}
};
const hasExportModifier = (node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
const primitiveParamsOf = (node) => {
	const params = /* @__PURE__ */ new Map();
	for (const param of node.parameters) {
		if (!ts.isIdentifier(param.name)) continue;
		const kind = primitiveKindOf(param.type);
		if (!kind) continue;
		params.set(param.name.text, kind);
	}
	return params;
};
const isRethrowStatement = (statement, errorName) => ts.isThrowStatement(statement) && statement.expression !== void 0 && ts.isIdentifier(statement.expression) && statement.expression.text === errorName;
const isPromiseRejectRethrow = (statement, errorName) => {
	if (!ts.isReturnStatement(statement) || !statement.expression) return false;
	const expression = statement.expression;
	if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) return false;
	const [arg] = expression.arguments;
	if (!ts.isIdentifier(arg) || arg.text !== errorName) return false;
	if (!ts.isPropertyAccessExpression(expression.expression)) return false;
	const target = expression.expression;
	return ts.isIdentifier(target.expression) && target.expression.text === "Promise" && target.name.text === "reject";
};
const detectRedundantTryCatch = (sourceFile, relativePath) => {
	const diagnostics = [];
	const visit = (node) => {
		if (ts.isTryStatement(node) && node.catchClause && !node.finallyBlock) {
			const catchNameNode = node.catchClause.variableDeclaration?.name;
			const [onlyStatement] = node.catchClause.block.statements;
			if (catchNameNode && ts.isIdentifier(catchNameNode) && node.catchClause.block.statements.length === 1 && onlyStatement && (isRethrowStatement(onlyStatement, catchNameNode.text) || isPromiseRejectRethrow(onlyStatement, catchNameNode.text))) diagnostics.push(makeDiagnostic(relativePath, lineFor$1(sourceFile, node.catchClause), "ai-slop/redundant-try-catch", "Catch block only rethrows the same error", "Remove the try/catch or add useful context, cleanup, or recovery. Rethrowing unchanged errors is usually defensive agent noise."));
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return diagnostics;
};
const detectPrimitiveCoercions = (sourceFile, relativePath) => {
	const diagnostics = [];
	const scanFunctionBody = (node, params) => {
		const body = node.body;
		if (!body || params.size === 0) return;
		const visitBody = (child) => {
			if (child !== body && isFunctionNode(child)) return;
			if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
				const [arg] = child.arguments;
				if (arg && ts.isIdentifier(arg)) {
					const primitive = params.get(arg.text);
					if (primitive && child.expression.text === COERCION_CTORS[primitive]) diagnostics.push(makeDiagnostic(relativePath, lineFor$1(sourceFile, child), "ai-slop/redundant-type-coercion", `Parameter '${arg.text}' is already typed as ${primitive} but is coerced again`, "Trust the typed boundary or validate unknown input before this function. Re-coercing already typed parameters is usually defensive agent noise."));
				}
			}
			ts.forEachChild(child, visitBody);
		};
		visitBody(body);
	};
	const visit = (node) => {
		if (isFunctionNode(node)) scanFunctionBody(node, primitiveParamsOf(node));
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return diagnostics;
};
const normalizedTypeDeclaration = (sourceFile, node) => sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()).replace(/\bexport\b/g, "").replace(/\bdeclare\b/g, "").replace(/\s+/g, " ").trim();
const exportedTypesOf = (parsed) => {
	const declarations = [];
	const visit = (node) => {
		if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && hasExportModifier(node)) declarations.push({
			name: node.name.text,
			signature: normalizedTypeDeclaration(parsed.sourceFile, node),
			filePath: parsed.relativePath,
			line: lineFor$1(parsed.sourceFile, node)
		});
		ts.forEachChild(node, visit);
	};
	visit(parsed.sourceFile);
	return declarations;
};
const duplicateTypeKeyOf = (declaration) => `${declaration.name}\0${declaration.signature}`;
const detectDuplicateExportedTypes = (parsedSources) => {
	const diagnostics = [];
	const seen = /* @__PURE__ */ new Map();
	for (const parsed of parsedSources) {
		if (!TS_EXTENSIONS.has(parsed.ext)) continue;
		for (const declaration of exportedTypesOf(parsed)) {
			const key = duplicateTypeKeyOf(declaration);
			const previous = seen.get(key);
			if (!previous) {
				seen.set(key, declaration);
				continue;
			}
			if (previous.filePath === declaration.filePath) continue;
			diagnostics.push(makeDiagnostic(declaration.filePath, declaration.line, "ai-slop/duplicate-type-declaration", `Exported type '${declaration.name}' duplicates an existing declaration`, `Reuse or import the existing type from ${previous.filePath} instead of re-declaring the same shape in another file.`));
		}
	}
	return diagnostics;
};
const detectDefensivePatterns = async (context) => {
	const diagnostics = [];
	const parsedSources = [];
	for (const filePath of getSourceFiles(context)) {
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relativePath = relativePosix(context.rootDirectory, filePath);
		if (isNonProductionPath(relativePath)) continue;
		const ext = path.extname(filePath);
		if (!JS_TS_EXTENSIONS$1.has(ext)) continue;
		const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKindFor$1(ext));
		parsedSources.push({
			sourceFile,
			relativePath,
			ext
		});
		diagnostics.push(...detectRedundantTryCatch(sourceFile, relativePath));
		if (TS_EXTENSIONS.has(ext)) diagnostics.push(...detectPrimitiveCoercions(sourceFile, relativePath));
	}
	diagnostics.push(...detectDuplicateExportedTypes(parsedSources));
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/duplicate-imports.ts
const JS_EXTENSIONS$4 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const IMPORT_FROM_RE$1 = /^\s*import\s+([^;]*?)\s+from\s+["']([^"']+)["']/;
const TYPE_ONLY_RE = /^\s*type\b/;
const VALUE_BINDING_RE = /\{([^}]*)\}/;
const NAMESPACE_RE = /\*\s+as\s+/;
const isTypeOnly = (clause) => {
	if (TYPE_ONLY_RE.test(clause)) return true;
	const braces = VALUE_BINDING_RE.exec(clause);
	if (!braces) return false;
	const members = braces[1].split(",").map((member) => member.trim()).filter((member) => member.length > 0);
	return members.length > 0 && members.every((member) => /^type\b/.test(member));
};
const extractImportLines = (content) => {
	const lines = content.split("\n");
	const results = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = IMPORT_FROM_RE$1.exec(line);
		if (!match) continue;
		results.push({
			spec: match[2],
			line: i + 1,
			typeOnly: isTypeOnly(match[1]),
			namespace: NAMESPACE_RE.test(match[1])
		});
	}
	return results;
};
const detectDuplicateImports = async (context) => {
	const diagnostics = [];
	const files = getSourceFiles(context);
	for (const filePath of files) {
		if (!JS_EXTENSIONS$4.has(path.extname(filePath))) continue;
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const imports = extractImportLines(maskComments(content, path.extname(filePath)));
		if (imports.length < 2) continue;
		const byBucket = /* @__PURE__ */ new Map();
		for (const imp of imports) {
			const key = `${imp.namespace ? "ns" : imp.typeOnly ? "type" : "value"}\0${imp.spec}`;
			const list = byBucket.get(key) ?? [];
			list.push(imp);
			byBucket.set(key, list);
		}
		const relPath = relativePosix(context.rootDirectory, filePath);
		for (const occurrences of byBucket.values()) {
			const { spec } = occurrences[0];
			if (occurrences.length < 2) continue;
			for (const dup of occurrences.slice(1)) {
				const firstLine = occurrences[0].line;
				diagnostics.push({
					filePath: relPath,
					engine: "ai-slop",
					rule: "ai-slop/duplicate-import",
					severity: "warning",
					message: `"${spec}" is also imported on line ${firstLine}. Merge into a single import statement.`,
					help: "Two imports from the same module split readers' attention and grow the import block. Run aislop fix to merge them automatically.",
					line: dup.line,
					column: 1,
					category: "AI Slop",
					fixable: true
				});
			}
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/exceptions.ts
const SWALLOWED_EXCEPTION_PATTERNS = [
	{
		pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*)?\s*\}/,
		languages: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		message: "Empty catch block swallows errors silently"
	},
	{
		pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*console\.log\([^)]*\);\s*\}/,
		languages: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		message: "Catch block only logs error without proper handling"
	},
	{
		pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\w+\s*=\s*(?:false|true|null|undefined|\d+|""|''))\s*;?\s*)+\}/,
		languages: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		message: "Catch block swallows error silently by only setting a flag"
	},
	{
		pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*return\s+(?:null|false|true|undefined|\[\s*\]|\{\s*\}|""|'');?\s*\}/,
		languages: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		message: "Catch block swallows error silently by returning a fallback default value"
	},
	{
		pattern: /\.catch\s*\(\s*(?:function\s*\([^)]*\)|\(?\s*[\w$]*\s*\)?\s*=>)\s*\{\s*(?:\/\/[^\n]*)?\s*\}\s*\)/,
		languages: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		message: "Promise .catch() swallows rejection silently with empty handler"
	},
	{
		pattern: /\.catch\s*\(\s*(?:function\s*\([^)]*\)\s*\{\s*return|\(?\s*[\w$]*\s*\)?\s*=>\s*(?:\{\s*return)?)\s+(?:null|false|true|undefined|\[\s*\]|\{\s*\}|""|'');?\s*\}?\s*\)/,
		languages: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		message: "Promise .catch() swallows rejection silently by returning a fallback default value"
	},
	{
		pattern: /except(?:\s+\w+)?:\s*\n\s*pass/,
		languages: [".py"],
		message: "Bare except with pass swallows errors silently"
	},
	{
		pattern: /\w+,\s*_\s*:?=\s*\w+\(/,
		languages: [".go"],
		message: "Error return value is being ignored"
	},
	{
		pattern: /rescue(?:\s+\w+)?\s*(?:=>?\s*\w+)?\s*\n\s*(?:nil|#)/,
		languages: [".rb"],
		message: "Rescue block swallows errors silently"
	},
	{
		pattern: /catch\s*\(\w+\s+\w+\)\s*\{\s*(?:\/\/[^\n]*)?\s*\}/,
		languages: [".java"],
		message: "Empty catch block swallows errors silently"
	},
	{
		pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
		languages: [".cs"],
		message: "Empty catch block swallows errors silently"
	},
	{
		pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
		languages: [
			".cpp",
			".cc",
			".cxx",
			".c",
			".h",
			".hh",
			".hpp",
			".hxx"
		],
		message: "Empty catch block swallows errors silently"
	}
];
const INTENTIONAL_IGNORE_NAMES = /* @__PURE__ */ new Set([
	"ignored",
	"ignore",
	"tolerated",
	"expected",
	"unused",
	"_",
	"_e",
	"_err",
	"_ex",
	"_t"
]);
const CATCH_PARAM_RE = /catch\s*\(\s*(?:\(?\s*(?:\w+\s+)?)([\w$]+)/;
const RESCUE_PARAM_RE = /rescue(?:\s+[\w:]+)?\s*=>\s*([\w$]+)/;
const PYTHON_EXCEPT_RE = /^([ \t]*)except\b[^:\n]*:\s*(?:#.*)?$/;
const isIntentionalIgnore = (matchText, ext) => {
	const m = (ext === ".rb" ? RESCUE_PARAM_RE : CATCH_PARAM_RE).exec(matchText);
	if (!m) return false;
	return INTENTIONAL_IGNORE_NAMES.has(m[1].toLowerCase());
};
const indentWidth = (line) => line.match(/^[ \t]*/)?.[0].length ?? 0;
const extractIndentedBlock = (lines, startLine, parentIndent) => {
	const body = [];
	for (let i = startLine + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().length === 0) {
			body.push(line);
			continue;
		}
		if (indentWidth(line) <= parentIndent) break;
		body.push(line);
	}
	return body;
};
const parenDelta = (line) => (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
const isPythonPrintOnlyBody = (body) => {
	let sawPrint = false;
	let inPrintCall = false;
	let printDepth = 0;
	for (const line of body) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		if (inPrintCall) {
			printDepth += parenDelta(trimmed);
			if (printDepth <= 0) inPrintCall = false;
			continue;
		}
		if (/^print\s*\(/.test(trimmed)) {
			sawPrint = true;
			printDepth = parenDelta(trimmed);
			inPrintCall = printDepth > 0;
			continue;
		}
		if (trimmed === "pass") continue;
		return false;
	}
	return sawPrint;
};
const detectPythonPrintOnlyExceptions = (content, relativePath) => {
	const diagnostics = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = PYTHON_EXCEPT_RE.exec(line);
		if (!match) continue;
		const body = extractIndentedBlock(lines, i, match[1].length);
		if (!isPythonPrintOnlyBody(body)) continue;
		diagnostics.push({
			filePath: relativePath,
			engine: "ai-slop",
			rule: "ai-slop/swallowed-exception",
			severity: "error",
			message: "Catch block only prints error without proper handling",
			help: "Handle errors explicitly: log with context, rethrow, or return an error value",
			line: i + 1,
			column: 0,
			category: "AI Slop",
			fixable: false
		});
	}
	return diagnostics;
};
const detectSwallowedExceptions = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const ext = path.extname(filePath);
		const relativePath = relativePosix(context.rootDirectory, filePath);
		if (ext === ".py") diagnostics.push(...detectPythonPrintOnlyExceptions(content, relativePath));
		for (const { pattern, languages, message } of SWALLOWED_EXCEPTION_PATTERNS) {
			if (!languages.includes(ext)) continue;
			const regex = new RegExp(pattern.source, pattern.flags + (pattern.flags.includes("g") ? "" : "g"));
			for (const match of content.matchAll(regex)) {
				if (isIntentionalIgnore(match[0], ext)) continue;
				const line = content.slice(0, match.index).split("\n").length;
				const lines = content.split("\n");
				let hasAgentTag = match[0].includes("AGENT:");
				for (let offset = 0; offset <= 5; offset++) {
					const l = line - 1 - offset;
					if (l >= 0 && lines[l]?.includes("AGENT:")) {
						hasAgentTag = true;
						break;
					}
				}
				if (hasAgentTag) continue;
				diagnostics.push({
					filePath: relativePath,
					engine: "ai-slop",
					rule: "ai-slop/swallowed-exception",
					severity: "error",
					message,
					help: "Handle errors explicitly: log with context, rethrow, or return an error value",
					line,
					column: 0,
					category: "AI Slop",
					fixable: false
				});
			}
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/go-patterns.ts
const GO_EXTENSIONS$1 = /* @__PURE__ */ new Set([".go"]);
const PACKAGE_DECL_RE = /^\s*package\s+(\w+)/;
const PANIC_CALL_RE = /\bpanic\s*\(/;
const COMMENT_LINE_RE$1 = /^\s*\/\//;
const NIL_GUARD_RE = /^\s*if\s+[\w.]+(?:\(\))?\s*==\s*nil\s*\{?\s*$/;
const SHORT_STRING_PANIC_RE = /\bpanic\s*\(\s*"[^"]{1,40}"\s*\)/;
const GO_TEST_SUPPORT_PATH_RE = /(?:^|\/)(?:testdata|testutil|testutils|tstest|ethtest|v4test|testing)(?:\/|$)/i;
const detectPackageName = (lines) => {
	for (const line of lines) {
		const m = PACKAGE_DECL_RE.exec(line);
		if (m) return m[1];
	}
	return null;
};
const PANIC_INTENT_LOOKBACK = 3;
const hasIntentComment$1 = (lines, panicLineIdx) => {
	for (let j = panicLineIdx - 1; j >= Math.max(0, panicLineIdx - PANIC_INTENT_LOOKBACK); j--) if (COMMENT_LINE_RE$1.test(lines[j])) return true;
	return false;
};
const isNilGuardPanic = (lines, panicLineIdx, line) => {
	if (!SHORT_STRING_PANIC_RE.test(line)) return false;
	for (let j = panicLineIdx - 1; j >= Math.max(0, panicLineIdx - 2); j--) {
		const prev = lines[j];
		if (prev.trim() === "") continue;
		return NIL_GUARD_RE.test(prev);
	}
	return false;
};
const flagLibraryPanic = (lines, relPath, pkg, out) => {
	if (pkg === "main") return;
	if (GO_TEST_SUPPORT_PATH_RE.test(relPath) || /test$/i.test(pkg)) return;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (COMMENT_LINE_RE$1.test(line)) continue;
		PANIC_CALL_RE.lastIndex = 0;
		if (!PANIC_CALL_RE.test(line)) continue;
		if (hasIntentComment$1(lines, i)) continue;
		if (isNilGuardPanic(lines, i, line)) continue;
		out.push({
			filePath: relPath,
			engine: "ai-slop",
			rule: "ai-slop/go-library-panic",
			severity: "warning",
			message: `\`panic()\` in package \`${pkg}\` (non-main, non-test). Library code should return errors, not unwind the goroutine.`,
			help: "Convert to `return fmt.Errorf(...)` (or a wrapped error) and let the caller decide. Reserve `panic` for genuinely-impossible states (corrupt internal invariants), and mark those with a comment so future readers know it's intentional.",
			line: i + 1,
			column: 1,
			category: "AI Slop",
			fixable: false
		});
	}
};
const detectGoPatterns = async (context) => {
	const diagnostics = [];
	const files = getSourceFiles(context);
	for (const filePath of files) {
		if (!GO_EXTENSIONS$1.has(path.extname(filePath))) continue;
		if (isAutoGenerated(filePath)) continue;
		if (filePath.endsWith("_test.go")) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		const pkg = detectPackageName(lines);
		if (!pkg) continue;
		const relPath = relativePosix(context.rootDirectory, filePath);
		flagLibraryPanic(lines, relPath, pkg, diagnostics);
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/js-workspaces.ts
const readJson$2 = (filePath, rootDirectory) => {
	try {
		const safePath = safeProjectFilePath(filePath, rootDirectory);
		return safePath ? JSON.parse(fs.readFileSync(safePath, "utf-8")) : null;
	} catch {
		return null;
	}
};
const readWorkspaceGlobs$1 = (rootDir, rootPkg) => {
	const globs = [];
	if (rootPkg && typeof rootPkg === "object") {
		const ws = rootPkg.workspaces;
		if (Array.isArray(ws)) {
			for (const g of ws) if (typeof g === "string") globs.push(g);
		} else if (ws && typeof ws === "object") {
			const pkgs = ws.packages;
			if (Array.isArray(pkgs)) {
				for (const g of pkgs) if (typeof g === "string") globs.push(g);
			}
		}
	}
	const lerna = readJson$2(path.join(rootDir, "lerna.json"), rootDir);
	if (lerna && Array.isArray(lerna.packages)) {
		for (const g of lerna.packages) if (typeof g === "string") globs.push(g);
	}
	try {
		const pnpmPath = safeProjectFilePath(path.join(rootDir, "pnpm-workspace.yaml"), rootDir);
		if (!pnpmPath) return globs;
		const pnpmWs = fs.readFileSync(pnpmPath, "utf-8");
		let inPackages = false;
		for (const rawLine of pnpmWs.split("\n")) {
			if (/^packages\s*:\s*$/.test(rawLine)) {
				inPackages = true;
				continue;
			}
			if (!inPackages) continue;
			if (/^\S/.test(rawLine)) break;
			const m = rawLine.match(/^\s*-\s*["']?([^"'\n]+?)["']?\s*$/);
			if (m) globs.push(m[1].trim());
		}
	} catch {
		return globs;
	}
	return globs;
};
const readWorkspaceEntries = (dir) => {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
};
const expandWorkspaceDirs = (rootDir, globs) => {
	const dirs = [];
	let rootDirectory;
	try {
		rootDirectory = fs.realpathSync(rootDir);
	} catch {
		return dirs;
	}
	for (const glob of globs) if (glob.endsWith("/*")) {
		const parent = safeProjectDirectoryPath(path.resolve(rootDirectory, glob.slice(0, -2)), rootDirectory);
		if (!parent) continue;
		for (const entry of readWorkspaceEntries(parent)) {
			if (!entry.isDirectory()) continue;
			const directory = safeProjectDirectoryPath(path.join(parent, entry.name), rootDirectory);
			if (directory) dirs.push(directory);
		}
	} else if (!glob.includes("*")) {
		const directory = safeProjectDirectoryPath(path.resolve(rootDirectory, glob), rootDirectory);
		if (directory) dirs.push(directory);
	}
	return dirs;
};
const collectWorkspaceDirs = (rootDir, rootPkg) => expandWorkspaceDirs(rootDir, readWorkspaceGlobs$1(rootDir, rootPkg));
//#endregion
//#region src/engines/ai-slop/python-dependency-parser.ts
const MAX_PYTHON_MANIFEST_BYTES = 1048576;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PYTHON_MANIFEST_FILES = [
	"pyproject.toml",
	"requirements.txt",
	"Pipfile"
];
const isWithinDirectory$2 = (directory, filePath) => {
	const relative = path.relative(directory, filePath);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const readPythonManifest = (filePath, boundaryDir) => {
	let descriptor = null;
	try {
		const realBoundary = fs.realpathSync(boundaryDir);
		const realFile = fs.realpathSync(filePath);
		if (!isWithinDirectory$2(realBoundary, realFile)) return null;
		descriptor = fs.openSync(realFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.size > MAX_PYTHON_MANIFEST_BYTES) return null;
		const content = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < content.length) {
			const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const overflow = Buffer.alloc(1);
		if (fs.readSync(descriptor, overflow, 0, 1, null) > 0) return null;
		return UTF8_DECODER.decode(content.subarray(0, offset));
	} catch {
		return null;
	} finally {
		if (descriptor !== null) fs.closeSync(descriptor);
	}
};
const readPyproject = (rootDir) => readPythonManifest(path.join(rootDir, "pyproject.toml"), rootDir);
const addPyDep = (pyDeps, name) => {
	const match = name.trim().match(/^([a-zA-Z0-9_.-]+)/);
	if (!match) return;
	const normalized = match[1].toLowerCase().replace(/_/g, "-");
	pyDeps.add(normalized);
};
const collectFromRequirementsTxt = (rootDir, pyDeps) => {
	const reqPath = path.join(rootDir, "requirements.txt");
	try {
		const content = readPythonManifest(reqPath, rootDir);
		if (content === null) return false;
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
			const match = trimmed.match(/^([a-zA-Z0-9_\-.]+)/);
			if (match) addPyDep(pyDeps, match[1]);
		}
		return true;
	} catch {
		return false;
	}
};
const TOML_HEADER_RE = /^\s*\[([^\]]+)\]\s*$/;
const readTomlSection = (content, sectionName) => {
	const lines = content.split(/\r?\n/);
	const sectionLines = [];
	let inSection = false;
	for (const line of lines) {
		const header = line.match(TOML_HEADER_RE);
		if (header) {
			if (inSection) break;
			inSection = header[1] === sectionName;
			continue;
		}
		if (inSection) sectionLines.push(line);
	}
	return sectionLines.join("\n");
};
const escapeRegExp$1 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const extractTomlArrayBody = (section, key) => {
	const match = new RegExp(`^\\s*${escapeRegExp$1(key)}\\s*=\\s*\\[`, "m").exec(section);
	if (!match) return null;
	const start = match.index + match[0].lastIndexOf("[") + 1;
	let depth = 1;
	let quote = null;
	let escaped = false;
	for (let i = start; i < section.length; i += 1) {
		const char = section[i];
		if (quote) {
			if (quote === "\"" && !escaped && char === "\\") {
				escaped = true;
				continue;
			}
			if (!escaped && char === quote) quote = null;
			escaped = false;
			continue;
		}
		if (char === "#") {
			const newline = section.indexOf("\n", i);
			if (newline === -1) return null;
			i = newline;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (char === "[") depth += 1;
		else if (char === "]") {
			depth -= 1;
			if (depth === 0) return section.slice(start, i);
		}
	}
	return null;
};
const extractTomlStrings = (source) => {
	const values = [];
	let quote = null;
	let escaped = false;
	let current = "";
	for (let i = 0; i < source.length; i += 1) {
		const char = source[i];
		if (!quote) {
			if (char === "#") {
				const newline = source.indexOf("\n", i);
				if (newline === -1) break;
				i = newline;
				continue;
			}
			if (char === "\"" || char === "'") {
				quote = char;
				current = "";
				escaped = false;
			}
			continue;
		}
		if (quote === "\"" && !escaped && char === "\\") {
			escaped = true;
			continue;
		}
		if (!escaped && char === quote) {
			values.push(current);
			quote = null;
			current = "";
			continue;
		}
		current += char;
		escaped = false;
	}
	return values;
};
const addTomlArrayDeps = (section, key, pyDeps) => {
	const body = extractTomlArrayBody(section, key);
	if (!body) return;
	for (const value of extractTomlStrings(body)) addPyDep(pyDeps, value);
};
const collectFromPyproject = (rootDir, pyDeps) => {
	try {
		const content = readPyproject(rootDir);
		if (content === null) return false;
		const projectSection = readTomlSection(content, "project");
		const projectNameMatch = projectSection.match(/^\s*name\s*=\s*["']([^"']+)/m);
		if (projectNameMatch) addPyDep(pyDeps, projectNameMatch[1]);
		const poetryNameMatch = readTomlSection(content, "tool.poetry").match(/^\s*name\s*=\s*["']([^"']+)/m);
		if (poetryNameMatch) addPyDep(pyDeps, poetryNameMatch[1]);
		addTomlArrayDeps(projectSection, "dependencies", pyDeps);
		const extras = readTomlSection(content, "project.optional-dependencies");
		if (extras) for (const value of extractTomlStrings(extras)) addPyDep(pyDeps, value);
		const groups = readTomlSection(content, "dependency-groups");
		if (groups) for (const value of extractTomlStrings(groups)) addPyDep(pyDeps, value);
		const poetryRe = /\[tool\.poetry(?:\.group\.[a-z0-9_-]+)?\.dependencies\]([\s\S]*?)(?=\n\[|$)/gi;
		let match = poetryRe.exec(content);
		while (match !== null) {
			for (const line of match[1].split("\n")) {
				const m = line.trim().match(/^([a-zA-Z0-9_\-.]+)\s*=/);
				if (m && m[1] !== "python") addPyDep(pyDeps, m[1]);
			}
			match = poetryRe.exec(content);
		}
		return true;
	} catch {
		return false;
	}
};
const collectFromPipfile = (rootDir, pyDeps) => {
	const pipfilePath = path.join(rootDir, "Pipfile");
	try {
		const content = readPythonManifest(pipfilePath, rootDir);
		if (content === null) return false;
		const sectionRe = /\[(packages|dev-packages)\]([\s\S]*?)(?=\n\[|$)/g;
		let match = sectionRe.exec(content);
		while (match !== null) {
			for (const line of match[2].split("\n")) {
				const m = line.trim().match(/^([a-zA-Z0-9_\-.]+)\s*=/);
				if (m) addPyDep(pyDeps, m[1]);
			}
			match = sectionRe.exec(content);
		}
		return true;
	} catch {
		return false;
	}
};
//#endregion
//#region src/engines/ai-slop/uv-workspace-definition.ts
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const PROJECT_VERSION_PATTERN = /^\s*v?(?:([0-9]+)!)?([0-9]+(?:\.[0-9]+)*)(?:[-_.]?(?:alpha|a|beta|b|preview|pre|c|rc)[-_.]?([0-9]*))?(?:(?:-([0-9]+))|(?:[-_.]?(?:post|rev|r)[-_.]?([0-9]*)))?(?:[-_.]?dev[-_.]?([0-9]*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;
const VERSION_WILDCARD_PATTERN = /^\s*v?(?:([0-9]+)!)?([0-9]+(?:\.[0-9]+)*)\.\*\s*$/i;
const MAX_U64 = "18446744073709551615";
const isTomlTable = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
const parsePyproject = (content) => {
	try {
		return parse$1(content);
	} catch {
		return null;
	}
};
const readStringArray = (value) => {
	if (value === void 0) return [];
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
	return value;
};
const isValidU64 = (value) => {
	const normalized = value.replace(/^0+/, "") || "0";
	return normalized.length < 20 || normalized.length === 20 && normalized <= MAX_U64;
};
const parseProjectVersion = (value) => {
	const match = PROJECT_VERSION_PATTERN.exec(value);
	if (!match) return null;
	const localParts = match[7]?.split(/[-_.]/) ?? [];
	if (![
		...match[1] ? [match[1]] : [],
		...match[2].split("."),
		...match.slice(3, 7).filter((part) => Boolean(part)),
		...localParts.filter((part) => /^[0-9]+$/.test(part))
	].every(isValidU64)) return null;
	return {
		hasLocal: localParts.length > 0,
		releaseSegments: match[2].split(".").length
	};
};
const isValidVersionSpecifier = (value) => {
	const match = value.match(/^\s*(===|~=|==|!=|<=|>=|<|>)\s*(\S+)\s*$/);
	if (!match) return false;
	const operator = match[1];
	const version = match[2];
	if (version.endsWith(".*")) {
		if (operator !== "==" && operator !== "!=") return false;
		const wildcard = VERSION_WILDCARD_PATTERN.exec(version);
		if (!wildcard) return false;
		return [...wildcard[1] ? [wildcard[1]] : [], ...wildcard[2].split(".")].every(isValidU64);
	}
	const parsed = parseProjectVersion(version);
	if (!parsed) return false;
	if ([
		"~=",
		"<",
		"<=",
		">",
		">="
	].includes(operator) && parsed.hasLocal) return false;
	return operator !== "~=" || parsed.releaseSegments >= 2;
};
const isValidVersionSpecifiers = (value) => value === "" || value.split(",").every(isValidVersionSpecifier);
const isValidOptionalDependencies = (value) => {
	if (value === void 0) return true;
	if (!isTomlTable(value)) return false;
	const names = /* @__PURE__ */ new Set();
	for (const [name, dependencies] of Object.entries(value)) {
		if (!PROJECT_NAME_PATTERN.test(name) || readStringArray(dependencies) === null) return false;
		const normalized = name.toLowerCase().replace(/[-_.]+/g, "-");
		if (names.has(normalized)) return false;
		names.add(normalized);
	}
	return true;
};
const hasValidProjectMetadata = (project) => {
	const dynamic = readStringArray(project.dynamic);
	if (!dynamic) return false;
	if (project.version === void 0 && !dynamic.includes("version")) return false;
	if (project.version !== void 0) {
		if (typeof project.version !== "string" || !parseProjectVersion(project.version)) return false;
	}
	const requiresPython = project["requires-python"];
	if (requiresPython !== void 0) {
		if (typeof requiresPython !== "string" || !isValidVersionSpecifiers(requiresPython)) return false;
	}
	return readStringArray(project.dependencies) !== null && isValidOptionalDependencies(project["optional-dependencies"]);
};
const readProjectName = (project) => {
	if (typeof project.name !== "string" || !PROJECT_NAME_PATTERN.test(project.name)) return null;
	return hasValidProjectMetadata(project) ? project.name : null;
};
const readUvWorkspaceDefinition = (rootDir) => {
	const content = readPyproject(rootDir);
	if (content === null) return { kind: "invalid" };
	const document = parsePyproject(content);
	if (!document) return { kind: "invalid" };
	const projectValue = document.project;
	if (projectValue !== void 0 && !isTomlTable(projectValue)) return { kind: "invalid" };
	const rootProjectName = isTomlTable(projectValue) ? readProjectName(projectValue) : null;
	if (isTomlTable(projectValue) && rootProjectName === null) return { kind: "invalid" };
	const toolValue = document.tool;
	if (toolValue === void 0) return { kind: "none" };
	if (!isTomlTable(toolValue)) return { kind: "invalid" };
	const uvValue = toolValue.uv;
	if (uvValue === void 0) return { kind: "none" };
	if (!isTomlTable(uvValue)) return { kind: "invalid" };
	if (uvValue.managed !== void 0 && typeof uvValue.managed !== "boolean") return { kind: "invalid" };
	if (uvValue.managed === false) return { kind: "unmanaged" };
	const workspaceValue = uvValue.workspace;
	if (workspaceValue === void 0) return { kind: "none" };
	if (!isTomlTable(workspaceValue)) return { kind: "invalid" };
	const members = readStringArray(workspaceValue.members);
	const exclude = readStringArray(workspaceValue.exclude);
	if (!members || !exclude) return { kind: "invalid" };
	return {
		kind: "workspace",
		members,
		exclude,
		rootProjectName
	};
};
const classifyUvWorkspaceMember = (directory) => {
	const pyprojectPath = path.join(directory, "pyproject.toml");
	if (!fs.existsSync(pyprojectPath)) return { kind: "missing" };
	const content = readPyproject(directory);
	if (content === null) return { kind: "invalid" };
	const document = parsePyproject(content);
	if (!document) return { kind: "invalid" };
	const toolValue = document.tool;
	if (toolValue !== void 0 && !isTomlTable(toolValue)) return { kind: "invalid" };
	const uvValue = isTomlTable(toolValue) ? toolValue.uv : void 0;
	if (uvValue !== void 0 && !isTomlTable(uvValue)) return { kind: "invalid" };
	if (isTomlTable(uvValue)) {
		if (uvValue.managed !== void 0 && typeof uvValue.managed !== "boolean") return { kind: "invalid" };
		if (uvValue.managed === false) return { kind: "unmanaged" };
		if (uvValue.workspace !== void 0) return { kind: "invalid" };
	}
	const projectValue = document.project;
	if (!isTomlTable(projectValue)) return { kind: "invalid" };
	const name = readProjectName(projectValue);
	return name === null ? { kind: "invalid" } : {
		kind: "member",
		name
	};
};
//#endregion
//#region src/engines/ai-slop/uv-workspace-glob.ts
const consumeMatchStep = (budget) => {
	if (budget.remainingSteps <= 0) return false;
	budget.remainingSteps -= 1;
	return true;
};
const readCharacterClass = (characters, start) => {
	const negated = characters[start + 1] === "!";
	const contentStart = start + (negated ? 2 : 1);
	let close = contentStart + 1;
	while (close < characters.length && characters[close] !== "]") close += 1;
	if (close === characters.length) return null;
	const ranges = [];
	for (let index = contentStart; index < close; index += 1) {
		const first = characters[index].codePointAt(0);
		if (first === void 0) return null;
		if (index + 2 < close && characters[index + 1] === "-") {
			const last = characters[index + 2].codePointAt(0);
			if (last === void 0) return null;
			ranges.push([first, last]);
			index += 2;
		} else ranges.push([first, first]);
	}
	return {
		next: close + 1,
		token: {
			kind: "character-class",
			negated,
			ranges
		}
	};
};
const compileUvGlob = (pattern) => {
	const characters = Array.from(pattern);
	const tokens = [];
	let isGlob = false;
	for (let index = 0; index < characters.length;) {
		const character = characters[index];
		if (character === "?") {
			tokens.push({ kind: "any-character" });
			isGlob = true;
			index += 1;
		} else if (character === "*") {
			if (characters[index + 1] === "*") {
				const beginsComponent = index === 0 || characters[index - 1] === "/";
				const after = characters[index + 2];
				if (!beginsComponent || after !== void 0 && after !== "/") return null;
				if (tokens.at(-1)?.kind !== "recursive-sequence") tokens.push({ kind: "recursive-sequence" });
				index += after === "/" ? 3 : 2;
			} else {
				tokens.push({ kind: "any-sequence" });
				index += 1;
			}
			isGlob = true;
		} else if (character === "[") {
			const characterClass = readCharacterClass(characters, index);
			if (!characterClass) return null;
			tokens.push(characterClass.token);
			isGlob = true;
			index = characterClass.next;
		} else {
			tokens.push({
				kind: "literal",
				value: character
			});
			index += 1;
		}
	}
	return {
		isGlob,
		tokens
	};
};
const characterClassMatches = (token, value) => {
	const codePoint = value.codePointAt(0);
	if (codePoint === void 0) return false;
	const included = token.ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
	return token.negated ? !included : included;
};
const closeEmptySequences = (tokens, states, followsSeparator, budget) => {
	const closed = new Set(states);
	for (const index of closed) {
		if (!consumeMatchStep(budget)) return null;
		const token = tokens[index];
		if (token?.kind === "any-sequence" || token?.kind === "recursive-sequence" && followsSeparator) closed.add(index + 1);
	}
	return closed;
};
const matchesUvGlob = (pattern, candidate, requireLiteralSeparator, budget) => {
	let states = closeEmptySequences(pattern.tokens, /* @__PURE__ */ new Set([0]), true, budget);
	if (!states) return null;
	for (const character of candidate) {
		const next = /* @__PURE__ */ new Set();
		for (const index of states) {
			if (!consumeMatchStep(budget)) return null;
			const token = pattern.tokens[index];
			const separatorBlocked = requireLiteralSeparator && character === "/";
			if (token?.kind === "literal" && token.value === character) next.add(index + 1);
			else if (token?.kind === "any-character" && !separatorBlocked) next.add(index + 1);
			else if (token?.kind === "character-class" && !separatorBlocked) {
				if (characterClassMatches(token, character)) next.add(index + 1);
			} else if (token?.kind === "any-sequence" && !separatorBlocked) next.add(index);
			else if (token?.kind === "recursive-sequence") next.add(index);
		}
		states = closeEmptySequences(pattern.tokens, next, character === "/", budget);
		if (!states) return null;
		if (states.size === 0) return false;
	}
	if (states.has(pattern.tokens.length)) return true;
	return [...states].some((index) => index === pattern.tokens.length - 1 && pattern.tokens[index]?.kind === "recursive-sequence");
};
//#endregion
//#region src/engines/ai-slop/uv-workspace-matchers.ts
const MAX_WORKSPACE_PATTERNS = 128;
const MAX_WORKSPACE_PATTERN_LENGTH = 512;
const MAX_WORKSPACE_PATTERN_CHARACTERS = 16384;
const normalizeWorkspacePattern = (pattern) => {
	const normalizedSeparators = path.sep === "\\" ? pattern.replaceAll("\\", "/") : pattern;
	if (!normalizedSeparators) return "";
	return path.posix.normalize(normalizedSeparators).replace(/\/$/, "");
};
const workspacePatternsWithinBudget = (patterns) => patterns.length <= MAX_WORKSPACE_PATTERNS && patterns.reduce((total, pattern) => total + pattern.length, 0) <= MAX_WORKSPACE_PATTERN_CHARACTERS && patterns.every((pattern) => pattern.length <= MAX_WORKSPACE_PATTERN_LENGTH);
const relativeWorkspacePath = (rootDir, directory) => path.relative(rootDir, directory).split(path.sep).join("/");
const compileWorkspaceComponent = (component) => {
	if (component === "**") return false;
	const pattern = compileUvGlob(component);
	if (!pattern) return null;
	return {
		isGlob: pattern.isGlob,
		pattern
	};
};
const compileWorkspacePattern = (pattern) => {
	const parts = normalizeWorkspacePattern(pattern).split("/");
	const components = [];
	const baseParts = [];
	let isGlob = false;
	for (const part of parts) {
		const component = compileWorkspaceComponent(part);
		if (component === null) return null;
		const componentIsGlob = component === false || component.isGlob;
		if (!isGlob && !componentIsGlob) baseParts.push(part);
		isGlob ||= componentIsGlob;
		if (component !== false || components.at(-1) !== false) components.push(component);
	}
	return {
		base: baseParts.join("/"),
		components,
		isGlob
	};
};
const scanWorkspacePattern = (pattern) => {
	const plan = compileWorkspacePattern(pattern);
	return plan && {
		base: plan.base,
		isGlob: plan.isGlob
	};
};
const compileWorkspacePatterns = (patterns) => {
	const plans = [];
	for (const pattern of patterns) {
		const plan = compileWorkspacePattern(pattern);
		if (!plan) return null;
		plans.push(plan);
	}
	return plans;
};
const candidateComponents = (rootDir, directory) => relativeWorkspacePath(rootDir, directory).split("/").filter(Boolean);
const searchPattern = (pattern, candidate, budget, goal) => {
	const visited = /* @__PURE__ */ new Set();
	let exhausted = false;
	const search = (patternIndex, candidateIndex) => {
		if (budget.remainingSteps <= 0) {
			exhausted = true;
			return false;
		}
		budget.remainingSteps -= 1;
		const key = patternIndex * (candidate.length + 1) + candidateIndex;
		if (visited.has(key)) return false;
		visited.add(key);
		if (goal === "exact" && patternIndex === pattern.length) return candidateIndex === candidate.length;
		if (goal === "descendant" && candidateIndex === candidate.length) return patternIndex < pattern.length;
		const matcher = pattern[patternIndex];
		if (matcher === void 0) return false;
		if (matcher === false) {
			if (goal === "exact" && patternIndex === pattern.length - 1) return candidateIndex < candidate.length;
			return search(patternIndex + 1, candidateIndex) || candidateIndex < candidate.length && search(patternIndex, candidateIndex + 1);
		}
		if (candidateIndex >= candidate.length) return false;
		const matches = matchesUvGlob(matcher.pattern, candidate[candidateIndex], true, budget);
		if (matches === null) {
			exhausted = true;
			return false;
		}
		return matches && search(patternIndex + 1, candidateIndex + 1);
	};
	const matched = search(0, 0);
	return exhausted ? null : matched;
};
const matchAnyPattern = (plans, candidate, budget, goal) => {
	for (const plan of plans) {
		const matched = searchPattern(plan.components, candidate, budget, goal);
		if (matched === null || matched) return matched;
	}
	return false;
};
const createWorkspacePathMatcher = (patterns, matchSeparators, budget) => {
	if (!workspacePatternsWithinBudget(patterns)) return null;
	if (matchSeparators) {
		const compiled = patterns.map((pattern) => compileUvGlob(normalizeWorkspacePattern(pattern)));
		if (compiled.some((pattern) => pattern === null)) return null;
		return (rootDir, directory) => {
			const candidate = relativeWorkspacePath(rootDir, directory);
			for (const pattern of compiled) {
				if (!pattern) continue;
				const matched = matchesUvGlob(pattern, candidate, false, budget);
				if (matched === null || matched) return matched;
			}
			return false;
		};
	}
	const plans = compileWorkspacePatterns(patterns);
	if (!plans) return null;
	return (rootDir, directory) => {
		const candidate = candidateComponents(rootDir, directory);
		return matchAnyPattern(plans, candidate, budget, "exact");
	};
};
const createWorkspaceDescendantMatcher = (patterns, budget) => {
	if (!workspacePatternsWithinBudget(patterns)) return null;
	const plans = compileWorkspacePatterns(patterns);
	if (!plans) return null;
	return (rootDir, directory) => {
		const candidate = candidateComponents(rootDir, directory);
		return matchAnyPattern(plans, candidate, budget, "descendant");
	};
};
//#endregion
//#region src/engines/ai-slop/uv-workspace-patterns.ts
const SKIP_WORKSPACE_DIRS = /* @__PURE__ */ new Set([
	".git",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	".venv",
	"__pycache__",
	"build",
	"dist",
	"node_modules",
	"site-packages"
]);
const MAX_WORKSPACE_DIRECTORIES = 1e4;
const MAX_WORKSPACE_DIRECTORY_ENTRIES = 5e3;
const MAX_WORKSPACE_DEPTH$1 = 32;
const MAX_WORKSPACE_MATCH_STEPS = 2e5;
const isWithinWorkspaceRoot = (rootDir, directory) => {
	const relative = path.relative(rootDir, directory);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const isRealPathWithinWorkspaceRoot = (rootDir, directory) => {
	try {
		return isWithinWorkspaceRoot(fs.realpathSync(rootDir), fs.realpathSync(directory));
	} catch {
		return false;
	}
};
const readWorkspaceChildDirectories = (directory) => {
	let directoryHandle = null;
	try {
		directoryHandle = fs.opendirSync(directory);
		const children = [];
		let entryCount = 0;
		let entry = directoryHandle.readSync();
		while (entry) {
			entryCount += 1;
			if (entryCount > MAX_WORKSPACE_DIRECTORY_ENTRIES) return null;
			const childDirectory = path.join(directory, entry.name);
			const skipped = SKIP_WORKSPACE_DIRS.has(entry.name);
			if (entry.isSymbolicLink()) children.push({
				directory: childDirectory,
				shouldTraverse: !skipped,
				symbolicLink: true
			});
			else if (entry.isDirectory()) children.push({
				directory: childDirectory,
				shouldTraverse: !skipped,
				symbolicLink: false
			});
			entry = directoryHandle.readSync();
		}
		return children;
	} catch {
		return null;
	} finally {
		directoryHandle?.closeSync();
	}
};
const normalizeProjectName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
const expandWorkspaceMemberDirs = ({ rootDir, memberPatterns, excludePatterns, rootProjectName }) => {
	if (!workspacePatternsWithinBudget(memberPatterns)) return null;
	const resolvedRoot = path.resolve(rootDir);
	const dirs = /* @__PURE__ */ new Set();
	const excludedDirs = /* @__PURE__ */ new Set();
	const globPatterns = [];
	const walkRoots = /* @__PURE__ */ new Set();
	const projectNames = /* @__PURE__ */ new Set();
	if (rootProjectName) projectNames.add(normalizeProjectName(rootProjectName));
	const processedCandidates = /* @__PURE__ */ new Set();
	const matchBudget = { remainingSteps: MAX_WORKSPACE_MATCH_STEPS };
	const excludeMatcher = createWorkspacePathMatcher(excludePatterns, true, matchBudget);
	if (!excludeMatcher) return null;
	const acceptCandidate = (directory) => {
		if (processedCandidates.has(directory)) return true;
		processedCandidates.add(directory);
		const excluded = excludeMatcher(resolvedRoot, directory);
		if (excluded === null) return false;
		if (excluded) {
			excludedDirs.add(directory);
			return true;
		}
		if (directory === resolvedRoot) return rootProjectName !== null;
		const admission = classifyUvWorkspaceMember(directory);
		if (admission.kind === "unmanaged") {
			excludedDirs.add(directory);
			return true;
		}
		if (admission.kind === "missing" && path.basename(directory).startsWith(".")) return true;
		if (admission.kind !== "member") return false;
		const projectName = normalizeProjectName(admission.name);
		if (projectNames.has(projectName)) return false;
		projectNames.add(projectName);
		dirs.add(directory);
		return true;
	};
	for (const pattern of new Set(memberPatterns.map(normalizeWorkspacePattern))) {
		const scan = scanWorkspacePattern(pattern);
		if (!scan) return null;
		if (!scan.isGlob) {
			const directory = path.resolve(resolvedRoot, pattern);
			if (!isWithinWorkspaceRoot(resolvedRoot, directory)) return null;
			if (!fs.existsSync(directory)) continue;
			try {
				if (!fs.statSync(directory).isDirectory()) continue;
			} catch {
				return null;
			}
			if (!isRealPathWithinWorkspaceRoot(resolvedRoot, directory)) return null;
			if (!acceptCandidate(directory)) return null;
			continue;
		}
		const walkRoot = path.resolve(resolvedRoot, scan.base || ".");
		if (!isWithinWorkspaceRoot(resolvedRoot, walkRoot)) return null;
		if (!fs.existsSync(walkRoot)) continue;
		try {
			if (!fs.statSync(walkRoot).isDirectory()) continue;
		} catch {
			return null;
		}
		if (!isRealPathWithinWorkspaceRoot(resolvedRoot, walkRoot)) return null;
		globPatterns.push(pattern);
		walkRoots.add(walkRoot);
	}
	const memberMatcher = createWorkspacePathMatcher(globPatterns, false, matchBudget);
	const descendantMatcher = createWorkspaceDescendantMatcher(globPatterns, matchBudget);
	if (!memberMatcher || !descendantMatcher) return null;
	const minimalWalkRoots = [];
	for (const walkRoot of [...walkRoots].sort((a, b) => a.length - b.length)) {
		if (minimalWalkRoots.some((parent) => isWithinWorkspaceRoot(parent, walkRoot))) continue;
		minimalWalkRoots.push(walkRoot);
	}
	const visited = /* @__PURE__ */ new Set();
	for (const walkRoot of minimalWalkRoots) {
		const pending = [{
			directory: walkRoot,
			shouldTraverse: true,
			symbolicLink: false
		}];
		while (pending.length > 0) {
			const nextDirectory = pending.pop();
			if (!nextDirectory || visited.has(nextDirectory.directory)) continue;
			const { directory, shouldTraverse, symbolicLink } = nextDirectory;
			visited.add(directory);
			if (visited.size > MAX_WORKSPACE_DIRECTORIES) return null;
			const matchesMember = memberMatcher(resolvedRoot, directory);
			if (matchesMember === null) return null;
			const matchesDescendant = descendantMatcher(resolvedRoot, directory);
			if (matchesDescendant === null) return null;
			if (symbolicLink) {
				if (!matchesMember && !matchesDescendant) continue;
				const excluded = excludeMatcher(resolvedRoot, directory);
				if (excluded === null) return null;
				if (excluded) continue;
				try {
					if (!fs.statSync(directory).isDirectory()) continue;
				} catch {
					return null;
				}
				return null;
			}
			if (matchesMember && !acceptCandidate(directory)) return null;
			if (!shouldTraverse) {
				if (matchesDescendant) return null;
				continue;
			}
			if (!matchesDescendant) continue;
			const depth = relativeWorkspacePath(resolvedRoot, directory).split("/").filter(Boolean).length;
			const children = readWorkspaceChildDirectories(directory);
			if (children === null) return null;
			if (depth >= MAX_WORKSPACE_DEPTH$1) {
				if (children.some((child) => child.shouldTraverse)) return null;
				for (const child of children) pending.push(child);
				continue;
			}
			for (const child of children) pending.push(child);
		}
	}
	return {
		memberDirs: [...dirs],
		excludedDirs: [...excludedDirs]
	};
};
//#endregion
//#region src/engines/ai-slop/python-manifest.ts
const LOCAL_PACKAGE_ROOTS = [
	"",
	"src",
	"lib"
];
const collectLocalPythonPackages = (rootDir, pyDeps) => {
	for (const sub of LOCAL_PACKAGE_ROOTS) {
		const dir = sub ? path.join(rootDir, sub) : rootDir;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
			const initPath = path.join(dir, entry.name, "__init__.py");
			if (fs.existsSync(initPath)) addPyDep(pyDeps, entry.name);
		}
	}
};
const collectScope = (rootDir) => {
	const pyDeps = /* @__PURE__ */ new Set();
	const hasReq = collectFromRequirementsTxt(rootDir, pyDeps);
	const hasPyproject = collectFromPyproject(rootDir, pyDeps);
	const hasPipfile = collectFromPipfile(rootDir, pyDeps);
	collectLocalPythonPackages(rootDir, pyDeps);
	return {
		directory: rootDir,
		pyDeps,
		hasPyManifest: hasReq || hasPyproject || hasPipfile
	};
};
const SKIP_MANIFEST_DIRS = /* @__PURE__ */ new Set([
	".git",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	".venv",
	"__pycache__",
	"build",
	"dist",
	"node_modules",
	"site-packages"
]);
const NESTED_PY_MANIFEST_DEPTH = 4;
const collectNestedScopes = (rootDir) => {
	const scopes = [];
	const walk = (dir, depth) => {
		if (depth > NESTED_PY_MANIFEST_DEPTH) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const hasManifest = entries.some((entry) => entry.isFile() && PYTHON_MANIFEST_FILES.some((fileName) => fileName === entry.name));
		if (dir !== rootDir && hasManifest) {
			const scope = collectScope(dir);
			if (scope.hasPyManifest) scopes.push(scope);
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (SKIP_MANIFEST_DIRS.has(entry.name)) continue;
			walk(path.join(dir, entry.name), depth + 1);
		}
	};
	walk(rootDir, 0);
	return scopes;
};
const findNearestPythonManifestDirectory = (startDir, boundaryDir) => {
	let directory = path.resolve(startDir);
	const boundary = path.resolve(boundaryDir);
	while (isWithinWorkspaceRoot(boundary, directory)) {
		if (PYTHON_MANIFEST_FILES.some((fileName) => fs.existsSync(path.join(directory, fileName)))) return directory;
		if (directory === boundary) break;
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return null;
};
const MAX_WORKSPACE_WALKUP = 32;
const emptyUvWorkspace = (rootDir, startDir) => {
	return {
		rootDir,
		appliesToStartDir: findNearestPythonManifestDirectory(startDir, rootDir) === rootDir,
		sharedDeps: /* @__PURE__ */ new Set(),
		memberDirs: [],
		excludedDirs: []
	};
};
const findUvWorkspace = (startDir) => {
	let dir = path.resolve(startDir);
	for (let i = 0; i < MAX_WORKSPACE_WALKUP; i += 1) {
		const pyprojPath = path.join(dir, "pyproject.toml");
		if (fs.existsSync(pyprojPath)) {
			const workspace = readUvWorkspaceDefinition(dir);
			if (workspace.kind === "invalid" || workspace.kind === "unmanaged") return emptyUvWorkspace(dir, startDir);
			if (workspace.kind === "workspace") {
				const sharedDeps = /* @__PURE__ */ new Set();
				collectFromPyproject(dir, sharedDeps);
				collectLocalPythonPackages(dir, sharedDeps);
				const expansion = expandWorkspaceMemberDirs({
					rootDir: dir,
					memberPatterns: workspace.members,
					excludePatterns: workspace.exclude,
					rootProjectName: workspace.rootProjectName
				});
				if (expansion === null) return emptyUvWorkspace(dir, startDir);
				const { memberDirs, excludedDirs } = expansion;
				const startProjectDir = findNearestPythonManifestDirectory(startDir, dir);
				const appliesToStartDir = startProjectDir === dir || startProjectDir !== null && memberDirs.includes(startProjectDir);
				for (const memberDir of memberDirs) {
					const memberScope = collectScope(memberDir);
					for (const dep of memberScope.pyDeps) sharedDeps.add(dep);
				}
				return {
					rootDir: dir,
					appliesToStartDir,
					sharedDeps,
					memberDirs,
					excludedDirs
				};
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
};
const isUnderDotDirectory = (rootDir, scopeDir) => {
	return path.relative(rootDir, scopeDir).split(path.sep).some((segment) => segment.startsWith("."));
};
const collectPythonDeps = (rootDir) => {
	const rootScope = collectScope(rootDir);
	const scopes = [rootScope, ...collectNestedScopes(rootDir)];
	const workspace = findUvWorkspace(rootDir);
	if (workspace) {
		const ancestorProjectDir = findNearestPythonManifestDirectory(rootDir, workspace.rootDir);
		if (ancestorProjectDir && !scopes.some((scope) => scope.directory === ancestorProjectDir)) {
			const ancestorScope = collectScope(ancestorProjectDir);
			if (ancestorScope.hasPyManifest) scopes.push(ancestorScope);
		}
	}
	for (const excludedDir of workspace?.excludedDirs ?? []) {
		if (scopes.some((scope) => scope.directory === excludedDir)) continue;
		const excludedScope = collectScope(excludedDir);
		if (excludedScope.hasPyManifest) scopes.push(excludedScope);
	}
	const pyDeps = /* @__PURE__ */ new Set();
	for (const scope of scopes) {
		if (isUnderDotDirectory(rootDir, scope.directory)) continue;
		for (const dep of scope.pyDeps) pyDeps.add(dep);
	}
	return {
		pyDeps,
		hasPyManifest: scopes.some((scope) => scope.hasPyManifest) || workspace?.appliesToStartDir === true,
		rootHasPyManifest: rootScope.hasPyManifest,
		scopes,
		workspaceDeps: workspace?.appliesToStartDir ? workspace.sharedDeps : null,
		workspaceRootDir: workspace?.appliesToStartDir ? workspace.rootDir : null,
		workspaceMemberDirs: workspace?.appliesToStartDir ? workspace.memberDirs : []
	};
};
//#endregion
//#region src/engines/ai-slop/hallucinated-imports-manifest.ts
const readJson$1 = (filePath, rootDirectory = path.dirname(filePath)) => {
	try {
		const safePath = safeProjectFilePath(filePath, rootDirectory);
		return safePath ? JSON.parse(fs.readFileSync(safePath, "utf-8")) : null;
	} catch {
		return null;
	}
};
const PKG_DEP_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies"
];
const addDepsFromPkg = (pkg, jsDeps) => {
	for (const section of PKG_DEP_SECTIONS) {
		const deps = pkg[section];
		if (deps && typeof deps === "object") for (const name of Object.keys(deps)) jsDeps.add(name);
	}
};
const SKIP_DIRS = /* @__PURE__ */ new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"target",
	"coverage"
]);
const mergeDeps = (target, source) => {
	for (const dep of source) target.add(dep);
};
const collectJsScope = (directory, rootDirectory) => {
	const pkgPath = path.join(directory, "package.json");
	const pkg = readJson$1(pkgPath, rootDirectory);
	if (!pkg || typeof pkg !== "object") return null;
	const jsDeps = /* @__PURE__ */ new Set();
	addDepsFromPkg(pkg, jsDeps);
	const packageName = typeof pkg.name === "string" ? pkg.name : void 0;
	if (packageName) jsDeps.add(packageName);
	return {
		directory,
		jsDeps,
		packageName
	};
};
const hasPackageManifest = (filePath) => {
	try {
		const stats = fs.lstatSync(filePath);
		return stats.isFile() || stats.isSymbolicLink();
	} catch {
		return false;
	}
};
const collectJsScopes = (rootDir) => {
	const scopes = [];
	const walk = (dir) => {
		const pkgPath = path.join(dir, "package.json");
		const scope = collectJsScope(dir, rootDir);
		if (scope) scopes.push(scope);
		else if (hasPackageManifest(pkgPath)) scopes.push({
			directory: dir,
			jsDeps: /* @__PURE__ */ new Set()
		});
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(path.join(dir, entry.name));
		}
	};
	walk(rootDir);
	return scopes;
};
const collectJsDeps = (rootDir, jsDeps, jsScopes) => {
	const pkgPath = path.join(rootDir, "package.json");
	const pkg = readJson$1(pkgPath, rootDir);
	if (!pkg || typeof pkg !== "object") return jsScopes.length > 0;
	for (const scope of jsScopes) mergeDeps(jsDeps, scope.jsDeps);
	const workspaceDirs = collectWorkspaceDirs(rootDir, pkg);
	for (const wsDir of workspaceDirs) {
		const wsPkg = readJson$1(path.join(wsDir, "package.json"), rootDir);
		if (!wsPkg) continue;
		if (typeof wsPkg.name === "string") jsDeps.add(wsPkg.name);
		addDepsFromPkg(wsPkg, jsDeps);
	}
	return true;
};
const loadManifest = (rootDir) => {
	const jsScopes = collectJsScopes(rootDir);
	const jsDeps = /* @__PURE__ */ new Set();
	const hasJsManifest = collectJsDeps(rootDir, jsDeps, jsScopes);
	const { pyDeps, hasPyManifest, rootHasPyManifest, scopes, workspaceDeps, workspaceRootDir, workspaceMemberDirs } = collectPythonDeps(rootDir);
	return {
		jsDeps,
		jsScopes,
		pyDeps,
		hasJsManifest,
		hasPyManifest,
		rootHasPyManifest,
		pyScopes: scopes,
		workspaceDeps,
		workspaceRootDir,
		workspaceMemberDirs
	};
};
const isWithinDirectory$1 = (filePath, directory) => {
	const relative = path.relative(directory, filePath);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const isWorkspaceProjectFile = (manifest, filePath) => {
	if (!manifest.workspaceRootDir) return false;
	const workspaceRoot = path.resolve(manifest.workspaceRootDir);
	let directory = path.dirname(path.resolve(filePath));
	while (isWithinDirectory$1(directory, workspaceRoot)) {
		if (PYTHON_MANIFEST_FILES.some((fileName) => fs.existsSync(path.join(directory, fileName)))) return directory === workspaceRoot || manifest.workspaceMemberDirs.some((memberDir) => path.resolve(memberDir) === directory);
		if (directory === workspaceRoot) break;
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return false;
};
const jsDepsForFile = (manifest, filePath, rootDirectory) => {
	const deps = /* @__PURE__ */ new Set();
	for (const scope of manifest.jsScopes) if (scope.packageName) deps.add(scope.packageName);
	const nearestScope = manifest.jsScopes.filter((scope) => scope.directory !== rootDirectory && isWithinDirectory$1(filePath, scope.directory)).sort((a, b) => b.directory.length - a.directory.length)[0];
	if (nearestScope) {
		mergeDeps(deps, nearestScope.jsDeps);
		return deps;
	}
	const rootScope = manifest.jsScopes.find((scope) => scope.directory === rootDirectory);
	if (rootScope) mergeDeps(deps, rootScope.jsDeps);
	else mergeDeps(deps, manifest.jsDeps);
	return deps;
};
const nearestPythonScope = (manifest, filePath, rootDirectory) => manifest.pyScopes.filter((scope) => scope.directory !== rootDirectory && scope.hasPyManifest && isWithinDirectory$1(filePath, scope.directory)).sort((a, b) => b.directory.length - a.directory.length)[0];
const pythonImportRootForFile = (manifest, filePath, rootDirectory) => nearestPythonScope(manifest, filePath, rootDirectory)?.directory ?? rootDirectory;
const pythonDepsForFile = (manifest, filePath, rootDirectory) => {
	const deps = /* @__PURE__ */ new Set();
	const rootScope = manifest.pyScopes.find((scope) => scope.directory === rootDirectory);
	const workspaceProjectFile = manifest.workspaceDeps !== null && isWorkspaceProjectFile(manifest, filePath);
	if (manifest.rootHasPyManifest && rootScope && (manifest.workspaceDeps === null || workspaceProjectFile)) mergeDeps(deps, rootScope.pyDeps);
	const nestedScope = nearestPythonScope(manifest, filePath, rootDirectory);
	if (nestedScope) mergeDeps(deps, nestedScope.pyDeps);
	const workspaceDeps = workspaceProjectFile ? manifest.workspaceDeps : null;
	if (workspaceDeps) mergeDeps(deps, workspaceDeps);
	if (!manifest.rootHasPyManifest && !nestedScope && !workspaceDeps) return null;
	if (deps.size === 0 && manifest.pyDeps.size > 0 && !manifest.workspaceDeps) return manifest.pyDeps;
	return deps;
};
//#endregion
//#region src/utils/read-jsonc.ts
/** Strip block and line comments outside JSON strings (preserves `@/*` paths and `https://` URLs). */
const stripJsonComments = (raw) => {
	let result = "";
	let i = 0;
	let inString = null;
	let escaped = false;
	while (i < raw.length) {
		const ch = raw[i];
		const next = raw[i + 1];
		if (inString) {
			result += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === inString) inString = null;
			i++;
			continue;
		}
		if (ch === "\"" || ch === "'") {
			inString = ch;
			result += ch;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			i += 2;
			while (i < raw.length && raw[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		result += ch;
		i++;
	}
	return result;
};
const stripTrailingCommas = (raw) => {
	let result = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < raw.length; index++) {
		const character = raw[index];
		if (inString) {
			result += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === "\"") inString = false;
			continue;
		}
		if (character === "\"") {
			inString = true;
			result += character;
			continue;
		}
		if (character === ",") {
			let nextIndex = index + 1;
			while (/\s/.test(raw[nextIndex] ?? "")) nextIndex++;
			if (raw[nextIndex] === "}" || raw[nextIndex] === "]") continue;
		}
		result += character;
	}
	return result;
};
const parseJsonc = (raw) => {
	try {
		return JSON.parse(raw);
	} catch {
		try {
			return JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
		} catch {
			return null;
		}
	}
};
const readJsoncFile = (filePath) => {
	try {
		return parseJsonc(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
};
//#endregion
//#region src/engines/ai-slop/js-alias-matcher.ts
const canonicalPath = (filePath) => {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.resolve(filePath);
	}
};
const isFileInScope = (filePath, scopeDirectory) => {
	if (!filePath) return true;
	const candidate = canonicalPath(filePath);
	const relative = path.relative(scopeDirectory, candidate);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
};
const buildAliasMatcher = (key, scopeDirectory) => {
	const starIndex = key.indexOf("*");
	if (starIndex === -1) return (specifier, filePath) => isFileInScope(filePath, scopeDirectory) && specifier === key;
	const before = key.slice(0, starIndex);
	const after = key.slice(starIndex + 1);
	return (specifier, filePath) => isFileInScope(filePath, scopeDirectory) && specifier.length >= before.length + after.length && specifier.startsWith(before) && specifier.endsWith(after);
};
const buildPrefixAliasMatcher = (key, scopeDirectory) => {
	if (key.includes("*")) return buildAliasMatcher(key, scopeDirectory);
	const prefix = key.endsWith("/") ? key : `${key}/`;
	return (specifier, filePath) => isFileInScope(filePath, scopeDirectory) && (specifier === key || specifier.startsWith(prefix));
};
//#endregion
//#region src/engines/ai-slop/js-declared-modules.ts
const AMBIENT_MODULE_RE = /^\s*declare\s+module\s+(["'])([^"']+)\1/gm;
const CONFIG_FILES = /* @__PURE__ */ new Set(["tsconfig.json", "jsconfig.json"]);
const SKIP_DIRECTORIES = /* @__PURE__ */ new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage"
]);
const MAX_NESTED_EXPORT_DEPTH = 32;
const MAX_NESTED_EXPORT_NODES = 1024;
const isExternalModuleDeclaration = (content) => {
	const maskedContent = maskStringsAndComments$1(content, ".ts");
	let braceDepth = 0;
	let cursor = 0;
	for (const token of maskedContent.matchAll(/\b(?:import|export)\b/g)) {
		const tokenIndex = token.index;
		for (let index = cursor; index < tokenIndex; index++) {
			const character = maskedContent[index];
			if (character === "{") braceDepth++;
			if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
		}
		const nextCharacter = maskedContent.slice(tokenIndex + token[0].length).trimStart()[0];
		if (braceDepth === 0 && (token[0] === "export" || nextCharacter !== "(")) return true;
		cursor = tokenIndex + token[0].length;
	}
	return false;
};
const declarationScope = (filePath, rootDirectory) => {
	const root = fs.realpathSync(rootDirectory);
	let directory = path.dirname(fs.realpathSync(filePath));
	while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
		const pkg = readJson$1(path.join(directory, "package.json"), root);
		if (pkg && typeof pkg === "object") return directory;
		if (directory === root) break;
		directory = path.dirname(directory);
	}
	return root;
};
const nestedStringValues = (value) => {
	const values = [];
	const pending = [{
		value,
		depth: 0
	}];
	let visitedNodes = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		visitedNodes++;
		if (visitedNodes > MAX_NESTED_EXPORT_NODES || current.depth > MAX_NESTED_EXPORT_DEPTH) return [];
		if (typeof current.value === "string") {
			values.push(current.value);
			continue;
		}
		if (!current.value || typeof current.value !== "object") continue;
		const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
		for (const child of children) pending.push({
			value: child,
			depth: current.depth + 1
		});
	}
	return values;
};
const declarationTypeReferences = (filePath, packageDirectory, rootDirectory) => {
	const references = /* @__PURE__ */ new Set();
	const pkg = readJson$1(path.join(packageDirectory, "package.json"), rootDirectory);
	if (!pkg || typeof pkg.name !== "string") return references;
	if (typeof pkg.types === "string") {
		if (safeProjectFilePath(path.resolve(packageDirectory, pkg.types), rootDirectory) === filePath) references.add(pkg.name);
	}
	if (!pkg.exports || typeof pkg.exports !== "object") return references;
	for (const [exportKey, value] of Object.entries(pkg.exports)) {
		if (exportKey !== "." && !exportKey.startsWith("./")) continue;
		if (nestedStringValues(value).some((target) => safeProjectFilePath(path.resolve(packageDirectory, target), rootDirectory) === filePath)) references.add(exportKey === "." ? pkg.name : `${pkg.name}${exportKey.slice(1)}`);
	}
	return references;
};
const configFiles = (rootDirectory) => {
	const files = [];
	const walk = (directory, depth) => {
		if (depth > 5 || files.length >= 256) return;
		let entries;
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) if (entry.isDirectory()) {
			if (!entry.isSymbolicLink() && !SKIP_DIRECTORIES.has(entry.name)) walk(path.join(directory, entry.name), depth + 1);
		} else if (CONFIG_FILES.has(entry.name)) {
			const safePath = safeProjectFilePath(path.join(directory, entry.name), rootDirectory);
			if (safePath) files.push(safePath);
		}
	};
	walk(rootDirectory, 0);
	return files;
};
const referencedTypeScopes = (references, rootDirectory, configs) => {
	if (references.size === 0) return [];
	const scopes = [];
	for (const configPath of configs) {
		const config = readJsoncFile(configPath);
		const compilerOptions = config?.compilerOptions && typeof config.compilerOptions === "object" ? config.compilerOptions : null;
		if (!compilerOptions || !Array.isArray(compilerOptions.types)) continue;
		if (compilerOptions.types.some((value) => typeof value === "string" && references.has(value))) scopes.push(path.dirname(configPath));
	}
	return scopes.filter((scope) => isFileInScope(scope, rootDirectory));
};
const matcherForDeclaration = (declaration, scopeDirectories) => {
	const inScope = (filePath) => scopeDirectories.some((scope) => isFileInScope(filePath, scope));
	const starIndex = declaration.indexOf("*");
	if (starIndex === -1) return (specifier, filePath) => inScope(filePath) && specifier === declaration;
	const before = declaration.slice(0, starIndex);
	const after = declaration.slice(starIndex + 1);
	return (specifier, filePath) => inScope(filePath) && specifier.length >= before.length + after.length && specifier.startsWith(before) && specifier.endsWith(after);
};
const collectDeclaredModuleMatchers = (files, rootDirectory) => {
	const matchers = [];
	const root = fs.realpathSync(rootDirectory);
	const configs = configFiles(root);
	for (const filePath of files) {
		if (!filePath.endsWith(".d.ts")) continue;
		const safePath = safeProjectFilePath(filePath, rootDirectory);
		if (!safePath) continue;
		let content;
		try {
			content = fs.readFileSync(safePath, "utf-8");
		} catch {
			continue;
		}
		if (isExternalModuleDeclaration(content)) continue;
		const packageDirectory = declarationScope(safePath, root);
		const references = declarationTypeReferences(safePath, packageDirectory, root);
		const scopeDirectories = [packageDirectory, ...referencedTypeScopes(references, root, configs)];
		for (const match of maskComments(content, ".ts").matchAll(AMBIENT_MODULE_RE)) matchers.push(matcherForDeclaration(match[2], scopeDirectories));
	}
	return matchers;
};
//#endregion
//#region src/engines/ai-slop/hallucinated-imports-js.ts
const isJsRelativeOrAbsolute = (spec) => spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~/");
const RUNTIME_BUILTINS = /* @__PURE__ */ new Set(["bun"]);
const isJsBuiltin = (spec) => {
	if (RUNTIME_BUILTINS.has(spec)) return true;
	return isBuiltin(spec.startsWith("node:") ? spec.slice(5) : spec) || isBuiltin(spec);
};
const VIRTUAL_MODULE_PREFIXES = [
	"astro:",
	"virtual:",
	"bun:",
	"file:",
	"http:",
	"https:",
	"jsr:",
	"npm:"
];
const DOCUSAURUS_VIRTUAL_PREFIXES = [
	"@docusaurus/",
	"@theme/",
	"@theme-original/",
	"@site"
];
const hasDocusaurusDependency = (jsDeps) => {
	for (const dep of jsDeps) if (dep.startsWith("@docusaurus/")) return true;
	return false;
};
const isDocusaurusVirtualImport = (spec, jsDeps) => {
	if (!hasDocusaurusDependency(jsDeps)) return false;
	return DOCUSAURUS_VIRTUAL_PREFIXES.some((prefix) => spec === prefix || spec.startsWith(prefix));
};
const readWorkspaceGlobs = (pkg) => {
	const globs = [];
	const ws = pkg.workspaces;
	if (Array.isArray(ws)) {
		for (const g of ws) if (typeof g === "string") globs.push(g);
	} else if (ws && typeof ws === "object") {
		const pkgs = ws.packages;
		if (Array.isArray(pkgs)) {
			for (const g of pkgs) if (typeof g === "string") globs.push(g);
		}
	}
	return globs;
};
const isWaspProjectDirectory = (directory) => {
	try {
		if (fs.existsSync(path.join(directory, "main.wasp"))) return true;
		const pkg = readJson$1(path.join(directory, "package.json"), directory);
		if (!pkg) return false;
		return readWorkspaceGlobs(pkg).some((glob) => glob.includes("wasp") || glob.includes(".wasp"));
	} catch {
		return false;
	}
};
const isWaspSdkImport = (spec, filePath, rootDirectory) => {
	if (spec !== "wasp" && !spec.startsWith("wasp/")) return false;
	let dir = path.dirname(filePath);
	const root = path.resolve(rootDirectory);
	while (dir.startsWith(root)) {
		if (isWaspProjectDirectory(dir)) return true;
		if (dir === root) break;
		dir = path.dirname(dir);
	}
	return false;
};
const isJsVirtualModule = (spec, jsDeps, declaredModuleMatchers, filePath, rootDirectory) => {
	if (VIRTUAL_MODULE_PREFIXES.some((prefix) => spec.startsWith(prefix))) return true;
	if (declaredModuleMatchers.some((matches) => matches(spec, filePath))) return true;
	if (spec === "bun") return true;
	if (spec === "unfonts.css" && jsDeps.has("unplugin-fonts")) return true;
	if (spec.startsWith("~icons/") && jsDeps.has("unplugin-icons")) return true;
	if (isDocusaurusVirtualImport(spec, jsDeps)) return true;
	if (isWaspSdkImport(spec, filePath, rootDirectory)) return true;
	return false;
};
const stripImportQuery = (spec) => {
	const idx = spec.indexOf("?");
	return idx === -1 ? spec : spec.slice(0, idx);
};
const TEMPLATE_PLACEHOLDER_RE = /\$\{/;
const isLikelyRealImportSpec = (spec) => {
	if (spec.length === 0) return false;
	if (TEMPLATE_PLACEHOLDER_RE.test(spec)) return false;
	if (spec.includes("\\")) return false;
	if (/\s/.test(spec)) return false;
	return true;
};
const packageNameFromImport = (spec) => {
	if (spec.startsWith("@")) {
		const parts = spec.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
	}
	return spec.split("/")[0];
};
const typesPackageName = (pkg) => {
	if (pkg.startsWith("@types/")) return pkg;
	if (pkg.startsWith("@")) return `@types/${pkg.slice(1).replace("/", "__")}`;
	return `@types/${pkg}`;
};
const STATIC_IMPORT_RE = /^\s*import\s+(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/;
const DYNAMIC_IMPORT_RE = /\b(import|require)\s*\(\s*["']([^"']+)["']/g;
const extractJsImports = (content) => {
	const lines = content.split("\n");
	const maskedLines = maskStringsAndComments$1(content, ".js").split("\n");
	const results = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
		const staticMatch = STATIC_IMPORT_RE.exec(line);
		const staticKeywordIndex = staticMatch ? line.indexOf("import", staticMatch.index) : -1;
		if (staticMatch && staticKeywordIndex >= 0 && maskedLines[i].slice(staticKeywordIndex, staticKeywordIndex + 6) === "import" && isLikelyRealImportSpec(staticMatch[1])) results.push({
			spec: staticMatch[1],
			line: i + 1
		});
		DYNAMIC_IMPORT_RE.lastIndex = 0;
		let dyn = DYNAMIC_IMPORT_RE.exec(line);
		while (dyn !== null) {
			if (maskedLines[i].slice(dyn.index, dyn.index + dyn[1].length) === dyn[1] && isLikelyRealImportSpec(dyn[2])) results.push({
				spec: dyn[2],
				line: i + 1
			});
			dyn = DYNAMIC_IMPORT_RE.exec(line);
		}
	}
	return results;
};
const JS_IMPORT_TO_DECLARATION = { "unist-util-visit": [
	"unified",
	"remark-cli",
	"@mdx-js/react",
	"@docusaurus/core"
] };
const isTransitiveJsImport = (pkg, jsDeps) => {
	return JS_IMPORT_TO_DECLARATION[pkg]?.some((dep) => jsDeps.has(dep)) ?? false;
};
const isScopedFamilyImport = (spec, jsDeps) => {
	if (!spec.startsWith("@")) return false;
	const slash = spec.indexOf("/");
	if (slash === -1) return false;
	const scope = spec.slice(0, slash);
	if (scope === "@types") return false;
	const prefix = `${scope}/`;
	for (const dep of jsDeps) if (dep.startsWith(prefix)) return true;
	return false;
};
const checkJsImport = (rawSpec, jsDeps, tsAliasMatchers, declaredModuleMatchers, filePath, rootDirectory) => {
	const spec = stripImportQuery(rawSpec);
	if (spec.length === 0) return null;
	if (isJsRelativeOrAbsolute(spec)) return null;
	if (isJsBuiltin(spec)) return null;
	if (isJsVirtualModule(spec, jsDeps, declaredModuleMatchers, filePath, rootDirectory)) return null;
	if (tsAliasMatchers.some((m) => m(spec, filePath))) return null;
	const pkg = packageNameFromImport(spec);
	if (pkg === "@prisma/client" && jsDeps.has("prisma")) return null;
	if (jsDeps.has(pkg)) return null;
	if (isTransitiveJsImport(pkg, jsDeps)) return null;
	if (isScopedFamilyImport(spec, jsDeps)) return null;
	if (pkg.startsWith("@types/")) {
		const realPkg = pkg.slice(7);
		if (jsDeps.has(realPkg)) return null;
	}
	if (jsDeps.has(typesPackageName(pkg))) return null;
	return pkg;
};
//#endregion
//#region src/engines/ai-slop/js-import-alias-targets.ts
const MAX_NESTED_TARGET_DEPTH = 32;
const MAX_NESTED_TARGET_NODES = 1024;
const literalValue = (rawValue) => {
	return /^(?:["'])([^"']+)(?:["'])$/.exec(rawValue.trim())?.[1] ?? null;
};
const literalArguments = (rawArguments) => {
	const values = [];
	let remainder = rawArguments;
	const argument = /^\s*,?\s*(["'])([^"']+)\1/;
	while (remainder.trim().length > 0) {
		const match = argument.exec(remainder);
		if (!match) return null;
		values.push(match[2]);
		remainder = remainder.slice(match[0].length);
	}
	return values;
};
const resolvedPathTarget = (rawValue, configDirectory, rootDirectory) => {
	const match = /^\s*path\.resolve\s*\(([\s\S]*)\)\s*$/.exec(rawValue);
	if (!match) return null;
	let argumentsText = match[1].trim();
	let baseDirectory = rootDirectory;
	const configBase = /^(?:__dirname|import\.meta\.dirname)\b/.exec(argumentsText);
	const cwdBase = /^process\.cwd\s*\(\s*\)/.exec(argumentsText);
	if (configBase) {
		baseDirectory = configDirectory;
		argumentsText = argumentsText.slice(configBase[0].length);
	} else if (cwdBase) argumentsText = argumentsText.slice(cwdBase[0].length);
	const parts = literalArguments(argumentsText);
	if (!parts || parts.length === 0) return null;
	return path.resolve(baseDirectory, ...parts);
};
const isLocalAliasReplacement = (rawValue, configDirectory, rootDirectory) => {
	const resolvedTarget = resolvedPathTarget(rawValue, configDirectory, rootDirectory);
	if (resolvedTarget) return isRootBoundedTarget(resolvedTarget, rootDirectory);
	const urlMatch = /new\s+URL\s*\(\s*(["'][^"']+["'])\s*,\s*import\.meta\.url\s*\)/.exec(rawValue);
	if (urlMatch) {
		const target = literalValue(urlMatch[1]);
		if (!target || !target.startsWith("./") && !target.startsWith("../")) return false;
		try {
			const configUrl = pathToFileURL(path.join(configDirectory, "__aislop_vite_config__.ts"));
			return isRootBoundedTarget(fileURLToPath(new URL(target, configUrl)), rootDirectory);
		} catch {
			return false;
		}
	}
	const target = literalValue(rawValue);
	if (!target) return false;
	if (!target.startsWith(".") && !target.startsWith("/") && !target.startsWith("~/") && !target.startsWith("@/")) return false;
	const normalized = target.startsWith("~/") || target.startsWith("@/") ? target.slice(2) : target;
	return isRootBoundedTarget(path.isAbsolute(normalized) ? normalized : path.resolve(configDirectory, normalized), rootDirectory);
};
const hasValidPackageImportTarget = (value, packageDirectory, rootDirectory) => {
	if (!isRootBoundedTarget(packageDirectory, rootDirectory)) return false;
	const pending = [{
		value,
		depth: 0
	}];
	let visitedNodes = 0;
	let hasValidTarget = false;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		visitedNodes++;
		if (visitedNodes > MAX_NESTED_TARGET_NODES || current.depth > MAX_NESTED_TARGET_DEPTH) return false;
		if (typeof current.value === "string") {
			if (current.value.startsWith("./")) {
				hasValidTarget ||= isRootBoundedTarget(path.resolve(packageDirectory, current.value.replaceAll("*", "__aislop__")), packageDirectory);
				continue;
			}
			const isExternalTarget = !(current.value.startsWith("../") || current.value.startsWith("/") || current.value.startsWith("file:") || /^[a-z][a-z0-9+.-]*:/i.test(current.value) && !current.value.startsWith("node:") || current.value === "." || current.value === "..");
			hasValidTarget ||= isExternalTarget;
			continue;
		}
		if (!current.value || typeof current.value !== "object") continue;
		const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
		for (const child of children) pending.push({
			value: child,
			depth: current.depth + 1
		});
	}
	return hasValidTarget;
};
//#endregion
//#region src/engines/ai-slop/js-package-imports.ts
const PACKAGE_ROOT_SKIP_DIRS = /* @__PURE__ */ new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"target",
	"coverage"
]);
const collectNestedPackageRootDirs = (rootDirectory) => {
	const roots = /* @__PURE__ */ new Set();
	const walk = (directory, depth) => {
		if (depth > 4) return;
		let entries;
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			if (PACKAGE_ROOT_SKIP_DIRS.has(entry.name)) continue;
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(fullPath, depth + 1);
			else if (entry.name === "package.json" && depth > 0) roots.add(directory);
		}
	};
	walk(rootDirectory, 0);
	return [...roots];
};
const collectPackageRootDirs = (rootDirectory, workspaceDirectories) => [.../* @__PURE__ */ new Set([
	rootDirectory,
	...workspaceDirectories,
	...collectNestedPackageRootDirs(rootDirectory)
])];
const collectPackageJsonImportMatchers = (packagePath, matchers, rootDirectory) => {
	const safePath = safeProjectFilePath(packagePath, rootDirectory);
	if (!safePath) return;
	const pkg = readJsoncFile(safePath);
	if (!pkg || typeof pkg !== "object") return;
	const imports = pkg.imports;
	if (!imports || typeof imports !== "object") return;
	const packageDirectory = path.dirname(safePath);
	for (const [key, value] of Object.entries(imports)) {
		if (key === "#" || key.startsWith("#/") || !key.startsWith("#")) continue;
		if (!hasValidPackageImportTarget(value, packageDirectory, rootDirectory)) continue;
		matchers.push(buildAliasMatcher(key, packageDirectory));
	}
};
//#endregion
//#region src/engines/ai-slop/js-vite-aliases.ts
const VITE_ALIAS_FILES = [
	"vite.config.ts",
	"vite.config.js",
	"vite.config.mts",
	"vite.config.mjs",
	"vite.config.cts",
	"vite.config.cjs",
	"vite.shared.ts",
	"vite.shared.js"
];
const findBalancedBlock = (content, openIndex) => {
	const open = content[openIndex];
	const close = open === "{" ? "}" : open === "[" ? "]" : null;
	if (!close) return null;
	let depth = 0;
	let quote = null;
	let escaped = false;
	for (let index = openIndex; index < content.length; index++) {
		const character = content[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "\"" || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === open) depth++;
		if (character === close) depth--;
		if (depth === 0) return content.slice(openIndex, index + 1);
	}
	return null;
};
const OBJECT_ALIAS_ENTRY_RE = /(?:^|[,{\n]\s*)(?:(["'])([^"']+)\1|([A-Za-z_$][\w$-]*))\s*:\s*(path\.resolve\s*\((?:process\.cwd\(\)|[^)])*\)|fileURLToPath\s*\(\s*new\s+URL\s*\([^)]*\)\s*\)|new\s+URL\s*\([^)]*\)|["'][^"']+["'])/g;
const ARRAY_ALIAS_ENTRY_RE = /\{\s*find\s*:\s*(["'])([^"']+)\1[\s\S]*?replacement\s*:\s*(path\.resolve\s*\((?:process\.cwd\(\)|[^)])*\)|fileURLToPath\s*\(\s*new\s+URL\s*\([^)]*\)\s*\)|new\s+URL\s*\([^)]*\)|["'][^"']+["'])[\s\S]*?\}/g;
const collectAliases = (block, pattern, matchers, configDirectory, rootDirectory) => {
	for (const match of block.matchAll(pattern)) {
		const key = pattern === OBJECT_ALIAS_ENTRY_RE ? match[2] ?? match[3] : match[2];
		const value = pattern === OBJECT_ALIAS_ENTRY_RE ? match[4] : match[3];
		if (!key || !value || !isLocalAliasReplacement(value, configDirectory, rootDirectory)) continue;
		matchers.push(buildPrefixAliasMatcher(key, configDirectory));
	}
};
const collectViteAliasesFromConfig = (configPath, matchers, rootDirectory) => {
	const safePath = safeProjectFilePath(configPath, rootDirectory);
	if (!safePath) return;
	let content;
	try {
		content = fs.readFileSync(safePath, "utf-8");
	} catch {
		return;
	}
	const aliasStartPattern = /\b(?:alias|aliases)\s*[:=]\s*(?:\x7b|\[)/g;
	const configDirectory = path.dirname(safePath);
	const extension = path.extname(safePath).toLowerCase();
	const commentMasked = maskComments(content, extension);
	const fullyMasked = maskStringsAndComments$1(content, extension);
	for (const match of commentMasked.matchAll(aliasStartPattern)) {
		const keywordOffset = match[0].search(/\b(?:alias|aliases)\b/);
		const keywordIndex = match.index + keywordOffset;
		const keyword = /^(?:alias|aliases)/.exec(match[0].slice(keywordOffset))?.[0];
		if (!keyword || fullyMasked.slice(keywordIndex, keywordIndex + keyword.length) !== keyword) continue;
		const openIndex = match.index + match[0].length - 1;
		const maskedBlock = findBalancedBlock(commentMasked, openIndex);
		if (!maskedBlock) continue;
		const block = commentMasked.slice(openIndex, openIndex + maskedBlock.length);
		const pattern = block.charCodeAt(0) === 123 ? OBJECT_ALIAS_ENTRY_RE : ARRAY_ALIAS_ENTRY_RE;
		collectAliases(block, pattern, matchers, configDirectory, rootDirectory);
	}
};
//#endregion
//#region src/engines/ai-slop/js-import-aliases.ts
const TS_CONFIG_FILES = ["tsconfig.json", "jsconfig.json"];
const JS_RESOLUTION_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	"/index.ts",
	"/index.tsx",
	"/index.js",
	"/index.jsx"
];
const MAX_TS_CONFIG_DEPTH = 16;
const MAX_TS_CONFIG_FILES = 128;
const safeConfigFilePath = (candidate, rootDirectory) => {
	return safeProjectFilePath(candidate, rootDirectory);
};
const safeResolutionEntryExists = (candidate, rootDirectory) => {
	try {
		const absolutePath = path.resolve(candidate);
		const lexicalRelative = path.relative(rootDirectory, absolutePath);
		if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) return false;
		const stats = fs.lstatSync(absolutePath);
		if (stats.isSymbolicLink() || !stats.isFile() && !stats.isDirectory()) return false;
		const realPath = fs.realpathSync(absolutePath);
		const relative = path.relative(rootDirectory, realPath);
		return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
	} catch {
		return false;
	}
};
const resolveTsConfigExtends = (configPath, extendsPath, rootDirectory) => {
	const target = path.resolve(path.dirname(configPath), extendsPath);
	const candidates = path.extname(target) === ".json" ? [target] : [target, `${target}.json`];
	for (const candidate of candidates) {
		const safePath = safeConfigFilePath(candidate, rootDirectory);
		if (safePath) return safePath;
	}
	return null;
};
const readTsConfigChain = (configPath, rootDirectory, chain, depth = 0) => {
	if (depth > MAX_TS_CONFIG_DEPTH || chain.size >= MAX_TS_CONFIG_FILES) return [];
	const resolvedConfigPath = safeConfigFilePath(configPath, rootDirectory);
	if (!resolvedConfigPath || chain.has(resolvedConfigPath)) return [];
	chain.add(resolvedConfigPath);
	const config = readJsoncFile(resolvedConfigPath);
	if (!config) return [];
	const extendsValue = config.extends;
	const extendsPaths = typeof extendsValue === "string" ? [extendsValue] : Array.isArray(extendsValue) ? extendsValue.filter((value) => typeof value === "string") : [];
	const parents = [];
	for (const extendsPath of extendsPaths) {
		const parentPath = resolveTsConfigExtends(resolvedConfigPath, extendsPath, rootDirectory);
		if (!parentPath) continue;
		parents.push(...readTsConfigChain(parentPath, rootDirectory, chain, depth + 1));
	}
	return [...parents, {
		configPath: resolvedConfigPath,
		config
	}];
};
const collectAliasMatchersFromConfig = (configPath, matchers, visited, rootDirectory) => {
	const resolvedConfigPath = safeConfigFilePath(configPath, rootDirectory);
	if (!resolvedConfigPath) return;
	const configScope = path.dirname(resolvedConfigPath);
	const visitKey = `${resolvedConfigPath}\0${configScope}`;
	if (visited.has(visitKey)) return;
	visited.add(visitKey);
	const chain = readTsConfigChain(resolvedConfigPath, rootDirectory, /* @__PURE__ */ new Set());
	let pathsOption;
	let baseUrlOption;
	for (const entry of chain) {
		const opts = entry.config.compilerOptions;
		if (!opts || typeof opts !== "object") continue;
		const compilerOptions = opts;
		if (Object.hasOwn(compilerOptions, "paths")) pathsOption = {
			configPath: entry.configPath,
			value: compilerOptions.paths
		};
		if (Object.hasOwn(compilerOptions, "baseUrl")) baseUrlOption = {
			configPath: entry.configPath,
			value: compilerOptions.baseUrl
		};
	}
	const baseDir = baseUrlOption && typeof baseUrlOption.value === "string" ? safeProjectDirectoryPath(path.resolve(path.dirname(baseUrlOption.configPath), baseUrlOption.value), rootDirectory) : null;
	const pathsBaseDirectory = baseDir ?? (pathsOption ? path.dirname(pathsOption.configPath) : null);
	const paths = pathsOption?.value;
	if (pathsBaseDirectory && paths && typeof paths === "object") {
		for (const [key, value] of Object.entries(paths)) if (Array.isArray(value) && value.some((target) => typeof target === "string" && isRootBoundedTarget(path.resolve(pathsBaseDirectory, target.replaceAll("*", "__aislop__")), rootDirectory))) matchers.push(buildAliasMatcher(key, configScope));
	}
	if (baseDir) matchers.push((spec, filePath) => {
		if (!isFileInScope(filePath, configScope)) return false;
		if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@")) return false;
		return JS_RESOLUTION_EXTENSIONS.some((suffix) => safeResolutionEntryExists(path.resolve(baseDir, `${spec}${suffix}`), rootDirectory));
	});
};
const collectTsPathAliases = (rootDir, workspaceDirs) => {
	const matchers = [];
	const visited = /* @__PURE__ */ new Set();
	let rootDirectory;
	try {
		rootDirectory = fs.realpathSync(rootDir);
	} catch {
		return matchers;
	}
	const dirs = collectPackageRootDirs(rootDirectory, workspaceDirs);
	for (const dir of dirs) {
		for (const fname of TS_CONFIG_FILES) collectAliasMatchersFromConfig(path.join(dir, fname), matchers, visited, rootDirectory);
		for (const fname of VITE_ALIAS_FILES) collectViteAliasesFromConfig(path.join(dir, fname), matchers, rootDirectory);
		collectPackageJsonImportMatchers(path.join(dir, "package.json"), matchers, rootDirectory);
	}
	return matchers;
};
//#endregion
//#region src/engines/ai-slop/python-import-map.ts
const PYTHON_IMPORT_TO_PIP = {
	yaml: ["pyyaml"],
	PIL: ["pillow"],
	dateutil: ["python-dateutil"],
	cv2: [
		"opencv-python",
		"opencv-python-headless",
		"opencv-contrib-python"
	],
	sklearn: ["scikit-learn"],
	bs4: ["beautifulsoup4"],
	typing_extensions: ["typing-extensions"],
	dotenv: ["python-dotenv"],
	genai: ["google-genai"],
	google: [
		"google-genai",
		"google-generativeai",
		"google-api-python-client",
		"google-cloud-storage",
		"google-cloud-aiplatform",
		"google-auth",
		"protobuf"
	],
	jose: ["python-jose"],
	jwt: ["pyjwt"],
	starlette: ["starlette", "fastapi"],
	asgiref: ["asgiref", "django"],
	OpenSSL: ["pyopenssl"],
	Crypto: ["pycryptodome", "pycryptodomex"],
	Cryptodome: ["pycryptodomex", "pycryptodome"],
	magic: ["python-magic"],
	docx: ["python-docx"],
	pptx: ["python-pptx"],
	git: ["gitpython"],
	github: ["pygithub"],
	socks: ["pysocks"],
	psycopg2: ["psycopg2-binary", "psycopg2"],
	redis: ["redis"],
	cairo: ["pycairo"],
	serial: ["pyserial"],
	usb: ["pyusb"],
	gi: ["pygobject"],
	Xlib: ["python-xlib"],
	ldap: ["python-ldap"],
	slugify: ["python-slugify"],
	memcache: ["python-memcached"],
	dns: ["dnspython"],
	attr: ["attrs"],
	attrs: ["attrs"],
	zoneinfo_data: ["tzdata"],
	pkg_resources: ["setuptools"],
	setuptools: ["setuptools"],
	wx: ["wxpython"],
	skimage: ["scikit-image"],
	OpenGL: ["pyopengl"],
	win32api: ["pywin32"],
	win32con: ["pywin32"],
	win32com: ["pywin32"],
	pythoncom: ["pywin32"],
	pywintypes: ["pywin32"],
	rest_framework: ["djangorestframework"],
	allauth: ["django-allauth"],
	corsheaders: ["django-cors-headers"],
	debug_toolbar: ["django-debug-toolbar"],
	environ: ["django-environ"],
	flask_cors: ["flask-cors"],
	flask_sqlalchemy: ["flask-sqlalchemy"],
	flask_migrate: ["flask-migrate"],
	flask_login: ["flask-login"],
	jwt_extended: ["flask-jwt-extended"],
	dateparser: ["dateparser"],
	yaml_include: ["pyyaml-include"],
	lxml_html_clean: ["lxml-html-clean"],
	grpc: ["grpcio"],
	grpc_status: ["grpcio-status"],
	google_crc32c: ["google-crc32c"],
	pkg_about: ["pkg-about"],
	mpl_toolkits: ["matplotlib"],
	dotmap: ["dotmap"],
	pydantic_settings: ["pydantic-settings"],
	telegram: ["python-telegram-bot"],
	discord: ["discord-py"],
	nacl: ["pynacl"],
	jwcrypto: ["jwcrypto"],
	humanfriendly: ["humanfriendly"],
	multipart: ["python-multipart"],
	paddle: ["paddlepaddle"],
	langchain_core: [
		"langchain-core",
		"langchain",
		"langchain-community"
	],
	langchain_community: ["langchain-community"],
	langchain_text_splitters: ["langchain-text-splitters"],
	huggingface_hub: ["huggingface-hub"],
	markdown_it: ["markdown-it-py"],
	cron_descriptor: ["cron-descriptor"],
	email_validator: ["email-validator"],
	e2b_code_interpreter: ["e2b-code-interpreter"],
	phonenumber_field: ["django-phonenumber-field"],
	frontmatter: ["python-frontmatter"],
	opentelemetry: ["opentelemetry-api", "opentelemetry-sdk"],
	ag_ui: ["ag-ui-protocol"]
};
//#endregion
//#region src/engines/ai-slop/python-stdlib.ts
const PYTHON_STDLIB = /* @__PURE__ */ new Set([
	"__future__",
	"_thread",
	"abc",
	"argparse",
	"array",
	"ast",
	"asyncio",
	"atexit",
	"base64",
	"binascii",
	"bisect",
	"builtins",
	"bz2",
	"calendar",
	"code",
	"codecs",
	"codeop",
	"collections",
	"concurrent",
	"configparser",
	"contextlib",
	"contextvars",
	"copy",
	"csv",
	"ctypes",
	"dataclasses",
	"datetime",
	"dbm",
	"decimal",
	"difflib",
	"dis",
	"doctest",
	"email",
	"encodings",
	"enum",
	"errno",
	"faulthandler",
	"filecmp",
	"fileinput",
	"fcntl",
	"fnmatch",
	"fractions",
	"ftplib",
	"functools",
	"gc",
	"getopt",
	"getpass",
	"gettext",
	"glob",
	"graphlib",
	"gzip",
	"hashlib",
	"heapq",
	"hmac",
	"html",
	"http",
	"imaplib",
	"importlib",
	"inspect",
	"io",
	"ipaddress",
	"itertools",
	"json",
	"keyword",
	"linecache",
	"locale",
	"logging",
	"lzma",
	"mailbox",
	"math",
	"mimetypes",
	"mmap",
	"multiprocessing",
	"msvcrt",
	"numbers",
	"operator",
	"os",
	"pathlib",
	"pdb",
	"pickle",
	"platform",
	"plistlib",
	"posixpath",
	"pprint",
	"profile",
	"pstats",
	"pty",
	"pwd",
	"queue",
	"quopri",
	"random",
	"re",
	"readline",
	"reprlib",
	"resource",
	"rlcompleter",
	"secrets",
	"select",
	"selectors",
	"shelve",
	"shlex",
	"shutil",
	"signal",
	"site",
	"smtplib",
	"socket",
	"socketserver",
	"sqlite3",
	"ssl",
	"stat",
	"statistics",
	"string",
	"stringprep",
	"struct",
	"subprocess",
	"sunau",
	"symtable",
	"sys",
	"sysconfig",
	"syslog",
	"tarfile",
	"telnetlib",
	"tempfile",
	"termios",
	"test",
	"textwrap",
	"threading",
	"time",
	"timeit",
	"tkinter",
	"token",
	"tokenize",
	"tomllib",
	"trace",
	"traceback",
	"tracemalloc",
	"tty",
	"turtle",
	"types",
	"typing",
	"unicodedata",
	"unittest",
	"urllib",
	"uu",
	"uuid",
	"venv",
	"warnings",
	"wave",
	"weakref",
	"webbrowser",
	"winreg",
	"winsound",
	"wsgiref",
	"xml",
	"xmlrpc",
	"zipapp",
	"zipfile",
	"zipimport",
	"zlib",
	"zoneinfo"
]);
//#endregion
//#region src/engines/ai-slop/hallucinated-imports.ts
const JS_EXTENSIONS$3 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const PY_EXTENSIONS$2 = /* @__PURE__ */ new Set([".py"]);
const extractPyImports = (content) => {
	const lines = content.split("\n");
	const results = [];
	let inDoc = null;
	let typeCheckIndent = -1;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		if (inDoc) {
			if (line.includes(inDoc)) inDoc = null;
			continue;
		}
		if (line === "" || line.startsWith("#")) continue;
		const triples = line.match(/"""|'''/g);
		if (triples) {
			if (triples.length % 2 === 1) inDoc = triples[triples.length - 1];
			continue;
		}
		const indent = raw.length - raw.trimStart().length;
		if (typeCheckIndent >= 0 && indent <= typeCheckIndent) typeCheckIndent = -1;
		if (/^if\s+(?:[\w.]+\.)?TYPE_CHECKING\b/.test(line)) {
			typeCheckIndent = indent;
			continue;
		}
		if (typeCheckIndent >= 0) continue;
		const fromMatch = line.match(/^from\s+([\w.]+)\s+import\b/);
		if (fromMatch && !fromMatch[1].startsWith(".")) {
			results.push({
				spec: fromMatch[1],
				line: i + 1
			});
			continue;
		}
		const importMatch = line.match(/^import\s+([\w.,\s]+?)(?:\s+as\s+\w+)?\s*$/);
		if (importMatch) for (const part of importMatch[1].split(",")) {
			const cleaned = part.trim().split(/\s+as\s+/)[0];
			if (cleaned && !cleaned.startsWith(".")) results.push({
				spec: cleaned,
				line: i + 1
			});
		}
	}
	return results;
};
const normalizePyName = (name) => name.toLowerCase().replace(/_/g, "-");
const isSafePythonModuleEntry = (candidate, rootDirectory, expectedType) => {
	try {
		const stats = fs.lstatSync(candidate);
		if (stats.isSymbolicLink()) return false;
		if (expectedType === "file" ? !stats.isFile() : !stats.isDirectory()) return false;
		const realPath = fs.realpathSync(candidate);
		const relative = path.relative(rootDirectory, realPath);
		return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
	} catch {
		return false;
	}
};
const isLocalPythonImport = (spec, filePath, rootDirectory) => {
	const modulePath = spec.split(".").join(path.sep);
	let root;
	let searchDirectory;
	try {
		root = fs.realpathSync(rootDirectory);
		searchDirectory = path.dirname(fs.realpathSync(filePath));
	} catch {
		return false;
	}
	while (searchDirectory === root || searchDirectory.startsWith(`${root}${path.sep}`)) {
		const candidate = path.join(searchDirectory, modulePath);
		if (isSafePythonModuleEntry(`${candidate}.py`, root, "file") || isSafePythonModuleEntry(candidate, root, "directory")) return true;
		if (searchDirectory === root) break;
		searchDirectory = path.dirname(searchDirectory);
	}
	return false;
};
const pyDepSatisfiesImportRoot = (root, pyDeps) => {
	const normalized = normalizePyName(root);
	for (const dep of pyDeps) if (dep === normalized || dep.startsWith(`${normalized}-`)) return true;
	return false;
};
const checkPyImport = (spec, pyDeps, filePath, rootDirectory) => {
	const root = spec.split(".")[0];
	if (PYTHON_STDLIB.has(root)) return null;
	if (isLocalPythonImport(spec, filePath, rootDirectory)) return null;
	if (pyDepSatisfiesImportRoot(root, pyDeps)) return null;
	const normalized = normalizePyName(root);
	if ((PYTHON_IMPORT_TO_PIP[root] ?? PYTHON_IMPORT_TO_PIP[normalized])?.some((dist) => pyDeps.has(normalizePyName(dist)))) return null;
	return root;
};
const detectHallucinatedImports = async (context) => {
	const rootPkg = readJson$1(path.join(context.rootDirectory, "package.json"), context.rootDirectory);
	const workspaceDirs = collectWorkspaceDirs(context.rootDirectory, rootPkg);
	const manifest = loadManifest(context.rootDirectory);
	if (!manifest.hasJsManifest && !manifest.hasPyManifest) return [];
	const tsAliasMatchers = manifest.hasJsManifest ? collectTsPathAliases(context.rootDirectory, workspaceDirs) : [];
	const diagnostics = [];
	const files = getSourceFiles(context);
	const projectFiles = getProjectSourceFiles(context);
	const declaredModuleMatchers = manifest.hasJsManifest ? collectDeclaredModuleMatchers(projectFiles, context.rootDirectory) : [];
	for (const filePath of files) {
		const ext = path.extname(filePath);
		const isJs = JS_EXTENSIONS$3.has(ext);
		const isPy = PY_EXTENSIONS$2.has(ext);
		if (!isJs && !isPy) continue;
		if (isJs && !manifest.hasJsManifest) continue;
		if (isPy && !manifest.hasPyManifest) continue;
		if (isAutoGenerated(filePath)) continue;
		const pyDeps = isPy ? pythonDepsForFile(manifest, filePath, context.rootDirectory) : null;
		const pyImportRoot = isPy ? pythonImportRootForFile(manifest, filePath, context.rootDirectory) : context.rootDirectory;
		if (isPy && !pyDeps) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relPath = relativePosix(context.rootDirectory, filePath);
		if (isNonProductionPath(relPath)) continue;
		const jsDeps = isJs ? jsDepsForFile(manifest, filePath, context.rootDirectory) : null;
		const imports = isJs ? extractJsImports(content) : extractPyImports(content);
		for (const { spec, line } of imports) {
			const hallucinated = isJs ? checkJsImport(spec, jsDeps ?? manifest.jsDeps, tsAliasMatchers, declaredModuleMatchers, filePath, context.rootDirectory) : checkPyImport(spec, pyDeps ?? manifest.pyDeps, filePath, pyImportRoot);
			if (!hallucinated) continue;
			const manifestLabel = isJs ? "package.json" : "requirements.txt / pyproject.toml / Pipfile";
			diagnostics.push({
				filePath: relPath,
				engine: "ai-slop",
				rule: "ai-slop/hallucinated-import",
				severity: "error",
				message: `Imports "${hallucinated}" but it's not declared in ${manifestLabel}${isPy ? " and isn't Python stdlib" : ""}`,
				help: "Most often this is an LLM hallucinating a plausible-sounding package name. Either add the package to your manifest, or correct the import.",
				line,
				column: 1,
				category: "AI Slop",
				fixable: false
			});
		}
	}
	return diagnostics;
};
//#endregion
//#region src/utils/python-docstrings.ts
const DOCSTRING_OPENER_RE = /^\s*[rRuUbBfF]{0,3}("""|''')/;
const scanPythonDocstrings = (lines) => {
	const tripleQuotedStringLines = /* @__PURE__ */ new Set();
	const docstringLines = /* @__PURE__ */ new Set();
	let openDelimiter = null;
	let openIsDocstring = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (openDelimiter) {
			tripleQuotedStringLines.add(i);
			if (openIsDocstring) docstringLines.add(i);
			if (line.includes(openDelimiter)) openDelimiter = null;
			continue;
		}
		const doubleIndex = line.indexOf("\"\"\"");
		const singleIndex = line.indexOf("'''");
		const firstIndex = doubleIndex === -1 ? singleIndex : singleIndex === -1 ? doubleIndex : Math.min(doubleIndex, singleIndex);
		if (firstIndex === -1) continue;
		const delimiter = firstIndex === doubleIndex ? "\"\"\"" : "'''";
		const openerMatch = DOCSTRING_OPENER_RE.exec(line);
		const isDocstringPositioned = openerMatch !== null && openerMatch[1] === delimiter;
		if (line.indexOf(delimiter, firstIndex + delimiter.length) === -1) {
			openDelimiter = delimiter;
			openIsDocstring = isDocstringPositioned;
			tripleQuotedStringLines.add(i);
			if (isDocstringPositioned) docstringLines.add(i);
		} else if (isDocstringPositioned) {
			tripleQuotedStringLines.add(i);
			docstringLines.add(i);
		}
	}
	return {
		tripleQuotedStringLines,
		docstringLines
	};
};
//#endregion
//#region src/engines/ai-slop/hardcoded-config.ts
const SOURCE_EXTENSIONS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".rb",
	".java",
	".php"
]);
const URL_LITERAL_RE = /(["'`])(https?:\/\/[^"'`\s<>]+)\1/g;
const ID_LITERAL_RE = /(["'])([A-Za-z][A-Za-z0-9_-]{15,})\1/g;
const ENV_REFERENCE_RE = /\b(?:process\.env|import\.meta\.env|Deno\.env|os\.environ|getenv|env\()\b/i;
const DOC_URL_CONTEXT_RE = /\b(?:docs?|documentation|homepage|repository|bugs|license|readme|source|svgUrl|pageUrl|href|link|install)\b/i;
const URL_CONFIG_CONTEXT_RE = /\b(?:api|base[_-]?url|baseUrl|endpoint|host|origin|webhook|callback|redirect|server|service|domain|url)\b/i;
const ENVIRONMENT_HOST_RE = /(?:^|[.-])(?:api|app|admin|auth|staging|stage|prod|dev|sandbox|webhook|internal)(?:[.-]|$)|^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)$/i;
const ID_CONTEXT_RE = /(?:^|[^A-Za-z0-9])(?:api[_-]?key|client[_-]?id|project[_-]?id|org(?:anization)?[_-]?id|workspace[_-]?id|tenant[_-]?id|price[_-]?id|product[_-]?id|customer[_-]?id|subscription[_-]?id|account[_-]?id|app[_-]?id|key|token|secret)(?:$|[^A-Za-z0-9])/i;
const MIGRATION_PATH_RE$1 = /(?:^|[\\/])(?:migrations?|db[\\/]migrate)[\\/]/i;
const PLACEHOLDER_HOSTS = /* @__PURE__ */ new Set([
	"example.com",
	"example.org",
	"example.net"
]);
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"0.0.0.0",
	"::1"
]);
const VENDOR_API_DOMAINS = [
	"github.com",
	"githubusercontent.com",
	"googleapis.com",
	"accounts.google.com",
	"stripe.com",
	"openai.com",
	"anthropic.com",
	"slack.com",
	"twilio.com",
	"sendgrid.com",
	"mailgun.net",
	"cloudflare.com",
	"discord.com",
	"telegram.org",
	"login.microsoftonline.com",
	"graph.microsoft.com",
	"twitter.com",
	"x.com",
	"twimg.com",
	"t.co",
	"api.telegram.org"
];
const isVendorApiHost = (host) => VENDOR_API_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
const PLACEHOLDER_ID_RE = /^(?:changeme|replace[_-]?me|your[_-]|example|placeholder|todo)/i;
const PROVIDER_ID_RE = /^(?:price|prod|cus|sub|acct|org|app|tenant|workspace|project|client|key|tok|token|sk|pk)_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READABLE_KEY_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+){2,}$/;
const HARDCODED_URL_FINDING = {
	rule: "ai-slop/hardcoded-url",
	message: "Hardcoded environment URL in production code",
	help: "Move deployment-specific URLs to environment variables (.env) or track with '// AGENT:HARDCODE [scope]: reason'."
};
const HARDCODED_ID_FINDING = {
	rule: "ai-slop/hardcoded-id",
	message: "Hardcoded provider/project ID in production code",
	help: "Move provider IDs, tenant IDs, price IDs, and similar deployment-specific identifiers to env/config so agents do not bake one environment into source."
};
const makeFinding = (filePath, line, spec) => ({
	filePath,
	engine: "ai-slop",
	rule: spec.rule,
	severity: "warning",
	message: spec.message,
	help: spec.help,
	line,
	column: 0,
	category: "AI Slop",
	fixable: false
});
const isCommentOnlyLine = (trimmed) => trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*");
const commentStartsBefore = (line, index, ext) => {
	const prefix = line.slice(0, index);
	if (ext === ".py" || ext === ".rb") return prefix.includes("#");
	if (ext === ".php") return prefix.includes("//") || prefix.includes("#");
	return prefix.includes("//") || prefix.includes("/*");
};
const safeUrlHost = (urlText) => {
	try {
		return new URL(urlText).hostname.toLowerCase();
	} catch {
		return null;
	}
};
const isEnvBackedLine = (line) => ENV_REFERENCE_RE.test(line);
const TEMPLATE_INTERPOLATION_START = "${";
const shouldFlagUrlLiteral = (line, urlText) => {
	if (line.includes("AGENT:HARDCODE")) return false;
	if (isEnvBackedLine(line)) return false;
	if (urlText.includes(TEMPLATE_INTERPOLATION_START) && /\bnew\s+URL\s*\(/.test(line)) return false;
	const host = safeUrlHost(urlText);
	if (!host) return false;
	if (PLACEHOLDER_HOSTS.has(host)) return false;
	if (LOOPBACK_HOSTS.has(host)) return !line.includes("AGENT:HARDCODE");
	if (isVendorApiHost(host)) return false;
	if (DOC_URL_CONTEXT_RE.test(line) && !ENVIRONMENT_HOST_RE.test(host)) return false;
	return URL_CONFIG_CONTEXT_RE.test(line) || ENVIRONMENT_HOST_RE.test(host);
};
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const hasUsefulIdShape = (value) => {
	if (PLACEHOLDER_ID_RE.test(value)) return false;
	if (ENV_VAR_NAME_RE.test(value)) return false;
	if (/^https?:\/\//i.test(value)) return false;
	if (/^[A-Za-z]+$/.test(value)) return false;
	if (READABLE_KEY_RE.test(value) && !PROVIDER_ID_RE.test(value)) return false;
	if (PROVIDER_ID_RE.test(value)) return true;
	if (UUID_RE.test(value)) return true;
	if (!/[0-9]/.test(value)) return false;
	return value.length >= 24 && !/[_-]/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value);
};
const scanLineForConfigLiterals = (line, relativePath, ext, lineNumber, isDocstringLine) => {
	const diagnostics = [];
	const trimmed = line.trim();
	if (isCommentOnlyLine(trimmed)) return diagnostics;
	for (const urlMatch of line.matchAll(URL_LITERAL_RE)) {
		const urlText = urlMatch[2];
		if (commentStartsBefore(line, urlMatch.index, ext)) continue;
		if (isDocstringLine) continue;
		if (!shouldFlagUrlLiteral(line, urlText)) continue;
		diagnostics.push(makeFinding(relativePath, lineNumber, HARDCODED_URL_FINDING));
	}
	if (!ID_CONTEXT_RE.test(line) || isEnvBackedLine(line) || DOC_URL_CONTEXT_RE.test(line)) return diagnostics;
	for (const idMatch of line.matchAll(ID_LITERAL_RE)) {
		const value = idMatch[2];
		if (commentStartsBefore(line, idMatch.index, ext)) continue;
		if (!hasUsefulIdShape(value)) continue;
		diagnostics.push(makeFinding(relativePath, lineNumber, HARDCODED_ID_FINDING));
	}
	return diagnostics;
};
const scanFileForConfigLiterals = (maskedContent, rawContent, relativePath, ext) => {
	if (!SOURCE_EXTENSIONS.has(ext)) return [];
	if (isNonProductionPath(relativePath)) return [];
	if (MIGRATION_PATH_RE$1.test(relativePath)) return [];
	const lines = maskedContent.split("\n");
	const rawLines = rawContent.split("\n");
	const docstringLines = ext === ".py" ? scanPythonDocstrings(lines).docstringLines : null;
	return lines.flatMap((line, index) => {
		const rawLine = rawLines[index] ?? "";
		const prevRawLine = index > 0 ? rawLines[index - 1] ?? "" : "";
		if (rawLine.includes("AGENT:HARDCODE") || prevRawLine.includes("AGENT:HARDCODE")) return [];
		return scanLineForConfigLiterals(line, relativePath, ext, index + 1, docstringLines?.has(index) ?? false);
	});
};
const detectHardcodedConfigLiterals = async (context) => {
	const diagnostics = [];
	for (const filePath of getSourceFiles(context)) {
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relativePath = relativePosix(context.rootDirectory, filePath);
		const ext = path.extname(filePath);
		diagnostics.push(...scanFileForConfigLiterals(maskComments(content, ext), content, relativePath, ext));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/hidden-fallback.ts
const JS_TS_EXTENSIONS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const HIDDEN_FALLBACK_CONTEXT_RE = /\b(?:fallback|direct\s+api|just in case|should never happen|impossible|missing|not provided|doesn'?t provide|caller\s+doesn'?t\s+provide|failed|failure|invalid|no diagnostics|no results|no files|empty diagnostics|empty results|empty files)\b/i;
const FAILURE_STATE_NAME_RE = /\b(?:count|total|diagnostic|diagnostics|file|files|sourcefile|result|results|error|errors|failure|failed|invalid|missing|state|status|success|response|output|input)\b/i;
const FAILURE_STATE_COMPACT_RE = /(?:count|diagnostic|file|sourcefile|result|error|failure|failed|invalid|missing|state|status|success|response|output|input)/;
const DEFAULT_VALUE_NAME_RE = /^(?:default(?:value|result|count)?|fallback(?:value|result|count)?|empty(?:result|response|list|array)?|success(?:result|response)?|ok(?:result|response)?)$/i;
const LOG_OR_THROW_RE = /\b(?:throw|console\.(?:debug|info|warn|warning|error|log)|(?:logger|log)\.(?:debug|info|warn|warning|error|exception|log))\b/;
const STATUS_TOKEN_RE = /^(?:ok|okay|success|succeeded|passed?|valid|healthy|done|ready|active|enabled|true|yes|good|online|live)$/i;
const scriptKindFor = (ext) => {
	switch (ext) {
		case ".tsx": return ts.ScriptKind.TSX;
		case ".jsx": return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs": return ts.ScriptKind.JS;
		default: return ts.ScriptKind.TS;
	}
};
const lineFor = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
const makeHiddenFallbackDiagnostic = (filePath, line, message, help) => ({
	filePath,
	engine: "ai-slop",
	rule: "ai-slop/hidden-fallback",
	severity: "warning",
	message,
	help,
	line,
	column: 0,
	category: "AI Slop",
	fixable: false
});
const nameTextOf = (name) => {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return null;
};
const isTrueLike = (expression) => expression.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteral(expression) && /^(?:true|ok|success)$/i.test(expression.text);
const isSuccessLikeObject = (expression) => expression.properties.some((property) => {
	if (!ts.isPropertyAssignment(property)) return false;
	const name = nameTextOf(property.name);
	return name !== null && /^(?:ok|success|status)$/i.test(name) && isTrueLike(property.initializer);
});
const isSafeLookingDefault = (expression) => {
	if (ts.isNumericLiteral(expression) || ts.isStringLiteral(expression) || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return true;
	if (ts.isIdentifier(expression)) return expression.text === "undefined" || DEFAULT_VALUE_NAME_RE.test(expression.text);
	if (ts.isArrayLiteralExpression(expression)) return expression.elements.length === 0;
	if (ts.isObjectLiteralExpression(expression)) return expression.properties.length === 0 || isSuccessLikeObject(expression);
	return false;
};
const expressionText = (sourceFile, expression) => expression.getText(sourceFile);
const expressionNamesFailureState = (sourceFile, expression) => {
	const text = expressionText(sourceFile, expression);
	const compact = text.toLowerCase().replace(/[^a-z0-9]/g, "");
	return FAILURE_STATE_NAME_RE.test(text) || FAILURE_STATE_COMPACT_RE.test(compact);
};
const defaultLooksLikeFallback = (expression) => ts.isIdentifier(expression) && DEFAULT_VALUE_NAME_RE.test(expression.text);
const isMathMinMaxFallback = (sourceFile, expression) => {
	if (!ts.isPropertyAccessExpression(expression.expression)) return false;
	const target = expression.expression;
	if (!ts.isIdentifier(target.expression) || target.expression.text !== "Math") return false;
	if (target.name.text !== "max" && target.name.text !== "min") return false;
	if (expression.arguments.length < 2) return false;
	const hasNumericDefault = expression.arguments.some((arg) => ts.isNumericLiteral(arg));
	const hasFailureStateArgument = expression.arguments.some((arg) => expressionNamesFailureState(sourceFile, arg));
	return hasNumericDefault && hasFailureStateArgument;
};
const isEnvAccess = (expression) => {
	if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
	const target = expression.expression;
	return ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === "process" && target.name.text === "env";
};
const isHiddenFallbackExpression = (sourceFile, expression) => {
	if (ts.isBinaryExpression(expression)) {
		if (!(expression.operatorToken.kind === ts.SyntaxKind.BarBarToken || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) || !isSafeLookingDefault(expression.right)) return false;
		if (isEnvAccess(expression.left)) return false;
		if (ts.isStringLiteral(expression.right) && !STATUS_TOKEN_RE.test(expression.right.text)) return false;
		return defaultLooksLikeFallback(expression.right) || expressionNamesFailureState(sourceFile, expression.left) || expressionNamesFailureState(sourceFile, expression);
	}
	return ts.isCallExpression(expression) && isMathMinMaxFallback(sourceFile, expression);
};
const nearbyText = (sourceFile, node) => {
	const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
	const lines = sourceFile.text.split(/\r?\n/);
	return lines.slice(Math.max(0, line - 4), Math.min(lines.length, line + 1)).join("\n");
};
const hasHiddenFallbackContext = (sourceFile, node) => HIDDEN_FALLBACK_CONTEXT_RE.test(nearbyText(sourceFile, node));
const catchSurfacesFailure = (sourceFile, catchClause, returnExpression) => {
	const bodyText = catchClause.block.getText(sourceFile);
	if (LOG_OR_THROW_RE.test(bodyText)) return true;
	const binding = catchClause.variableDeclaration?.name;
	if (!binding || !ts.isIdentifier(binding)) return false;
	return new RegExp(`\\b${binding.text}\\b`).test(returnExpression.getText(sourceFile));
};
const isSuccessLikeReturn = (expression) => ts.isObjectLiteralExpression(expression) && isSuccessLikeObject(expression);
const shouldFlagCatchFallback = (sourceFile, catchClause, expression) => hasHiddenFallbackContext(sourceFile, catchClause) || defaultLooksLikeFallback(expression) || isSuccessLikeReturn(expression) || isHiddenFallbackExpression(sourceFile, expression);
const detectHiddenCatchFallback = (sourceFile, catchClause, relativePath, diagnostics) => {
	for (const statement of catchClause.block.statements) {
		if (!ts.isReturnStatement(statement) || !statement.expression) continue;
		const expression = statement.expression;
		if (!isSafeLookingDefault(expression) && !isHiddenFallbackExpression(sourceFile, expression)) continue;
		if (!shouldFlagCatchFallback(sourceFile, catchClause, expression)) continue;
		if (catchSurfacesFailure(sourceFile, catchClause, expression)) continue;
		diagnostics.push(makeHiddenFallbackDiagnostic(relativePath, lineFor(sourceFile, statement), "Catch returns a safe-looking fallback without surfacing the failure", "Log or return the failure explicitly, rethrow with context, or make the fallback an intentional typed outcome."));
	}
};
const detectHiddenFallbacksInSource = (sourceFile, relativePath) => {
	const diagnostics = [];
	const reportIfHiddenFallback = (node, expression) => {
		if (!hasHiddenFallbackContext(sourceFile, node)) return;
		if (!isHiddenFallbackExpression(sourceFile, expression)) return;
		diagnostics.push(makeHiddenFallbackDiagnostic(relativePath, lineFor(sourceFile, node), "Fallback turns missing, failed, or impossible state into a safe-looking value", "Handle the missing input explicitly: require the value, return a typed error, or name the conservative estimate so callers know it is not authoritative."));
	};
	const visit = (node) => {
		if (ts.isReturnStatement(node) && node.expression) reportIfHiddenFallback(node, node.expression);
		if (ts.isVariableDeclaration(node) && node.initializer) reportIfHiddenFallback(node, node.initializer);
		if (ts.isCatchClause(node)) detectHiddenCatchFallback(sourceFile, node, relativePath, diagnostics);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return diagnostics;
};
const detectHiddenFallbacks = async (context) => {
	const diagnostics = [];
	for (const filePath of getSourceFiles(context)) {
		if (isAutoGenerated(filePath)) continue;
		const ext = path.extname(filePath);
		if (!JS_TS_EXTENSIONS.has(ext)) continue;
		const relativePath = relativePosix(context.rootDirectory, filePath);
		if (isNonProductionPath(relativePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKindFor(ext));
		const rawLines = content.split("\n");
		for (const diag of detectHiddenFallbacksInSource(sourceFile, relativePath)) {
			let hasAgentTag = false;
			const targetLine = (diag.line ?? 1) - 1;
			for (let offset = 0; offset <= 5; offset++) {
				const l = targetLine - offset;
				if (l >= 0 && rawLines[l]?.includes("AGENT:")) {
					hasAgentTag = true;
					break;
				}
			}
			if (!hasAgentTag) diagnostics.push(diag);
		}
	}
	return diagnostics;
};
//#endregion
//#region src/utils/suppress.ts
const DIRECTIVE_RE = /^\s*(?:\/\/|\/\*+|#|<!--|\*)\s*aislop-ignore-(next-line|line|file)\b([^\n]*)/;
const INLINE_COMMENT_MARKERS = [
	"//",
	"/*",
	"#",
	"<!--"
];
const isAislopDirectiveLine = (line) => findDirective(line) !== null;
const findDirective = (line) => {
	const leading = DIRECTIVE_RE.exec(line);
	if (leading) return leading;
	let quote = null;
	let escaped = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "\"" || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (INLINE_COMMENT_MARKERS.some((marker) => line.startsWith(marker, i))) {
			const match = DIRECTIVE_RE.exec(line.slice(i));
			if (match) return match;
		}
	}
	return null;
};
const parseDirective = (rest) => {
	const tokens = rest.split("--")[0].match(/[A-Za-z0-9@][\w@/.-]*/g) ?? [];
	if (tokens.length === 0) return {
		rules: /* @__PURE__ */ new Set(),
		all: true
	};
	return {
		rules: new Set(tokens),
		all: false
	};
};
const covers = (directive, rule) => directive.all || [...directive.rules].some((r) => r === rule || rule.endsWith(`/${r}`));
const parseFileDirectives = (content) => {
	const lines = content.split(/\r?\n/);
	const file = [];
	const byLine = /* @__PURE__ */ new Map();
	const addLine = (target, directive) => {
		const list = byLine.get(target) ?? [];
		list.push(directive);
		byLine.set(target, list);
	};
	for (let i = 0; i < lines.length; i++) {
		const match = findDirective(lines[i]);
		if (!match) continue;
		const scope = match[1];
		const directive = parseDirective(match[2] ?? "");
		if (scope === "file") file.push(directive);
		else if (scope === "next-line") addLine(i + 2, directive);
		else addLine(i + 1, directive);
	}
	return {
		file,
		byLine
	};
};
const applySuppressions = (results, rootDirectory) => {
	const cache = /* @__PURE__ */ new Map();
	let suppressedCount = 0;
	const load = (filePath) => {
		const cached = cache.get(filePath);
		if (cached !== void 0) return cached;
		const absolute = path.isAbsolute(filePath) ? filePath : path.join(rootDirectory, filePath);
		let parsed = null;
		try {
			parsed = parseFileDirectives(fs.readFileSync(absolute, "utf-8"));
		} catch {
			parsed = null;
		}
		cache.set(filePath, parsed);
		return parsed;
	};
	const isSuppressed = (diagnostic) => {
		const directives = load(diagnostic.filePath);
		if (!directives) return false;
		if (directives.file.some((d) => covers(d, diagnostic.rule))) return true;
		return (directives.byLine.get(diagnostic.line) ?? []).some((d) => covers(d, diagnostic.rule));
	};
	return {
		results: results.map((result) => {
			const kept = result.diagnostics.filter((diagnostic) => {
				if (isSuppressed(diagnostic)) {
					suppressedCount += 1;
					return false;
				}
				return true;
			});
			return {
				...result,
				diagnostics: kept
			};
		}),
		suppressedCount
	};
};
//#endregion
//#region src/engines/ai-slop/comment-blocks.ts
const stripJsdocLine = (line) => line.replace(/^\s*\/\*\*+\s?/, "").replace(/\s*\*+\/\s*$/, "").replace(/^\s*\*\s?/, "").trim();
const stripLineComment = (line) => line.replace(/^\s*(?:(?:\/\/)|#)\s?/, "");
const getCommentSyntax = (ext) => {
	switch (ext) {
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
		case ".go":
		case ".rs":
		case ".java":
		case ".cs": return { linePrefixes: ["//"] };
		case ".py":
		case ".rb": return { linePrefixes: ["#"] };
		case ".php": return { linePrefixes: ["//", "#"] };
		default: return null;
	}
};
const getMatchedLinePrefix = (line, syntax) => {
	const trimmed = line.trimStart();
	if (isAislopDirectiveLine(trimmed)) return null;
	for (const prefix of syntax.linePrefixes) {
		if (!trimmed.startsWith(prefix)) continue;
		if (prefix === "#" && trimmed.startsWith("#!")) return null;
		return prefix;
	}
	return null;
};
const isRustDocCommentLine = (line) => {
	const trimmed = line.trimStart();
	return trimmed.startsWith("///") || trimmed.startsWith("//!");
};
const collectBlocks = (sourceLines, syntax) => {
	const blocks = [];
	let i = 0;
	while (i < sourceLines.length) {
		const line = sourceLines[i];
		const trimmed = line.trim();
		if (getMatchedLinePrefix(line, syntax) !== null) {
			const start = i;
			const raw = [];
			while (i < sourceLines.length && getMatchedLinePrefix(sourceLines[i], syntax) !== null) {
				raw.push(sourceLines[i]);
				i += 1;
			}
			let next = i;
			while (next < sourceLines.length && sourceLines[next].trim() === "") next += 1;
			const docCandidates = raw.filter((l) => l.trim().length > 0);
			const isRustDoc = docCandidates.length > 0 && docCandidates.every((l) => isRustDocCommentLine(l));
			blocks.push({
				kind: "line",
				startLine: start + 1,
				endLine: start + raw.length,
				rawLines: raw,
				prose: raw.map(stripLineComment),
				hasMeaningfulJsdocTag: false,
				isRustDoc,
				nextNonBlankLine: next < sourceLines.length ? sourceLines[next] : null
			});
			continue;
		}
		if (trimmed.startsWith("/**")) {
			const start = i;
			const raw = [sourceLines[i]];
			let hasClose = /\*\/\s*$/.test(sourceLines[i]) && sourceLines[i].trim() !== "/**";
			i += 1;
			while (!hasClose && i < sourceLines.length) {
				raw.push(sourceLines[i]);
				if (/\*\/\s*$/.test(sourceLines[i])) hasClose = true;
				i += 1;
			}
			let next = i;
			while (next < sourceLines.length && sourceLines[next].trim() === "") next += 1;
			const prose = raw.map(stripJsdocLine).filter((l) => l.length > 0 && !l.startsWith("@"));
			const tagNames = [];
			for (const line of raw) {
				const stripped = stripJsdocLine(line);
				if (stripped.startsWith("@")) {
					const tagMatch = stripped.match(/^@(\w+)/);
					if (tagMatch) tagNames.push(tagMatch[1].toLowerCase());
				}
			}
			const hasMeaningful = tagNames.some((t) => MEANINGFUL_JSDOC_TAGS.has(t));
			blocks.push({
				kind: "jsdoc",
				startLine: start + 1,
				endLine: start + raw.length,
				rawLines: raw,
				prose,
				hasMeaningfulJsdocTag: hasMeaningful,
				isRustDoc: false,
				nextNonBlankLine: next < sourceLines.length ? sourceLines[next] : null
			});
			continue;
		}
		i += 1;
	}
	return blocks;
};
//#endregion
//#region src/engines/ai-slop/meta-comment.ts
const PLAN_REFERENCE_RES = [
	/^(?:stage|step|phase)\s+\d+\s*[:.\-–—]/i,
	/\bstep\s+\d+\s+of\s+the\s+plan\b/i,
	/\bas\s+(?:per|requested)\s+(?:the\s+)?(?:requirements?|spec|task|ticket|prompt|instructions?)\b/i,
	/\bper\s+the\s+(?:spec|requirements?|task|ticket|plan|prompt|instructions?)\b/i,
	/\bfrom\s+the\s+(?:task|todo|plan|spec|ticket|prompt|requirements?)\b/i,
	/\bimplement(?:ing|s|ed)?\s+use\s*case\s+\d*/i,
	/\b(?:requirements?\s+doc|requirement\s+\d+)\b/i,
	/\bas\s+(?:instructed|specified|outlined)\s+(?:above|below|in\s+the)\b/i
];
const BEFORE_AFTER_RES = [
	/\bpreviously[,:]?\s+(?:this|we|it|the)\b/i,
	/\bused\s+to\s+(?:be|use|call|return|do|have|rely)\b/i,
	/\bchanged\s+(?:\w+\s+){0,3}from\s+.+\bto\b/i,
	/\bno\s+longer\s+(?:needed|used|required|necessary|calls?|returns?|does)\b/i,
	/\bthis\s+was\s+.+\bbut\s+now\b/i,
	/\bwe\s+(?:now|used\s+to)\s+(?:no\s+longer\s+)?(?:use|call|return|do|have)\b/i,
	/\breplaced\s+the\s+(?:old|previous|former)\b/i,
	/\b(?:was|were)\s+(?:renamed|moved|removed|refactored|extracted)\s+(?:from|to|out\s+of)\b/i
];
const WHY_OR_TODO_RE = /\b(?:because|since|otherwise|todo|fixme|hack|note:|reason:|workaround|see\s+(?:issue|#))\b/i;
const looksLikeLicenseHeader$1 = (block) => {
	if (block.startLine !== 1) return false;
	const text = block.rawLines.join(" ").toLowerCase();
	return text.includes("copyright") || text.includes("license") || text.includes("spdx-license-identifier");
};
const looksLikeSuppressDirective$1 = (block) => block.rawLines.some((line) => /\b(?:biome-ignore|eslint-disable|ts-ignore|ts-expect-error|@ts-\w+|noqa|pylint:\s*disable|rubocop:disable|noinspection|phpcs:disable)\b/.test(line));
const matchMetaSignal = (block) => {
	if (looksLikeLicenseHeader$1(block)) return null;
	if (looksLikeSuppressDirective$1(block)) return null;
	if (block.kind === "jsdoc" && block.hasMeaningfulJsdocTag) return null;
	if (block.isRustDoc) return null;
	const joined = block.prose.join(" ");
	if (joined.trim().length === 0) return null;
	if (WHY_OR_TODO_RE.test(joined)) return null;
	if (PLAN_REFERENCE_RES.some((re) => re.test(joined))) return "plan/process reference";
	if (BEFORE_AFTER_RES.some((re) => re.test(joined))) return "before/after state narration";
	return null;
};
const detectMetaComments = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		const ext = path.extname(filePath);
		if (!SUPPORTED_EXTS.has(ext)) continue;
		if (isAutoGenerated(filePath)) continue;
		const syntax = getCommentSyntax(ext);
		if (!syntax) continue;
		const relativePath = relativePosix(context.rootDirectory, filePath);
		if (isNonProductionPath(relativePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const blocks = collectBlocks(content.split("\n"), syntax);
		for (const block of blocks) {
			const reason = matchMetaSignal(block);
			if (!reason) continue;
			diagnostics.push({
				filePath: relativePath,
				engine: "ai-slop",
				rule: "ai-slop/meta-comment",
				severity: "warning",
				message: `Meta/plan comment (${reason})`,
				help: "Remove — references to the build plan or before/after code state belong in PR descriptions and commit messages, not source.",
				line: block.startLine,
				column: 0,
				category: "Comments",
				fixable: false
			});
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/narrative-comments.ts
const looksLikeDeclarationPreamble = (nextLine, ext) => {
	if (nextLine === null) return false;
	if (DECL_START.test(nextLine) || EXPORT_DEFAULT.test(nextLine)) return true;
	switch (ext) {
		case ".py": return PY_DECL_START.test(nextLine);
		case ".go": return GO_DECL_START.test(nextLine);
		case ".rs": return RUST_DECL_START.test(nextLine);
		case ".rb": return RUBY_DECL_START.test(nextLine);
		case ".java": return JAVA_DECL_START.test(nextLine) || JAVA_DECL_START_FALLBACK.test(nextLine);
		case ".php": return PHP_DECL_START.test(nextLine);
		case ".cs": return CSHARP_DECL_START.test(nextLine) || CSHARP_DECL_START_FALLBACK.test(nextLine);
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs": return TS_MEMBER_DECL_START.test(nextLine);
		default: return false;
	}
};
const looksLikeLicenseHeader = (block) => {
	if (block.startLine !== 1) return false;
	const text = block.rawLines.join(" ").toLowerCase();
	return text.includes("copyright") || text.includes("license") || text.includes("spdx-license-identifier");
};
const looksLikeSuppressDirective = (block) => block.rawLines.some((l) => /\b(biome-ignore|eslint-disable|ts-ignore|ts-expect-error|@ts-\w+|noqa|pylint:\s*disable|rubocop:disable|noinspection|phpcs:disable)\b/.test(l));
const GO_DECL_NAME_RE = /^(?:func|type|var|const)\s+(?:\([^)]*\)\s*)?(\w+)/;
const GO_FIELD_LEAD_RE = /^(\w+)\s+/;
const GO_KEYWORDS = /* @__PURE__ */ new Set([
	"return",
	"if",
	"for",
	"switch",
	"case",
	"default",
	"go",
	"select",
	"defer",
	"else",
	"break",
	"continue",
	"goto",
	"package",
	"import",
	"map",
	"chan",
	"range"
]);
const looksLikeGoDocComment = (block, ext) => {
	if (ext !== ".go" || block.kind !== "line") return false;
	const next = block.nextNonBlankLine;
	if (!next) return false;
	const trimmedNext = next.trim();
	const firstWord = (block.prose.find((l) => l.length > 0) ?? "").split(/\s+/)[0] ?? "";
	const declMatch = GO_DECL_NAME_RE.exec(trimmedNext);
	if (declMatch && firstWord === declMatch[1]) return true;
	const fieldMatch = GO_FIELD_LEAD_RE.exec(trimmedNext);
	if (fieldMatch && !GO_KEYWORDS.has(fieldMatch[1]) && firstWord === fieldMatch[1]) return true;
	return false;
};
const RUBY_DOC_INDICATORS = /^\s*#\s*(?:#|@\w+|:[\w-]+:|=begin|=end)/;
const looksLikeRubyDocBlock = (block, ext) => {
	if (ext !== ".rb" || block.kind !== "line") return false;
	return block.rawLines.some((line) => RUBY_DOC_INDICATORS.test(line));
};
const DOC_INDICATOR_RE = /`[^`]+`|\|\s*[-:]+\s*\||```|\b(?:note|warning|warn|caveat|example|caution|see|todo|fixme|hack|reason|deprecated|deprecation|migration|legacy|historical|context):|\(e\.g\.[^)]+\)|\(i\.e\.[^)]+\)|\b\w+\.\w+(?:\.\w+)+\b|\[[\w/.-]+\]/i;
const hasDocIndicator = (block) => {
	const joined = block.prose.join(" ");
	if (DOC_INDICATOR_RE.test(joined)) return true;
	for (const l of block.prose) if (/^[-]\s/.test(l)) return true;
	return false;
};
const hasPreambleSlopSignal = (block) => {
	const joined = block.prose.join(" ");
	for (const l of block.prose) {
		if (EXPLANATORY_OPENERS.test(l)) return true;
		if (JUSTIFICATION_OPENERS.some((re) => re.test(l))) return true;
	}
	return CROSS_REFERENCE_PHRASES.some((re) => re.test(joined));
};
const detectNarrativeInBlock = (block, ext) => {
	if (looksLikeLicenseHeader(block)) return {
		matched: false,
		reason: ""
	};
	if (looksLikeSuppressDirective(block)) return {
		matched: false,
		reason: ""
	};
	if (block.kind === "jsdoc" && block.hasMeaningfulJsdocTag) return {
		matched: false,
		reason: ""
	};
	if (block.isRustDoc) return {
		matched: false,
		reason: ""
	};
	if (looksLikeGoDocComment(block, ext)) return {
		matched: false,
		reason: ""
	};
	if (looksLikeRubyDocBlock(block, ext)) return {
		matched: false,
		reason: ""
	};
	if (block.kind === "line" && block.prose.some((l) => DECORATIVE_SEPARATOR.test(l) || DECORATIVE_SECTION_HEADER.test(l))) return {
		matched: true,
		reason: "decorative separator"
	};
	if (block.kind === "line" && block.prose.some((l) => SECTION_HEADER.test(l))) return {
		matched: true,
		reason: "phase/section header"
	};
	const joined = block.prose.join(" ");
	const hasWhyMarker = EXPLANATORY_WHY_MARKERS.test(joined);
	if (hasWhyMarker || hasDocIndicator(block)) return {
		matched: false,
		reason: ""
	};
	if (block.kind === "line" && block.prose.length >= 3 && looksLikeDeclarationPreamble(block.nextNonBlankLine, ext) && hasPreambleSlopSignal(block)) return {
		matched: true,
		reason: "multi-line preamble before declaration"
	};
	if (block.kind === "jsdoc" && block.prose.length >= 3 && looksLikeDeclarationPreamble(block.nextNonBlankLine, ext) && hasPreambleSlopSignal(block)) return {
		matched: true,
		reason: "JSDoc preamble with slop signal"
	};
	if (CROSS_REFERENCE_PHRASES.some((re) => re.test(joined))) return {
		matched: true,
		reason: "cross-reference commentary"
	};
	if (block.kind === "line") {
		for (const l of block.prose) if (JUSTIFICATION_OPENERS.some((re) => re.test(l))) return {
			matched: true,
			reason: "justification prose"
		};
	}
	if (block.kind === "line" && block.rawLines.length === 1 && EXPLANATORY_OPENERS.test(block.prose[0] ?? "") && looksLikeDeclarationPreamble(block.nextNonBlankLine, ext)) return {
		matched: true,
		reason: "explanatory preamble"
	};
	const nonEmptyProseCount = block.prose.filter((l) => l.length > 0).length;
	const isAboveDeclaration = looksLikeDeclarationPreamble(block.nextNonBlankLine, ext);
	if (nonEmptyProseCount >= 5 && !isAboveDeclaration && hasPreambleSlopSignal(block)) return {
		matched: true,
		reason: "long narrative block"
	};
	if (nonEmptyProseCount >= 3 && !hasWhyMarker && block.kind === "line" && !isAboveDeclaration && hasPreambleSlopSignal(block)) return {
		matched: true,
		reason: "multi-line narrative prose"
	};
	return {
		matched: false,
		reason: ""
	};
};
const detectNarrativeComments = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		const ext = path.extname(filePath);
		if (!SUPPORTED_EXTS.has(ext)) continue;
		if (isAutoGenerated(filePath)) continue;
		const syntax = getCommentSyntax(ext);
		if (!syntax) continue;
		const relativePath = relativePosix(context.rootDirectory, filePath);
		if (isNonProductionPath(relativePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const blocks = collectBlocks(content.split("\n"), syntax);
		for (const block of blocks) {
			const { matched, reason } = detectNarrativeInBlock(block, ext);
			if (!matched) continue;
			diagnostics.push({
				filePath: relativePath,
				engine: "ai-slop",
				rule: "ai-slop/narrative-comment",
				severity: "warning",
				message: `Narrative comment block (${reason})`,
				help: "Remove — narrative/decorative comments belong in PR descriptions, not source. Code should be self-explanatory.",
				line: block.startLine,
				column: 0,
				category: "Comments",
				fixable: true
			});
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/python-patterns.ts
const PY_EXTENSIONS$1 = /* @__PURE__ */ new Set([".py"]);
const BARE_EXCEPT_RE = /^\s*except\s*:\s*(?:#.*)?$/;
const BROAD_EXCEPT_RE = /^\s*except\s+(Exception|BaseException)\s*(?:as\s+\w+)?\s*:\s*(?:#.*)?$/;
const PRINT_RE = /^\s*print\s*\(/;
const DEF_RE = /^\s*(?:async\s+)?def\s+\w+\s*\(/;
const MUTABLE_DEFAULT_RE = /(\w+)\s*(?::\s*[^,)=]+)?\s*=\s*(\[\s*\]|\{\s*\}|set\(\s*\))/g;
const isFStringOpener = (text, quoteIndex) => {
	let start = quoteIndex;
	while (start > 0 && /[A-Za-z]/.test(text.charAt(start - 1))) start--;
	const prefix = text.slice(start, quoteIndex);
	if (prefix.length === 0 || prefix.length > 3) return false;
	if (start > 0 && /[0-9_]/.test(text.charAt(start - 1))) return false;
	return /^[bBfFrRuU]+$/.test(prefix) && /[fF]/.test(prefix);
};
const maskStringInterior = (text, masked, start, closer, isFString) => {
	let position = start;
	while (position < text.length) {
		if (text[position] === "\\") {
			masked[position] = " ";
			if (position + 1 < text.length) masked[position + 1] = " ";
			position += 2;
			continue;
		}
		if (text.startsWith(closer, position)) return position + closer.length;
		if (isFString && text[position] === "{") {
			masked[position] = " ";
			if (text[position + 1] === "{") {
				masked[position + 1] = " ";
				position += 2;
				continue;
			}
			position = maskReplacementField(text, masked, position + 1);
			continue;
		}
		masked[position] = " ";
		position++;
	}
	return position;
};
const maskReplacementField = (text, masked, start) => {
	let position = start;
	while (position < text.length) {
		const character = text[position];
		if (character === "}") {
			masked[position] = " ";
			return position + 1;
		}
		if (character === "{") {
			masked[position] = " ";
			position = maskReplacementField(text, masked, position + 1);
			continue;
		}
		if (character === "\"" || character === "'") {
			const closer = text.startsWith(character.repeat(3), position) ? character.repeat(3) : character;
			position = maskStringInterior(text, masked, position + closer.length, closer, isFStringOpener(text, position));
			continue;
		}
		masked[position] = " ";
		position++;
	}
	return position;
};
const maskStringsAndComments = (text) => {
	const masked = text.split("");
	let position = 0;
	while (position < text.length) {
		const character = text[position];
		if (character === "#") {
			while (position < text.length && text[position] !== "\n") {
				masked[position] = " ";
				position++;
			}
			continue;
		}
		if (character === "\"" || character === "'") {
			const closer = text.startsWith(character.repeat(3), position) ? character.repeat(3) : character;
			position = maskStringInterior(text, masked, position + closer.length, closer, isFStringOpener(text, position));
			continue;
		}
		position++;
	}
	return masked.join("");
};
const parenthesisDepthAt = (text, index) => {
	let depth = 0;
	for (let position = 0; position < index; position++) {
		const character = text[position];
		if (character === "(") depth++;
		else if (character === ")") depth--;
	}
	return depth;
};
const RANGE_LEN_LOOP_RE = /^\s*for\s+([A-Za-z_]\w*)\s+in\s+range\s*\(\s*len\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\)\s*\)\s*:\s*(?:#.*)?$/;
const CHAINED_DICT_GET_RE = /\.get\s*\([^)]*,\s*\{\s*\}\s*\)\s*\.get\s*\(/;
const SAME_VALUE_BRANCH_RE = /^(\s*)(?:if|elif)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*==\s*["'][^"']+["']\s*:/;
const INSTANCE_BRANCH_RE = /^(\s*)(?:if|elif)\s+isinstance\s*\(\s*([A-Za-z_]\w*)\s*,\s*[^)]+\)\s*:/;
const BRANCH_LADDER_THRESHOLD = 4;
const isTestFile$1 = (relPath, basename) => basename.startsWith("test_") || basename.endsWith("_test.py") || basename === "conftest.py" || relPath.split("/").some((seg) => seg === "tests" || seg === "test");
const isScriptOrEntrypoint = (basename) => basename === "__main__.py" || basename === "manage.py" || basename === "setup.py";
const SCRIPT_DIR_NAMES = /* @__PURE__ */ new Set([
	"scripts",
	"bin",
	".github",
	"action",
	"docs",
	"docs_src",
	"examples",
	"example"
]);
const isInScriptDir = (relPath) => relPath.split("/").some((seg) => SCRIPT_DIR_NAMES.has(seg));
const isTutorialFile = (basename) => basename.startsWith("tutorial") && basename.endsWith(".py");
const MAIN_GUARD_RE = /^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/;
const hasMainGuard = (lines) => lines.some((l) => MAIN_GUARD_RE.test(l));
const pushFinding = (out, a) => {
	out.push({
		filePath: a.relPath,
		engine: "ai-slop",
		rule: a.rule,
		severity: a.severity,
		message: a.message,
		help: a.help,
		line: a.line,
		column: 1,
		category: "AI Slop",
		fixable: false
	});
};
const pushLineFinding = (out, relPath, line, finding) => {
	pushFinding(out, {
		relPath,
		line,
		...finding
	});
};
const flagBareExcept = (lines, relPath, out) => {
	for (let i = 0; i < lines.length; i++) {
		if (!BARE_EXCEPT_RE.test(lines[i])) continue;
		pushFinding(out, {
			relPath,
			rule: "ai-slop/python-bare-except",
			severity: "warning",
			message: "Bare `except:` swallows every exception including KeyboardInterrupt and SystemExit.",
			help: "Catch the specific exception type you actually expect (`except ValueError:`, `except (KeyError, IndexError):`). If you genuinely want everything, `except BaseException:` plus a re-raise or log makes the intent explicit.",
			line: i + 1
		});
	}
};
const flagBroadExceptWithSilentBody = (lines, relPath, out) => {
	for (let i = 0; i < lines.length; i++) {
		const match = BROAD_EXCEPT_RE.exec(lines[i]);
		if (!match) continue;
		const trimmedNext = (lines[i + 1] ?? "").trim();
		if (!(trimmedNext === "pass" || trimmedNext.startsWith("#") && (lines[i + 2] ?? "").trim() === "pass")) continue;
		pushFinding(out, {
			relPath,
			rule: "ai-slop/python-broad-except",
			severity: "warning",
			message: `\`except ${match[1]}: pass\` silently drops every exception. Failures vanish without a trace.`,
			help: "Either narrow the exception class (`except ValueError:`), log the error, or re-raise. If you genuinely intend to swallow, add a comment naming the specific failure mode you're handling — auditors will thank you.",
			line: i + 1
		});
	}
};
const flagMutableDefaults = (lines, relPath, out) => {
	let i = 0;
	while (i < lines.length) {
		if (!DEF_RE.test(lines[i])) {
			i++;
			continue;
		}
		const startLine = i;
		let signature = lines[i];
		let maskedSignature = maskStringsAndComments(signature);
		while (parenthesisDepthAt(maskedSignature, maskedSignature.length) > 0 && i + 1 < lines.length) {
			i++;
			signature += `\n${lines[i]}`;
			maskedSignature = maskStringsAndComments(signature);
		}
		let found = null;
		for (const match of maskedSignature.matchAll(MUTABLE_DEFAULT_RE)) {
			if (parenthesisDepthAt(maskedSignature, match.index ?? 0) > 1) continue;
			found = match;
			break;
		}
		if (found) pushFinding(out, {
			relPath,
			rule: "ai-slop/python-mutable-default",
			severity: "warning",
			message: `Mutable default argument \`${found[1]}=${found[2]}\`. The default is shared across all calls — bugs that look like state-leakage.`,
			help: "Use `None` as the default and create the mutable value inside the body: `def f(items=None): items = items if items is not None else []`. Standard Python idiom; anything else is the AI agent shortcutting.",
			line: startLine + 1
		});
		i++;
	}
};
const flagPrintInProduction = (lines, relPath, basename, out) => {
	if (isTestFile$1(relPath, basename) || isScriptOrEntrypoint(basename)) return;
	if (isInScriptDir(relPath)) return;
	if (isTutorialFile(basename)) return;
	if (hasMainGuard(lines)) return;
	const stringContentLines = scanPythonDocstrings(lines).tripleQuotedStringLines;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!PRINT_RE.test(line)) continue;
		if (line.trim().startsWith("#")) continue;
		if (stringContentLines.has(i)) continue;
		pushFinding(out, {
			relPath,
			rule: "ai-slop/python-print-debug",
			severity: "warning",
			message: "`print()` in production code — usually a leftover debug statement.",
			help: "Use the project's logger (`logging.getLogger(__name__).info(...)`). If this file is genuinely a CLI entry point (typer/click/argparse), it's safe to ignore — but rename to `__main__.py` or move under `scripts/` so the rule skips it next time.",
			line: i + 1
		});
	}
};
const flagRangeLenLoops = (lines, relPath, out) => {
	for (let i = 0; i < lines.length; i++) {
		const match = RANGE_LEN_LOOP_RE.exec(lines[i]);
		if (!match) continue;
		pushLineFinding(out, relPath, i + 1, {
			rule: "ai-slop/python-range-len-loop",
			severity: "info",
			message: `\`range(len(${match[2]}))\` loop — usually a hand-rolled iteration pattern.`,
			help: "Prefer direct iteration (`for item in items`) or `enumerate(items)` when the index is needed. Keeping index plumbing out of the loop reduces checkpoint-to-checkpoint bloat."
		});
	}
};
const flagChainedDictGets = (lines, relPath, out) => {
	for (let i = 0; i < lines.length; i++) {
		if (!CHAINED_DICT_GET_RE.test(lines[i])) continue;
		pushLineFinding(out, relPath, i + 1, {
			rule: "ai-slop/python-chained-dict-get",
			severity: "warning",
			message: "Chained `.get(..., {})` defaults hide missing-data cases.",
			help: "Normalize the input at the boundary, use a typed object, or split the lookup into explicit steps. Empty-dict fallback chains are a common agent shortcut that becomes brittle as schemas evolve."
		});
	}
};
const countBranchLadder = (lines, start, pattern, selector, indent) => {
	let count = 1;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const match = pattern.exec(line);
		if (match?.[1] === indent && match[2] === selector) {
			count++;
			continue;
		}
		if (line.startsWith(`${indent}elif `)) break;
		if (line.length - line.trimStart().length <= indent.length && !line.startsWith(`${indent}else`)) break;
	}
	return count;
};
const flagBranchLadders = (lines, relPath, out) => {
	const reported = /* @__PURE__ */ new Set();
	for (let i = 0; i < lines.length; i++) {
		if (reported.has(i)) continue;
		const valueMatch = SAME_VALUE_BRANCH_RE.exec(lines[i]);
		if (valueMatch) {
			const count = countBranchLadder(lines, i, SAME_VALUE_BRANCH_RE, valueMatch[2], valueMatch[1]);
			if (count >= BRANCH_LADDER_THRESHOLD) {
				reported.add(i);
				pushLineFinding(out, relPath, i + 1, {
					rule: "ai-slop/python-repetitive-dispatch",
					severity: "warning",
					message: `${count} repeated branches dispatch on \`${valueMatch[2]}\`.`,
					help: "Use a table, set membership, or handler map when branches share the same shape. SlopCodeBench highlights these selector ladders as code that keeps growing instead of absorbing new cases cleanly."
				});
			}
			continue;
		}
		const instanceMatch = INSTANCE_BRANCH_RE.exec(lines[i]);
		if (!instanceMatch) continue;
		const count = countBranchLadder(lines, i, INSTANCE_BRANCH_RE, instanceMatch[2], instanceMatch[1]);
		if (count < BRANCH_LADDER_THRESHOLD) continue;
		reported.add(i);
		pushLineFinding(out, relPath, i + 1, {
			rule: "ai-slop/python-isinstance-ladder",
			severity: "warning",
			message: `${count} repeated \`isinstance(${instanceMatch[2]}, ...)\` branches.`,
			help: "Prefer a handler map, protocol, or normalized intermediate representation when each type branch has the same role. Repeated type ladders are one of the maintainability smells SCBench-style checks look for."
		});
	}
};
const detectPythonPatterns = async (context) => {
	const diagnostics = [];
	const files = getSourceFiles(context);
	for (const filePath of files) {
		if (!PY_EXTENSIONS$1.has(path.extname(filePath))) continue;
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relPath = relativePosix(context.rootDirectory, filePath);
		const basename = path.basename(filePath);
		const lines = content.split("\n");
		flagBareExcept(lines, relPath, diagnostics);
		flagBroadExceptWithSilentBody(lines, relPath, diagnostics);
		flagMutableDefaults(lines, relPath, diagnostics);
		flagPrintInProduction(lines, relPath, basename, diagnostics);
		flagRangeLenLoops(lines, relPath, diagnostics);
		flagChainedDictGets(lines, relPath, diagnostics);
		flagBranchLadders(lines, relPath, diagnostics);
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/rust-patterns.ts
const RUST_EXTENSIONS = /* @__PURE__ */ new Set([".rs"]);
const UNWRAP_CALL_RE = /\.unwrap\s*\(\s*\)/;
const TODO_MACRO_RE = /\b(todo|unimplemented)\s*!\s*\(/;
const COMMENT_LINE_RE = /^\s*\/\//;
const TEST_ATTR_RE = /^\s*#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|test|tokio::test)/;
const WRITELN_UNWRAP_RE = /\b(?:writeln|write)\s*!\s*\([^)]*\)\s*\.unwrap\s*\(\s*\)/;
const TEST_BASENAMES = /* @__PURE__ */ new Set([
	"tests.rs",
	"testutil.rs",
	"test_util.rs",
	"test_utils.rs",
	"build.rs"
]);
const TEST_CRATE_SEGMENT_RE = /(?:^|[-_])tests?(?:$|[-_])/;
const isTestFile = (relPath) => {
	const segments = relPath.split("/");
	if (segments.some((s) => TEST_CRATE_SEGMENT_RE.test(s))) return true;
	const basename = segments[segments.length - 1] ?? "";
	if (TEST_BASENAMES.has(basename)) return true;
	return basename.endsWith("_tests.rs") || basename.endsWith("_test.rs") || basename.endsWith("_testutil.rs");
};
const buildBlockCommentRanges = (lines) => {
	const ranges = [];
	let openLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (openLine === -1) {
			const openIdx = line.indexOf("/*");
			if (openIdx !== -1 && line.indexOf("*/", openIdx + 2) === -1) openLine = i;
		} else if (line.indexOf("*/") !== -1) {
			ranges.push([openLine, i]);
			openLine = -1;
		}
	}
	if (openLine !== -1) ranges.push([openLine, lines.length - 1]);
	return ranges;
};
const isExampleFile = (relPath) => relPath.split("/").some((seg) => seg === "examples" || seg === "benches");
const UNWRAP_INTENT_LOOKBACK = 2;
const hasIntentComment = (lines, lineIdx) => {
	for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - UNWRAP_INTENT_LOOKBACK); j--) if (COMMENT_LINE_RE.test(lines[j])) return true;
	return false;
};
const buildTestRanges = (lines) => {
	const ranges = [];
	for (let i = 0; i < lines.length; i++) {
		if (!TEST_ATTR_RE.test(lines[i])) continue;
		const openLine = i;
		let depth = 0;
		let started = false;
		for (let j = i; j < lines.length; j++) {
			const line = lines[j];
			for (const ch of line) if (ch === "{") {
				depth++;
				started = true;
			} else if (ch === "}") depth--;
			if (started && depth === 0) {
				ranges.push([openLine, j]);
				i = j;
				break;
			}
		}
	}
	return ranges;
};
const isInRange = (ranges, lineIdx) => ranges.some(([start, end]) => lineIdx >= start && lineIdx <= end);
const flagNonTestUnwrap = (lines, relPath, testRanges, blockCommentRanges, out) => {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (COMMENT_LINE_RE.test(line)) continue;
		if (isInRange(testRanges, i)) continue;
		if (isInRange(blockCommentRanges, i)) continue;
		if (!UNWRAP_CALL_RE.test(line)) continue;
		if (WRITELN_UNWRAP_RE.test(line)) continue;
		if (hasIntentComment(lines, i)) continue;
		out.push({
			filePath: relPath,
			engine: "ai-slop",
			rule: "ai-slop/rust-non-test-unwrap",
			severity: "warning",
			message: "`.unwrap()` in non-test code panics on None/Err. Surfaces as a hard crash for the caller.",
			help: "Use `?` to propagate, `.expect(\"context\")` if you really mean it (and the message names the invariant), or pattern-match the variant you care about. Reserve raw `.unwrap()` for tests and prototypes.",
			line: i + 1,
			column: 1,
			category: "AI Slop",
			fixable: false
		});
	}
};
const flagTodoMacro = (lines, relPath, out) => {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (COMMENT_LINE_RE.test(line)) continue;
		const match = TODO_MACRO_RE.exec(line);
		if (!match) continue;
		out.push({
			filePath: relPath,
			engine: "ai-slop",
			rule: "ai-slop/rust-todo-stub",
			severity: "warning",
			message: `\`${match[1]}!()\` panics at runtime — almost certainly a stub the agent forgot to fill in.`,
			help: "Implement the missing path or remove it. If the work is genuinely deferred, file a ticket and put the number in a comment next to the macro so it doesn't ship invisibly.",
			line: i + 1,
			column: 1,
			category: "AI Slop",
			fixable: false
		});
	}
};
const detectRustPatterns = async (context) => {
	const diagnostics = [];
	const files = getSourceFiles(context);
	for (const filePath of files) {
		if (!RUST_EXTENSIONS.has(path.extname(filePath))) continue;
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relPath = relativePosix(context.rootDirectory, filePath);
		const lines = content.split("\n");
		if (isExampleFile(relPath)) continue;
		if (isTestFile(relPath)) {
			flagTodoMacro(lines, relPath, diagnostics);
			continue;
		}
		const testRanges = buildTestRanges(lines);
		const blockCommentRanges = buildBlockCommentRanges(lines);
		flagNonTestUnwrap(lines, relPath, testRanges, blockCommentRanges, diagnostics);
		flagTodoMacro(lines, relPath, diagnostics);
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/silent-recovery.ts
const JS_EXTS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const CATCH_HEAD_RE = /\bcatch\s*(?:\(\s*([^)]*?)\s*\))?\s*\{/g;
const isIdentifier = (s) => /^[A-Za-z_$][\w$]*$/.test(s);
const recoveryDropsError = (binding, body) => {
	const name = binding?.trim() ?? "";
	if (name === "") return true;
	if (!isIdentifier(name)) return false;
	return !new RegExp(`\\b${name}\\b`).test(body);
};
const LOG_STATEMENT_RE = /^(?:console|[\w$]+(?:\.[\w$]+)*)\.(?:log|info|warn|warning|error|debug|trace)\s*\(/;
const HANDLING_TOKEN_RE = /\b(?:throw|return|reject|next|process\.exit|continue|break)\b/;
const stripBlockComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const extractCatchBody = (content, openBraceIndex) => {
	let depth = 0;
	let inString = null;
	for (let i = openBraceIndex; i < content.length; i += 1) {
		const ch = content[i];
		const prev = content[i - 1];
		if (inString) {
			if (ch === inString && prev !== "\\") inString = null;
			continue;
		}
		if (ch === "\"" || ch === "'" || ch === "`") {
			inString = ch;
			continue;
		}
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return content.slice(openBraceIndex + 1, i);
		}
	}
	return null;
};
const isLogOnlyBody = (body) => {
	const statements = stripBlockComments(body).split("\n").map((line) => line.replace(/\/\/.*$/, "").trim()).filter((line) => line.length > 0 && line !== ";");
	if (statements.length === 0) return false;
	if (statements.some((line) => HANDLING_TOKEN_RE.test(line))) return false;
	let sawLog = false;
	for (const statement of statements) {
		const normalized = statement.replace(/;+$/, "");
		if (LOG_STATEMENT_RE.test(normalized)) {
			sawLog = true;
			continue;
		}
		if (/^[\w$"'`{[(),.\s+:-]+$/.test(normalized) && !/[=(]\s*(?:async\s+)?\(/.test(normalized)) continue;
		return false;
	}
	return sawLog;
};
const detectJsSilentRecovery = (content, relPath) => {
	const out = [];
	for (const match of content.matchAll(CATCH_HEAD_RE)) {
		const braceIndex = match.index + match[0].length - 1;
		const body = extractCatchBody(content, braceIndex);
		if (body === null) continue;
		if (!isLogOnlyBody(body)) continue;
		if (!recoveryDropsError(match[1], body)) continue;
		const line = content.slice(0, match.index).split("\n").length;
		out.push({
			filePath: relPath,
			engine: "ai-slop",
			rule: "ai-slop/silent-recovery",
			severity: "warning",
			message: "Catch logs without the caught error then continues; the failure cause is lost",
			help: "Include the caught error in the log, or rethrow / recover explicitly, so the failure stays diagnosable.",
			line,
			column: 0,
			category: "AI Slop",
			fixable: false
		});
	}
	return out;
};
const PY_EXCEPT_RE = /^(\s*)except\b[^\n]*:\s*(?:#.*)?$/;
const PY_EXCEPT_BINDING_RE = /\bas\s+(\w+)\s*:/;
const PY_LOG_STATEMENT_RE = /^(?:logging|logger|log|self\.log|self\.logger|print)(?:\.(?:debug|info|warning|warn|error|exception|critical))?\s*\(/;
const PY_HANDLING_TOKEN_RE = /^(?:raise\b|return\b|continue\b|break\b|self\.|[\w.]+\s*=)/;
const PY_LOG_CAPTURES_EXCEPTION_RE = /\.exception\s*\(|\bexc_info\s*=\s*True\b/;
const PY_EXC_INFO_DISABLED_RE = /\bexc_info\s*=\s*False\b/;
const splitPyStatements = (bodyLines) => {
	const statements = [];
	let text = "";
	let masked = "";
	let depth = 0;
	let quote = null;
	const flush = () => {
		if (text.trim() !== "") statements.push({
			text: text.trim(),
			masked: masked.trim()
		});
		text = "";
		masked = "";
	};
	for (const line of bodyLines) {
		if (text !== "") {
			text += " ";
			masked += " ";
		}
		let i = 0;
		while (i < line.length) {
			if (quote !== null) {
				const closes = line.startsWith(quote, i);
				const width = line[i] === "\\" ? 2 : closes ? quote.length : 1;
				text += line.slice(i, i + width);
				if (closes) {
					masked += quote;
					quote = null;
				}
				i += width;
				continue;
			}
			const ch = line[i];
			if (ch === "#") {
				text += line.slice(i);
				break;
			}
			if (ch === "\"" || ch === "'") {
				quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
				text += quote;
				masked += quote;
				i += quote.length;
				continue;
			}
			if (ch === ";" && depth === 0) {
				flush();
				i += 1;
				continue;
			}
			text += ch;
			masked += ch;
			if (ch === "(" || ch === "[" || ch === "{") depth += 1;
			else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
			i += 1;
		}
		if (quote !== null && quote.length === 1) quote = null;
		if (depth === 0 && quote === null && !line.endsWith("\\")) flush();
	}
	flush();
	return statements;
};
const pyLogStatementCapturesException = (statement) => PY_LOG_CAPTURES_EXCEPTION_RE.test(statement) && !PY_EXC_INFO_DISABLED_RE.test(statement);
const detectPySilentRecovery = (content, relPath) => {
	const out = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const exceptMatch = PY_EXCEPT_RE.exec(lines[i]);
		if (!exceptMatch) continue;
		const indent = exceptMatch[1].length;
		const rawBodyLines = [];
		let j = i + 1;
		for (; j < lines.length; j += 1) {
			const raw = lines[j];
			if (raw.trim() === "") continue;
			if (raw.length - raw.trimStart().length <= indent) break;
			rawBodyLines.push(raw.trim());
		}
		const body = splitPyStatements(rawBodyLines);
		if (body.length === 0) continue;
		if (body.some((s) => PY_HANDLING_TOKEN_RE.test(s.masked))) continue;
		if (body.some((s) => s.masked === "pass")) continue;
		const allLogs = body.every((s) => PY_LOG_STATEMENT_RE.test(s.masked) || /^[\w"'(),.\s+:%{}[\]-]+$/.test(s.masked));
		const sawLog = body.some((s) => PY_LOG_STATEMENT_RE.test(s.masked));
		if (!allLogs || !sawLog) continue;
		if (body.some((s) => pyLogStatementCapturesException(s.masked))) continue;
		const bodyText = body.map((s) => s.text).join(" ");
		if (!recoveryDropsError(PY_EXCEPT_BINDING_RE.exec(lines[i])?.[1], bodyText)) continue;
		out.push({
			filePath: relPath,
			engine: "ai-slop",
			rule: "ai-slop/silent-recovery",
			severity: "warning",
			message: "except logs without the caught error then continues; the failure cause is lost",
			help: "Include the caught error in the log, or re-raise / recover explicitly, so the failure stays diagnosable.",
			line: i + 1,
			column: 0,
			category: "AI Slop",
			fixable: false
		});
	}
	return out;
};
const detectSilentRecovery = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		if (isAutoGenerated(filePath)) continue;
		const ext = path.extname(filePath);
		const isJs = JS_EXTS.has(ext);
		if (!isJs && !(ext === ".py")) continue;
		const relPath = relativePosix(context.rootDirectory, filePath);
		if (isNonProductionPath(relPath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		if (isJs) diagnostics.push(...detectJsSilentRecovery(content, relPath));
		else diagnostics.push(...detectPySilentRecovery(content, relPath));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/test-quality.ts
const JS_EXTENSIONS$2 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const EXPECT_NAME = "expect";
const ASSERT_NAME = "assert";
const JS_LITERAL = String.raw`(?:true|false|null|undefined|-?\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;
const JS_TAUTOLOGY_PATTERNS = [new RegExp(String.raw`\b${EXPECT_NAME}\s*\(\s*(${JS_LITERAL})\s*\)\s*\.\s*toBe\s*\(\s*(${JS_LITERAL})\s*\)`, "g"), new RegExp(String.raw`\b${ASSERT_NAME}\s*\.\s*(?:equal|strictEqual)\s*\(\s*(${JS_LITERAL})\s*,\s*(${JS_LITERAL})\s*\)`, "g")];
const PYTHON_TAUTOLOGY_RE = new RegExp(String.raw`^\s*${ASSERT_NAME}\s+True\s*$`);
const SIMPLE_STRING_ESCAPES = {
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	",
	v: "\v",
	"0": "\0"
};
const parseHexEscape = (value) => {
	if (!/^[\da-f]+$/i.test(value)) return null;
	const codePoint = Number.parseInt(value, 16);
	if (codePoint > 1114111) return null;
	return String.fromCodePoint(codePoint);
};
const parseStringLiteral = (rawValue) => {
	let value = "";
	for (let index = 1; index < rawValue.length - 1; index++) {
		const character = rawValue[index];
		if (character !== "\\") {
			value += character;
			continue;
		}
		index++;
		if (index >= rawValue.length - 1) return null;
		const escapeCode = rawValue[index];
		if (SIMPLE_STRING_ESCAPES[escapeCode] !== void 0) {
			value += SIMPLE_STRING_ESCAPES[escapeCode];
			continue;
		}
		if (escapeCode === "x") {
			const decoded = parseHexEscape(rawValue.slice(index + 1, index + 3));
			if (decoded === null) return null;
			value += decoded;
			index += 2;
			continue;
		}
		if (escapeCode === "u") {
			const hasBraces = rawValue[index + 1] === "{";
			const end = hasBraces ? rawValue.indexOf("}", index + 2) : index + 5;
			if (end === -1 || end >= rawValue.length) return null;
			const digits = rawValue.slice(index + (hasBraces ? 2 : 1), end);
			if (!hasBraces && digits.length !== 4 || digits.length === 0) return null;
			const decoded = parseHexEscape(digits);
			if (decoded === null) return null;
			value += decoded;
			index = hasBraces ? end : end - 1;
			continue;
		}
		value += escapeCode;
	}
	return value;
};
const parseFixedLiteral = (rawValue) => {
	if (rawValue === "true") return { value: true };
	if (rawValue === "false") return { value: false };
	if (rawValue === "null") return { value: null };
	if (rawValue === "undefined") return { value: void 0 };
	if (rawValue.startsWith("\"") || rawValue.startsWith("'")) {
		const value = parseStringLiteral(rawValue);
		return value === null ? null : { value };
	}
	return { value: Number(rawValue) };
};
const literalsAreEqual = (left, right) => {
	const leftLiteral = parseFixedLiteral(left);
	const rightLiteral = parseFixedLiteral(right);
	return !!leftLiteral && !!rightLiteral && Object.is(leftLiteral.value, rightLiteral.value);
};
const isTautologicalLine = (line, fullyMaskedLine, extension) => {
	if (extension === ".py") return PYTHON_TAUTOLOGY_RE.test(fullyMaskedLine);
	if (!JS_EXTENSIONS$2.has(extension)) return false;
	return JS_TAUTOLOGY_PATTERNS.some((pattern) => {
		pattern.lastIndex = 0;
		let match = pattern.exec(line);
		while (match) {
			const name = match[0].startsWith(EXPECT_NAME) ? EXPECT_NAME : ASSERT_NAME;
			if (fullyMaskedLine.slice(match.index, match.index + name.length) === name && literalsAreEqual(match[1], match[2])) return true;
			match = pattern.exec(line);
		}
		return false;
	});
};
const detectTautologicalTests = async (context) => {
	const diagnostics = [];
	for (const filePath of getTestFiles(context)) {
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const extension = path.extname(filePath).toLowerCase();
		const lines = maskComments(content, extension).split("\n");
		const fullyMaskedLines = maskStringsAndComments$1(content, extension).split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (!isTautologicalLine(lines[index], fullyMaskedLines[index], extension)) continue;
			diagnostics.push({
				filePath: relativePosix(context.rootDirectory, filePath),
				engine: "ai-slop",
				rule: "ai-slop/tautological-test",
				severity: "warning",
				message: "Tautological test assertion cannot fail",
				help: "Assert behavior produced by the code under test instead of comparing fixed literals.",
				line: index + 1,
				column: 1,
				category: "AI Slop",
				fixable: false
			});
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/unused-css.ts
const STYLE_EXTENSIONS = /* @__PURE__ */ new Set([".css", ".scss"]);
const REFERENCE_EXTENSIONS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".astro",
	".vue",
	".svelte",
	".html",
	".htm",
	".php",
	".erb",
	".md",
	".mdx",
	".css",
	".scss"
]);
const UNUSED_CSS_EXTRA_EXTENSIONS = [
	".css",
	".scss",
	".astro",
	".vue",
	".svelte",
	".html",
	".htm",
	".erb",
	".md",
	".mdx"
];
const stripCssComments = (content) => content.replace(/\/\*[\s\S]*?\*\//g, "");
const SELECTOR_CLASS_RE = /\.(-?[A-Za-z_][\w-]*)/g;
const TAILWIND_PREFIXES = [
	"sm:",
	"md:",
	"lg:",
	"xl:",
	"2xl:",
	"hover:",
	"focus:",
	"active:",
	"group-",
	"peer-",
	"dark:",
	"motion-",
	"first:",
	"last:",
	"odd:",
	"even:",
	"disabled:"
];
const TAILWIND_UTILITY_RE = /^(?:m|p)(?:[trblxy])?-(?:\d|px|auto|\[)|^(?:w|h|min-w|min-h|max-w|max-h)-|^(?:text|bg|border|ring|from|via|to|fill|stroke)-(?:\[|(?:red|blue|green|gray|grey|slate|zinc|neutral|stone|amber|yellow|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|orange|white|black|transparent|current)\b)|^(?:flex|grid|gap|space|inset|top|bottom|left|right|z|order|col|row|justify|items|content|self|place)-|^(?:rounded|shadow|opacity|leading|tracking|font|duration|delay|ease|translate|scale|rotate|skew|origin|cursor|select|overflow|object|aspect|columns|divide|backdrop|blur|brightness|contrast|grayscale|saturate|sepia)-/;
const looksLikeTailwindUtility = (name) => {
	if (TAILWIND_PREFIXES.some((prefix) => name.includes(prefix))) return true;
	if (TAILWIND_UTILITY_RE.test(name)) return true;
	if (name.includes("[") || name.includes("/")) return true;
	if (/^(?:flex|grid|block|inline|hidden|table|contents|container|relative|absolute|fixed|sticky|static|truncate|italic|underline|uppercase|lowercase|capitalize|antialiased|sr-only)$/.test(name)) return true;
	return false;
};
const collectClassDefinitions = (content) => {
	const lines = stripCssComments(content).split("\n");
	const seen = /* @__PURE__ */ new Set();
	const definitions = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		SELECTOR_CLASS_RE.lastIndex = 0;
		let match = SELECTOR_CLASS_RE.exec(line);
		while (match !== null) {
			const name = match[1];
			if (name && !seen.has(name)) {
				seen.add(name);
				definitions.push({
					name,
					line: i + 1
				});
			}
			match = SELECTOR_CLASS_RE.exec(line);
		}
	}
	return definitions;
};
const isReferenced = (name, corpus) => {
	if (corpus.includes(name)) return true;
	let cut = name.indexOf("-");
	while (cut !== -1) {
		if (corpus.includes(name.slice(0, cut + 1))) return true;
		cut = name.indexOf("-", cut + 1);
	}
	return false;
};
const collectScanInputs = (files) => {
	const styleFiles = [];
	const referenceChunks = [];
	for (const filePath of files) {
		const ext = path.extname(filePath).toLowerCase();
		const isStyle = STYLE_EXTENSIONS.has(ext);
		const isReference = REFERENCE_EXTENSIONS.has(ext);
		if (!isStyle && !isReference) continue;
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		if (isStyle) styleFiles.push(filePath);
		if (isReference) referenceChunks.push(isStyle ? stripSelectorTokens(content) : content);
	}
	return {
		styleFiles,
		corpus: referenceChunks.join("\n")
	};
};
const detectUnusedCss = async (context) => {
	const files = getSourceFilesWithExtras(context, UNUSED_CSS_EXTRA_EXTENSIONS);
	if (files.length === 0) return [];
	const { styleFiles, corpus } = collectScanInputs(files);
	if (styleFiles.length === 0) return [];
	const diagnostics = [];
	for (const filePath of styleFiles) {
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relativePath = relativePosix(context.rootDirectory, filePath);
		const definitions = collectClassDefinitions(content);
		for (const def of definitions) {
			if (looksLikeTailwindUtility(def.name)) continue;
			if (isReferenced(def.name, corpus)) continue;
			diagnostics.push({
				filePath: relativePath,
				engine: "ai-slop",
				rule: "ai-slop/unused-css",
				severity: "warning",
				message: `CSS class '.${def.name}' is defined but never referenced in the codebase`,
				help: "Remove the dead CSS rule, or confirm the class is used dynamically (and add an aislop-ignore comment if so)",
				line: def.line,
				column: 0,
				category: "AI Slop",
				fixable: false
			});
		}
	}
	return diagnostics;
};
const stripSelectorTokens = (content) => {
	return stripCssComments(content).split("\n").map((line) => {
		if (/@apply\b/.test(line)) return line;
		if (line.includes("{") || /^\s*\.[\w-]/.test(line) || /,\s*$/.test(line)) return line.replace(SELECTOR_CLASS_RE, " ");
		return line;
	}).join("\n");
};
//#endregion
//#region src/engines/ai-slop/unused-imports.ts
const JS_EXTENSIONS$1 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const PY_EXTENSIONS = /* @__PURE__ */ new Set([".py"]);
const REMOVE_MARKER = "\0__AISLOP_REMOVE__";
const extractJsImportedSymbols = (lines) => {
	const symbols = [];
	const importLines = /* @__PURE__ */ new Set();
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed.startsWith("import ")) continue;
		importLines.add(i);
		if (/^import\s+["']/.test(trimmed)) continue;
		if (/^import\s+type\s/.test(trimmed)) continue;
		let fullImport = trimmed;
		let endLine = i;
		while (!fullImport.includes("from") && endLine < lines.length - 1) {
			endLine++;
			fullImport += ` ${lines[endLine].trim()}`;
			importLines.add(endLine);
		}
		const namespaceMatch = fullImport.match(/import\s+\*\s+as\s+(\w+)\s+from/);
		if (namespaceMatch) {
			symbols.push({
				name: namespaceMatch[1],
				line: i + 1,
				isDefault: false,
				isNamespace: true
			});
			continue;
		}
		const defaultMatch = fullImport.match(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s+from/);
		if (defaultMatch && defaultMatch[1] !== "type") symbols.push({
			name: defaultMatch[1],
			line: i + 1,
			isDefault: true,
			isNamespace: false
		});
		const namedMatch = fullImport.match(/\{([^}]+)\}/);
		if (namedMatch) {
			const namedImports = namedMatch[1].split(",");
			for (const ni of namedImports) {
				const parts = ni.trim().split(/\s+as\s+/);
				if (parts.length === 0 || !parts[0]) continue;
				const cleanParts = parts.map((p) => p.trim().replace(/^type\s+/, ""));
				const localName = cleanParts.length > 1 ? cleanParts[1] : cleanParts[0];
				if (localName && /^\w+$/.test(localName)) symbols.push({
					name: localName,
					line: i + 1,
					isDefault: false,
					isNamespace: false
				});
			}
		}
	}
	return {
		symbols,
		importLines
	};
};
const extractPyImportedSymbols = (lines) => {
	const symbols = [];
	const importLines = /* @__PURE__ */ new Set();
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
		if (fromMatch) {
			importLines.add(i);
			if (fromMatch[1] === "__future__") continue;
			const importPart = fromMatch[2].replace(/#.*$/, "").trim();
			if (importPart === "*") continue;
			const cleaned = importPart.replace(/[()]/g, "");
			for (const item of cleaned.split(",")) {
				const parts = item.trim().split(/\s+as\s+/);
				const original = parts[0].trim();
				const localName = parts.length > 1 ? parts[1].trim() : original;
				if (parts.length > 1 && original === localName) continue;
				if (localName && /^\w+$/.test(localName)) symbols.push({
					name: localName,
					line: i + 1,
					isDefault: false,
					isNamespace: false
				});
			}
			continue;
		}
		const importMatch = trimmed.match(/^import\s+(.+)/);
		if (importMatch) {
			importLines.add(i);
			for (const clause of importMatch[1].replace(/#.*$/, "").split(",")) {
				const clauseMatch = clause.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?/);
				if (!clauseMatch) continue;
				const alias = clauseMatch[2];
				if (alias && alias === clauseMatch[1]) continue;
				const simpleName = (alias ?? clauseMatch[1]).split(".")[0];
				if (simpleName && /^\w+$/.test(simpleName)) symbols.push({
					name: simpleName,
					line: i + 1,
					isDefault: false,
					isNamespace: true
				});
			}
		}
	}
	return {
		symbols,
		importLines
	};
};
const isSymbolUsed = (name, content, importLines, lines) => {
	const pattern = new RegExp(`\\b${name}\\b`, "g");
	for (const match of content.matchAll(pattern)) {
		const lineIndex = content.slice(0, match.index).split("\n").length - 1;
		if (!importLines.has(lineIndex)) return true;
	}
	for (let i = 0; i < lines.length; i++) {
		if (importLines.has(i)) continue;
		if (lines[i].includes(name)) return true;
	}
	return false;
};
const analyzeFile = (filePath) => {
	if (isAutoGenerated(filePath)) return null;
	let content;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const ext = path.extname(filePath);
	const lines = content.split("\n");
	let symbols;
	let importLines;
	if (JS_EXTENSIONS$1.has(ext)) {
		const result = extractJsImportedSymbols(lines);
		symbols = result.symbols;
		importLines = result.importLines;
	} else if (PY_EXTENSIONS.has(ext)) {
		const result = extractPyImportedSymbols(lines);
		symbols = result.symbols;
		importLines = result.importLines;
	} else return null;
	return {
		lines,
		symbols,
		importLines,
		ext
	};
};
const getUnusedSymbols = (lines, symbols, importLines) => {
	const content = lines.join("\n");
	return symbols.filter((symbol) => !isSymbolUsed(symbol.name, content, importLines, lines));
};
const detectUnusedImports = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		const analysis = analyzeFile(filePath);
		if (!analysis) continue;
		const relativePath = relativePosix(context.rootDirectory, filePath);
		const unused = getUnusedSymbols(analysis.lines, analysis.symbols, analysis.importLines);
		for (const symbol of unused) diagnostics.push({
			filePath: relativePath,
			engine: "ai-slop",
			rule: "ai-slop/unused-import",
			severity: "warning",
			message: `Imported symbol '${symbol.name}' is never used`,
			help: "Remove unused imports to keep the code clean",
			line: symbol.line,
			column: 0,
			category: "AI Slop",
			fixable: true
		});
	}
	return diagnostics;
};
//#endregion
//#region src/engines/ai-slop/index.ts
const aiSlopEngine = {
	name: "ai-slop",
	async run(context) {
		const diagnostics = [];
		const results = await Promise.allSettled([
			detectTrivialComments(context),
			detectSwallowedExceptions(context),
			detectDefensivePatterns(context),
			detectOverAbstraction(context),
			detectDeadPatterns(context),
			detectUnusedImports(context),
			detectNarrativeComments(context),
			detectDuplicateImports(context),
			detectHardcodedConfigLiterals(context),
			detectHiddenFallbacks(context),
			detectPythonPatterns(context),
			detectGoPatterns(context),
			detectRustPatterns(context),
			detectHallucinatedImports(context),
			detectSilentRecovery(context),
			detectMetaComments(context),
			detectCSharpPatterns(context),
			detectCppPatterns(context),
			detectUnusedCss(context),
			detectTautologicalTests(context)
		]);
		for (const result of results) if (result.status === "fulfilled") diagnostics.push(...result.value);
		return {
			engine: "ai-slop",
			diagnostics,
			elapsed: 0,
			skipped: false
		};
	}
};
//#endregion
//#region src/engines/architecture/matchers.ts
const REGEX_SPECIAL_CHARS = /* @__PURE__ */ new Set([
	".",
	"+",
	"^",
	"$",
	"{",
	"}",
	"(",
	")",
	"|",
	"\\"
]);
const minimatch = (filePath, pattern) => {
	let regex = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*" && pattern[i + 1] === "*") {
			regex += ".*";
			i += 2;
			if (pattern[i] === "/") i++;
		} else if (ch === "*") {
			regex += "[^/]*";
			i++;
		} else if (ch === "?") {
			regex += "[^/]";
			i++;
		} else if (ch === "[") {
			const closeIndex = pattern.indexOf("]", i + 1);
			if (closeIndex === -1) {
				regex += "\\[";
				i++;
			} else {
				regex += pattern.slice(i, closeIndex + 1);
				i = closeIndex + 1;
			}
		} else if (REGEX_SPECIAL_CHARS.has(ch)) {
			regex += `\\${ch}`;
			i++;
		} else {
			regex += ch;
			i++;
		}
	}
	return new RegExp(`^${regex}$`).test(filePath);
};
const extractImports = (content, ext) => {
	const imports = [];
	if ([
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs"
	].includes(ext)) {
		for (const match of content.matchAll(/(?:import|from)\s+["']([^"']+)["']/g)) imports.push(match[1]);
		for (const match of content.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) imports.push(match[1]);
	}
	if (ext === ".py") for (const match of content.matchAll(/(?:from|import)\s+([\w.]+)/g)) imports.push(match[1]);
	if (ext === ".go") {
		for (const match of content.matchAll(/^\s*import\s+"([^"]+)"/gm)) imports.push(match[1]);
		for (const match of content.matchAll(/import\s*\(([^)]*)\)/gs)) {
			const block = match[1];
			for (const pkgMatch of block.matchAll(/"([^"]+)"/g)) imports.push(pkgMatch[1]);
		}
	}
	return imports;
};
const applyForbidImport = (rule, imports, content, relativePath) => {
	if (!rule.match) return [];
	return imports.filter((imp) => imp.includes(rule.match)).map((imp) => ({
		filePath: relativePath,
		engine: "architecture",
		rule: `arch/${rule.name}`,
		severity: rule.severity,
		message: `Forbidden import '${imp}' (rule: ${rule.name})`,
		help: `This import is not allowed by your architecture rules`,
		line: findImportLine(content, imp),
		column: 0,
		category: "Architecture",
		fixable: false
	}));
};
const applyForbidImportFromPath = (rule, imports, content, relativePath) => {
	if (!rule.from || !rule.forbid) return [];
	if (!minimatch(relativePath, rule.from)) return [];
	return imports.filter((imp) => minimatch(imp, rule.forbid) || imp.includes(rule.forbid.replace(/\*\*/g, ""))).map((imp) => ({
		filePath: relativePath,
		engine: "architecture",
		rule: `arch/${rule.name}`,
		severity: rule.severity,
		message: `Import '${imp}' is forbidden from '${rule.from}' (rule: ${rule.name})`,
		help: `Files in '${rule.from}' cannot import from '${rule.forbid}'`,
		line: findImportLine(content, imp),
		column: 0,
		category: "Architecture",
		fixable: false
	}));
};
const applyRequirePattern = (rule, content, relativePath) => {
	if (!rule.where || !rule.pattern) return [];
	if (!minimatch(relativePath, rule.where)) return [];
	if (content.includes(rule.pattern)) return [];
	return [{
		filePath: relativePath,
		engine: "architecture",
		rule: `arch/${rule.name}`,
		severity: rule.severity,
		message: `Required pattern '${rule.pattern}' not found (rule: ${rule.name})`,
		help: `Files matching '${rule.where}' must contain '${rule.pattern}'`,
		line: 0,
		column: 0,
		category: "Architecture",
		fixable: false
	}];
};
const applyRule = (rule, imports, content, relativePath) => {
	switch (rule.type) {
		case "forbid_import": return applyForbidImport(rule, imports, content, relativePath);
		case "forbid_import_from_path": return applyForbidImportFromPath(rule, imports, content, relativePath);
		case "require_pattern": return applyRequirePattern(rule, content, relativePath);
		default: return [];
	}
};
const checkRules = async (context, rules) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relativePath = relativePosix(context.rootDirectory, filePath);
		const imports = extractImports(content, path.extname(filePath));
		for (const rule of rules) diagnostics.push(...applyRule(rule, imports, content, relativePath));
	}
	return diagnostics;
};
const findImportLine = (content, importPath) => {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) if (lines[i].includes(importPath)) return i + 1;
	return 0;
};
//#endregion
//#region src/engines/architecture/rule-loader.ts
const loadArchitectureRules = (rulesPath) => {
	if (!fs.existsSync(rulesPath)) return [];
	try {
		const content = fs.readFileSync(rulesPath, "utf-8");
		return YAML.parse(content)?.rules ?? [];
	} catch {
		return [];
	}
};
//#endregion
//#region src/engines/architecture/index.ts
const architectureEngine = {
	name: "architecture",
	async run(context) {
		if (!context.config.architectureRulesPath) return {
			engine: "architecture",
			diagnostics: [],
			elapsed: 0,
			skipped: true,
			skipReason: "No architecture rules configured"
		};
		const rules = loadArchitectureRules(context.config.architectureRulesPath);
		if (rules.length === 0) return {
			engine: "architecture",
			diagnostics: [],
			elapsed: 0,
			skipped: true,
			skipReason: "No rules found in rules file"
		};
		return {
			engine: "architecture",
			diagnostics: await checkRules(context, rules),
			elapsed: 0,
			skipped: false
		};
	}
};
//#endregion
//#region src/engines/code-quality/complexity-cpp.ts
const CPP_FUNCTION_PATTERNS = [{
	regex: /^\s*(?:[\w:<>,*&[\]]+\s+)*?(\w+::~?\w+)\s*\(([^)]*)\)/,
	langFilter: [...CPP_SOURCE_EXTENSIONS]
}, {
	regex: /^\s*(?:explicit\s+|constexpr\s+|inline\s+|virtual\s+)*(?!(?:if|for|while|switch|do|else|catch|return|throw|sizeof|new|delete|typeid|static_assert|decltype|case|goto)\b)(~?\w+)\s*\(([^)]*)\)\s*(?:const\b|noexcept\b|override\b|final\b|\s)*(?::|\{|$)/,
	langFilter: [
		".cc",
		".cpp",
		".cxx",
		".hh",
		".hpp",
		".hxx"
	]
}];
const CPP_FILE_LOC_MULTIPLIERS = Object.fromEntries([...CPP_SOURCE_EXTENSIONS].map((extension) => [extension, 2.5]));
const CPP_FILE_TOO_LARGE_HELP = "Split this C++ file into a component using the component-as-translation-unit pattern; see docs/cpp-component-pattern.md";
//#endregion
//#region src/engines/code-quality/complexity-csharp.ts
const CSHARP_FUNCTION_PATTERNS = [{
	regex: /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|async|virtual|override|sealed|abstract|extern|unsafe|new|partial|readonly)\s+)+[^()=;{]*?(\w+)\s*\(([^)]*)\)/,
	langFilter: [".cs"]
}];
const CSHARP_FILE_TOO_LARGE_HELP = "Consider splitting this file into partial class files or smaller modules";
const MULTILINE_SIGNATURE_EXTS = /* @__PURE__ */ new Set([".cs", ...CPP_SOURCE_EXTENSIONS]);
const logicalSignatureLine = (lines, startIndex) => {
	const first = lines[startIndex];
	let depth = 0;
	let sawOpen = false;
	for (const ch of first) if (ch === "(") {
		depth++;
		sawOpen = true;
	} else if (ch === ")") depth--;
	if (!sawOpen || depth <= 0) return first;
	let joined = first;
	for (let j = startIndex + 1; j < lines.length && j < startIndex + 12; j++) {
		const line = lines[j];
		joined += ` ${line}`;
		for (const ch of line) if (ch === "(") depth++;
		else if (ch === ")") depth--;
		if (depth <= 0) break;
		if (line.includes(";")) break;
	}
	return joined;
};
//#endregion
//#region src/engines/code-quality/initializer-list.ts
const MAXIMUM_INITIALIZER_LINES = 200;
const SIGNATURE_QUALIFIERS = /* @__PURE__ */ new Set([
	"const",
	"volatile",
	"noexcept",
	"override",
	"final"
]);
const NAME_CHARACTER_RE = /[A-Za-z0-9_:~.*&[\]]/;
const characterAt = (lines, position) => {
	const line = lines[position.lineIndex];
	if (line === void 0) return null;
	if (position.columnIndex >= line.length) return "\n";
	return line[position.columnIndex];
};
const advance = (lines, position) => {
	const line = lines[position.lineIndex];
	if (line === void 0 || position.columnIndex >= line.length) return {
		lineIndex: position.lineIndex + 1,
		columnIndex: 0
	};
	return {
		lineIndex: position.lineIndex,
		columnIndex: position.columnIndex + 1
	};
};
const isSamePosition = (left, right) => left.lineIndex === right.lineIndex && left.columnIndex === right.columnIndex;
const skipWhitespace = (lines, position) => {
	let current = position;
	while (true) {
		const character = characterAt(lines, current);
		if (character === null || !/\s/.test(character)) return current;
		current = advance(lines, current);
	}
};
const skipBalanced = (lines, position, open, close, limitLine) => {
	let current = position;
	let depth = 0;
	while (current.lineIndex <= limitLine) {
		const character = characterAt(lines, current);
		if (character === null) return null;
		if (character === open) depth++;
		else if (character === close) {
			depth--;
			if (depth === 0) return advance(lines, current);
		}
		current = advance(lines, current);
	}
	return null;
};
const skipInitializerName = (lines, position) => {
	let current = position;
	let angleDepth = 0;
	while (true) {
		const character = characterAt(lines, current);
		if (character === null) return current;
		if (character === "<") angleDepth++;
		else if (character === ">") angleDepth = Math.max(0, angleDepth - 1);
		else if (character === "," || /\s/.test(character)) {
			if (angleDepth === 0) return current;
		} else if (!NAME_CHARACTER_RE.test(character)) return current;
		current = advance(lines, current);
	}
};
const skipFunctionTryKeyword = (lines, position) => {
	const wordEnd = skipInitializerName(lines, position);
	if ((lines[position.lineIndex]?.slice(position.columnIndex, wordEnd.columnIndex) ?? "") !== "try") return position;
	return skipWhitespace(lines, wordEnd);
};
const findInitializerListColon = (lines, startIndex, limitLine) => {
	let current = {
		lineIndex: startIndex,
		columnIndex: 0
	};
	while (current.lineIndex <= limitLine) {
		const character = characterAt(lines, current);
		if (character === null || character === "{" || character === ";") return null;
		if (character === "(") break;
		current = advance(lines, current);
	}
	const afterParameters = skipBalanced(lines, current, "(", ")", limitLine);
	if (!afterParameters) return null;
	current = afterParameters;
	while (current.lineIndex <= limitLine) {
		current = skipWhitespace(lines, current);
		const character = characterAt(lines, current);
		if (character === null) return null;
		if (character === ":") return characterAt(lines, advance(lines, current)) === ":" ? null : current;
		if (character === "&") {
			current = advance(lines, current);
			continue;
		}
		if (character === "(") {
			const afterSpecification = skipBalanced(lines, current, "(", ")", limitLine);
			if (!afterSpecification) return null;
			current = afterSpecification;
			continue;
		}
		const wordStart = current;
		current = skipInitializerName(lines, current);
		if (isSamePosition(current, wordStart)) return null;
		const word = lines[wordStart.lineIndex]?.slice(wordStart.columnIndex, current.columnIndex) ?? "";
		if (!SIGNATURE_QUALIFIERS.has(word.trim())) return null;
	}
	return null;
};
const findInitializerListBodyStart = (lines, startIndex) => {
	const limitLine = Math.min(lines.length - 1, startIndex + MAXIMUM_INITIALIZER_LINES);
	const colon = findInitializerListColon(lines, startIndex, limitLine);
	if (!colon) return null;
	let current = advance(lines, colon);
	while (current.lineIndex <= limitLine) {
		current = skipWhitespace(lines, current);
		const nameEnd = skipInitializerName(lines, current);
		if (isSamePosition(nameEnd, current)) return null;
		const opener = characterAt(lines, nameEnd);
		if (opener !== "(" && opener !== "{") return null;
		const afterInitializer = skipBalanced(lines, nameEnd, opener, opener === "(" ? ")" : "}", limitLine);
		if (!afterInitializer) return null;
		current = skipWhitespace(lines, afterInitializer);
		while (characterAt(lines, current) === ".") current = advance(lines, current);
		current = skipWhitespace(lines, current);
		current = skipFunctionTryKeyword(lines, current);
		const next = characterAt(lines, current);
		if (next === "{") return current;
		if (next !== ",") return null;
		current = advance(lines, current);
	}
	return null;
};
//#endregion
//#region src/engines/code-quality/function-boundaries.ts
const PYTHON_CONTROL_FLOW_RE = /^\s*(?:if|for|while|with|try|except|else|elif|finally|def|class)\b/;
const ARROW_BLOCK_RE = /=>\s*\{/;
const ARROW_END_RE = /=>\s*$/;
const BRACE_START_RE = /^\s*\{/;
const NEW_STATEMENT_RE = /^(?:export\s+)?(?:const|let|var|function|class)\s/;
const isControlFlowBrace = (lineText, braceIndex) => {
	const before = lineText.substring(0, braceIndex).trimEnd();
	if (before.endsWith(")")) return true;
	if (before.endsWith("=>")) return true;
	if (/\b(?:else|try|finally|do)$/.test(before)) return true;
	return false;
};
const findBraceFunctionEnd = (lines, startIndex) => {
	let depth = 0;
	let started = false;
	let endLine = startIndex;
	let maxNesting = 0;
	let functionStartDepth = 0;
	const braceStack = [];
	const bodyStart = findInitializerListBodyStart(lines, startIndex);
	for (let j = bodyStart?.lineIndex ?? startIndex; j < lines.length; j++) {
		const l = lines[j];
		for (let ci = j === bodyStart?.lineIndex ? bodyStart.columnIndex : 0; ci < l.length; ci++) {
			const ch = l[ci];
			if (ch === ";" && !started) return {
				endLine: -1,
				maxNesting: 0
			};
			if (ch === "{") {
				depth++;
				if (!started && depth === 1) {
					started = true;
					functionStartDepth = depth;
					braceStack.push(false);
				} else {
					const isCF = isControlFlowBrace(l, ci);
					braceStack.push(isCF);
					if (isCF) {
						let cfCount = 0;
						for (const b of braceStack) if (b) cfCount++;
						if (cfCount > maxNesting) maxNesting = cfCount;
					}
				}
			} else if (ch === "}") {
				depth--;
				braceStack.pop();
			}
		}
		if (started && depth < functionStartDepth && j > startIndex) {
			endLine = j;
			break;
		}
		if (j === lines.length - 1) endLine = j;
	}
	if (!started) return {
		endLine: startIndex,
		maxNesting: 0
	};
	return {
		endLine,
		maxNesting
	};
};
const extractPythonSignature = (lines, startIndex) => {
	let depth = 0;
	let started = false;
	let params = "";
	for (let j = startIndex; j < lines.length; j++) {
		const l = lines[j];
		for (let ci = 0; ci < l.length; ci++) {
			const ch = l[ci];
			if (ch === "(") {
				depth++;
				if (depth === 1 && !started) {
					started = true;
					continue;
				}
			} else if (ch === ")") {
				depth--;
				if (depth === 0) return {
					params,
					sigEndIndex: j
				};
			}
			if (started) params += ch;
		}
		if (started) params += " ";
	}
	return {
		params,
		sigEndIndex: startIndex
	};
};
const countPythonParams = (signature) => {
	let depth = 0;
	const parts = [];
	let current = "";
	for (const ch of signature) {
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	parts.push(current);
	let count = 0;
	for (const raw of parts) {
		const p = raw.trim();
		if (p.length === 0 || p === "*" || p === "/") continue;
		if (p.startsWith("*")) continue;
		if (p.includes("=")) continue;
		const name = p.split(":")[0].trim();
		if (name === "self" || name === "cls") continue;
		count++;
	}
	return count;
};
const countPythonBodyCodeLines = (lines, sigEndIndex, endLine) => {
	let count = 0;
	let inDoc = false;
	let delim = "";
	for (let j = sigEndIndex + 1; j <= endLine && j < lines.length; j++) {
		const t = lines[j].trim();
		if (inDoc) {
			if (t.includes(delim)) inDoc = false;
			continue;
		}
		if (t === "" || t.startsWith("#")) continue;
		const opener = t.startsWith("\"\"\"") ? "\"\"\"" : t.startsWith("'''") ? "'''" : "";
		if (opener) {
			if (!t.slice(3).includes(opener)) {
				inDoc = true;
				delim = opener;
			}
			continue;
		}
		count++;
	}
	return count;
};
const findPythonFunctionEnd = (lines, defIndex, bodyStartIndex) => {
	const baseIndent = lines[defIndex].match(/^(\s*)/)?.[1].length ?? 0;
	let endLine = bodyStartIndex;
	let maxNesting = 0;
	const controlIndentStack = [];
	for (let j = bodyStartIndex + 1; j < lines.length; j++) {
		const l = lines[j];
		if (l.trim() === "") {
			endLine = j;
			continue;
		}
		const currentIndent = l.match(/^(\s*)/)?.[1].length ?? 0;
		if (currentIndent <= baseIndent) break;
		endLine = j;
		while (controlIndentStack.length > 0 && currentIndent <= controlIndentStack[controlIndentStack.length - 1]) controlIndentStack.pop();
		if (PYTHON_CONTROL_FLOW_RE.test(l)) {
			controlIndentStack.push(currentIndent);
			const nesting = controlIndentStack.length;
			if (nesting > maxNesting) maxNesting = nesting;
		}
	}
	return {
		endLine,
		maxNesting
	};
};
const findFunctionEnd = (codeLines, startIndex, isPython) => {
	if (isPython) {
		const { sigEndIndex } = extractPythonSignature(codeLines, startIndex);
		return findPythonFunctionEnd(codeLines, startIndex, sigEndIndex);
	}
	return findBraceFunctionEnd(codeLines, startIndex);
};
const isBlockArrow = (lines, startIndex) => {
	if (ARROW_BLOCK_RE.test(lines[startIndex])) return true;
	if (ARROW_END_RE.test(lines[startIndex])) {
		const next = lines[startIndex + 1];
		if (next && BRACE_START_RE.test(next)) return true;
	}
	for (let j = startIndex + 1; j < Math.min(startIndex + 3, lines.length); j++) {
		const l = lines[j];
		if (l.trim() === "" || NEW_STATEMENT_RE.test(l.trim())) break;
		if (ARROW_BLOCK_RE.test(l)) return true;
		if (BRACE_START_RE.test(l)) return true;
	}
	return false;
};
const countTemplateLines = (bodyLines) => {
	let insideTemplate = false;
	let templateLineCount = 0;
	for (const line of bodyLines) {
		const startedInside = insideTemplate;
		let escaped = false;
		for (const ch of line) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === "`") insideTemplate = !insideTemplate;
		}
		if (startedInside) templateLineCount++;
	}
	return templateLineCount;
};
//#endregion
//#region src/engines/code-quality/complexity-functions.ts
const FUNCTION_PATTERNS = [
	{
		regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
		langFilter: [
			".js",
			".ts",
			".jsx",
			".tsx",
			".mjs",
			".cjs"
		]
	},
	{
		regex: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?:=>|:\s*\w)/,
		langFilter: [
			".js",
			".ts",
			".jsx",
			".tsx",
			".mjs",
			".cjs"
		]
	},
	{
		regex: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/,
		langFilter: [".py"]
	},
	{
		regex: /^\s*func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)/,
		langFilter: [".go"]
	},
	{
		regex: /^\s*fn\s+(\w+)\s*\(([^)]*)\)/,
		langFilter: [".rs"]
	},
	{
		regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:(?!(?:return|if|for|while|switch|do|else|throw|delete|new|break|continue|goto|try|catch)\b)\w+\s+)(\w+)\s*\(([^)]*)\)/,
		langFilter: [
			".java",
			".php",
			".cs",
			...CPP_SOURCE_EXTENSIONS
		]
	},
	...CSHARP_FUNCTION_PATTERNS,
	...CPP_FUNCTION_PATTERNS
];
const countParams = (parameterList) => {
	const trimmed = parameterList.trim();
	if (!trimmed) return 0;
	let depth = 0;
	let count = 1;
	for (const ch of trimmed) if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
	else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1);
	else if (ch === "," && depth === 0) count++;
	return count;
};
const matchFunctionOnLine = (line, ext) => {
	for (let i = 0; i < FUNCTION_PATTERNS.length; i++) {
		const pattern = FUNCTION_PATTERNS[i];
		if (!pattern.langFilter.includes(ext)) continue;
		const match = line.match(pattern.regex);
		if (match) return {
			name: match[1],
			params: match[2] ?? "",
			patternIndex: i
		};
	}
	return null;
};
const isDataFile = (content) => {
	const nonEmpty = content.split("\n").filter((l) => l.trim().length > 0);
	if (nonEmpty.length === 0) return false;
	const dataLinePattern = /^\s*[{}[\]"']/;
	return nonEmpty.filter((l) => dataLinePattern.test(l)).length / nonEmpty.length > .8;
};
const TEST_PATH_RE = /(?:^|\/)(?:tests?|spec|specs|__tests__|__spec__|src\/test)\//i;
const TEST_BASENAME_RE = /(?:^|[/.])(?:test_[\w-]+\.(?:py|rb)|[\w-]+_(?:test|spec)\.(?:py|rb|go|rs)|[\w-]+\.(?:test|spec)\.(?:[jt]sx?|mjs|cjs)|conftest\.py|[A-Z]\w*Tests?\.(?:java|cs|php))$/;
const MIGRATION_PATH_RE = /(?:^|\/)(?:migrations?|migrate|prisma\/migrations|db\/migrate)\//i;
const FIXTURE_PATH_RE = /(?:^|\/)(?:__fixtures__|__snapshots__|__mocks__|fixtures?|snapshots?|seeds?|stubs?)\//i;
const GENERATED_PATH_RE = /(?:^|\/)(?:generated|gen|build|dist|out|target|coverage|node_modules|vendor|\.next|\.nuxt|\.svelte-kit)\//i;
const isExemptFromComplexity = (relativePath) => TEST_PATH_RE.test(relativePath) || TEST_BASENAME_RE.test(relativePath) || MIGRATION_PATH_RE.test(relativePath) || FIXTURE_PATH_RE.test(relativePath) || GENERATED_PATH_RE.test(relativePath);
const analyzeFunctions = (content, ext) => {
	const lines = content.split("\n");
	const maskedLines = maskStringsAndComments$1(content, ext).split("\n");
	const functions = [];
	for (let i = 0; i < lines.length; i++) {
		const matchLine = MULTILINE_SIGNATURE_EXTS.has(ext) ? logicalSignatureLine(maskedLines, i) : lines[i];
		const fnMatch = matchFunctionOnLine(matchLine, ext);
		if (!fnMatch) continue;
		const isPython = fnMatch.patternIndex === 2;
		if (fnMatch.patternIndex === 1 && !isBlockArrow(maskedLines, i)) continue;
		const { endLine, maxNesting } = findFunctionEnd(maskedLines, i, isPython);
		if (endLine < 0) continue;
		let templateLines;
		let paramCount;
		if (isPython) {
			const sig = extractPythonSignature(lines, i);
			const codeLines = countPythonBodyCodeLines(lines, sig.sigEndIndex, endLine);
			templateLines = endLine - i + 1 - codeLines;
			paramCount = countPythonParams(sig.params);
		} else {
			templateLines = countTemplateLines(lines.slice(i + 1, endLine));
			paramCount = countParams(fnMatch.params);
		}
		functions.push({
			name: fnMatch.name,
			startLine: i + 1,
			lineCount: endLine - i + 1,
			maxNesting,
			paramCount,
			templateLines
		});
	}
	return functions;
};
//#endregion
//#region src/engines/code-quality/complexity.ts
const FILE_LOC_MULTIPLIERS = {
	".tsx": 1.5,
	".jsx": 1.5,
	".rs": 2.5,
	".go": 1.5,
	...CPP_FILE_LOC_MULTIPLIERS
};
const DECLARATION_FILE_RE = /\.d\.ts$/i;
const GENERIC_FILE_TOO_LARGE_HELP = "Consider splitting this file into smaller modules";
const fileTooLargeHelp = (ext) => {
	if (CPP_SOURCE_EXTENSIONS.has(ext)) return CPP_FILE_TOO_LARGE_HELP;
	if (ext === ".cs") return CSHARP_FILE_TOO_LARGE_HELP;
	return GENERIC_FILE_TOO_LARGE_HELP;
};
const fileLocBudget = (ext, relativePath, base) => {
	if (DECLARATION_FILE_RE.test(relativePath)) return Number.POSITIVE_INFINITY;
	const multiplier = FILE_LOC_MULTIPLIERS[ext] ?? 1;
	return Math.ceil(base * multiplier);
};
const checkFileDiagnostics = (relativePath, content, limits) => {
	const results = [];
	const lineCount = content.split("\n").length;
	const ext = path.extname(relativePath).toLowerCase();
	if (isDataFile(content)) return results;
	const configuredMax = fileLocBudget(ext, relativePath, limits.maxFileLoc);
	if (!Number.isFinite(configuredMax)) return results;
	if (lineCount > Math.ceil(configuredMax * 1.1)) results.push({
		filePath: relativePath,
		engine: "code-quality",
		rule: "complexity/file-too-large",
		severity: "warning",
		message: `File too large (max: ${configuredMax})`,
		help: fileTooLargeHelp(ext),
		line: 0,
		column: 0,
		category: "Complexity",
		fixable: false,
		detail: `${lineCount} lines`
	});
	return results;
};
const JSX_EXTENSIONS = /* @__PURE__ */ new Set([".tsx", ".jsx"]);
const isComponentFunction = (name, ext) => JSX_EXTENSIONS.has(ext) && /^[A-Z]/.test(name);
const functionLocBudget = (fn, ext, base) => {
	if (isComponentFunction(fn.name, ext)) return Math.ceil(base * 2);
	if (ext === ".rs") return Math.ceil(base * 1.5);
	return base;
};
const checkFunctionDiagnostics = (relativePath, fn, limits, ext) => {
	const results = [];
	const fnMax = functionLocBudget(fn, ext, limits.maxFunctionLoc);
	if (fn.lineCount - fn.templateLines > Math.ceil(fnMax * 1.1)) results.push({
		filePath: relativePath,
		engine: "code-quality",
		rule: "complexity/function-too-long",
		severity: "warning",
		message: `Function too long (max: ${fnMax})`,
		help: "Consider breaking this function into smaller pieces",
		line: fn.startLine,
		column: 0,
		category: "Complexity",
		fixable: false,
		detail: `${fn.name} · ${fn.lineCount} lines`
	});
	if (fn.maxNesting > limits.maxNesting) results.push({
		filePath: relativePath,
		engine: "code-quality",
		rule: "complexity/deep-nesting",
		severity: "warning",
		message: `Function nested too deeply (max: ${limits.maxNesting})`,
		help: "Consider using early returns or extracting nested logic",
		line: fn.startLine,
		column: 0,
		category: "Complexity",
		fixable: false,
		detail: `${fn.name} · depth ${fn.maxNesting}`
	});
	if (fn.paramCount > limits.maxParams) results.push({
		filePath: relativePath,
		engine: "code-quality",
		rule: "complexity/too-many-params",
		severity: "warning",
		message: `Function has too many parameters (max: ${limits.maxParams})`,
		help: "Consider using an options object parameter",
		line: fn.startLine,
		column: 0,
		category: "Complexity",
		fixable: false,
		detail: `${fn.name} · ${fn.paramCount} params`
	});
	return results;
};
const checkFileComplexity = (filePath, rootDirectory, limits) => {
	const relativePath = relativePosix(rootDirectory, filePath);
	if (isExemptFromComplexity(relativePath)) return [];
	let content;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	const ext = path.extname(filePath).toLowerCase();
	const diagnostics = checkFileDiagnostics(relativePath, content, limits);
	for (const fn of analyzeFunctions(content, ext)) diagnostics.push(...checkFunctionDiagnostics(relativePath, fn, limits, ext));
	return diagnostics;
};
const checkComplexity = async (context) => {
	const files = getSourceFiles(context);
	const limits = context.config.quality;
	const diagnostics = [];
	for (const filePath of files) {
		if (isAutoGenerated(filePath)) continue;
		diagnostics.push(...checkFileComplexity(filePath, context.rootDirectory, limits));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/code-quality/duplicate-block.ts
const WINDOW_SIZE = 10;
const MIN_DISTINCT_LINES = 7;
const SOURCE_EXTS$1 = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const STATIC_SVG_COMPONENT_RE = /(?:^|\/)[^/]+(?:_svg|\.svg)\.(?:tsx|jsx|ts|js)$/i;
const MEANINGFUL_LINE = /\S/;
const normaliseLine = (line) => line.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "\"L\"").replace(/\b\d+(?:\.\d+)?\b/g, "0").replace(/\s+/g, " ").trim();
const isTrivialLine = (line) => {
	const trimmed = line.trim();
	if (trimmed.length === 0) return true;
	if (trimmed === "{" || trimmed === "}" || trimmed === "});" || trimmed === "},") return true;
	if (trimmed.startsWith("//")) return true;
	if (trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
	return false;
};
const SVG_MARKUP_RE = /<\/?(?:svg|path|polyline|line|circle|rect|g)\b|(?:xmlns|viewBox|stroke(?:-width|-linecap|-linejoin)?|fill|fill-opacity|d|points|x1|x2|y1|y2)=/;
const DATA_LITERAL_RE = /^\s*(?:[A-Za-z_$][\w$-]*:\s*(?:["'`[{]|\d|true\b|false\b|null\b)|["'`][^"'`]*["'`],?\s*$|[{}\]],?\s*$|\),?\s*$)/;
const SUPPRESS_RE = /aislop[- ]ignore(?:-next-block|-file)?\b.*\b(?:duplicate-block|code-quality\/duplicate-block)\b/;
const FILE_SUPPRESS_RE = /aislop[- ]ignore-file\b.*\b(?:duplicate-block|code-quality\/duplicate-block)\b/;
const fileHasSuppression = (content) => FILE_SUPPRESS_RE.test(content);
const isLowSignalMarkupWindow = (lines) => {
	return lines.filter((line) => SVG_MARKUP_RE.test(line)).length >= Math.ceil(WINDOW_SIZE / 2);
};
const isLowSignalDataWindow = (lines) => {
	return lines.filter((line) => DATA_LITERAL_RE.test(line)).length >= WINDOW_SIZE - 1;
};
const findSuppressedLines = (lines) => {
	const suppressed = /* @__PURE__ */ new Set();
	for (let i = 0; i < lines.length; i++) {
		if (!SUPPRESS_RE.test(lines[i])) continue;
		let depth = 0;
		let started = false;
		for (let j = i + 1; j < lines.length; j++) {
			suppressed.add(j + 1);
			const opens = (lines[j].match(/\{/g) ?? []).length;
			const closes = (lines[j].match(/\}/g) ?? []).length;
			depth += opens - closes;
			if (opens > 0) started = true;
			if (started && depth <= 0) break;
		}
	}
	return suppressed;
};
const collectMeaningfulLines = (content) => {
	if (fileHasSuppression(content)) return [];
	const lines = content.split("\n");
	const suppressed = findSuppressedLines(lines);
	const hits = [];
	for (let i = 0; i < lines.length - WINDOW_SIZE + 1; i++) {
		if (suppressed.has(i + 1)) continue;
		const window = lines.slice(i, i + WINDOW_SIZE);
		if (window.some((l) => !MEANINGFUL_LINE.test(l))) continue;
		if (isLowSignalMarkupWindow(window)) continue;
		if (isLowSignalDataWindow(window)) continue;
		if (window.every(isTrivialLine)) continue;
		const normalised = window.map(normaliseLine);
		if (normalised.filter((n) => n.length > 0 && n !== "}" && n !== "{").length < WINDOW_SIZE - 1) continue;
		if (new Set(normalised).size < MIN_DISTINCT_LINES) continue;
		hits.push({
			startLine: i + 1,
			normalised
		});
	}
	return hits;
};
const findDuplicateBlocks = (content, relativePath) => {
	const blocks = collectMeaningfulLines(content);
	const seen = /* @__PURE__ */ new Map();
	const reports = [];
	const reportedCurrent = /* @__PURE__ */ new Set();
	for (const block of blocks) {
		const key = block.normalised.join("\n");
		const prior = seen.get(key);
		if (prior === void 0) {
			seen.set(key, block.startLine);
			continue;
		}
		if (block.startLine - prior < WINDOW_SIZE) continue;
		if (reportedCurrent.has(prior)) continue;
		const last = reports[reports.length - 1];
		if (last && block.startLine - last.currentStart < WINDOW_SIZE && prior - last.priorStart < WINDOW_SIZE) {
			last.priorEnd = Math.max(last.priorEnd, prior + WINDOW_SIZE - 1);
			last.currentEnd = Math.max(last.currentEnd, block.startLine + WINDOW_SIZE - 1);
			continue;
		}
		reportedCurrent.add(prior);
		reports.push({
			priorStart: prior,
			priorEnd: prior + WINDOW_SIZE - 1,
			currentStart: block.startLine,
			currentEnd: block.startLine + WINDOW_SIZE - 1
		});
	}
	return reports.map((r) => {
		const span = r.currentEnd - r.currentStart + 1;
		return {
			filePath: relativePath,
			engine: "code-quality",
			rule: "code-quality/duplicate-block",
			severity: "warning",
			message: "Duplicate code block — extract a shared helper",
			help: `Pull the shared logic into a function both sites can call. Keeps one version of the truth and makes future changes one-shot instead of N-shot.`,
			line: r.currentStart,
			column: 0,
			category: "Complexity",
			fixable: false,
			detail: `${span} lines duplicate block at L${r.priorStart}`
		};
	});
};
const detectDuplicateBlocks = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		const ext = path.extname(filePath).toLowerCase();
		if (!SOURCE_EXTS$1.has(ext)) continue;
		if (filePath.endsWith(".d.ts")) continue;
		if (isAutoGenerated(filePath)) continue;
		const relative = relativePosix(context.rootDirectory, filePath);
		if (STATIC_SVG_COMPONENT_RE.test(relative)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		diagnostics.push(...findDuplicateBlocks(content, relative));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/code-quality/knip.ts
const KNIP_MESSAGE_MAP = {
	files: "Unused file",
	dependencies: "Unused dependency",
	devDependencies: "Unused devDependency",
	unlisted: "Unlisted dependency",
	unresolved: "Unresolved import",
	binaries: "Unlisted binary",
	exports: "Unused export",
	types: "Unused type",
	duplicates: "Duplicate export"
};
const DEPENDENCY_TYPES = [
	"dependencies",
	"devDependencies",
	"unlisted",
	"unresolved",
	"binaries"
];
const isDependencyType = (type) => DEPENDENCY_TYPES.includes(type);
const getIssueItems = (fileIssue, issueType) => {
	const items = fileIssue[issueType];
	return Array.isArray(items) ? items : [];
};
const shouldIncludeIssue = (issueType, filePath) => {
	if (issueType !== "binaries") return true;
	return !filePath.replace(/\\/g, "/").includes(".github/workflows/");
};
const DEPENDENCY_HELP = {
	dependencies: "This package is listed in package.json but not imported anywhere. Remove it with `npm uninstall` or `aislop fix`.",
	devDependencies: "This package is listed in package.json but not imported anywhere. Remove it with `npm uninstall` or `aislop fix`.",
	unlisted: "This package is imported in code but not declared in package.json. Run `npm install` to add it.",
	unresolved: "This import cannot be resolved. Check for typos or missing packages.",
	binaries: "This binary is used but its package is not in package.json."
};
const collectIssues = (fileIssue, issueType, rootDir, knipCwd) => {
	const diagnostics = [];
	if (!shouldIncludeIssue(issueType, fileIssue.file)) return diagnostics;
	const issues = getIssueItems(fileIssue, issueType);
	const category = isDependencyType(issueType) ? "Dependencies" : "Dead Code";
	const severity = issueType === "unlisted" || issueType === "unresolved" ? "error" : "warning";
	const fixable = issueType === "dependencies" || issueType === "devDependencies" || issueType === "exports" || issueType === "types" || issueType === "duplicates";
	const help = DEPENDENCY_HELP[issueType] ?? "";
	for (const issue of issues) {
		const symbol = issue.name ?? issue.symbol ?? "unknown";
		const absolutePath = path.resolve(knipCwd, fileIssue.file);
		diagnostics.push({
			filePath: relativePosix(rootDir, absolutePath),
			engine: "code-quality",
			rule: `knip/${issueType}`,
			severity,
			message: `${KNIP_MESSAGE_MAP[issueType]}: ${symbol}`,
			help,
			line: issue.line ?? 0,
			column: issue.col ?? 0,
			category,
			fixable
		});
	}
	return diagnostics;
};
const findMonorepoRoot = (directory) => {
	let current = directory;
	while (current !== path.dirname(current)) {
		if (fs.existsSync(path.join(current, "pnpm-workspace.yaml")) || (() => {
			const pkgPath = path.join(current, "package.json");
			if (!fs.existsSync(pkgPath)) return false;
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			return Array.isArray(pkg.workspaces) || pkg.workspaces?.packages;
		})()) return current;
		current = path.dirname(current);
	}
	return null;
};
const isSubpath = (parent, child) => {
	const relative = path.relative(parent, child);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
};
const getRelativePathWithinRoot = (rootDirectory, baseDirectory, reportedPath) => {
	const rootPath = path.resolve(rootDirectory);
	const absolutePath = path.resolve(baseDirectory, reportedPath);
	if (!isSubpath(rootPath, absolutePath)) return null;
	return relativePosix(rootPath, absolutePath);
};
const getSafeUnusedFilePath = (rootDirectory, filePath) => {
	const rootPath = fs.realpathSync(rootDirectory);
	const absolutePath = path.resolve(rootDirectory, filePath);
	let stat;
	let realPath;
	try {
		stat = fs.lstatSync(absolutePath);
		realPath = fs.realpathSync(absolutePath);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;
	if (!isSubpath(rootPath, realPath)) return null;
	return absolutePath;
};
const KNIP_BIN = path.join("bin", "knip.js");
const requireFromAislop = createRequire(import.meta.url);
const findPackageRoot = (entryPath, packageName) => {
	let current = path.dirname(entryPath);
	while (current !== path.dirname(current)) {
		const pkgPath = path.join(current, "package.json");
		if (fs.existsSync(pkgPath)) try {
			if (JSON.parse(fs.readFileSync(pkgPath, "utf-8")).name === packageName) return current;
		} catch {
			return null;
		}
		current = path.dirname(current);
	}
	return null;
};
const findBundledKnipBin = () => {
	try {
		const knipEntry = requireFromAislop.resolve("knip");
		const knipRoot = findPackageRoot(knipEntry, "knip");
		if (!knipRoot) return null;
		const binPath = path.join(knipRoot, KNIP_BIN);
		return fs.existsSync(binPath) ? binPath : null;
	} catch {
		return null;
	}
};
const packageDeclaresKnip = (directory) => {
	const pkgPath = path.join(directory, "package.json");
	if (!fs.existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return Boolean(pkg.dependencies?.knip || pkg.devDependencies?.knip || pkg.peerDependencies?.knip || pkg.optionalDependencies?.knip);
	} catch {
		return false;
	}
};
const findKnipRuntime = (rootDirectory, monorepoRoot) => {
	const monorepoDeclaresKnip = monorepoRoot ? packageDeclaresKnip(monorepoRoot) : false;
	const packageDeclaresKnipDependency = packageDeclaresKnip(rootDirectory);
	if (!monorepoDeclaresKnip && !packageDeclaresKnipDependency) return null;
	const binPath = findBundledKnipBin();
	if (!binPath) return null;
	return {
		binPath,
		cwd: monorepoRoot && monorepoDeclaresKnip ? monorepoRoot : rootDirectory
	};
};
const runKnipDependencyCheck = async (rootDirectory) => {
	return (await runKnip(rootDirectory)).filter((d) => d.rule === "knip/dependencies" || d.rule === "knip/devDependencies");
};
const fixUnusedDependencies = async (rootDirectory) => {
	const diagnostics = await runKnipDependencyCheck(rootDirectory);
	if (diagnostics.length === 0) return;
	const pkgPath = path.join(rootDirectory, "package.json");
	if (!fs.existsSync(pkgPath)) return;
	const raw = fs.readFileSync(pkgPath, "utf-8");
	const pkg = JSON.parse(raw);
	const unusedDeps = /* @__PURE__ */ new Set();
	const unusedDevDeps = /* @__PURE__ */ new Set();
	for (const d of diagnostics) {
		const pkgName = d.message.replace(/^Unused (dev)?[Dd]ependency: /, "");
		if (d.rule === "knip/dependencies") unusedDeps.add(pkgName);
		if (d.rule === "knip/devDependencies") unusedDevDeps.add(pkgName);
	}
	let changed = false;
	if (pkg.dependencies) {
		for (const name of unusedDeps) if (name in pkg.dependencies) {
			delete pkg.dependencies[name];
			changed = true;
		}
	}
	if (pkg.devDependencies) {
		for (const name of unusedDevDeps) if (name in pkg.devDependencies) {
			delete pkg.devDependencies[name];
			changed = true;
		}
	}
	if (changed) fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "	")}\n`);
};
const runKnipUnusedFiles = async (rootDirectory) => {
	return (await runKnip(rootDirectory)).filter((d) => d.rule === "knip/files");
};
const fixUnusedFiles = async (rootDirectory, allow = () => true) => {
	const diagnostics = await runKnipUnusedFiles(rootDirectory);
	for (const d of diagnostics) {
		if (!allow(d.filePath)) continue;
		const absolutePath = getSafeUnusedFilePath(rootDirectory, d.filePath);
		if (absolutePath) fs.unlinkSync(absolutePath);
	}
};
const runKnip = async (rootDirectory) => {
	const monorepoRoot = findMonorepoRoot(rootDirectory);
	const knipRuntime = findKnipRuntime(rootDirectory, monorepoRoot);
	if (!knipRuntime) return [];
	try {
		const args = [
			knipRuntime.binPath,
			"--no-progress",
			"--reporter",
			"json",
			"--no-exit-code"
		];
		const result = await runSubprocess(process.execPath, args, {
			cwd: knipRuntime.cwd,
			timeout: 6e4,
			env: { FORCE_COLOR: "0" }
		});
		if (!result.stdout) return [];
		const parsed = JSON.parse(result.stdout);
		const diagnostics = [];
		const files = parsed.files ?? [];
		for (const unusedFile of files) {
			const filePath = getRelativePathWithinRoot(rootDirectory, knipRuntime.cwd, unusedFile);
			if (!filePath) continue;
			diagnostics.push({
				filePath,
				engine: "code-quality",
				rule: "knip/files",
				severity: "warning",
				message: KNIP_MESSAGE_MAP.files,
				help: "This file is not imported by any other file in the project.",
				line: 0,
				column: 0,
				category: "Dead Code",
				fixable: false
			});
		}
		const issues = parsed.issues ?? [];
		const issueTypes = [
			...DEPENDENCY_TYPES,
			"exports",
			"types",
			"duplicates"
		];
		for (const fileIssue of issues) for (const type of issueTypes) diagnostics.push(...collectIssues(fileIssue, type, rootDirectory, knipRuntime.cwd));
		return diagnostics;
	} catch {
		return [];
	}
};
//#endregion
//#region src/engines/code-quality/repeated-chained-call.ts
const METHOD_CALL_RE = /^\s*\.([A-Za-z_$][\w$]*)\s*\(/;
const CHAIN_THRESHOLD = 5;
const hasOnlyLiteralDifferences = (lines) => {
	const normalised = lines.map((l) => l.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "\"L\"").trim().replace(/;\s*$/, ""));
	return new Set(normalised).size === 1;
};
const findRepeatedChains = (content, relativePath) => {
	const diagnostics = [];
	const lines = content.split("\n");
	let i = 0;
	while (i < lines.length) {
		const match = lines[i].match(METHOD_CALL_RE);
		if (!match) {
			i += 1;
			continue;
		}
		const methodName = match[1];
		const runStart = i;
		let runEnd = i;
		while (runEnd + 1 < lines.length) {
			const next = lines[runEnd + 1].match(METHOD_CALL_RE);
			if (!next || next[1] !== methodName) break;
			runEnd += 1;
		}
		const runLength = runEnd - runStart + 1;
		if (runLength >= CHAIN_THRESHOLD && hasOnlyLiteralDifferences(lines.slice(runStart, runEnd + 1))) {
			diagnostics.push({
				filePath: relativePath,
				engine: "code-quality",
				rule: "code-quality/repeated-chained-call",
				severity: "warning",
				message: `${runLength} consecutive \`.${methodName}()\` calls that differ only in string literals. Extract a data table + loop.`,
				help: `Move the per-call args into an array and call \`.${methodName}()\` in a \`for\` loop. Keeps the registration in one place and lets you document the table once.`,
				line: runStart + 1,
				column: 0,
				category: "Complexity",
				fixable: false
			});
			i = runEnd + 1;
		} else i += 1;
	}
	return diagnostics;
};
const SOURCE_EXTS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const detectRepeatedChainedCalls = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		const ext = path.extname(filePath).toLowerCase();
		if (!SOURCE_EXTS.has(ext)) continue;
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relative = relativePosix(context.rootDirectory, filePath);
		diagnostics.push(...findRepeatedChains(content, relative));
	}
	return diagnostics;
};
//#endregion
//#region src/engines/code-quality/index.ts
const codeQualityEngine = {
	name: "code-quality",
	async run(context) {
		const diagnostics = [];
		const promises = [];
		if (context.config.allowProjectLocalTools !== false && (context.languages.includes("typescript") || context.languages.includes("javascript"))) promises.push(runKnip(context.rootDirectory));
		promises.push(checkComplexity(context));
		promises.push(detectRepeatedChainedCalls(context));
		promises.push(detectDuplicateBlocks(context));
		const results = await Promise.allSettled(promises);
		for (const result of results) if (result.status === "fulfilled") diagnostics.push(...result.value);
		return {
			engine: "code-quality",
			diagnostics,
			elapsed: 0,
			skipped: false
		};
	}
};
//#endregion
//#region src/engines/comment-dedupe.ts
const COMMENT_RULES = /* @__PURE__ */ new Set(["ai-slop/narrative-comment", "ai-slop/meta-comment"]);
const dedupeOverlappingComments = (results) => results.map((result) => {
	if (result.engine !== "ai-slop") return result;
	const seen = /* @__PURE__ */ new Set();
	return {
		...result,
		diagnostics: result.diagnostics.filter((diagnostic) => {
			if (!COMMENT_RULES.has(diagnostic.rule)) return true;
			const key = `${diagnostic.filePath}:${diagnostic.line}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
	};
});
//#endregion
//#region src/engines/csharp-dedupe.ts
const AUTHORITATIVE_RULES = {
	"ai-slop/csharp-async-void": /* @__PURE__ */ new Set(["dotnet/AsyncFixer03"]),
	"ai-slop/csharp-sync-over-async": /* @__PURE__ */ new Set([
		"dotnet/AsyncFixer02",
		"dotnet/MA0042",
		"dotnet/MA0045"
	])
};
const dedupeCSharpAsync = (results) => {
	const dotnetRulesByLocation = /* @__PURE__ */ new Map();
	for (const result of results) {
		if (result.engine !== "lint") continue;
		for (const diagnostic of result.diagnostics) {
			if (!diagnostic.rule.startsWith("dotnet/")) continue;
			const location = `${diagnostic.filePath}:${diagnostic.line}`;
			const rulesAtLocation = dotnetRulesByLocation.get(location) ?? /* @__PURE__ */ new Set();
			rulesAtLocation.add(diagnostic.rule);
			dotnetRulesByLocation.set(location, rulesAtLocation);
		}
	}
	if (dotnetRulesByLocation.size === 0) return results;
	return results.map((result) => {
		if (result.engine !== "ai-slop") return result;
		return {
			...result,
			diagnostics: result.diagnostics.filter((diagnostic) => {
				const authoritativeRules = AUTHORITATIVE_RULES[diagnostic.rule];
				if (!authoritativeRules) return true;
				const rulesAtLocation = dotnetRulesByLocation.get(`${diagnostic.filePath}:${diagnostic.line}`);
				if (!rulesAtLocation) return true;
				for (const rule of rulesAtLocation) if (authoritativeRules.has(rule)) return false;
				return true;
			})
		};
	});
};
//#endregion
//#region src/engines/format/biome.ts
const esmRequire$3 = createRequire(import.meta.url);
const resolveLocalBiomeScript = () => {
	try {
		const packageJsonPath = esmRequire$3.resolve("@biomejs/biome/package.json");
		return path.join(path.dirname(packageJsonPath), "bin", "biome");
	} catch {
		return null;
	}
};
const runBiome = async (args, rootDirectory, timeout) => {
	const localScript = resolveLocalBiomeScript();
	if (localScript) return runSubprocess(process.execPath, [localScript, ...args], {
		cwd: rootDirectory,
		timeout
	});
	return runSubprocess("biome", args, {
		cwd: rootDirectory,
		timeout
	});
};
const BIOME_EXTENSIONS = /* @__PURE__ */ new Set([
	".js",
	".jsx",
	".ts",
	".tsx",
	".mjs",
	".cjs"
]);
const projectHasBiomeConfig = (rootDir) => {
	try {
		const biomePath = path.join(rootDir, "biome.json");
		return fs.existsSync(biomePath);
	} catch {
		return false;
	}
};
const getBiomeLineWidth = (rootDir) => {
	try {
		const biomePath = path.join(rootDir, "biome.json");
		if (!fs.existsSync(biomePath)) return 120;
		const content = fs.readFileSync(biomePath, "utf-8");
		return JSON.parse(content).formatter?.lineWidth ?? 120;
	} catch {
		return 120;
	}
};
const getBiomeTargets = (context) => getSourceFiles(context).filter((filePath) => BIOME_EXTENSIONS.has(path.extname(filePath))).filter((filePath) => fs.existsSync(filePath)).map((filePath) => path.relative(context.rootDirectory, filePath));
const projectUsesDecorators = (rootDir) => {
	try {
		const tsconfigPath = path.join(rootDir, "tsconfig.json");
		if (!fs.existsSync(tsconfigPath)) return false;
		const content = fs.readFileSync(tsconfigPath, "utf-8");
		return /experimentalDecorators.*true/i.test(content);
	} catch {
		return false;
	}
};
const runBiomeFormat = async (context) => {
	const targets = getBiomeTargets(context);
	if (targets.length === 0) return [];
	if (!projectHasBiomeConfig(context.rootDirectory)) return [];
	const args = [
		"format",
		"--reporter=json",
		`--line-width=${getBiomeLineWidth(context.rootDirectory)}`,
		...targets
	];
	try {
		const result = await runBiome(args, context.rootDirectory, 6e4);
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		if (!output) return [];
		let diagnostics = parseBiomeJsonOutput(output, context.rootDirectory);
		if (projectUsesDecorators(context.rootDirectory)) diagnostics = diagnostics.filter((d) => {
			const msg = d.message.toLowerCase();
			return !msg.includes("decorator") && !msg.includes("parsing error");
		});
		return diagnostics;
	} catch {
		return [];
	}
};
const parseBiomeJsonOutput = (output, rootDir) => {
	const diagnostics = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let parsed = null;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			parsed = null;
		}
		if (!parsed || !Array.isArray(parsed.diagnostics)) continue;
		for (const entry of parsed.diagnostics) {
			const rawPath = entry.location?.path;
			if (!rawPath) continue;
			const severity = "warning";
			const rawMessage = entry.message ?? "";
			const message = !rawMessage || rawMessage.toLowerCase().includes("would have printed") ? "File is not formatted correctly" : rawMessage;
			diagnostics.push({
				filePath: projectRelativePosix(rootDir, rawPath),
				engine: "format",
				rule: "formatting",
				severity,
				message,
				help: "Run `aislop fix` to auto-format",
				line: entry.location?.start?.line ?? 0,
				column: entry.location?.start?.column ?? 0,
				category: "Format",
				fixable: true
			});
		}
	}
	return diagnostics;
};
const fixBiomeFormat = async (context) => {
	const targets = getBiomeTargets(context);
	if (targets.length === 0) return;
	const lineWidth = getBiomeLineWidth(context.rootDirectory);
	await runBiome([
		"format",
		"--write",
		`--line-width=${lineWidth}`,
		...targets
	], context.rootDirectory, 6e4);
};
//#endregion
//#region src/utils/concurrency.ts
const mapWithConcurrencyLimit = async (items, concurrencyLimit, worker) => {
	const results = Array.from({ length: items.length });
	let firstFailureIndex = -1;
	let firstFailure;
	let nextIndex = 0;
	const runNextItem = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				if (firstFailureIndex === -1 || index < firstFailureIndex) {
					firstFailureIndex = index;
					firstFailure = error;
				}
			}
		}
	};
	const runnerCount = Math.min(Math.max(1, Math.floor(concurrencyLimit)), items.length);
	await Promise.all(Array.from({ length: runnerCount }, () => runNextItem()));
	if (firstFailureIndex !== -1) throw firstFailure;
	return results;
};
//#endregion
//#region src/engines/format/clang-format.ts
const CLANG_FORMAT_CHUNK_CONCURRENCY = Math.max(1, os.availableParallelism() - 2);
const CONFIG_NAMES = [".clang-format", "_clang-format"];
const hasClangFormatConfig = (rootDirectory) => CONFIG_NAMES.some((name) => fs.existsSync(path.join(rootDirectory, name)));
const formattingDiagnostic = (relativeFilePath) => ({
	filePath: relativeFilePath,
	engine: "format",
	rule: "cpp-formatting",
	severity: "warning",
	message: "C/C++ file is not formatted correctly",
	help: "Run `aislop fix` to auto-format with clang-format",
	line: 0,
	column: 0,
	category: "Format",
	fixable: true
});
const VIOLATION_LINE = new RegExp(`^(.+?):\\d+:\\d+: error: code should be clang-formatted \\[-Wclang-format-violations\\]$`);
const parseClangFormatViolations = (stderr) => {
	const flagged = /* @__PURE__ */ new Set();
	for (const line of stderr.split(/\r?\n/)) {
		const match = VIOLATION_LINE.exec(line);
		if (match) flagged.add(match[1]);
	}
	return flagged;
};
const runDryRunChunk = async (chunk, rootDirectory) => {
	try {
		const result = await runSubprocess("clang-format", [
			"--dry-run",
			"--Werror",
			"--",
			...chunk
		], {
			cwd: rootDirectory,
			timeout: 12e4
		});
		if (result.exitCode === 0) return /* @__PURE__ */ new Set();
		return parseClangFormatViolations(result.stderr);
	} catch {
		return /* @__PURE__ */ new Set();
	}
};
const runClangFormat = async (context) => {
	if (!hasClangFormatConfig(context.rootDirectory)) return [];
	const files = findCppSources(context);
	if (files.length === 0) return [];
	const chunkResults = await mapWithConcurrencyLimit(chunkFilePaths(files), CLANG_FORMAT_CHUNK_CONCURRENCY, (chunk) => runDryRunChunk(chunk, context.rootDirectory));
	const flagged = /* @__PURE__ */ new Set();
	for (const chunkFlagged of chunkResults) for (const filePath of chunkFlagged) flagged.add(filePath);
	return files.filter((filePath) => flagged.has(filePath)).map((filePath) => formattingDiagnostic(relativePosix(context.rootDirectory, filePath)));
};
const fixClangFormat = async (context) => {
	const { rootDirectory } = context;
	if (!hasClangFormatConfig(rootDirectory)) return;
	const files = findCppSources(context);
	if (files.length === 0) return;
	await mapWithConcurrencyLimit(chunkFilePaths(files), CLANG_FORMAT_CHUNK_CONCURRENCY, async (chunk) => {
		const result = await runSubprocess("clang-format", [
			"-i",
			"--",
			...chunk
		], {
			cwd: rootDirectory,
			timeout: 12e4
		});
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `clang-format exited ${result.exitCode}`);
	});
};
//#endregion
//#region src/engines/format/dotnet-format.ts
const REPORT_FILENAME = ".aislop-dotnet-format.json";
const parseDotnetFormatReport = (json, rootDirectory) => {
	if (!json) return [];
	let report;
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		report = parsed;
	} catch {
		return [];
	}
	const seen = /* @__PURE__ */ new Set();
	const diagnostics = [];
	for (const file of report) {
		if (!file.FileChanges || file.FileChanges.length === 0) continue;
		const raw = file.FilePath ?? file.FileName;
		if (!raw) continue;
		const filePath = toPosix(path.isAbsolute(raw) ? path.relative(rootDirectory, raw) : raw);
		if (seen.has(filePath)) continue;
		seen.add(filePath);
		diagnostics.push({
			filePath,
			engine: "format",
			rule: "csharp-formatting",
			severity: "warning",
			message: "C# file is not formatted correctly",
			help: "Run `aislop fix` to auto-format with dotnet format",
			line: 0,
			column: 0,
			category: "Format",
			fixable: true
		});
	}
	return diagnostics;
};
const withReportPath = async (run) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-dotnet-format-"));
	try {
		return await run(path.join(dir, REPORT_FILENAME));
	} finally {
		fs.rmSync(dir, {
			recursive: true,
			force: true
		});
	}
};
const UNSUPPORTED_GLOB_SYNTAX = /[?[\]{}!|()\\]/;
const isDotnetFormatPath = (pattern) => !pattern.startsWith("-") && !UNSUPPORTED_GLOB_SYNTAX.test(pattern);
const buildDotnetFormatExcludeScope = (excludePatterns) => {
	const scope = {
		excludeArguments: [],
		unsupportedPatterns: []
	};
	for (const pattern of normalizeExcludePatterns(excludePatterns ?? [])) {
		const expanded = micromatch.braces(pattern, { expand: true });
		if (expanded.every(isDotnetFormatPath)) scope.excludeArguments.push(...expanded);
		else scope.unsupportedPatterns.push(pattern);
	}
	return scope;
};
const excludeOption = (scope) => scope.excludeArguments.length > 0 ? ["--exclude", ...scope.excludeArguments] : [];
const checkTarget = async (context, target) => withReportPath(async (reportPath) => {
	const scope = buildDotnetFormatExcludeScope(context.excludePatterns);
	try {
		await runSubprocess("dotnet", [
			"format",
			"whitespace",
			target,
			"--no-restore",
			...excludeOption(scope),
			"--verify-no-changes",
			"--report",
			reportPath
		], {
			cwd: context.rootDirectory,
			timeout: 18e4
		});
		let json;
		try {
			json = fs.readFileSync(reportPath, "utf-8");
		} catch {
			return [];
		}
		return parseDotnetFormatReport(json, context.rootDirectory);
	} catch {
		return [];
	}
});
const runDotnetFormat = async (context) => {
	const { targets } = findDotnetTargets(context);
	if (targets.length === 0) return [];
	const diagnostics = [];
	const seen = /* @__PURE__ */ new Set();
	for (const target of targets) for (const diagnostic of await checkTarget(context, target)) {
		if (seen.has(diagnostic.filePath)) continue;
		seen.add(diagnostic.filePath);
		diagnostics.push(diagnostic);
	}
	return diagnostics;
};
const fixDotnetFormat = async (context) => {
	const { rootDirectory } = context;
	const scope = buildDotnetFormatExcludeScope(context.excludePatterns);
	if (scope.unsupportedPatterns.length > 0) throw new Error(`dotnet format cannot be scoped to the configured exclude patterns: ${scope.unsupportedPatterns.join(", ")}`);
	const { targets } = findDotnetTargets(context);
	for (const target of targets) {
		const result = await runSubprocess("dotnet", [
			"format",
			"whitespace",
			target,
			"--no-restore",
			...excludeOption(scope)
		], {
			cwd: rootDirectory,
			timeout: 18e4
		});
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `dotnet format exited with code ${result.exitCode}`);
	}
};
//#endregion
//#region src/engines/format/generic.ts
const FORMATTERS = {
	rust: {
		command: "cargo",
		checkArgs: ["fmt", "--check"],
		fixArgs: ["fmt"],
		parseOutput: (output, _rootDir) => {
			const diagnostics = [];
			const lines = output.split("\n").filter((l) => l.startsWith("Diff in"));
			for (const line of lines) {
				const match = line.match(/Diff in (.+) at line (\d+)/);
				if (match) diagnostics.push({
					filePath: match[1],
					engine: "format",
					rule: "rust-formatting",
					severity: "warning",
					message: "Rust file is not formatted correctly",
					help: "Run `aislop fix` to auto-format with rustfmt",
					line: parseInt(match[2], 10),
					column: 0,
					category: "Format",
					fixable: true
				});
			}
			return diagnostics;
		}
	},
	ruby: {
		command: "rubocop",
		checkArgs: [
			"--format",
			"json",
			"--only",
			"Layout"
		],
		fixArgs: [
			"--auto-correct",
			"--only",
			"Layout"
		],
		parseOutput: (output) => {
			try {
				const parsed = JSON.parse(output);
				const diagnostics = [];
				for (const file of parsed.files ?? []) for (const offense of file.offenses ?? []) diagnostics.push({
					filePath: file.path,
					engine: "format",
					rule: offense.cop_name ?? "ruby-formatting",
					severity: "warning",
					message: offense.message ?? "Ruby formatting issue",
					help: "Run `aislop fix` to auto-format",
					line: offense.location?.start_line ?? 0,
					column: offense.location?.start_column ?? 0,
					category: "Format",
					fixable: offense.correctable ?? false
				});
				return diagnostics;
			} catch {
				return [];
			}
		}
	},
	php: {
		command: "php-cs-fixer",
		checkArgs: [
			"fix",
			"--dry-run",
			"--format=json",
			"."
		],
		fixArgs: ["fix", "."],
		parseOutput: (output) => {
			try {
				const parsed = JSON.parse(output);
				const diagnostics = [];
				for (const file of parsed.files ?? []) diagnostics.push({
					filePath: file.name,
					engine: "format",
					rule: "php-formatting",
					severity: "warning",
					message: "PHP file is not formatted correctly",
					help: "Run `aislop fix` to auto-format",
					line: 0,
					column: 0,
					category: "Format",
					fixable: true
				});
				return diagnostics;
			} catch {
				return [];
			}
		}
	}
};
const runGenericFormatter = async (context, language) => {
	const config = FORMATTERS[language];
	if (!config) return [];
	try {
		const result = await runSubprocess(config.command, config.checkArgs, {
			cwd: context.rootDirectory,
			timeout: 6e4
		});
		const output = result.stdout || result.stderr;
		if (!output) return [];
		const diagnostics = config.parseOutput(output, context.rootDirectory).map((diagnostic) => ({
			...diagnostic,
			filePath: projectRelativePosix(context.rootDirectory, diagnostic.filePath)
		}));
		if (!context.files) return diagnostics;
		const allowed = new Set(relativeTargets(context, language));
		return diagnostics.filter((diagnostic) => allowed.has(diagnostic.filePath));
	} catch {
		return [];
	}
};
const LANGUAGE_EXTENSIONS = {
	rust: /* @__PURE__ */ new Set([".rs"]),
	ruby: /* @__PURE__ */ new Set([".rb"]),
	php: /* @__PURE__ */ new Set([".php"])
};
const relativeTargets = (context, language) => {
	const extensions = LANGUAGE_EXTENSIONS[language];
	if (!extensions || !context.files) return [];
	return [...new Set(context.files.filter((filePath) => extensions.has(path.extname(filePath).toLowerCase())).map((filePath) => projectRelativePosix(context.rootDirectory, filePath)).filter((filePath) => filePath.length > 0 && !filePath.startsWith("..")))];
};
const fixGenericFormatter = async (context, language) => {
	const config = FORMATTERS[language];
	if (!config) return;
	const scoped = relativeTargets(context, language);
	if (context.files && scoped.length === 0) return;
	const args = language === "php" && context.files ? ["fix", ...scoped] : context.files ? [...config.fixArgs, ...scoped] : config.fixArgs;
	const result = await runSubprocess(config.command, args, {
		cwd: context.rootDirectory,
		timeout: 6e4
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `${config.command} exited with code ${result.exitCode}`);
};
//#endregion
//#region src/engines/format/gofmt.ts
const GO_EXTENSIONS = /* @__PURE__ */ new Set([".go"]);
const gofmtTargets = (context) => {
	if (!context.files) return [context.rootDirectory];
	return [...new Set(context.files.filter((filePath) => GO_EXTENSIONS.has(path.extname(filePath).toLowerCase())).map((filePath) => relativePosix(context.rootDirectory, filePath)).filter((filePath) => filePath.length > 0 && !filePath.startsWith("..")))];
};
const runGofmt = async (context) => {
	const targets = gofmtTargets(context);
	if (targets.length === 0) return [];
	try {
		const result = await runSubprocess("gofmt", ["-l", ...targets], {
			cwd: context.rootDirectory,
			timeout: 6e4
		});
		if (!result.stdout) return [];
		return result.stdout.split("\n").filter((f) => f.length > 0).map((file) => ({
			filePath: relativePosix(context.rootDirectory, file),
			engine: "format",
			rule: "go-formatting",
			severity: "warning",
			message: "Go file is not formatted correctly",
			help: "Run `aislop fix` to auto-format with gofmt",
			line: 0,
			column: 0,
			category: "Format",
			fixable: true
		}));
	} catch {
		return [];
	}
};
const fixGofmt = async (context) => {
	const targets = gofmtTargets(context);
	if (targets.length === 0) return;
	const result = await runSubprocess("gofmt", ["-w", ...targets], {
		cwd: context.rootDirectory,
		timeout: 6e4
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `gofmt exited with code ${result.exitCode}`);
};
//#endregion
//#region src/utils/tooling.ts
const THIS_FILE = fileURLToPath(import.meta.url);
createRequire(import.meta.url);
const resolvePackageRoot = (startFile) => {
	let current = path.dirname(startFile);
	while (true) {
		const packageJsonPath = path.join(current, "package.json");
		if (fs.existsSync(packageJsonPath)) try {
			if (JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")).name === "aislop") return current;
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return path.resolve(path.dirname(startFile), "..", "..");
};
const PACKAGE_ROOT = resolvePackageRoot(THIS_FILE);
const TOOLS_BIN_DIR = path.join(PACKAGE_ROOT, "tools", "bin");
const TOOLS_ANALYZERS_DIR = path.join(PACKAGE_ROOT, "tools", "analyzers");
const TOOLS_JB_DIR = path.join(PACKAGE_ROOT, "tools", "jb");
const BUNDLED_TOOL_NAMES = /* @__PURE__ */ new Set(["ruff", "golangci-lint"]);
const withExecutableExtension = (toolName) => process.platform === "win32" ? `${toolName}.exe` : toolName;
const getBundledToolPath = (toolName) => {
	if (!BUNDLED_TOOL_NAMES.has(toolName)) return null;
	const candidate = path.join(TOOLS_BIN_DIR, withExecutableExtension(toolName));
	return fs.existsSync(candidate) ? candidate : null;
};
const isExecutableFile = (candidate) => {
	let stats;
	try {
		stats = fs.statSync(candidate);
	} catch {
		return false;
	}
	if (!stats.isFile()) return false;
	if (process.platform === "win32") return true;
	return (stats.mode & 73) !== 0;
};
const findToolOnPath = (toolName) => {
	const executable = withExecutableExtension(toolName);
	const pathValue = process.env.PATH ?? "";
	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, executable);
		if (isExecutableFile(candidate)) return candidate;
	}
	return null;
};
const resolveToolBinary = (toolName) => {
	if (!BUNDLED_TOOL_NAMES.has(toolName)) return toolName;
	return findToolOnPath(toolName) ?? getBundledToolPath(toolName) ?? toolName;
};
const isBundledTool = (toolName) => getBundledToolPath(toolName) !== null;
const isToolAvailable = async (toolName) => {
	if (isBundledTool(toolName)) return true;
	return isToolInstalled(toolName);
};
const resolveBundledAnalyzerAssemblies = () => {
	try {
		return fs.readdirSync(TOOLS_ANALYZERS_DIR).filter((name) => name.toLowerCase().endsWith(".dll")).map((name) => path.join(TOOLS_ANALYZERS_DIR, name));
	} catch {
		return [];
	}
};
const resolveBundledJbSettings = () => {
	const candidate = path.join(TOOLS_JB_DIR, "aislop.DotSettings");
	return fs.existsSync(candidate) ? candidate : null;
};
//#endregion
//#region src/engines/python-targets.ts
const PYTHON_EXTENSIONS = /* @__PURE__ */ new Set([".py", ".pyi"]);
const ANSI_RE = /\u001B\[[0-9;]*m/g;
const stripAnsi = (value) => value.replace(ANSI_RE, "");
const normalizeProjectPath = (filePath) => filePath.split(path.sep).join("/");
const getPythonTargets = (context) => {
	const targets = (context.files ?? getSourceFiles(context)).filter((filePath) => PYTHON_EXTENSIONS.has(path.extname(filePath).toLowerCase())).map((filePath) => {
		const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(context.rootDirectory, filePath);
		return normalizeProjectPath(path.relative(context.rootDirectory, absolutePath));
	}).filter((filePath) => filePath.length > 0 && !filePath.startsWith(".."));
	return [...new Set(targets)];
};
const getRuffDiagnosticPath = (rootDirectory, filePath) => {
	const normalizedPath = stripAnsi(filePath).replace(/^a\//, "");
	const relativePath = path.isAbsolute(normalizedPath) ? path.relative(rootDirectory, normalizedPath) : normalizedPath;
	return normalizeProjectPath(relativePath);
};
//#endregion
//#region src/engines/format/ruff-format.ts
const runRuffFormat = async (context) => {
	const ruffBinary = resolveToolBinary("ruff");
	const targets = getPythonTargets(context);
	if (targets.length === 0) return [];
	try {
		const result = await runSubprocess(ruffBinary, [
			"format",
			"--check",
			"--diff",
			...targets
		], {
			cwd: context.rootDirectory,
			timeout: 6e4
		});
		if (result.exitCode === 0) return [];
		const output = result.stdout || result.stderr;
		return parseRuffFormatOutput(output, context.rootDirectory);
	} catch {
		return [];
	}
};
const parseRuffFormatOutput = (output, rootDir) => {
	const diagnostics = [];
	for (const match of output.matchAll(/^--- (.+)$/gm)) {
		const filePath = getRuffDiagnosticPath(rootDir, match[1]);
		diagnostics.push({
			filePath,
			engine: "format",
			rule: "python-formatting",
			severity: "warning",
			message: "Python file is not formatted correctly",
			help: "Run `aislop fix` to auto-format with ruff",
			line: 0,
			column: 0,
			category: "Format",
			fixable: true
		});
	}
	return diagnostics;
};
const fixRuffFormat = async (context) => {
	const targets = context.files ? getPythonTargets(context) : [context.rootDirectory];
	if (context.files && targets.length === 0) return;
	const result = await runSubprocess(resolveToolBinary("ruff"), ["format", ...targets], {
		cwd: context.rootDirectory,
		timeout: 6e4
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `ruff format exited with code ${result.exitCode}`);
};
//#endregion
//#region src/engines/format/index.ts
const formatEngine = {
	name: "format",
	async run(context) {
		const diagnostics = [];
		const { languages, installedTools } = context;
		const promises = [];
		if (languages.includes("typescript") || languages.includes("javascript")) promises.push(runBiomeFormat(context));
		if (languages.includes("python") && installedTools.ruff) promises.push(runRuffFormat(context));
		if (languages.includes("go") && installedTools.gofmt) promises.push(runGofmt(context));
		if (languages.includes("rust") && installedTools.rustfmt) promises.push(runGenericFormatter(context, "rust"));
		if (languages.includes("ruby") && installedTools.rubocop) promises.push(runGenericFormatter(context, "ruby"));
		if (languages.includes("php") && installedTools["php-cs-fixer"]) promises.push(runGenericFormatter(context, "php"));
		if (languages.includes("csharp") && installedTools.dotnet && context.config.lint.csharp?.projectEvaluation === true) promises.push(runDotnetFormat(context));
		if (languages.includes("cpp") && installedTools["clang-format"]) promises.push(runClangFormat(context));
		if (promises.length === 0) return {
			engine: "format",
			diagnostics,
			elapsed: 0,
			skipped: true,
			skipReason: "no formatter for the detected languages"
		};
		const results = await Promise.allSettled(promises);
		for (const result of results) if (result.status === "fulfilled") diagnostics.push(...result.value);
		return {
			engine: "format",
			diagnostics,
			elapsed: 0,
			skipped: false
		};
	}
};
//#endregion
//#region src/engines/lint/clang-tidy.ts
const CLANG_TIDY_CHUNK_MAX_FILES = 500;
const LINE_RE = /^(.+?):(\d+):(\d+):\s+(warning|error):\s+(.*?)\s+\[([A-Za-z0-9_.,-]+)\]\s*$/;
const resolveCheckId = (payload) => payload.split(",").map((part) => part.trim()).find((part) => part.length > 0 && part !== "-warnings-as-errors");
const parseClangTidyOutput = (output, rootDirectory) => {
	const out = [];
	for (const raw of output.split(/\r?\n/)) {
		const match = LINE_RE.exec(raw);
		if (!match) continue;
		const [, file, line, column, severity, message, checkPayload] = match;
		const check = resolveCheckId(checkPayload);
		if (!check) continue;
		out.push({
			filePath: path.isAbsolute(file) ? relativePosix(rootDirectory, file) : file,
			engine: "lint",
			rule: `clang-tidy/${check}`,
			severity: severity === "error" ? "error" : "warning",
			message,
			help: "",
			line: Number(line),
			column: Number(column),
			category: "C++ Lint",
			fixable: false
		});
	}
	return out;
};
const runClangTidy = async (context) => {
	const compileCommandsDir = findCompileCommandsDir(context);
	if (!compileCommandsDir) return [];
	const sources = filterSourcesInDatabase(findCppSources(context).filter((f) => CPP_IMPL_EXTENSIONS.has(path.extname(f).toLowerCase())), readCompileCommandsFiles(compileCommandsDir));
	if (sources.length === 0) return [];
	const diagnostics = [];
	for (const chunk of chunkFilePaths(sources, CLANG_TIDY_CHUNK_MAX_FILES)) try {
		const result = await runSubprocess("clang-tidy", [
			"-p",
			compileCommandsDir,
			"--quiet",
			...chunk
		], {
			cwd: context.rootDirectory,
			timeout: 3e5
		});
		diagnostics.push(...parseClangTidyOutput(result.stdout, context.rootDirectory));
	} catch (error) {
		if (!isMissingToolError(error)) warnSubprocessFailure("clang-tidy", error);
	}
	return diagnostics;
};
//#endregion
//#region src/engines/lint/xml-entities.ts
const decodeEntities = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xmlAttribute = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
//#endregion
//#region src/engines/lint/cppcheck.ts
const CPPCHECK_CHUNK_MAX_FILES = 500;
const CPPCHECK_JOB_COUNT = Math.max(1, os.availableParallelism() - 2);
const WHOLE_PROGRAM_ENABLE_TOKENS = /* @__PURE__ */ new Set(["all", "unusedFunction"]);
const wantsWholeProgramAnalysis = (enable) => enable.split(",").map((token) => token.trim()).some((token) => WHOLE_PROGRAM_ENABLE_TOKENS.has(token));
const CPP_LINT_DEFAULTS = {
	cppcheck: true,
	clangTidy: true,
	cppcheckEnable: "warning,performance,portability",
	jb: false,
	jbSeverityFloor: "WARNING",
	jbExcludeTypes: []
};
const resolveCppLintConfig = (context) => {
	const cpp = context.config.lint.cpp;
	if (!cpp) return { ...CPP_LINT_DEFAULTS };
	return {
		cppcheck: cpp.cppcheck,
		clangTidy: cpp.clangTidy,
		cppcheckEnable: cpp.cppcheckEnable,
		jb: cpp.jb,
		jbProjects: cpp.jbProjects,
		jbSeverityFloor: cpp.jbSeverityFloor,
		jbExcludeTypes: cpp.jbExcludeTypes
	};
};
const SEVERITY_MAP = {
	error: "error",
	warning: "warning",
	performance: "warning",
	portability: "warning",
	style: "warning"
};
const PARSE_CONTEXT_SUPPRESSIONS = [
	"syntaxError",
	"unknownMacro",
	"internalAstError",
	"internalError"
];
const buildCppcheckArgs = (sources, config, isCppTree = hasCppOnlySources(sources)) => {
	const args = [
		`--enable=${config.cppcheckEnable}`,
		"--inline-suppr",
		"--quiet"
	];
	if (!wantsWholeProgramAnalysis(config.cppcheckEnable)) args.push("-j", String(CPPCHECK_JOB_COUNT));
	if (isCppTree) args.push("--language=c++");
	for (const id of PARSE_CONTEXT_SUPPRESSIONS) args.push(`--suppress=${id}`);
	args.push("--xml", "--xml-version=2", ...sources);
	return args;
};
const isTimeoutError = (error) => error instanceof Error && /timed out/i.test(error.message);
const relativizeChunkFile = (file, rootDirectory) => toPosix(path.isAbsolute(file) ? path.relative(rootDirectory, file) : file);
const describeChunk = (chunk, rootDirectory) => ({
	first: relativizeChunkFile(chunk[0], rootDirectory),
	last: relativizeChunkFile(chunk[chunk.length - 1], rootDirectory),
	fileCount: chunk.length
});
const formatChunkRange = ({ first, last, fileCount }) => {
	return `files ${first === last ? first : `${first}..${last}`} (${fileCount} file${fileCount === 1 ? "" : "s"})`;
};
const MAX_LISTED_CHUNK_RANGES = 3;
const buildChunksSkippedDiagnostic = (failures, totalChunks) => {
	const totalFiles = failures.reduce((sum, failure) => sum + failure.fileCount, 0);
	const reasons = new Set(failures.map((failure) => failure.reason));
	const reasonText = reasons.size > 1 ? "some timed out, some failed" : [...reasons][0];
	const listed = failures.slice(0, MAX_LISTED_CHUNK_RANGES).map((failure) => formatChunkRange(failure));
	const remaining = failures.length - listed.length;
	const rangeText = remaining > 0 ? `${listed.join(", ")}, and ${remaining} more` : listed.join(", ");
	return {
		filePath: failures[0].first,
		engine: "lint",
		rule: "cppcheck/chunks-skipped",
		severity: "info",
		message: `cppcheck skipped ${failures.length} of ${totalChunks} chunk${totalChunks === 1 ? "" : "s"} (${totalFiles} file${totalFiles === 1 ? "" : "s"} total, ${reasonText}): ${rangeText}`,
		help: "Re-run cppcheck directly on the skipped files, or investigate why the chunk timed out or failed, to recover their findings.",
		line: 0,
		column: 0,
		category: "C++ Lint",
		fixable: false
	};
};
const attr = (tag, name) => xmlAttribute(tag, name) ?? "";
const parseCppcheckXml = (xml, rootDirectory) => {
	if (!xml || !xml.includes("<error")) return [];
	const out = [];
	for (const block of xml.match(/<error\b[\s\S]*?<\/error>/g) ?? []) {
		const open = /<error\b[^>]*>/.exec(block)?.[0] ?? "";
		const severity = SEVERITY_MAP[attr(open, "severity")];
		if (!severity) continue;
		const loc = /<location\b[^>]*>/.exec(block)?.[0];
		if (!loc) continue;
		const file = attr(loc, "file");
		if (!file) continue;
		out.push({
			filePath: toPosix(path.isAbsolute(file) ? path.relative(rootDirectory, file) : file),
			engine: "lint",
			rule: `cppcheck/${attr(open, "id")}`,
			severity,
			message: decodeEntities(attr(open, "msg")),
			help: "",
			line: Number(attr(loc, "line")) || 1,
			column: Number(attr(loc, "column")) || 1,
			category: "C++ Lint",
			fixable: false
		});
	}
	return out;
};
const runCppcheck = async (context) => {
	const sources = findCppSources(context);
	if (sources.length === 0) return [];
	const config = resolveCppLintConfig(context);
	const isCppTree = hasCppOnlySources(sources);
	const diagnostics = [];
	const chunks = chunkFilePaths(sources, CPPCHECK_CHUNK_MAX_FILES);
	const failures = [];
	for (const chunk of chunks) try {
		const result = await runSubprocess("cppcheck", buildCppcheckArgs(chunk, config, isCppTree), {
			cwd: context.rootDirectory,
			timeout: 18e4
		});
		diagnostics.push(...parseCppcheckXml(result.stderr, context.rootDirectory));
	} catch (error) {
		if (isMissingToolError(error)) continue;
		const identity = describeChunk(chunk, context.rootDirectory);
		warnSubprocessFailure(`cppcheck (${formatChunkRange(identity)})`, error);
		failures.push({
			...identity,
			reason: isTimeoutError(error) ? "timed out" : "failed"
		});
	}
	if (failures.length > 0) diagnostics.push(buildChunksSkippedDiagnostic(failures, chunks.length));
	return diagnostics;
};
//#endregion
//#region src/engines/lint/dotnet.ts
const RELEVANT_IDS = /* @__PURE__ */ new Set([
	"AsyncFixer01",
	"AsyncFixer02",
	"AsyncFixer03",
	"MA0040",
	"MA0042",
	"MA0045",
	"CS0219",
	"CS0162",
	"IDISP001"
]);
const extractDiagnostics = (xml) => {
	const result = [];
	const blockRe = /<Diagnostic\b[^>]*\bId="([^"]+)"[\s\S]*?<\/Diagnostic>/g;
	let block = blockRe.exec(xml);
	while (block !== null) {
		const id = block[1];
		const body = block[0];
		const message = /<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1] ?? "";
		const filePath = /<FilePath>([\s\S]*?)<\/FilePath>/.exec(body)?.[1] ?? "";
		const location = /<Location\b[^>]*\bLine="(\d+)"[^>]*\bCharacter="(\d+)"/.exec(body);
		block = blockRe.exec(xml);
		if (!filePath) continue;
		result.push({
			id,
			message: decodeEntities(message.trim()),
			filePath: decodeEntities(filePath.trim()),
			line: location ? Number(location[1]) : 1,
			column: location ? Number(location[2]) : 1
		});
	}
	return result;
};
const parseRoslynatorXml = (xml, rootDirectory) => {
	let parsed;
	try {
		parsed = extractDiagnostics(xml);
	} catch {
		return [];
	}
	return parsed.filter((d) => RELEVANT_IDS.has(d.id)).map((d) => ({
		filePath: projectRelativePosix(rootDirectory, d.filePath),
		engine: "lint",
		rule: `dotnet/${d.id}`,
		severity: "warning",
		message: d.message,
		help: "",
		line: d.line,
		column: d.column,
		category: "C# Lint",
		fixable: false
	}));
};
const analyzeTarget = async (context, roslynator, analyzerAssemblies, target) => {
	const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-roslynator-"));
	const outputPath = path.join(outputDirectory, "report.xml");
	try {
		const analyzeArgs = [
			"analyze",
			target,
			"--output",
			outputPath
		];
		if (analyzerAssemblies.length > 0) analyzeArgs.push("--analyzer-assemblies", ...analyzerAssemblies);
		await runSubprocess(roslynator, analyzeArgs, {
			cwd: context.rootDirectory,
			timeout: 18e4
		});
		const xml = fs.readFileSync(outputPath, "utf-8");
		return parseRoslynatorXml(xml, context.rootDirectory);
	} catch {
		return [];
	} finally {
		fs.rmSync(outputDirectory, {
			recursive: true,
			force: true
		});
	}
};
const runDotnetLint = async (context) => {
	const selection = findDotnetTargets(context);
	const notice = projectsSkippedNotice(selection, context.rootDirectory);
	if (selection.targets.length === 0) return notice;
	const roslynator = resolveToolBinary("roslynator");
	const analyzerAssemblies = resolveBundledAnalyzerAssemblies();
	const diagnostics = [];
	for (const target of selection.targets) diagnostics.push(...await analyzeTarget(context, roslynator, analyzerAssemblies, target));
	return [...diagnostics, ...notice];
};
//#endregion
//#region src/engines/lint/expo-doctor.ts
const esmRequire$2 = createRequire(import.meta.url);
const ISSUE_PREFIX = "✖ ";
const resolveExpoDoctorScript = () => {
	try {
		const packageJsonPath = esmRequire$2.resolve("expo-doctor/package.json");
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
		const binRelativePath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["expo-doctor"];
		if (!binRelativePath) return null;
		return path.join(path.dirname(packageJsonPath), binRelativePath);
	} catch {
		return null;
	}
};
const toRuleSuffix = (title) => {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return slug.length > 0 ? slug : "issue";
};
const parseIssues = (output) => {
	const lines = output.split("\n").map((line) => line.trimEnd());
	const startIndex = lines.findIndex((line) => line.includes("Possible issues detected:"));
	if (startIndex < 0) return [];
	const issues = [];
	let current = null;
	let inAdvice = false;
	for (let i = startIndex + 1; i < lines.length; i += 1) {
		const line = lines[i].trim();
		if (/^\d+\s+checks failed/.test(line)) break;
		if (line.length === 0) continue;
		if (line.startsWith(ISSUE_PREFIX)) {
			if (current) issues.push(current);
			current = {
				title: line.slice(2).trim(),
				details: [],
				advice: []
			};
			inAdvice = false;
			continue;
		}
		if (!current) continue;
		if (line === "Advice:") {
			inAdvice = true;
			continue;
		}
		if (inAdvice) current.advice.push(line);
		else current.details.push(line);
	}
	if (current) issues.push(current);
	return issues;
};
const parseConfigError = (output) => {
	const line = output.split("\n").find((candidate) => candidate.trim().startsWith("ConfigError:"));
	return line ? line.trim() : null;
};
const toDiagnostics = (issues) => issues.map((issue) => {
	const helpParts = [issue.details.join(" ").trim(), issue.advice.join(" ").trim()].filter((part) => part.length > 0);
	return {
		filePath: "package.json",
		engine: "lint",
		rule: `expo-doctor/${toRuleSuffix(issue.title)}`,
		severity: "warning",
		message: `Expo Doctor: ${issue.title}`,
		help: helpParts.join(" "),
		line: 0,
		column: 0,
		category: "Expo",
		fixable: false
	};
});
const hasExpoInstalled = (rootDirectory) => {
	try {
		createRequire(path.join(rootDirectory, "package.json")).resolve("expo/package.json");
		return true;
	} catch {
		return false;
	}
};
const runExpoDoctor = async (context) => {
	if (!hasExpoInstalled(context.rootDirectory)) return [];
	const scriptPath = resolveExpoDoctorScript();
	let stdout = "";
	let stderr = "";
	try {
		if (scriptPath) {
			const result = await runSubprocess(process.execPath, [
				scriptPath,
				context.rootDirectory,
				"--verbose"
			], {
				cwd: context.rootDirectory,
				timeout: 12e4
			});
			stdout = result.stdout;
			stderr = result.stderr;
		} else {
			const result = await runSubprocess("npx", [
				"--yes",
				"expo-doctor",
				context.rootDirectory,
				"--verbose"
			], {
				cwd: context.rootDirectory,
				timeout: 12e4
			});
			stdout = result.stdout;
			stderr = result.stderr;
		}
	} catch {
		return [];
	}
	const output = [stdout, stderr].filter(Boolean).join("\n");
	if (!output) return [];
	const configError = parseConfigError(output);
	if (configError) return [{
		filePath: "package.json",
		engine: "lint",
		rule: "expo-doctor/config-error",
		severity: "warning",
		message: configError,
		help: "Install project dependencies, then re-run `aislop scan`.",
		line: 0,
		column: 0,
		category: "Expo",
		fixable: false
	}];
	return toDiagnostics(parseIssues(output));
};
//#endregion
//#region src/engines/lint/generic.ts
const runGenericLinter = async (context, language) => {
	let diagnostics;
	switch (language) {
		case "rust":
			diagnostics = await runClippy(context);
			break;
		case "ruby":
			diagnostics = await runRubocop(context);
			break;
		default: return [];
	}
	const normalized = diagnostics.map((diagnostic) => ({
		...diagnostic,
		filePath: projectRelativePosix(context.rootDirectory, diagnostic.filePath)
	}));
	if (!context.files) return normalized;
	const allowed = new Set(context.files.map((filePath) => projectRelativePosix(context.rootDirectory, filePath)));
	return normalized.filter((diagnostic) => allowed.has(diagnostic.filePath));
};
const fixRubyLint = async (context) => {
	const targets = context.files?.filter((filePath) => path.extname(filePath).toLowerCase() === ".rb").map((filePath) => projectRelativePosix(context.rootDirectory, filePath)).filter((filePath) => filePath.length > 0 && !filePath.startsWith("..")) ?? [];
	if (context.files && targets.length === 0) return;
	const result = await runSubprocess("rubocop", [
		"-a",
		"--except",
		"Layout",
		...targets
	], {
		cwd: context.rootDirectory,
		timeout: 6e4
	});
	if (result.exitCode !== null && result.exitCode > 1) throw new Error(result.stderr || result.stdout || `rubocop exited with code ${result.exitCode}`);
};
const runClippy = async (context) => {
	try {
		const result = await runSubprocess("cargo", [
			"clippy",
			"--message-format=json",
			"--quiet"
		], {
			cwd: context.rootDirectory,
			timeout: 12e4
		});
		return parseClippyDiagnostics(result.stdout);
	} catch {
		return [];
	}
};
const parseClippyEntry = (line) => {
	if (!line.startsWith("{")) return null;
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
};
const toClippyDiagnostic = (entry) => {
	if (entry.reason !== "compiler-message" || !entry.message) return null;
	const message = entry.message;
	const span = message.spans?.[0];
	return {
		filePath: span?.file_name ?? "",
		engine: "lint",
		rule: `clippy/${message.code?.code ?? "unknown"}`,
		severity: message.level === "error" ? "error" : "warning",
		message: message.message ?? "",
		help: message.children?.[0]?.message ?? "",
		line: span?.line_start ?? 0,
		column: span?.column_start ?? 0,
		category: "Rust Lint",
		fixable: false
	};
};
const parseClippyDiagnostics = (output) => {
	const diagnostics = [];
	for (const line of output.split("\n")) {
		const entry = parseClippyEntry(line);
		if (!entry) continue;
		const diagnostic = toClippyDiagnostic(entry);
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return diagnostics;
};
const runRubocop = async (context) => {
	try {
		const output = (await runSubprocess("rubocop", [
			"--format",
			"json",
			"--except",
			"Layout"
		], {
			cwd: context.rootDirectory,
			timeout: 6e4
		})).stdout;
		if (!output) return [];
		const parsed = JSON.parse(output);
		const diagnostics = [];
		for (const file of parsed.files ?? []) for (const offense of file.offenses ?? []) diagnostics.push({
			filePath: file.path,
			engine: "lint",
			rule: `rubocop/${offense.cop_name}`,
			severity: offense.severity === "error" || offense.severity === "fatal" ? "error" : "warning",
			message: offense.message,
			help: "",
			line: offense.location?.start_line ?? 0,
			column: offense.location?.start_column ?? 0,
			category: "Ruby Lint",
			fixable: offense.correctable ?? false
		});
		return diagnostics;
	} catch {
		return [];
	}
};
//#endregion
//#region src/engines/lint/golangci.ts
const runGolangciLint = async (context) => {
	const golangciBinary = resolveToolBinary("golangci-lint");
	try {
		const output = (await runSubprocess(golangciBinary, [
			"run",
			"--out-format=json",
			"./..."
		], {
			cwd: context.rootDirectory,
			timeout: 12e4
		})).stdout;
		if (!output) return [];
		let parsed;
		try {
			parsed = JSON.parse(output);
		} catch {
			return [];
		}
		return (parsed.Issues ?? []).map((issue) => ({
			filePath: relativePosix(context.rootDirectory, issue.Pos.Filename),
			engine: "lint",
			rule: `go/${issue.FromLinter}`,
			severity: "warning",
			message: issue.Text,
			help: "",
			line: issue.Pos.Line,
			column: issue.Pos.Column,
			category: "Go Lint",
			fixable: false
		}));
	} catch {
		return [];
	}
};
//#endregion
//#region src/engines/lint/jb.ts
const SEVERITY_RANK$2 = {
	HINT: 0,
	SUGGESTION: 1,
	WARNING: 2,
	ERROR: 3
};
const toAislopSeverity = (severity) => SEVERITY_RANK$2[severity] >= SEVERITY_RANK$2.WARNING ? "warning" : "info";
const attribute = (tag, name) => {
	const value = xmlAttribute(tag, name);
	return value !== null ? decodeEntities(value) : null;
};
const asSeverity = (raw) => raw === "ERROR" || raw === "SUGGESTION" || raw === "HINT" ? raw : "WARNING";
const parseJbXml = (xml, rootDirectory, options) => {
	try {
		const severityByType = /* @__PURE__ */ new Map();
		const typeTagRe = /<IssueType\b[^>]*\/?>/g;
		let typeTag = typeTagRe.exec(xml);
		while (typeTag !== null) {
			const id = attribute(typeTag[0], "Id");
			if (id) severityByType.set(id, asSeverity(attribute(typeTag[0], "Severity")));
			typeTag = typeTagRe.exec(xml);
		}
		const result = [];
		const issueTagRe = /<Issue\b[^>]*\/?>/g;
		let issueTag = issueTagRe.exec(xml);
		while (issueTag !== null) {
			const tag = issueTag[0];
			issueTag = issueTagRe.exec(xml);
			const typeId = attribute(tag, "TypeId");
			const file = attribute(tag, "File");
			if (!typeId || !file) continue;
			const isCpp = typeId.startsWith("Cpp");
			const langOptions = isCpp ? options.cpp : options.csharp;
			if (langOptions.excludeTypes.has(typeId)) continue;
			const severity = severityByType.get(typeId) ?? "WARNING";
			if (SEVERITY_RANK$2[severity] < SEVERITY_RANK$2[langOptions.severityFloor]) continue;
			const relative = projectRelativePosix(rootDirectory, file.replace(/\\/g, "/"));
			const lineRaw = attribute(tag, "Line");
			result.push({
				filePath: relative,
				engine: "lint",
				rule: `jb/${typeId}`,
				severity: toAislopSeverity(severity),
				message: attribute(tag, "Message") ?? "",
				help: "",
				line: lineRaw ? Number(lineRaw) : 1,
				column: 1,
				category: isCpp ? "C++ Lint" : "C# Lint",
				fixable: false
			});
		}
		return result;
	} catch {
		return [];
	}
};
const CSHARP_LINT_DEFAULTS = {
	projectEvaluation: false,
	jb: true,
	roslynator: true,
	jbSeverityFloor: "WARNING",
	jbExcludeTypes: ["InconsistentNaming"]
};
const resolveCsharpLintConfig = (context) => {
	const raw = context.config.lint.csharp;
	if (!raw) return { ...CSHARP_LINT_DEFAULTS };
	return {
		projectEvaluation: raw.projectEvaluation === true,
		jb: raw.jb,
		roslynator: raw.roslynator,
		jbSeverityFloor: raw.jbSeverityFloor,
		jbExcludeTypes: raw.jbExcludeTypes,
		jbProjects: raw.jbProjects
	};
};
const reportLooksComplete = (xml) => /<Project\b/.test(xml);
const minSeverityFloor = (a, b) => SEVERITY_RANK$2[a] <= SEVERITY_RANK$2[b] ? a : b;
const analyzeJbTarget = async (context, jb, settings, parseOptions, coarseFloor, projectScope, includeCpp, target) => {
	const cachesHome = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-jb-"));
	const outputPath = path.join(cachesHome, "report.xml");
	try {
		const args = [
			"inspectcode",
			target,
			"--format=Xml",
			`--output=${outputPath}`,
			`--caches-home=${cachesHome}`,
			`--severity=${coarseFloor}`
		];
		if (settings) args.push(`--settings=${settings}`);
		if (projectScope) args.push(`--project=${projectScope}`);
		if (includeCpp) args.push("--no-build");
		await runSubprocess(jb, args, {
			cwd: context.rootDirectory,
			timeout: 6e5
		});
		let xml;
		try {
			xml = fs.readFileSync(outputPath, "utf-8");
		} catch {
			return [];
		}
		if (!reportLooksComplete(xml)) return [];
		return parseJbXml(xml, context.rootDirectory, parseOptions);
	} catch {
		return [];
	} finally {
		fs.rmSync(cachesHome, {
			recursive: true,
			force: true
		});
	}
};
const buildJbProjectScope = (csharpProjects, cppProjects) => {
	const parts = [csharpProjects, cppProjects].filter((p) => !!p && p.length > 0);
	return parts.length > 0 ? parts.join(";") : void 0;
};
const runJbLint = async (context, options) => {
	const selection = findJbTargets(context);
	const notice = options.includeCsharp ? projectsSkippedNotice(selection, context.rootDirectory) : [];
	if (selection.targets.length === 0) return notice;
	const csharp = resolveCsharpLintConfig(context);
	const cpp = resolveCppLintConfig(context);
	const jbBinary = resolveToolBinary("jb");
	const settings = resolveBundledJbSettings();
	const projectScope = buildJbProjectScope(options.includeCsharp ? csharp.jbProjects : void 0, options.includeCpp ? cpp.jbProjects : void 0);
	const coarseFloor = minSeverityFloor(options.includeCsharp ? csharp.jbSeverityFloor : "ERROR", options.includeCpp ? cpp.jbSeverityFloor : "ERROR");
	const parseOptions = {
		csharp: {
			excludeTypes: new Set(csharp.jbExcludeTypes),
			severityFloor: csharp.jbSeverityFloor
		},
		cpp: {
			excludeTypes: new Set(cpp.jbExcludeTypes),
			severityFloor: cpp.jbSeverityFloor
		}
	};
	const diagnostics = [];
	for (const target of selection.targets) diagnostics.push(...await analyzeJbTarget(context, jbBinary, settings, parseOptions, coarseFloor, projectScope, options.includeCpp, target));
	return [...diagnostics, ...notice];
};
//#endregion
//#region src/engines/code-quality/unused-var-rename-ast.ts
const getLineOfIdentifier = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
/**
* Walk the AST and collect every Identifier whose text matches `name` and
* whose line is within ±1 of `targetLine`.
*/
const findCandidateIdentifiers = (sourceFile, name, targetLine) => {
	const matches = [];
	const visit = (n) => {
		if (ts.isIdentifier(n) && n.text === name) {
			const line = getLineOfIdentifier(sourceFile, n);
			if (Math.abs(line - targetLine) <= 1) matches.push(n);
		}
		ts.forEachChild(n, visit);
	};
	visit(sourceFile);
	return matches;
};
const classifyBindingElement = (identifier, bindingElement) => {
	const pattern = bindingElement.parent;
	if (bindingElement.dotDotDotToken !== void 0 && bindingElement.name === identifier) return {
		kind: "restElement",
		identifier
	};
	if (ts.isObjectBindingPattern(pattern)) {
		if (bindingElement.propertyName !== void 0 && bindingElement.name === identifier) return {
			kind: "aliasedDestructure",
			identifier
		};
		if (bindingElement.propertyName === void 0 && bindingElement.name === identifier) return {
			kind: "shorthandDestructure",
			identifier
		};
	}
	if (ts.isArrayBindingPattern(pattern) && bindingElement.name === identifier) return {
		kind: "arrayBindingElement",
		identifier
	};
	return {
		kind: "unsupported",
		reason: "binding element context not supported"
	};
};
const classifyIdentifier = (identifier) => {
	const parent = identifier.parent;
	if (ts.isParameter(parent) && parent.name === identifier) return {
		kind: "positionalParameter",
		identifier
	};
	if (ts.isBindingElement(parent)) return classifyBindingElement(identifier, parent);
	if (ts.isVariableDeclaration(parent) && parent.parent && ts.isCatchClause(parent.parent) && parent.name === identifier) return {
		kind: "catchParameter",
		identifier
	};
	if (ts.isVariableDeclaration(parent) && parent.name === identifier) return {
		kind: "variableDeclaration",
		identifier
	};
	return {
		kind: "unsupported",
		reason: "identifier context not supported"
	};
};
const renameIdentifierInPlace = (sourceFile, identifier) => {
	const name = identifier.text;
	if (name.startsWith("_")) return {
		edit: null,
		skipReason: "already prefixed"
	};
	return { edit: {
		start: identifier.getStart(sourceFile),
		end: identifier.getEnd(),
		replacement: `_${name}`
	} };
};
const shorthandToAliased = (sourceFile, identifier) => {
	const name = identifier.text;
	if (name.startsWith("_")) return {
		edit: null,
		skipReason: "already prefixed"
	};
	return { edit: {
		start: identifier.getStart(sourceFile),
		end: identifier.getEnd(),
		replacement: `${name}: _${name}`
	} };
};
const computeEdit = (sourceFile, shape) => {
	switch (shape.kind) {
		case "unsupported": return {
			edit: null,
			skipReason: shape.reason
		};
		case "positionalParameter":
		case "catchParameter":
		case "restElement":
		case "arrayBindingElement": return renameIdentifierInPlace(sourceFile, shape.identifier);
		case "shorthandDestructure": return shorthandToAliased(sourceFile, shape.identifier);
		case "aliasedDestructure": return renameIdentifierInPlace(sourceFile, shape.identifier);
		case "variableDeclaration": return {
			edit: null,
			skipReason: "unused variable binding outside parameter/destructure"
		};
	}
};
//#endregion
//#region src/engines/code-quality/unused-var-rename.ts
const hasSyntaxDiagnostics$1 = (filePath, content) => {
	const diagnostics = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics;
	return Array.isArray(diagnostics) && diagnostics.length > 0;
};
const pickBestCandidate = (sourceFile, candidates, target) => {
	let best = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const c of candidates) {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(c.getStart(sourceFile));
		const oneBasedCol = character + 1;
		const distance = Math.abs(line + 1 - target.line) * 1e3 + Math.abs(oneBasedCol - target.column);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = c;
		}
	}
	return best;
};
const applyEditsDescending = (content, edits) => {
	const ordered = [...edits].sort((a, b) => b.start - a.start);
	let output = content;
	for (const e of ordered) output = output.slice(0, e.start) + e.replacement + output.slice(e.end);
	return output;
};
const processFile = (filePath, fileTargets, result) => {
	if (!fs.existsSync(filePath)) {
		for (const t of fileTargets) result.skipped.push({
			target: t,
			reason: "file not found"
		});
		return;
	}
	const original = fs.readFileSync(filePath, "utf-8");
	const originalHadSyntaxErrors = hasSyntaxDiagnostics$1(filePath, original);
	const sourceFile = ts.createSourceFile(filePath, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const edits = [];
	const pendingSkips = [];
	const seenRanges = /* @__PURE__ */ new Set();
	for (const target of fileTargets) {
		const candidates = findCandidateIdentifiers(sourceFile, target.name, target.line);
		if (candidates.length === 0) {
			pendingSkips.push({
				target,
				reason: "target node not found"
			});
			continue;
		}
		const best = pickBestCandidate(sourceFile, candidates, target);
		if (!best) {
			pendingSkips.push({
				target,
				reason: "target node not found"
			});
			continue;
		}
		const { edit, skipReason } = computeEdit(sourceFile, classifyIdentifier(best));
		if (!edit) {
			pendingSkips.push({
				target,
				reason: skipReason ?? "unable to compute edit"
			});
			continue;
		}
		const rangeKey = `${edit.start}:${edit.end}`;
		if (seenRanges.has(rangeKey)) continue;
		seenRanges.add(rangeKey);
		edits.push(edit);
	}
	if (edits.length === 0) {
		for (const s of pendingSkips) result.skipped.push(s);
		return;
	}
	const updated = applyEditsDescending(original, edits);
	if (updated === original) {
		for (const s of pendingSkips) result.skipped.push(s);
		return;
	}
	if (!originalHadSyntaxErrors && hasSyntaxDiagnostics$1(filePath, updated)) {
		for (const t of fileTargets) if (!pendingSkips.some((p) => p.target === t)) result.skipped.push({
			target: t,
			reason: "rename would break file syntax"
		});
		for (const s of pendingSkips) result.skipped.push(s);
		return;
	}
	fs.writeFileSync(filePath, updated);
	result.renamed += edits.length;
	for (const s of pendingSkips) result.skipped.push(s);
};
const prefixUnusedVars = (rootDirectory, targets) => {
	const result = {
		renamed: 0,
		skipped: []
	};
	const byFile = /* @__PURE__ */ new Map();
	for (const t of targets) {
		const absolute = path.isAbsolute(t.filePath) ? t.filePath : path.join(rootDirectory, t.filePath);
		const arr = byFile.get(absolute) ?? [];
		arr.push({
			...t,
			filePath: absolute
		});
		byFile.set(absolute, arr);
	}
	for (const [filePath, fileTargets] of byFile) processFile(filePath, fileTargets, result);
	return result;
};
//#endregion
//#region src/engines/lint/oxlint-config.ts
const buildBaseRules = () => ({
	"no-unused-vars": "warn",
	"no-undef": "error",
	"no-constant-condition": "warn",
	"no-control-regex": "off",
	"no-debugger": "warn",
	"no-empty": "warn",
	"no-extra-boolean-cast": "warn",
	"no-irregular-whitespace": "warn",
	"no-loss-of-precision": "error",
	"import/no-duplicates": "warn",
	"unicorn/no-unnecessary-await": "warn"
});
const hasReact = (framework) => framework === "react" || framework === "nextjs" || framework === "vite" || framework === "remix";
const buildFrameworkPlugins = (framework) => {
	const extra = [];
	if (hasReact(framework)) extra.push("react", "react-hooks", "jsx-a11y");
	if (framework === "nextjs") extra.push("nextjs");
	return extra;
};
const buildReactRules = () => ({
	"react/no-direct-mutation-state": "error",
	"react-hooks/rules-of-hooks": "error",
	"react-hooks/exhaustive-deps": "warn"
});
const TEST_GLOBALS_COMMON = [
	"describe",
	"it",
	"expect",
	"test",
	"beforeAll",
	"afterAll",
	"beforeEach",
	"afterEach"
];
const buildTestGlobals = (testFramework) => {
	const globals = {};
	const setAll = (names) => {
		for (const name of names) globals[name] = "readonly";
	};
	if (testFramework === "jest") {
		setAll(TEST_GLOBALS_COMMON);
		globals.jest = "readonly";
	} else if (testFramework === "vitest") {
		setAll(TEST_GLOBALS_COMMON);
		globals.vi = "readonly";
	} else if (testFramework === "mocha") setAll([
		"describe",
		"it",
		"before",
		"after",
		"beforeEach",
		"afterEach"
	]);
	return globals;
};
const createOxlintConfig = (options) => {
	const rules = buildBaseRules();
	rules["no-undef"] = options.noUndefSeverity ?? rules["no-undef"];
	if (hasReact(options.framework)) Object.assign(rules, buildReactRules());
	if (options.mode === "fix") {
		rules["no-unused-vars"] = "off";
		rules["react-hooks/exhaustive-deps"] = "off";
		rules["jsx-a11y/no-aria-hidden-on-focusable"] = "off";
		rules["unicorn/no-useless-fallback-in-spread"] = "off";
	}
	const plugins = [
		"import",
		"unicorn",
		"typescript",
		...buildFrameworkPlugins(options.framework)
	];
	const globals = buildTestGlobals(options.testFramework ?? null);
	for (const name of [
		"__DEV__",
		"__TEST__",
		"__BROWSER__",
		"__NODE__",
		"__GLOBAL__",
		"__SSR__",
		"__ESM_BROWSER__",
		"__ESM_BUNDLER__",
		"__VERSION__",
		"__COMMIT__",
		"__BUILD__"
	]) globals[name] = "readonly";
	for (const globalName of options.globals ?? []) globals[globalName] = "readonly";
	if (options.framework === "astro") {
		globals.Astro = "readonly";
		rules["no-undef"] = "off";
		rules["no-unused-expressions"] = "off";
	}
	return {
		plugins,
		rules,
		env: {
			browser: true,
			node: true,
			es2022: true
		},
		globals,
		settings: {}
	};
};
//#endregion
//#region src/engines/lint/oxlint-context-filters.ts
const AMBIENT_GLOBAL_DEPS = [
	"unplugin-icons",
	"@types/bun",
	"bun-types"
];
const SST_PLATFORM_REF_RE = /\/\/\/\s*<reference\s+path=["'][^"']*sst[\\/]+platform[\\/]+config\.d\.ts["']/;
const ICON_AUTOIMPORT_RE = /^Icon[A-Z]/;
const NO_UNDEF_IDENT_RE = /^['‘"`]([^'’"`]+)['’"`]/;
const SUPABASE_FUNCTION_PATH_RE = /(?:^|\/)supabase\/functions\/[^/]+\/.+\.[cm]?[jt]sx?$/;
const detectAmbientSources = (rootDir) => {
	const found = /* @__PURE__ */ new Set();
	const skipDirs = /* @__PURE__ */ new Set([
		"node_modules",
		".git",
		"dist",
		"build",
		"out",
		"target",
		"coverage",
		".next",
		".turbo"
	]);
	const walk = (dir, depth) => {
		if (depth > 4 || found.size === AMBIENT_GLOBAL_DEPS.length) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.size === AMBIENT_GLOBAL_DEPS.length) return;
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			if (skipDirs.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name === "package.json") try {
				const pkg = JSON.parse(fs.readFileSync(full, "utf-8"));
				const allDeps = {
					...pkg.dependencies ?? {},
					...pkg.devDependencies ?? {},
					...pkg.peerDependencies ?? {}
				};
				for (const dep of AMBIENT_GLOBAL_DEPS) if (dep in allDeps) found.add(dep);
			} catch {}
		}
	};
	walk(rootDir, 0);
	return found;
};
const extractNoUndefIdentifier = (message) => {
	return NO_UNDEF_IDENT_RE.exec(message)?.[1] ?? null;
};
const looksLikeChromeExtensionManifest = (filePath) => {
	try {
		const manifest = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return typeof manifest.manifest_version === "number" && ("background" in manifest || "content_scripts" in manifest || "permissions" in manifest);
	} catch {
		return false;
	}
};
const chromeExtensionFileCache = /* @__PURE__ */ new Map();
const isChromeExtensionFile = (rootDir, relativeFilePath) => {
	const cacheKey = `${rootDir}:${relativeFilePath.split(path.sep).join("/")}`;
	const cached = chromeExtensionFileCache.get(cacheKey);
	if (cached !== void 0) return cached;
	const absolute = path.isAbsolute(relativeFilePath) ? relativeFilePath : path.join(rootDir, relativeFilePath);
	const root = path.resolve(rootDir);
	let dir = path.dirname(path.resolve(absolute));
	let matched = false;
	while (true) {
		const relativeToRoot = path.relative(root, dir);
		if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) break;
		if (looksLikeChromeExtensionManifest(path.join(dir, "manifest.json"))) {
			matched = true;
			break;
		}
		if (dir === root) break;
		dir = path.dirname(dir);
	}
	chromeExtensionFileCache.set(cacheKey, matched);
	return matched;
};
const isAmbientFalsePositive = (rule, message, sources) => {
	if (rule !== "eslint/no-undef") return false;
	const ident = extractNoUndefIdentifier(message);
	if (!ident) return false;
	if (sources.has("unplugin-icons") && ICON_AUTOIMPORT_RE.test(ident)) return true;
	if ((sources.has("@types/bun") || sources.has("bun-types")) && ident === "Bun") return true;
	return false;
};
const isRuntimeGlobalFalsePositive = (rule, message, rootDir, relativeFilePath) => {
	if (rule !== "eslint/no-undef") return false;
	const ident = extractNoUndefIdentifier(message);
	if (!ident) return false;
	const normalized = relativeFilePath.split(path.sep).join("/");
	if (ident === "Deno" && SUPABASE_FUNCTION_PATH_RE.test(normalized)) return true;
	if (ident === "chrome" && isChromeExtensionFile(rootDir, relativeFilePath)) return true;
	return false;
};
const sstReferencedFiles = /* @__PURE__ */ new Map();
const clearSstReferenceCache = () => {
	sstReferencedFiles.clear();
	chromeExtensionFileCache.clear();
};
const fileReferencesSstPlatform = (rootDir, relativeFilePath) => {
	const cached = sstReferencedFiles.get(relativeFilePath);
	if (cached !== void 0) return cached;
	const absolute = path.isAbsolute(relativeFilePath) ? relativeFilePath : path.join(rootDir, relativeFilePath);
	let referenced = false;
	try {
		const fd = fs.openSync(absolute, "r");
		try {
			const buf = Buffer.alloc(512);
			const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
			referenced = SST_PLATFORM_REF_RE.test(buf.toString("utf-8", 0, bytesRead));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		referenced = false;
	}
	sstReferencedFiles.set(relativeFilePath, referenced);
	return referenced;
};
//#endregion
//#region src/engines/lint/oxlint-globals.ts
const OPEN_BRACE = String.fromCharCode(123);
const CLOSE_BRACE = String.fromCharCode(125);
const OPEN_BRACKET = String.fromCharCode(91);
const CLOSE_BRACKET = String.fromCharCode(93);
const readTextFile$2 = (filePath) => {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
};
const collectPackageNames = (dir) => {
	const names = /* @__PURE__ */ new Set();
	const raw = readTextFile$2(path.join(dir, "package.json"));
	if (!raw) return names;
	try {
		const pkg = JSON.parse(raw);
		for (const section of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies"
		]) {
			const deps = pkg[section];
			if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
		}
	} catch {
		return names;
	}
	return names;
};
const readJson = (filePath) => {
	const raw = readTextFile$2(filePath);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
};
const ESLINT_CONFIG_RE = /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:json|[cm]?[jt]s))?)$/;
const ESLINT_GLOBALS_PROPERTY_RE = /(?:\bglobals|["']globals["'])\s*:/g;
const ESLINT_IGNORES_PROPERTY_RE = /(?:\bignores|\bignorePatterns|["']ignores["']|["']ignorePatterns["'])\s*:/g;
const IDENTIFIER_GLOBAL_RE = /(?:^|,\s*)([A-Za-z_$][\w$]*)\s*:/g;
const QUOTED_GLOBAL_KEY_RE = /["']([A-Za-z_$][\w$]*)["']\s*:/g;
const STRING_LITERAL_RE = /["']([^"']+)["']/g;
const ESLINT_GLOBAL_PACKAGE_MEMBERS = {
	jquery: ["$", "jQuery"],
	jest: [
		"describe",
		"it",
		"expect",
		"test",
		"beforeAll",
		"afterAll",
		"beforeEach",
		"afterEach",
		"jest"
	],
	mocha: [
		"describe",
		"it",
		"before",
		"after",
		"beforeEach",
		"afterEach"
	]
};
const stripJsComments = (value) => value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const readBalancedBlock = (source, openIndex, openToken, closeToken) => {
	let depth = 0;
	let quote = null;
	let escaped = false;
	for (let index = openIndex; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === "\"" || char === "`") {
			quote = char;
			continue;
		}
		if (char === openToken) depth++;
		else if (char === closeToken) {
			depth--;
			if (depth === 0) return source.slice(openIndex + 1, index);
		}
	}
	return null;
};
const readBalancedObject = (source, openBraceIndex) => readBalancedBlock(source, openBraceIndex, OPEN_BRACE, CLOSE_BRACE);
const readBalancedArray = (source, openBracketIndex) => readBalancedBlock(source, openBracketIndex, OPEN_BRACKET, CLOSE_BRACKET);
const extractGlobalsObjectBlocks = (source) => {
	const blocks = [];
	for (const match of source.matchAll(ESLINT_GLOBALS_PROPERTY_RE)) {
		const openBraceIndex = source.indexOf(OPEN_BRACE, (match.index ?? 0) + match[0].length);
		if (openBraceIndex === -1) continue;
		const block = readBalancedObject(source, openBraceIndex);
		if (block) blocks.push(block);
	}
	return blocks;
};
const extractIgnoreArrayBlocks = (source) => {
	const blocks = [];
	for (const match of source.matchAll(ESLINT_IGNORES_PROPERTY_RE)) {
		const openBracketIndex = source.indexOf(OPEN_BRACKET, (match.index ?? 0) + match[0].length);
		if (openBracketIndex === -1) continue;
		const block = readBalancedArray(source, openBracketIndex);
		if (block) blocks.push(block);
	}
	return blocks;
};
const collectGlobalsFromEslintConfig = (content) => {
	const globals = /* @__PURE__ */ new Set();
	const stripped = stripJsComments(content);
	for (const block of extractGlobalsObjectBlocks(stripped)) {
		for (const spread of block.matchAll(/\.\.\.\s*globals\.([A-Za-z_$][\w$]*)/g)) for (const name of ESLINT_GLOBAL_PACKAGE_MEMBERS[spread[1]] ?? []) globals.add(name);
		for (const quoted of block.matchAll(QUOTED_GLOBAL_KEY_RE)) globals.add(quoted[1]);
		for (const identifier of block.matchAll(IDENTIFIER_GLOBAL_RE)) if (identifier[1] !== "globals") globals.add(identifier[1]);
	}
	return [...globals];
};
const collectIgnoresFromEslintConfig = (content) => {
	const ignores = /* @__PURE__ */ new Set();
	const stripped = stripJsComments(content);
	for (const block of extractIgnoreArrayBlocks(stripped)) for (const literal of block.matchAll(STRING_LITERAL_RE)) if (!literal[1].startsWith("!")) ignores.add(literal[1]);
	return [...ignores];
};
const collectEslintGlobals = (rootDir, projectFiles) => {
	const globals = /* @__PURE__ */ new Set();
	for (const relativePath of projectFiles) {
		const normalized = relativePath.split(path.sep).join("/");
		if (!ESLINT_CONFIG_RE.test(normalized)) continue;
		const content = readTextFile$2(path.join(rootDir, relativePath));
		if (!content) continue;
		for (const name of collectGlobalsFromEslintConfig(content)) globals.add(name);
	}
	return [...globals];
};
const collectEslintIgnorePatterns = (rootDir) => {
	const ignores = /* @__PURE__ */ new Set();
	const projectFiles = listProjectFiles(rootDir);
	for (const relativePath of projectFiles) {
		const normalized = relativePath.split(path.sep).join("/");
		if (!ESLINT_CONFIG_RE.test(normalized)) continue;
		const content = readTextFile$2(path.join(rootDir, relativePath));
		if (!content) continue;
		for (const pattern of collectIgnoresFromEslintConfig(content)) ignores.add(pattern);
	}
	return [...ignores];
};
const hasBunRuntime = (rootDir, projectFiles) => {
	if (fs.existsSync(path.join(rootDir, "bun.lock")) || fs.existsSync(path.join(rootDir, "bun.lockb")) || fs.existsSync(path.join(rootDir, "bunfig.toml"))) return true;
	const hasBunFiles = projectFiles.some((filePath) => /(?:^|\/)bunfig\.toml$|(?:^|\/)bun\.lockb?$/.test(filePath));
	const pkg = readJson(path.join(rootDir, "package.json"));
	if (!pkg) return hasBunFiles;
	if (typeof pkg.packageManager === "string" && /^bun@/i.test(pkg.packageManager)) return true;
	const scripts = pkg.scripts;
	if (scripts && typeof scripts === "object") {
		for (const command of Object.values(scripts)) if (typeof command === "string" && /(?:^|[;&|()\s])bunx?\s/.test(command)) return true;
	}
	return hasBunFiles;
};
const hasDenoRuntime = (rootDir, projectFiles) => {
	if (fs.existsSync(path.join(rootDir, "deno.json")) || fs.existsSync(path.join(rootDir, "deno.jsonc"))) return true;
	return projectFiles.some((filePath) => /(?:^|\/)deno\.jsonc?$/.test(filePath));
};
const AMBIENT_GLOBAL_RE = /^\s*(?:declare\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
const collectAmbientGlobals = (rootDir) => {
	const globals = /* @__PURE__ */ new Set();
	const projectFiles = listProjectFiles(rootDir);
	for (const relativePath of projectFiles) {
		if (!relativePath.endsWith(".d.ts")) continue;
		const content = readTextFile$2(path.join(rootDir, relativePath));
		if (!content) continue;
		for (const match of content.matchAll(AMBIENT_GLOBAL_RE)) globals.add(match[1]);
	}
	const deps = collectPackageNames(rootDir);
	if (deps.has("@types/bun") || deps.has("bun-types") || hasBunRuntime(rootDir, projectFiles)) globals.add("Bun");
	if (hasDenoRuntime(rootDir, projectFiles)) globals.add("Deno");
	for (const name of collectEslintGlobals(rootDir, projectFiles)) globals.add(name);
	if (projectFiles.some((filePath) => /(?:^|\/)sst\.config\.ts$/.test(filePath))) for (const name of [
		"$app",
		"$config",
		"$dev",
		"$interpolate",
		"$resolve",
		"$jsonParse",
		"$jsonStringify",
		"aws",
		"cloudflare",
		"docker",
		"random",
		"sst",
		"vercel",
		"pulumi"
	]) globals.add(name);
	return [...globals];
};
//#endregion
//#region src/engines/lint/oxlint.ts
const esmRequire$1 = createRequire(import.meta.url);
const OXLINT_EXTENSIONS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const resolveOxlintBinary = () => {
	try {
		const oxlintMainPath = esmRequire$1.resolve("oxlint");
		const oxlintDir = path.resolve(path.dirname(oxlintMainPath), "..");
		return path.join(oxlintDir, "bin", "oxlint");
	} catch {
		return "oxlint";
	}
};
const VITE_QUERY_RE = /["'][^"']*\?(worker|sharedworker|worker-url|url|raw|inline|init)\b/;
const isViteVirtualImportFalsePositive = (rule, message) => rule.startsWith("import/") && VITE_QUERY_RE.test(message);
const UNUSED_VAR_IDENT_RE = /(?:Variable|Parameter|Catch parameter) '([^']+)' (?:is declared but never used|is caught but never used)/;
const isUnderscoreUnusedVar = (rule, message) => {
	if (rule !== "eslint/no-unused-vars") return false;
	const match = UNUSED_VAR_IDENT_RE.exec(message);
	return match ? match[1].startsWith("_") : false;
};
const readTextFile$1 = (filePath) => {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
};
const isSolidRefFalsePositive = (context, diagnostic) => {
	if (diagnostic.rule !== "eslint/no-unassigned-vars") return false;
	const name = diagnostic.message.match(/^'([^']+)' is always 'undefined'/)?.[1];
	if (!name) return false;
	const absolutePath = path.isAbsolute(diagnostic.filePath) ? diagnostic.filePath : path.join(context.rootDirectory, diagnostic.filePath);
	const content = readTextFile$1(absolutePath);
	if (!content) return false;
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\bref=\\{\\s*${escaped}\\s*\\}`).test(content);
};
const isContextualTypeScriptFalsePositive = (diagnostic) => diagnostic.rule === "typescript-eslint/triple-slash-reference" && (diagnostic.filePath.endsWith(".d.ts") || /(?:^|\/)sst\.config\.ts$/.test(diagnostic.filePath));
const parseRuleCode = (code) => {
	if (!code) return {
		plugin: "eslint",
		rule: "syntax-error"
	};
	const match = code.match(/^(.+)\((.+)\)$/);
	if (!match) return {
		plugin: "eslint",
		rule: code
	};
	return {
		plugin: match[1].replace(/^eslint-plugin-/, ""),
		rule: match[2]
	};
};
const detectTestFramework = (rootDir) => {
	try {
		const raw = fs.readFileSync(path.join(rootDir, "package.json"), "utf-8");
		const pkg = JSON.parse(raw);
		const allDeps = {
			...pkg.dependencies,
			...pkg.devDependencies
		};
		if (allDeps.vitest) return "vitest";
		if (allDeps.jest || allDeps["ts-jest"] || allDeps["@jest/core"]) return "jest";
		if (allDeps.mocha) return "mocha";
		if (fs.existsSync(path.join(rootDir, "jest.config.js")) || fs.existsSync(path.join(rootDir, "jest.config.ts")) || fs.existsSync(path.join(rootDir, "jest.config.mjs"))) return "jest";
		if (fs.existsSync(path.join(rootDir, "vitest.config.ts")) || fs.existsSync(path.join(rootDir, "vitest.config.js"))) return "vitest";
		if (fs.existsSync(path.join(rootDir, ".mocharc.yml"))) return "mocha";
	} catch {}
	return null;
};
const normalizeEslintIgnorePatterns = (patterns) => patterns.map((pattern) => pattern.trim().replace(/^\/+/, "")).filter((pattern) => pattern.length > 0 && !pattern.startsWith("!")).flatMap((pattern) => {
	if (pattern.endsWith("/*")) return [pattern.replace(/\/\*$/, "/**")];
	if (!pattern.includes("*") && !path.extname(pattern)) return [`${pattern}/**`];
	return [pattern];
});
const isEslintIgnored = (relativePath, patterns) => patterns.length > 0 && micromatch.isMatch(relativePath, patterns, { dot: true });
const getOxlintTargets = (context) => {
	const eslintIgnorePatterns = normalizeEslintIgnorePatterns(collectEslintIgnorePatterns(context.rootDirectory));
	return getSourceFiles(context).filter((filePath) => OXLINT_EXTENSIONS.has(path.extname(filePath).toLowerCase())).filter((filePath) => !isAutoGenerated(filePath)).map((filePath) => path.relative(context.rootDirectory, filePath).split(path.sep).join("/")).filter((filePath) => !isEslintIgnored(filePath, eslintIgnorePatterns));
};
const noUndefSeverityForContext = (context) => context.languages.includes("php") ? "warn" : "error";
const extractUnusedVarName = (message) => {
	const variableMatch = message.match(/Variable '([^']+)' is declared but never used/);
	if (variableMatch?.[1]) return {
		name: variableMatch[1],
		type: "variable"
	};
	const paramMatch = message.match(/Parameter '([^']+)' is declared but never used/);
	if (paramMatch?.[1]) return {
		name: paramMatch[1],
		type: "parameter"
	};
	const catchMatch = message.match(/Catch parameter '([^']+)' is caught but never used/);
	if (catchMatch?.[1]) return {
		name: catchMatch[1],
		type: "parameter"
	};
	return null;
};
const collectUnusedVarCandidates = (diagnostics) => diagnostics.filter((d) => d.rule === "eslint/no-unused-vars").map((d) => {
	const extracted = extractUnusedVarName(d.message);
	if (!extracted || extracted.name.startsWith("_")) return null;
	return {
		filePath: d.filePath,
		line: d.line,
		column: d.column,
		name: extracted.name,
		type: extracted.type
	};
}).filter((candidate) => candidate !== null);
const removeDuplicateKeyLines = (rootDirectory, diagnostics) => {
	const byFile = /* @__PURE__ */ new Map();
	for (const d of diagnostics) {
		const keyMatch = d.message.match(/Duplicate key '([^']+)'/);
		if (!keyMatch) continue;
		const absolute = path.isAbsolute(d.filePath) ? d.filePath : path.join(rootDirectory, d.filePath);
		const entries = byFile.get(absolute) ?? [];
		entries.push({
			key: keyMatch[1],
			line: d.line
		});
		byFile.set(absolute, entries);
	}
	for (const [filePath, dupes] of byFile) {
		if (!fs.existsSync(filePath)) continue;
		const lines = fs.readFileSync(filePath, "utf-8").split("\n");
		const toRemove = /* @__PURE__ */ new Set();
		for (const { key } of dupes) {
			const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const keyPattern = new RegExp(`^\\s*['"]?${escaped}['"]?\\s*:|^\\s*${escaped}\\s*:`);
			const matches = [];
			for (let i = 0; i < lines.length; i++) if (keyPattern.test(lines[i])) matches.push(i);
			for (let j = 1; j < matches.length; j++) toRemove.add(matches[j]);
		}
		if (toRemove.size === 0) continue;
		const filtered = lines.filter((_, i) => !toRemove.has(i));
		fs.writeFileSync(filePath, filtered.join("\n"));
	}
};
const toDiagnostic = (d) => {
	const { plugin, rule } = parseRuleCode(d.code);
	const label = d.labels[0];
	return {
		filePath: d.filename,
		engine: "lint",
		rule: `${plugin}/${rule}`,
		severity: d.severity,
		message: d.message.replace(/\S+\.\w+:\d+:\d+[\s\S]*$/, "").trim() || d.message,
		help: d.help || "",
		line: label?.span.line ?? 0,
		column: label?.span.column ?? 0,
		category: plugin === "react" ? "React" : plugin === "import" ? "Imports" : "Lint",
		fixable: false
	};
};
const shouldKeepOxlintDiagnostic = (context, ambientSources, seen, d) => {
	const relativePath = path.isAbsolute(d.filePath) ? relativePosix(context.rootDirectory, d.filePath) : d.filePath;
	if (isExcludedFromScan(relativePath)) return false;
	if (isViteVirtualImportFalsePositive(d.rule, d.message)) return false;
	if (isAmbientFalsePositive(d.rule, d.message, ambientSources)) return false;
	if (isRuntimeGlobalFalsePositive(d.rule, d.message, context.rootDirectory, relativePath)) return false;
	if (isSolidRefFalsePositive(context, d)) return false;
	if (isContextualTypeScriptFalsePositive(d)) return false;
	if (isUnderscoreUnusedVar(d.rule, d.message)) return false;
	if (d.rule === "eslint/no-undef" && fileReferencesSstPlatform(context.rootDirectory, d.filePath)) return false;
	const key = `${d.filePath}:${d.line}:${d.rule}:${d.message}`;
	if (seen.has(key)) return false;
	seen.add(key);
	return true;
};
const runOxlint = async (context) => {
	const configPath = path.join(os.tmpdir(), `aislop-oxlintrc-${process.pid}.json`);
	const framework = context.frameworks.find((f) => f !== "none");
	const testFramework = detectTestFramework(context.rootDirectory);
	const targets = getOxlintTargets(context);
	if (targets.length === 0) return [];
	const config = createOxlintConfig({
		framework,
		testFramework,
		globals: collectAmbientGlobals(context.rootDirectory),
		noUndefSeverity: noUndefSeverityForContext(context)
	});
	const ambientSources = detectAmbientSources(context.rootDirectory);
	clearSstReferenceCache();
	try {
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
		const args = [
			resolveOxlintBinary(),
			"-c",
			configPath,
			"--format",
			"json"
		];
		if (context.languages.includes("typescript") && fs.existsSync(path.join(context.rootDirectory, "tsconfig.json"))) args.push("--tsconfig", "./tsconfig.json");
		args.push(...targets);
		const result = await runSubprocess(process.execPath, args, {
			cwd: context.rootDirectory,
			timeout: 12e4
		});
		if (!result.stdout) return [];
		let output;
		try {
			output = JSON.parse(result.stdout);
		} catch {
			return [];
		}
		const seen = /* @__PURE__ */ new Set();
		return output.diagnostics.map(toDiagnostic).filter((d) => shouldKeepOxlintDiagnostic(context, ambientSources, seen, d));
	} finally {
		if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
	}
};
const fixOxlint = async (context, options = {}) => {
	const dangerous = options.force ?? false;
	const configPath = path.join(os.tmpdir(), `aislop-oxlintrc-fix-${process.pid}.json`);
	const framework = context.frameworks.find((f) => f !== "none");
	const testFramework = detectTestFramework(context.rootDirectory);
	const targets = getOxlintTargets(context);
	if (targets.length === 0) return;
	const config = createOxlintConfig({
		framework,
		testFramework,
		mode: "fix",
		globals: collectAmbientGlobals(context.rootDirectory),
		noUndefSeverity: noUndefSeverityForContext(context)
	});
	try {
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
		const binary = resolveOxlintBinary();
		const args = dangerous ? [
			binary,
			"-c",
			configPath,
			"--fix",
			"--fix-suggestions",
			"--fix-dangerously",
			...targets
		] : [
			binary,
			"-c",
			configPath,
			"--fix",
			...targets
		];
		const result = await runSubprocess(process.execPath, args, {
			cwd: context.rootDirectory,
			timeout: 12e4
		});
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `Oxlint exited with code ${result.exitCode}`);
		const remaining = await runOxlint(context);
		const candidates = collectUnusedVarCandidates(remaining);
		if (candidates.length > 0) {
			const targets = candidates.map((c) => ({
				filePath: path.isAbsolute(c.filePath) ? c.filePath : path.join(context.rootDirectory, c.filePath),
				line: c.line,
				column: c.column,
				name: c.name,
				type: c.type
			}));
			prefixUnusedVars(context.rootDirectory, targets);
		}
		const duplicateKeys = remaining.filter((d) => d.message.startsWith("Duplicate key"));
		if (duplicateKeys.length > 0) removeDuplicateKeyLines(context.rootDirectory, duplicateKeys);
	} finally {
		if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
	}
};
//#endregion
//#region src/engines/lint/ruff.ts
const runRuffLint = async (context, ruffBinary = resolveToolBinary("ruff")) => {
	const targets = getPythonTargets(context);
	if (targets.length === 0) return [];
	try {
		const output = (await runSubprocess(ruffBinary, [
			"check",
			"--output-format=json",
			...targets
		], {
			cwd: context.rootDirectory,
			timeout: 6e4
		})).stdout;
		if (!output) return [];
		return JSON.parse(output).map((d) => ({
			filePath: getRuffDiagnosticPath(context.rootDirectory, d.filename),
			engine: "lint",
			rule: `ruff/${d.code}`,
			severity: d.code.startsWith("E") || d.code.startsWith("F") ? "error" : "warning",
			message: d.message,
			help: "",
			line: d.location.row,
			column: d.location.column,
			category: "Python Lint",
			fixable: d.fix?.applicability === "safe"
		}));
	} catch {
		return [];
	}
};
const ruffLintFixArgs = (context, unsafe) => {
	const targets = context.files ? getPythonTargets(context) : [context.rootDirectory];
	const args = ["check", "--fix"];
	if (unsafe) args.push("--unsafe-fixes");
	args.push(...targets);
	return args;
};
const fixRuffLint = async (context) => {
	if (context.files && getPythonTargets(context).length === 0) return;
	const result = await runSubprocess(resolveToolBinary("ruff"), ruffLintFixArgs(context, false), {
		cwd: context.rootDirectory,
		timeout: 6e4
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `ruff check --fix exited with code ${result.exitCode}`);
};
const fixRuffLintForce = async (context) => {
	if (context.files && getPythonTargets(context).length === 0) return;
	const result = await runSubprocess(resolveToolBinary("ruff"), ruffLintFixArgs(context, true), {
		cwd: context.rootDirectory,
		timeout: 6e4
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `ruff check --fix exited with code ${result.exitCode}`);
};
//#endregion
//#region src/engines/lint/typecheck.ts
const MAX_DEPTH = 3;
const TSC_TIMEOUT_MS = 12e4;
const esmRequire = createRequire(import.meta.url);
const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/;
const findTsconfigs = (root) => {
	const results = [];
	const walk = (dir, depth) => {
		if (depth > MAX_DEPTH) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name === "tsconfig.json") results.push(full);
		}
	};
	walk(root, 0);
	return dropGitIgnoredPaths(root, results);
};
const resolveTrustedTscPath = () => {
	try {
		return esmRequire.resolve("typescript/lib/tsc.js");
	} catch {
		return null;
	}
};
const isReferenceOnlyConfig = (tsconfigPath) => {
	try {
		const parsed = parseJsonc(fs.readFileSync(tsconfigPath, "utf-8"));
		if (!parsed) return false;
		return Array.isArray(parsed.references) && !parsed.files && !parsed.include && !parsed.extends;
	} catch {
		return false;
	}
};
const runTypecheck = async (context) => {
	const tsconfigs = findTsconfigs(context.rootDirectory).filter((p) => !isReferenceOnlyConfig(p));
	if (tsconfigs.length === 0) return [];
	const diagnostics = [];
	const seen = /* @__PURE__ */ new Set();
	const tscCli = resolveTrustedTscPath();
	if (!tscCli) return [];
	for (const tsconfig of tsconfigs) {
		const projectDir = path.dirname(tsconfig);
		let output = "";
		try {
			const result = await runSubprocess(process.execPath, [
				tscCli,
				"--noEmit",
				"--pretty",
				"false",
				"-p",
				tsconfig
			], {
				cwd: projectDir,
				timeout: TSC_TIMEOUT_MS
			});
			output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		} catch {
			continue;
		}
		for (const rawLine of output.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			const match = TSC_LINE_RE.exec(line);
			if (!match) continue;
			const [, filePath, lineStr, colStr, severity, code, message] = match;
			const absolute = path.resolve(projectDir, filePath);
			const relative = relativePosix(context.rootDirectory, absolute);
			const key = `${relative}:${lineStr}:${colStr}:TS${code}`;
			if (seen.has(key)) continue;
			seen.add(key);
			diagnostics.push({
				filePath: relative,
				engine: "lint",
				rule: `typescript/TS${code}`,
				severity: severity === "error" ? "error" : "warning",
				message,
				help: `Fix the underlying type — TS${code} is a hard contract violation, not a style nit.`,
				line: Number.parseInt(lineStr, 10),
				column: Number.parseInt(colStr, 10),
				category: "TypeScript",
				fixable: false
			});
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/lint/index.ts
const bareRuleId = (rule) => {
	const slash = rule.indexOf("/");
	return slash === -1 ? rule : rule.slice(slash + 1);
};
const camelToKebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase();
const canonicalCppRuleId = (rule) => {
	const bare = bareRuleId(rule);
	const m = /^CppClangTidy(.+)$/.exec(bare);
	return m ? camelToKebab(m[1]) : bare;
};
const dedupeDiagnostics = (diagnostics, canonicalize) => {
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const diagnostic of diagnostics) {
		const key = `${diagnostic.filePath.replace(/\\/g, "/")}::${diagnostic.line}::${canonicalize(diagnostic.rule)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(diagnostic);
	}
	return result;
};
/** Exported for unit tests. cppcheck and clang-tidy frequently report the same
*  underlying defect at the same site; jb CppClangTidy* inspections normalize
*  to the same key as aislop clang-tidy findings. */
const dedupeCppDiagnostics = (diagnostics) => dedupeDiagnostics(diagnostics, canonicalCppRuleId);
/** Exported for unit tests. */
const dedupeCsharpDiagnostics = (diagnostics) => dedupeDiagnostics(diagnostics, bareRuleId);
const lintEngine = {
	name: "lint",
	async run(context) {
		const diagnostics = [];
		const { languages, installedTools } = context;
		const promises = [];
		if (languages.includes("typescript") || languages.includes("javascript")) {
			promises.push(runOxlint(context));
			if (context.config.lint.typecheck) promises.push(runTypecheck(context));
		}
		if (context.frameworks.includes("expo") && context.config.lint.expoDoctor) promises.push(runExpoDoctor(context));
		if (languages.includes("python") && installedTools.ruff) promises.push(runRuffLint(context));
		if (languages.includes("go") && installedTools["golangci-lint"]) promises.push(runGolangciLint(context));
		if (languages.includes("rust") && installedTools.cargo) promises.push(runGenericLinter(context, "rust"));
		if (languages.includes("ruby") && installedTools.rubocop) promises.push(runGenericLinter(context, "ruby"));
		const cpp = resolveCppLintConfig(context);
		const csharp = resolveCsharpLintConfig(context);
		const wantJbCsharp = languages.includes("csharp") && csharp.projectEvaluation && csharp.jb && installedTools.jb;
		const wantJbCpp = languages.includes("cpp") && cpp.jb && installedTools.jb;
		const jbPromise = wantJbCsharp || wantJbCpp ? runJbLint(context, {
			includeCsharp: wantJbCsharp,
			includeCpp: wantJbCpp
		}) : Promise.resolve([]);
		if (languages.includes("cpp")) {
			const cppPasses = [];
			if (cpp.cppcheck && installedTools.cppcheck) cppPasses.push(runCppcheck(context));
			if (cpp.clangTidy && installedTools["clang-tidy"]) cppPasses.push(runClangTidy(context));
			if (wantJbCpp) cppPasses.push(jbPromise.then((d) => d.filter((x) => x.category === "C++ Lint")));
			if (cppPasses.length > 0) promises.push(Promise.all(cppPasses).then((p) => dedupeCppDiagnostics(p.flat())));
		}
		if (languages.includes("csharp")) {
			const csharpPasses = [];
			if (csharp.projectEvaluation && csharp.roslynator && installedTools.roslynator) csharpPasses.push(runDotnetLint(context));
			if (wantJbCsharp) csharpPasses.push(jbPromise.then((d) => d.filter((x) => x.category === "C# Lint")));
			if (csharpPasses.length > 0) promises.push(Promise.all(csharpPasses).then((p) => dedupeCsharpDiagnostics(p.flat())));
		}
		if (promises.length === 0) return {
			engine: "lint",
			diagnostics,
			elapsed: 0,
			skipped: true,
			skipReason: "no linter for the detected languages"
		};
		const results = await Promise.allSettled(promises);
		for (const result of results) if (result.status === "fulfilled") diagnostics.push(...result.value);
		return {
			engine: "lint",
			diagnostics,
			elapsed: 0,
			skipped: false
		};
	}
};
//#endregion
//#region src/ui/invocation.ts
const detectInvocation = () => "aislop";
//#endregion
//#region src/engines/security/audit-value.ts
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const readString = (record, key) => {
	const value = record[key];
	return typeof value === "string" ? value : void 0;
};
const readRecordArray = (record, key) => {
	const value = record[key];
	return Array.isArray(value) ? value.filter(isRecord) : [];
};
//#endregion
//#region src/engines/security/audit-shared.ts
const SEVERITY_RANK$1 = {
	critical: 4,
	high: 3,
	moderate: 2,
	low: 1
};
const toSeverity$1 = (value) => value === "critical" || value === "high" ? "error" : "warning";
//#endregion
//#region src/engines/security/audit-dotnet.ts
const severityRank = (severity) => SEVERITY_RANK$1[severity] ?? 0;
const worstSeverityOf = (vulnerabilities) => vulnerabilities.reduce((worst, vulnerability) => {
	const severity = (vulnerability.severity ?? "moderate").toLowerCase();
	return severityRank(severity) > severityRank(worst) ? severity : worst;
}, "low");
const dedupeVulnerabilities = (vulnerabilities) => {
	const seen = /* @__PURE__ */ new Set();
	return vulnerabilities.filter((vulnerability) => {
		const key = `${(vulnerability.severity ?? "").toLowerCase()}|${vulnerability.advisoryurl ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};
const readVulnerabilities = (pkg) => readRecordArray(pkg, "vulnerabilities").map((vulnerability) => ({
	severity: readString(vulnerability, "severity"),
	advisoryurl: readString(vulnerability, "advisoryurl")
}));
const toDotnetFinding = (pkg, projectFile, transitive) => {
	const vulnerabilities = dedupeVulnerabilities(readVulnerabilities(pkg));
	const packageId = readString(pkg, "id");
	if (vulnerabilities.length === 0 || !packageId) return null;
	return {
		projectFile,
		packageId,
		transitive,
		resolvedVersion: readString(pkg, "resolvedVersion") ?? "?",
		worstSeverity: worstSeverityOf(vulnerabilities),
		vulnerabilities
	};
};
const mergeDotnetFindings = (existing, incoming) => {
	return {
		...severityRank(incoming.worstSeverity) > severityRank(existing.worstSeverity) ? incoming : existing,
		vulnerabilities: dedupeVulnerabilities([...existing.vulnerabilities, ...incoming.vulnerabilities])
	};
};
const toDotnetDiagnostic = (finding) => {
	const advisory = finding.vulnerabilities.find((vulnerability) => vulnerability.advisoryurl && (vulnerability.severity ?? "moderate").toLowerCase() === finding.worstSeverity)?.advisoryurl ?? finding.vulnerabilities.find((vulnerability) => vulnerability.advisoryurl)?.advisoryurl ?? "";
	const scopeLabel = finding.transitive ? " transitive" : "";
	const countLabel = finding.vulnerabilities.length > 1 ? ` (${finding.vulnerabilities.length} advisories)` : "";
	return {
		filePath: finding.projectFile,
		engine: "security",
		rule: "security/vulnerable-dependency",
		severity: toSeverity$1(finding.worstSeverity),
		message: `${finding.packageId}@${finding.resolvedVersion} (${finding.worstSeverity})${scopeLabel}${countLabel}`,
		help: advisory ? `See ${advisory}; upgrade ${finding.packageId} to a patched version.` : `Upgrade ${finding.packageId} to a patched version.`,
		line: 0,
		column: 0,
		category: "Security",
		fixable: false,
		detail: "dotnet"
	};
};
const parseDotnetAudit = (output, rootDirectory) => {
	if (!output) return [];
	let report;
	try {
		report = JSON.parse(output);
	} catch {
		return [];
	}
	if (!isRecord(report)) return [];
	const findings = /* @__PURE__ */ new Map();
	for (const project of readRecordArray(report, "projects")) {
		const projectPath = readString(project, "path");
		const projectFile = projectPath ? projectRelativePosix(rootDirectory, projectPath) : "*.csproj";
		for (const framework of readRecordArray(project, "frameworks")) {
			const packages = [...readRecordArray(framework, "topLevelPackages").map((pkg) => ({
				pkg,
				transitive: false
			})), ...readRecordArray(framework, "transitivePackages").map((pkg) => ({
				pkg,
				transitive: true
			}))];
			for (const { pkg, transitive } of packages) {
				const finding = toDotnetFinding(pkg, projectFile, transitive);
				if (!finding) continue;
				const key = `${projectFile}:${finding.packageId}:${transitive}`;
				const existing = findings.get(key);
				findings.set(key, existing ? mergeDotnetFindings(existing, finding) : finding);
			}
		}
	}
	return [...findings.values()].map(toDotnetDiagnostic);
};
const runDotnetAudit = async (rootDir, timeout) => {
	try {
		const result = await runSubprocess("dotnet", [
			"list",
			"package",
			"--no-restore",
			"--vulnerable",
			"--include-transitive",
			"--format",
			"json"
		], {
			cwd: rootDir,
			timeout
		});
		return parseDotnetAudit(result.stdout, rootDir);
	} catch {
		return [];
	}
};
//#endregion
//#region src/engines/security/audit-ecosystem.ts
const withFixHint = (rest) => {
	return `Run \`${detectInvocation()} fix -f\` to apply this fix${rest ? ` — ${rest}` : ""}`;
};
const dependencyDiagnostic = (filePath, message, help) => ({
	filePath,
	engine: "security",
	rule: "security/vulnerable-dependency",
	severity: "error",
	message,
	help,
	line: 0,
	column: 0,
	category: "Security",
	fixable: false
});
const runPipAudit = async (rootDir, timeout) => {
	try {
		const result = await runSubprocess("pip-audit", ["--format=json"], {
			cwd: rootDir,
			timeout
		});
		if (!result.stdout) return [];
		const parsed = JSON.parse(result.stdout);
		if (!isRecord(parsed)) return [];
		return readRecordArray(parsed, "dependencies").filter((dependency) => readRecordArray(dependency, "vulns").length > 0).flatMap((dependency) => {
			const name = readString(dependency, "name");
			if (!name) return [];
			return [dependencyDiagnostic("requirements.txt", `Vulnerable Python dependency: ${name}`, withFixHint(`Upgrade ${name} to fix known vulnerabilities`))];
		});
	} catch {
		return [];
	}
};
const toGovulnDiagnostic = (entry) => {
	const vulnerability = entry.vulnerability;
	if (!isRecord(vulnerability)) return null;
	const id = readString(vulnerability, "id");
	if (!id) return null;
	return {
		filePath: "go.mod",
		engine: "security",
		rule: "security/vulnerable-dependency",
		severity: "error",
		message: `Go vulnerability: ${id}`,
		help: withFixHint(readString(vulnerability, "details") ?? ""),
		line: 0,
		column: 0,
		category: "Security",
		fixable: false
	};
};
const parseGovulncheckOutput = (output) => {
	const diagnostics = [];
	for (const line of output.split("\n")) {
		if (!line.startsWith("{")) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		const diagnostic = toGovulnDiagnostic(parsed);
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return diagnostics;
};
const runGovulncheck = async (rootDir, timeout) => {
	try {
		const result = await runSubprocess("govulncheck", ["-json", "./..."], {
			cwd: rootDir,
			timeout
		});
		if (!result.stdout) return [];
		return parseGovulncheckOutput(result.stdout);
	} catch {
		return [];
	}
};
const runCargoAudit = async (rootDir, timeout) => {
	try {
		const result = await runSubprocess("cargo", ["audit", "--json"], {
			cwd: rootDir,
			timeout
		});
		if (!result.stdout) return [];
		const parsed = JSON.parse(result.stdout);
		if (!isRecord(parsed) || !isRecord(parsed.vulnerabilities)) return [];
		return readRecordArray(parsed.vulnerabilities, "list").flatMap((vulnerability) => {
			const advisory = vulnerability.advisory;
			if (!isRecord(advisory)) return [];
			const id = readString(advisory, "id");
			if (!id) return [];
			return [dependencyDiagnostic("Cargo.toml", `Rust vulnerability: ${id}`, withFixHint(readString(advisory, "title") ?? ""))];
		});
	} catch {
		return [];
	}
};
//#endregion
//#region src/engines/security/audit-js-parser.ts
const SEVERITY_RANK = {
	critical: 4,
	high: 3,
	moderate: 2,
	low: 1
};
const toSeverity = (value) => value === "critical" || value === "high" ? "error" : "warning";
const reachesRuntime = (packageName, vulnerabilities, runtimeDependencies, visited) => {
	if (runtimeDependencies.has(packageName)) return true;
	if (visited.has(packageName)) return false;
	visited.add(packageName);
	const entry = vulnerabilities[packageName];
	if (!isRecord(entry) || !Array.isArray(entry.effects)) return false;
	return entry.effects.some((effect) => typeof effect === "string" && reachesRuntime(effect, vulnerabilities, runtimeDependencies, visited));
};
const upsertVuln = (bucket, packageName, severity, recommendation) => {
	const existing = bucket.get(packageName);
	if (existing) {
		existing.advisories++;
		if ((SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[existing.worstSeverity] ?? 0)) existing.worstSeverity = severity;
		if (recommendation) existing.recommendations.add(recommendation);
	} else bucket.set(packageName, {
		packageName,
		worstSeverity: severity,
		advisories: 1,
		recommendations: recommendation ? /* @__PURE__ */ new Set([recommendation]) : /* @__PURE__ */ new Set()
	});
};
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;
const cmpSemver = (a, b) => {
	const [, a1, a2, a3] = SEMVER_RE.exec(a) ?? [
		"",
		"0",
		"0",
		"0"
	];
	const [, b1, b2, b3] = SEMVER_RE.exec(b) ?? [
		"",
		"0",
		"0",
		"0"
	];
	if (Number(a1) !== Number(b1)) return Number(a1) - Number(b1);
	if (Number(a2) !== Number(b2)) return Number(a2) - Number(b2);
	return Number(a3) - Number(b3);
};
const pickBestRecommendation = (recs) => {
	if (recs.length <= 1) return recs[0] ?? "";
	const versioned = recs.filter((r) => SEMVER_RE.test(r));
	if (versioned.length === 0) return recs[0];
	return versioned.reduce((best, r) => cmpSemver(r, best) > 0 ? r : best);
};
const cleanRecommendation = (raw) => {
	const t = raw.trim();
	if (!t || t.toLowerCase() === "none") return "no fix available";
	return t;
};
const aggregateToDiagnostic = (agg, source) => {
	const recs = [...agg.recommendations];
	const best = cleanRecommendation(pickBestRecommendation(recs));
	const countLabel = agg.advisories > 1 ? ` (${agg.advisories} advisories)` : "";
	const recLabel = best ? ` — ${best}` : "";
	const scopeLabel = agg.devOnly ? ", dev-only" : "";
	return {
		filePath: "package.json",
		engine: "security",
		rule: "security/vulnerable-dependency",
		severity: agg.devOnly ? "info" : toSeverity(agg.worstSeverity),
		message: `${agg.packageName} (${agg.worstSeverity}${scopeLabel})${recLabel}${countLabel}`,
		help: "",
		line: 0,
		column: 0,
		category: "Security",
		fixable: false,
		detail: source === "npm audit" ? "npm" : source === "pnpm audit" ? "pnpm" : "bun"
	};
};
const parseBunAudit = (output) => {
	if (!output.trim()) return [];
	try {
		const parsed = JSON.parse(output);
		if (!isRecord(parsed)) return [];
		const bucket = /* @__PURE__ */ new Map();
		for (const [packageName, advisories] of Object.entries(parsed)) {
			if (!Array.isArray(advisories) || advisories.length === 0) continue;
			for (const advisory of advisories) {
				if (!isRecord(advisory)) continue;
				const severity = (readString(advisory, "severity") ?? "moderate").toLowerCase();
				const recommendation = readString(advisory, "title") ?? readString(advisory, "vulnerable_versions") ?? readString(advisory, "url") ?? "";
				upsertVuln(bucket, packageName, severity, recommendation);
			}
		}
		return [...bucket.values()].map((agg) => aggregateToDiagnostic(agg, "bun audit"));
	} catch {
		return [];
	}
};
const parseLegacyAdvisories = (advisories, source) => {
	const bucket = /* @__PURE__ */ new Map();
	for (const [key, advisory] of Object.entries(advisories)) {
		if (!isRecord(advisory)) continue;
		const packageName = readString(advisory, "module_name") ?? readString(advisory, "name") ?? readString(advisory, "package") ?? key;
		const severity = (readString(advisory, "severity") ?? "moderate").toLowerCase();
		const recommendation = readString(advisory, "recommendation") ?? readString(advisory, "title") ?? "";
		upsertVuln(bucket, packageName, severity, recommendation);
	}
	return [...bucket.values()].map((agg) => aggregateToDiagnostic(agg, source));
};
const carriesAdvisory = (vulnerability) => Array.isArray(vulnerability.via) && vulnerability.via.some(isRecord);
const parseModernVulnerabilities = (vulnerabilities, source, manifest) => {
	const bucket = /* @__PURE__ */ new Map();
	const records = Object.entries(vulnerabilities).filter((entry) => isRecord(entry[1]));
	const hasRootCauses = records.some(([, vulnerability]) => carriesAdvisory(vulnerability));
	for (const [packageName, vulnerability] of records) {
		if (hasRootCauses && !carriesAdvisory(vulnerability)) continue;
		const severity = (readString(vulnerability, "severity") ?? "moderate").toLowerCase();
		const fixAvailable = vulnerability.fixAvailable;
		const isDirect = vulnerability.isDirect === true;
		let recommendation = "";
		if (fixAvailable === false) recommendation = isDirect ? "no automatic fix" : "transitive — needs override or parent upgrade";
		else if (!isDirect && fixAvailable === true) recommendation = "transitive — may need override or parent upgrade";
		else if (isRecord(fixAvailable)) {
			const name = readString(fixAvailable, "name");
			const version = readString(fixAvailable, "version");
			if (name && version) recommendation = `upgrade to ${name}@${version}`;
		}
		upsertVuln(bucket, packageName, severity, recommendation);
		if (manifest) {
			const aggregate = bucket.get(packageName);
			if (aggregate) aggregate.devOnly = !reachesRuntime(packageName, vulnerabilities, manifest.runtimeDependencies, /* @__PURE__ */ new Set());
		}
	}
	return [...bucket.values()].map((agg) => aggregateToDiagnostic(agg, source));
};
const parseJsAudit = (output, source, manifest) => {
	if (!output) return [];
	try {
		const parsed = JSON.parse(output);
		if (!isRecord(parsed)) return [];
		const error = isRecord(parsed.error) ? parsed.error : void 0;
		const errorCode = error ? readString(error, "code") : void 0;
		const errorSummary = error ? readString(error, "summary") : void 0;
		const errorDetail = error ? readString(error, "detail") : void 0;
		if (errorCode === "ENOLOCK") return [{
			filePath: "package.json",
			engine: "security",
			rule: "security/dependency-audit-skipped",
			severity: "info",
			message: `Dependency audit skipped (${source}): lockfile is missing`,
			help: errorDetail ?? "Generate a lockfile, then re-run `aislop scan` for dependency vulnerability checks.",
			line: 0,
			column: 0,
			category: "Security",
			fixable: false
		}];
		if (errorSummary || errorCode) return [{
			filePath: "package.json",
			engine: "security",
			rule: "security/dependency-audit-skipped",
			severity: "info",
			message: `Dependency audit did not complete (${source})`,
			help: errorDetail ?? errorSummary ?? "Re-run dependency audit directly to inspect the underlying error.",
			line: 0,
			column: 0,
			category: "Security",
			fixable: false
		}];
		const advisories = parsed.advisories;
		if (isRecord(advisories)) return parseLegacyAdvisories(advisories, source);
		const vulnerabilities = parsed.vulnerabilities;
		if (isRecord(vulnerabilities)) return parseModernVulnerabilities(vulnerabilities, source, manifest);
		return [];
	} catch {
		return [];
	}
};
//#endregion
//#region src/engines/security/runtime-dependencies.ts
const RUNTIME_DEPENDENCY_FIELDS = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies"
];
const MAX_WORKSPACE_DEPTH = 5;
const SKIPPED_DIRECTORIES = /* @__PURE__ */ new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage",
	".next"
]);
const readJsonFile = (filePath) => {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
		return parsed;
	} catch {
		return;
	}
};
const collectRuntimeNames = (manifest, into) => {
	for (const field of RUNTIME_DEPENDENCY_FIELDS) {
		const section = manifest[field];
		if (section && typeof section === "object") for (const name of Object.keys(section)) into.add(name);
	}
};
const asStringArray = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
const npmWorkspaceGlobs = (manifest) => {
	const workspaces = manifest.workspaces;
	if (Array.isArray(workspaces)) return asStringArray(workspaces);
	if (workspaces && typeof workspaces === "object") return asStringArray(workspaces.packages);
	return [];
};
const pnpmWorkspaceGlobs = (rootDir) => {
	const configPath = path.join(rootDir, "pnpm-workspace.yaml");
	if (!fs.existsSync(configPath)) return [];
	try {
		const parsed = parse(fs.readFileSync(configPath, "utf-8"));
		if (!parsed || typeof parsed !== "object") return [];
		return asStringArray(parsed.packages);
	} catch {
		return [];
	}
};
const listPackageDirectories = (rootDir) => {
	const found = [];
	const walk = (directory, depth) => {
		if (depth > MAX_WORKSPACE_DEPTH) return;
		let entries;
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
			const child = path.join(directory, entry.name);
			found.push(path.relative(rootDir, child).split(path.sep).join("/"));
			walk(child, depth + 1);
		}
	};
	walk(rootDir, 1);
	return found;
};
/**
* Runtime dependency names for the whole project, workspace members included.
*
* A vulnerability reachable only through a member's production dependency is still shipped,
* so reading the root manifest alone would wrongly report it as dev-only. Returns undefined
* when no manifest is readable, which leaves every advisory at full severity.
*/
const readRuntimeDependencies = (rootDir) => {
	const rootManifest = readJsonFile(path.join(rootDir, "package.json"));
	if (!rootManifest) return void 0;
	const names = /* @__PURE__ */ new Set();
	collectRuntimeNames(rootManifest, names);
	const globs = [...npmWorkspaceGlobs(rootManifest), ...pnpmWorkspaceGlobs(rootDir)];
	if (globs.length === 0) return { runtimeDependencies: names };
	for (const relativeDir of micromatch(listPackageDirectories(rootDir), globs)) {
		const memberManifest = readJsonFile(path.join(rootDir, relativeDir, "package.json"));
		if (memberManifest) collectRuntimeNames(memberManifest, names);
	}
	return { runtimeDependencies: names };
};
//#endregion
//#region src/engines/security/audit.ts
const toRelativePath = (rootDirectory, filePath) => {
	const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(rootDirectory, filePath);
	return path.relative(rootDirectory, absolute).split(path.sep).join("/");
};
const shouldRunDependencyAudit = (context) => {
	if (context.dependencyAuditScope === "full") return true;
	const scopedFiles = context.dependencyAuditFiles ?? context.files;
	if (!scopedFiles) return true;
	return scopedFiles.some((file) => isDependencyAuditInputFile(toRelativePath(context.rootDirectory, file)));
};
const PYTHON_DEPENDENCY_MANIFESTS = [
	"requirements.txt",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"Pipfile",
	"poetry.lock"
];
const hasPythonDependencyManifest = (rootDir) => PYTHON_DEPENDENCY_MANIFESTS.some((file) => fs.existsSync(path.join(rootDir, file)));
const runDependencyAudit = async (context) => {
	if (!shouldRunDependencyAudit(context)) return [];
	const diagnostics = [];
	const timeout = context.config.security.auditTimeout;
	const auditLanguages = context.dependencyAuditLanguages ?? context.languages;
	const promises = [];
	if (auditLanguages.includes("typescript") || auditLanguages.includes("javascript")) {
		if (fs.existsSync(path.join(context.rootDirectory, "pnpm-lock.yaml"))) promises.push(runPnpmAuditWithFallback(context.rootDirectory, timeout));
		else if (hasBunLockfile(context.rootDirectory)) promises.push(runBunAudit(context.rootDirectory, timeout));
		else if (fs.existsSync(path.join(context.rootDirectory, "package-lock.json")) || fs.existsSync(path.join(context.rootDirectory, "package.json"))) promises.push(runNpmAudit(context.rootDirectory, timeout));
	}
	if (auditLanguages.includes("python") && context.installedTools["pip-audit"] && hasPythonDependencyManifest(context.rootDirectory)) promises.push(runPipAudit(context.rootDirectory, timeout));
	if (auditLanguages.includes("go") && context.installedTools.govulncheck) promises.push(runGovulncheck(context.rootDirectory, timeout));
	if (auditLanguages.includes("rust")) promises.push(runCargoAudit(context.rootDirectory, timeout));
	if (auditLanguages.includes("csharp") && context.installedTools.dotnet && context.config.lint.csharp?.projectEvaluation === true) promises.push(runDotnetAudit(context.rootDirectory, timeout));
	const results = await Promise.allSettled(promises);
	for (const result of results) if (result.status === "fulfilled") diagnostics.push(...result.value);
	return diagnostics;
};
const hasBunLockfile = (rootDir) => fs.existsSync(path.join(rootDir, "bun.lock")) || fs.existsSync(path.join(rootDir, "bun.lockb"));
const errorMessageOf = (error) => error instanceof Error ? error.message : String(error);
const auditSkippedDiagnostic = (source, help) => ({
	filePath: "package.json",
	engine: "security",
	rule: "security/dependency-audit-skipped",
	severity: "info",
	message: `Dependency audit did not complete (${source})`,
	help,
	line: 0,
	column: 0,
	category: "Security",
	fixable: false
});
const runNpmAudit = async (rootDir, timeout) => {
	try {
		return parseJsAudit((await runSubprocess("npm", ["audit", "--json"], {
			cwd: rootDir,
			timeout
		})).stdout, "npm audit", readRuntimeDependencies(rootDir));
	} catch (error) {
		return [auditSkippedDiagnostic("npm audit", `Failed to run npm audit: ${errorMessageOf(error)}`)];
	}
};
const runBunAudit = async (rootDir, timeout) => {
	try {
		const result = await runSubprocess("bun", ["audit", "--json"], {
			cwd: rootDir,
			timeout
		});
		if (result.stdout) return parseBunAudit(result.stdout);
		if (result.exitCode === 0) return [];
		return [auditSkippedDiagnostic("bun audit", `Failed to run bun audit: ${result.stderr || "unknown error"}`)];
	} catch (error) {
		return [auditSkippedDiagnostic("bun audit", `Failed to run bun audit: ${errorMessageOf(error)}`)];
	}
};
const runPnpmAuditWithFallback = async (rootDir, timeout) => {
	const canFallbackToNpm = fs.existsSync(path.join(rootDir, "package-lock.json"));
	try {
		const diagnostics = parseJsAudit((await runSubprocess("pnpm", ["audit", "--json"], {
			cwd: rootDir,
			timeout
		})).stdout, "pnpm audit", readRuntimeDependencies(rootDir));
		if (diagnostics.some((d) => d.rule === "security/dependency-audit-skipped")) {
			if (canFallbackToNpm) return runNpmAudit(rootDir, timeout);
			return diagnostics;
		}
		return diagnostics;
	} catch (error) {
		if (canFallbackToNpm) return runNpmAudit(rootDir, timeout);
		return [auditSkippedDiagnostic("pnpm audit", `Failed to run pnpm audit: ${errorMessageOf(error)}`)];
	}
};
//#endregion
//#region src/engines/security/html-safety.ts
const SAFE_EMPTY_INNER_HTML_RE = /^\.innerHTML\s*=\s*(?:""|''|``)\s*;?/;
const SAFE_SANITIZED_INNER_HTML_RE = /^\.innerHTML\s*=\s*(?:escapeHtml|sanitizeHtml|sanitizeHTML|DOMPurify\.sanitize)\s*\([^;\n]*\)\s*;?(?:\n|$)/;
const SANITIZER_EXPR_RE = /^(?:escapeHtml|escapeHTML|sanitizeHtml|sanitizeHTML|DOMPurify\.sanitize)\s*\([^;\n]*\)$/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const STATIC_STRING_RE = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\$])*`)$/;
const NUMERICISH_EXPR_RE = /^(?:[-+]?\d+(?:\.\d+)?|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*\|\|\s*[-+]?\d+(?:\.\d+)?)?)$/;
const NUMERICISH_NAME_RE = /(?:^|\.)(?:count|length|size|width|height|top|right|bottom|left|duration|elapsed|timestamp|time|ms|port|pid|attempt|attempts|index|total|x|y)$|(?:count|length|size|width|height|duration|elapsed|timestamp|time|port|pid|attempt|index|total)$/i;
const SAFE_FORMAT_CALL_RE = /^(?:format[A-Z]\w*|fmt[A-Z]?\w*)\s*\((.*)\)$/;
const consumeQuotedLiteral = (content, startIndex, quote) => {
	let i = startIndex + 1;
	while (i < content.length) {
		const char = content[i];
		if (char === "\\") {
			i += 2;
			continue;
		}
		if (char === quote) return { endIndex: i };
		if (char === "\n") return null;
		i++;
	}
	return null;
};
const consumeTemplateLiteral = (content, startIndex) => {
	const openIndex = content.indexOf("`", startIndex);
	if (openIndex === -1) return null;
	let i = openIndex + 1;
	while (i < content.length) {
		const char = content[i];
		if (char === "\\") {
			i += 2;
			continue;
		}
		if (char === "`") return {
			body: content.slice(openIndex + 1, i),
			endIndex: i
		};
		i++;
	}
	return null;
};
const assignmentTailIsClosed = (content, endIndex) => /^\s*(?:;[^\n]*)?(?:\n|$)/.test(content.slice(endIndex + 1));
const assignmentRhsStart = (content, matchIndex) => {
	const match = /^\.innerHTML\s*=\s*/.exec(content.slice(matchIndex));
	return match ? matchIndex + match[0].length : null;
};
const templateExpressions = (templateBody) => [...templateBody.matchAll(/\$\{\s*([^}]+?)\s*\}/g)].map((match) => match[1].trim());
const staticTernaryRe = /^\s*[^?]+\?\s*(?:"[^"]*"|'[^']*'|`[^`$]*`)\s*:\s*(?:"[^"]*"|'[^']*'|`[^`$]*`)\s*$/;
const splitTopLevelTernary = (expr) => {
	let quote = null;
	let depth = 0;
	let question = -1;
	let colon = -1;
	for (let i = 0; i < expr.length; i++) {
		const char = expr[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if ((char === "'" || char === "\"" || char === "`") && quote === null) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (quote) continue;
		if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
		else if (char === "?" && depth === 0 && question === -1) question = i;
		else if (char === ":" && depth === 0 && question !== -1) {
			colon = i;
			break;
		}
	}
	if (question === -1 || colon === -1) return null;
	return {
		whenTrue: expr.slice(question + 1, colon).trim(),
		whenFalse: expr.slice(colon + 1).trim()
	};
};
const isNumericishExpression = (expr) => {
	const normalized = expr.trim();
	if (/^(?:Math\.\w+|Number|parseInt|parseFloat)\s*\(/.test(normalized)) return true;
	if (!NUMERICISH_EXPR_RE.test(normalized)) return false;
	return /\d/.test(normalized) || NUMERICISH_NAME_RE.test(normalized);
};
const isSafeTemplateLiteralExpression = (expr, safeNames) => {
	if (!expr.startsWith("`") || !expr.endsWith("`")) return false;
	const body = expr.slice(1, -1);
	return templateExpressions(body).every((part) => isSafeHtmlExpression(part, safeNames));
};
const collectSafeHtmlNames = (content, matchIndex) => {
	const safeNames = /* @__PURE__ */ new Set();
	const prefix = content.slice(Math.max(0, matchIndex - 8e3), matchIndex);
	for (const rawLine of prefix.split("\n")) {
		const line = rawLine.trim();
		let match = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)\s*;?$/.exec(line);
		if (match) {
			const [, name, expr] = match;
			if (isSafeHtmlExpression(expr.trim(), safeNames)) safeNames.add(name);
			else safeNames.delete(name);
			continue;
		}
		match = /^([A-Za-z_$][\w$]*)\s*\+=\s*(.+?)\s*;?$/.exec(line);
		if (match) {
			const [, name, expr] = match;
			if (safeNames.has(name) && isSafeHtmlExpression(expr.trim(), safeNames)) safeNames.add(name);
			else safeNames.delete(name);
			continue;
		}
		match = /^([A-Za-z_$][\w$]*)\s*=\s*(.+?)\s*;?$/.exec(line);
		if (match) {
			const [, name, expr] = match;
			if (isSafeHtmlExpression(expr.trim(), safeNames)) safeNames.add(name);
			else safeNames.delete(name);
		}
	}
	return safeNames;
};
const isSafeHtmlExpression = (expr, safeNames) => {
	const normalized = expr.trim();
	if (SANITIZER_EXPR_RE.test(normalized)) return true;
	if (STATIC_STRING_RE.test(normalized)) return true;
	if (staticTernaryRe.test(expr)) return true;
	if (isNumericishExpression(normalized)) return true;
	if (IDENT_RE.test(normalized) && safeNames.has(normalized)) return true;
	if (isSafeTemplateLiteralExpression(normalized, safeNames)) return true;
	const ternary = splitTopLevelTernary(normalized);
	if (ternary && isSafeHtmlExpression(ternary.whenTrue, safeNames) && isSafeHtmlExpression(ternary.whenFalse, safeNames)) return true;
	const formatCall = SAFE_FORMAT_CALL_RE.exec(normalized);
	if (formatCall) return formatCall[1].split(",").map((arg) => arg.trim()).filter((arg) => arg.length > 0).every((arg) => isNumericishExpression(arg) || IDENT_RE.test(arg) && safeNames.has(arg));
	return false;
};
const readSingleLineRhs = (content, rhsStart) => {
	const lineEnd = content.indexOf("\n", rhsStart);
	const line = content.slice(rhsStart, lineEnd === -1 ? content.length : lineEnd);
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if ((char === "'" || char === "\"" || char === "`") && quote === null) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (char === ";" && quote === null) return line.slice(0, i).trim();
	}
	return line.trim();
};
const isSafeMapJoinHtmlAssignment = (content, rhsStart) => {
	const head = content.slice(rhsStart);
	const mapMatch = /^[A-Za-z_$][\w$.]*\.map\(\s*[A-Za-z_$][\w$]*\s*=>\s*`/.exec(head);
	if (!mapMatch) return false;
	const templateStart = rhsStart + mapMatch[0].length - 1;
	const template = consumeTemplateLiteral(content, templateStart);
	if (!template) return false;
	if (!/^\s*\)\.join\(\s*(?:""|'')\s*\)/.test(content.slice(template.endIndex + 1))) return false;
	const safeNames = collectSafeHtmlNames(content, rhsStart);
	return templateExpressions(template.body).every((expr) => isSafeHtmlExpression(expr, safeNames));
};
const isSafeInnerHtmlAssignment = (content, matchIndex) => {
	const tail = content.slice(matchIndex);
	if (SAFE_EMPTY_INNER_HTML_RE.test(tail) || SAFE_SANITIZED_INNER_HTML_RE.test(tail)) return true;
	const rhsStart = assignmentRhsStart(content, matchIndex);
	if (rhsStart === null) return false;
	const first = content[rhsStart];
	const safeNames = collectSafeHtmlNames(content, matchIndex);
	const singleLineRhs = readSingleLineRhs(content, rhsStart);
	if (isSafeHtmlExpression(singleLineRhs, safeNames)) return true;
	if (isSafeMapJoinHtmlAssignment(content, rhsStart)) return true;
	if (first === "'" || first === "\"") {
		const quoted = consumeQuotedLiteral(content, rhsStart, first);
		return Boolean(quoted && assignmentTailIsClosed(content, quoted.endIndex));
	}
	if (first !== "`") return false;
	const template = consumeTemplateLiteral(content, rhsStart);
	if (!template || !assignmentTailIsClosed(content, template.endIndex)) return false;
	const expressions = templateExpressions(template.body);
	if (expressions.length === 0) return true;
	return expressions.every((expr) => isSafeHtmlExpression(expr, safeNames));
};
//#endregion
//#region src/engines/security/risky-patterns.ts
const ev = "eval";
const Fn = "Function";
const DB_RECEIVER = "(?:db|database|knex|client|connection|conn|pool|sql|prisma|trx|tx|sequelize|mongoose|typeorm|postgres|pg|mysql|sqlite|model|orm|datasource)";
const DB_METHOD = "(?:query|execute|exec|raw|\\$queryRaw|\\$queryRawUnsafe|\\$executeRaw|\\$executeRawUnsafe)";
const CPP_EXTS = [...CPP_SOURCE_EXTENSIONS];
const CS_SQL_SINK = "(?:SqlCommand|MySqlCommand|NpgsqlCommand|SqliteCommand|OleDbCommand|OracleCommand|SqlDataAdapter|CommandText|FromSqlRaw|FromSqlRawAsync|ExecuteSqlRaw|ExecuteSqlRawAsync|ExecuteSqlCommand)";
const CS_INTERP = "(?:\\$@?|@\\$)\"";
const CS_CONCAT = "@?\"[^\"]*\"\\s*\\+";
const CS_CMD_SINK = "(?:\\bProcess\\.Start\\s*\\(|\\.Arguments\\s*=)";
const csharpRisk = (pattern, name, message, help) => ({
	pattern,
	extensions: [".cs"],
	name,
	message,
	help
});
const RISKY_PATTERNS = [
	{
		pattern: new RegExp(`(?<![\\w.>:\\\\])\\b${ev}\\s*\\(`, "g"),
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs",
			".py",
			".rb",
			".php"
		],
		name: "eval",
		message: `Use of ${ev}() is a security risk`,
		help: `Avoid ${ev} — use safer alternatives like JSON.parse, Function constructor, or AST-based approaches`
	},
	{
		pattern: new RegExp(`new\\s+${Fn}\\s*\\(`, "g"),
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		name: "new-function",
		message: `Use of new ${Fn}() is similar to ${ev} and can be a security risk`,
		help: "Avoid dynamic code execution — refactor to use static code paths"
	},
	{
		pattern: new RegExp(`\\.innerHTML\\s*=`, "g"),
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx"
		],
		name: "innerhtml",
		message: "Direct innerHTML assignment can lead to XSS",
		help: "Use textContent, DOM APIs, or a sanitization library instead"
	},
	{
		pattern: /dangerouslySetInnerHTML/g,
		extensions: [".tsx", ".jsx"],
		name: "dangerously-set-innerhtml",
		message: "dangerouslySetInnerHTML can lead to XSS if not sanitized",
		help: "Ensure the HTML is sanitized with DOMPurify or similar before rendering"
	},
	{
		pattern: /pickle\.loads?\s*\(/g,
		extensions: [".py"],
		name: "pickle-load",
		message: "pickle.load can execute arbitrary code — unsafe deserialization",
		help: "Use JSON, MessagePack, or other safe serialization formats for untrusted data"
	},
	{
		pattern: new RegExp(`(?<![\\w.>:\\\\])\\bexec\\s*\\(`, "g"),
		extensions: [".py"],
		name: "python-exec",
		message: "Use of exec() can execute arbitrary code",
		help: "Avoid exec — use safer alternatives"
	},
	{
		pattern: /(?:child_process|subprocess|os\.system|exec|spawn)\s*\([^)]*\$\{/g,
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs",
			".py"
		],
		name: "shell-injection",
		message: "Possible shell injection — user input in command execution",
		help: "Use parameterized commands or a safe shell execution library"
	},
	{
		pattern: new RegExp(`\\b${DB_RECEIVER}(?:\\.\\w+)*\\.${DB_METHOD}\\s*\\(?\\s*\`[^\`]*\\$\\{`, "g"),
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		name: "sql-injection",
		message: "Possible SQL injection — template literal in query",
		help: "Use parameterized queries or an ORM instead of string interpolation"
	},
	{
		pattern: new RegExp(`\\b${DB_RECEIVER}(?:\\.\\w+)*\\.${DB_METHOD}\\s*\\(\\s*["'][^"']*["']\\s*\\+`, "g"),
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs"
		],
		name: "sql-injection",
		message: "Possible SQL injection — string concatenation in query",
		help: "Use parameterized queries or an ORM instead of string concatenation"
	},
	csharpRisk(new RegExp(`\\b${CS_SQL_SINK}\\b\\s*[(=]\\s*${CS_INTERP}`, "g"), "sql-injection", "Possible SQL injection: interpolated string in query", "Use parameterized queries (SqlParameter) or EF Core FromSqlInterpolated/ExecuteSqlInterpolated"),
	csharpRisk(new RegExp(`\\b${CS_SQL_SINK}\\b\\s*[(=]\\s*${CS_CONCAT}`, "g"), "sql-injection", "Possible SQL injection: string concatenation in query", "Use parameterized queries (SqlParameter) instead of string concatenation"),
	csharpRisk(new RegExp(`${CS_CMD_SINK}\\s*${CS_INTERP}`, "g"), "shell-injection", "Possible command injection: interpolated string in process invocation", "Pass arguments as a ProcessStartInfo.ArgumentList collection, not an interpolated command string"),
	csharpRisk(new RegExp(`${CS_CMD_SINK}\\s*${CS_CONCAT}`, "g"), "shell-injection", "Possible command injection: string concatenation in process invocation", "Pass arguments as a ProcessStartInfo.ArgumentList collection, not a concatenated command string"),
	{
		pattern: /\b(?:BinaryFormatter|NetDataContractSerializer|SoapFormatter|LosFormatter|ObjectStateFormatter)\b/g,
		extensions: [".cs"],
		name: "unsafe-deserialization",
		message: "Unsafe deserializer can execute arbitrary code on untrusted input",
		help: "Use System.Text.Json or DataContractSerializer with a known, restricted set of types"
	},
	{
		pattern: /(?<![\w.>])\b(?:system|popen)\s*\(/g,
		extensions: CPP_EXTS,
		name: "shell-injection",
		message: "Use of system()/popen() spawns a shell - a command-injection risk",
		help: "Use posix_spawn/exec-family with an explicit argument vector, or a vetted process library"
	},
	{
		pattern: /(?<![\w.>])\b(?:gets|strcpy|strcat|sprintf)\s*\(/g,
		extensions: CPP_EXTS,
		name: "unsafe-c-call",
		message: "Memory-unsafe C string function - buffer overflow risk",
		help: "Use bounded variants (snprintf, strncpy/strncat, fgets) or std::string / std::format"
	}
];
//#endregion
//#region src/engines/security/risky.ts
const hasDangerouslySetInnerHtmlIgnore = (lines, lineIndex) => {
	const start = Math.max(0, lineIndex - 2);
	return lines.slice(start, lineIndex + 1).some((line) => /(?:biome-ignore|eslint-disable|aislop-ignore).*(?:noDangerouslySetInnerHtml|dangerouslySetInnerHTML|dangerously-set-innerhtml)/i.test(line));
};
const isStructuredDataScript = (content, matchIndex) => {
	const before = content.slice(Math.max(0, matchIndex - 300), matchIndex);
	if (/type=["']application\/ld\+json["']/.test(before)) return true;
	const after = content.slice(matchIndex, Math.min(content.length, matchIndex + 180));
	return /__html\s*:\s*JSON\.stringify\s*\(/.test(after);
};
const isSafeShellSpawnArray = (content, matchIndex) => /^spawn\s*\(\s*\[/.test(content.slice(matchIndex)) && !/^\s*spawn\s*\(\s*\[\s*["'](?:sh|bash|zsh|cmd|cmd\.exe|powershell|pwsh)["']\s*,\s*["'](?:-c|\/c|\/C)["']/i.test(content.slice(matchIndex)) && !/shell\s*:\s*true\b/.test(content.slice(matchIndex, matchIndex + 500));
const PLACEHOLDER_EXPR_RE = /^(?:placeholders?|placeholderList|bindMarkers?|bindingMarkers?|bindPlaceholders?|bindingPlaceholders?|parameterPlaceholders?|sqlPlaceholders?)(?:\.\w+\([^)]*\))?$/i;
const SQL_PLACEHOLDER_LITERAL_RE = /["'](?:\?|\$\d+|\$\{[^}]+\})["']/;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isGeneratedPlaceholderList = (content, matchIndex, placeholderExpr) => {
	const name = placeholderExpr.match(/^([A-Za-z_$][\w$]*)/)?.[1];
	if (!name) return false;
	const prefix = content.slice(Math.max(0, matchIndex - 4e3), matchIndex);
	const declarationRe = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*([^;\\n]+)`, "g");
	const declaration = [...prefix.matchAll(declarationRe)].at(-1);
	if (!declaration) return false;
	const expr = declaration[1];
	if (!/\.join\s*\(/.test(expr)) return false;
	return /\.map\s*\(/.test(expr) && /=>/.test(expr) && SQL_PLACEHOLDER_LITERAL_RE.test(expr) || /\.fill\s*\(/.test(expr) && SQL_PLACEHOLDER_LITERAL_RE.test(expr);
};
const isSafeSqlPlaceholderTemplate = (content, matchIndex) => {
	const template = consumeTemplateLiteral(content, matchIndex);
	if (!template) return false;
	const afterTemplate = content.slice(template.endIndex + 1);
	if (!(/^\s*,/.test(afterTemplate) || /^\s*\)\s*\.(?:all|get|run|values)\s*\(/.test(afterTemplate))) return false;
	const expressions = [...template.body.matchAll(/\$\{\s*([^}]+?)\s*\}/g)].map((match) => match[1].trim());
	if (expressions.length === 0) return false;
	return expressions.every((expr) => PLACEHOLDER_EXPR_RE.test(expr) && isGeneratedPlaceholderList(content, matchIndex, expr));
};
const detectRiskyConstructs = async (context) => {
	const files = getSourceFiles(context);
	const diagnostics = [];
	for (const filePath of files) {
		const ext = path.extname(filePath);
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const relativePath = relativePosix(context.rootDirectory, filePath);
		const masked = maskStringsAndComments$1(content, ext);
		const lines = content.split("\n");
		for (const { pattern, extensions, name, message, help } of RISKY_PATTERNS) {
			if (!extensions.includes(ext)) continue;
			const regex = new RegExp(pattern.source, pattern.flags);
			for (const match of masked.matchAll(regex)) {
				const line = content.slice(0, match.index).split("\n").length;
				if (name === "innerhtml") {
					const beforeMatch = content.slice(Math.max(0, match.index - 200), match.index);
					if (isSafeInnerHtmlAssignment(content, match.index)) continue;
					if (/(?:template|tmpl|tpl)$/i.test(beforeMatch.trimEnd()) || /createElement\s*\(\s*['"]template['"]\s*\)$/.test(beforeMatch.trimEnd())) continue;
				}
				if (name === "sql-injection" && isSafeSqlPlaceholderTemplate(content, match.index)) continue;
				if (name === "shell-injection" && isSafeShellSpawnArray(content, match.index)) continue;
				if (name === "dangerously-set-innerhtml") {
					if (hasDangerouslySetInnerHtmlIgnore(lines, line - 1)) continue;
					if (isStructuredDataScript(content, match.index)) continue;
				}
				diagnostics.push({
					filePath: relativePath,
					engine: "security",
					rule: `security/${name}`,
					severity: "error",
					message,
					help,
					line,
					column: 0,
					category: "Security",
					fixable: false
				});
			}
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/security/secrets.ts
const SECRET_PATTERNS = [
	{
		pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/gi,
		name: "API key",
		keywordPrefixed: true
	},
	{
		pattern: /AKIA[0-9A-Z]{16}/g,
		name: "AWS Access Key"
	},
	{
		pattern: /(?:aws[_-]?secret|secret[_-]?key)\s*[:=]\s*["']([A-Za-z0-9/+=]{40})["']/gi,
		name: "AWS Secret Key",
		keywordPrefixed: true
	},
	{
		pattern: /(?:password|passwd|pwd|secret)\s*[:=]\s*["']([^"']{8,})["']/gi,
		name: "Hardcoded password/secret",
		keywordPrefixed: true
	},
	{
		pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
		name: "Private key"
	},
	{
		pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
		name: "JWT token"
	},
	{
		pattern: /(?:token|bearer)\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/gi,
		name: "Authentication token",
		keywordPrefixed: true
	},
	{
		pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
		name: "GitHub token"
	},
	{
		pattern: /xox[baprs]-[A-Za-z0-9-]+/g,
		name: "Slack token"
	},
	{
		pattern: /(?:mongodb(?:\+srv)?|postgres|mysql|redis):\/\/[^:@/"'`\s]+:[^@"'`\s]+@[^"'`\s]+/gi,
		name: "Database connection string with credentials"
	}
];
const isInsideStringLiteral = (content, matchIndex) => {
	const lineStart = content.lastIndexOf("\n", matchIndex - 1) + 1;
	const prefix = content.slice(lineStart, matchIndex);
	let inDouble = false;
	let inSingle = false;
	let inBacktick = false;
	for (let i = 0; i < prefix.length; i++) {
		const ch = prefix[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "\"" && !inSingle && !inBacktick) inDouble = !inDouble;
		else if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
		else if (ch === "`" && !inDouble && !inSingle) inBacktick = !inBacktick;
	}
	return inDouble || inSingle || inBacktick;
};
const PLACEHOLDER_EXACT = /* @__PURE__ */ new Set([
	"changeme",
	"password",
	"secret",
	"xxx",
	"todo",
	"replace_me"
]);
const ENV_PLACEHOLDER_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const PLACEHOLDER_URL_PARTS = /* @__PURE__ */ new Set([
	"example",
	"host",
	"localhost",
	"pass",
	"password",
	"pw",
	"user",
	"username"
]);
const PUBLIC_POSTHOG_PROJECT_TOKEN_RE = /^phc_[A-Za-z0-9_-]{20,}$/;
const LOCAL_DB_HOSTS = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]"
]);
const NON_PRODUCTION_CREDENTIAL_EXACT = /* @__PURE__ */ new Set([
	"pass",
	"password",
	"pw",
	"mostest"
]);
const NON_PRODUCTION_CREDENTIAL_PREFIXES = [
	"demo",
	"dummy",
	"fake",
	"local",
	"sample",
	"test",
	"testing"
];
const isNonProductionCredentialValue = (value) => {
	const lower = value.toLowerCase();
	const prefix = NON_PRODUCTION_CREDENTIAL_PREFIXES.find((candidate) => lower.startsWith(candidate));
	if (!prefix) return false;
	let rest = lower.slice(prefix.length);
	if (rest.length === 0) return true;
	while (rest.length > 0) {
		if (rest[0] === "_" || rest[0] === "." || rest[0] === "-") {
			rest = rest.slice(1);
			if (rest.length === 0) return false;
		}
		const segment = rest.match(/^[a-z0-9]+/);
		if (!segment) return false;
		rest = rest.slice(segment[0].length);
	}
	return true;
};
const NON_PRODUCTION_SECRET_PATH_RE = /(?:^|\/)(?:__fixtures__|__mocks__|cypress|demo|demos|e2e-tests?|examples?|fixtures?|playwright|samples?|seeders?|seeds?|storetest|testdata|tests?|tools\/sharedchannel-test)(?:\/|$)|(?:^|\/)db\/seeds\.[^/]+$/i;
const SYMBOLIC_VALUE_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const HEADER_CONSTANT_RE = /\bHeader[A-Za-z0-9_]*\s*=/;
const GENERATED_SECRET_RE = /\b(?:SecureRandom|crypto\.random|randomBytes|randomUUID|random_bytes|secrets\.token|uuid)\b/i;
const FIXTURE_LINE_RE = /\b(?:fixture|mock|sample|seed|test)\b|(?:^|[^A-Za-z])B?Test[A-Z_]/i;
const FIXTURE_VALUE_RE = /^(?:password1!?\.?|passwd\+us3r\d+|sys@dmin-sample\d+|usr@mmtest\d+|test(?:ing)?[-_ ]?(?:password|secret)?\d*)$/i;
const MASKED_SECRET_RE = /^[*xX]{6,}$/;
const isPlaceholderCredentialUrl = (matchedText) => {
	const credentialMatch = matchedText.match(/^[a-z][a-z+.-]*:\/\/([^:@/\s]+):([^@/\s]+)@/i);
	if (credentialMatch) return PLACEHOLDER_URL_PARTS.has(credentialMatch[1].toLowerCase()) && PLACEHOLDER_URL_PARTS.has(credentialMatch[2].toLowerCase());
	try {
		const parsed = new URL(matchedText);
		return PLACEHOLDER_URL_PARTS.has(parsed.username.toLowerCase()) && PLACEHOLDER_URL_PARTS.has(parsed.password.toLowerCase()) && PLACEHOLDER_URL_PARTS.has(parsed.hostname.toLowerCase());
	} catch {
		return false;
	}
};
const isLocalhostExampleDatabaseUrl = (matchedText) => {
	try {
		const parsed = new URL(matchedText);
		if (!LOCAL_DB_HOSTS.has(parsed.hostname.toLowerCase())) return false;
		const password = decodeURIComponent(parsed.password);
		const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
		return NON_PRODUCTION_CREDENTIAL_EXACT.has(password.toLowerCase()) || isNonProductionCredentialValue(password) || /(?:^|[_-])test(?:$|[_-])|sample|fixture/i.test(database);
	} catch {
		return false;
	}
};
const lineForMatch = (content, matchIndex) => {
	const lineStart = content.lastIndexOf("\n", matchIndex - 1) + 1;
	const lineEnd = content.indexOf("\n", matchIndex);
	return content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
};
const isPlaceholderValue = (matchedText) => {
	const value = matchedText.trim();
	if (isPlaceholderCredentialUrl(value)) return true;
	if (ENV_PLACEHOLDER_RE.test(value)) return true;
	if (PLACEHOLDER_EXACT.has(value.toLowerCase())) return true;
	return false;
};
const isSymbolicConstantValue = (matchedText) => {
	if (/^process\.env\./i.test(matchedText)) return false;
	if (!SYMBOLIC_VALUE_RE.test(matchedText)) return false;
	if (/\d/.test(matchedText)) return false;
	return /[_.]/.test(matchedText) || /[a-z][A-Z]/.test(matchedText);
};
const isHeaderNameConstant = (lineText, matchedText) => {
	if (!HEADER_CONSTANT_RE.test(lineText)) return false;
	return matchedText.toLowerCase() === "token" || matchedText.toLowerCase() === "bearer" || matchedText === "Authorization" || matchedText.startsWith("X-");
};
const isFixtureSecret = (relativePath, lineText, matchedText) => {
	if (MASKED_SECRET_RE.test(matchedText)) return true;
	if (/(?:mmtest|sample|testing)/i.test(matchedText)) return true;
	if (/updated .*(?:client)?secret/i.test(matchedText)) return true;
	if (!NON_PRODUCTION_SECRET_PATH_RE.test(relativePath) && !FIXTURE_LINE_RE.test(lineText)) return false;
	if (FIXTURE_VALUE_RE.test(matchedText)) return true;
	if (isPlaceholderCredentialUrl(matchedText)) return true;
	return /(?:localhost|mattermost_test|_test|sample|test)/i.test(matchedText);
};
const shouldSkipSecretFinding = (relativePath, name, lineText, matchedText) => {
	if (name === "API key" && PUBLIC_POSTHOG_PROJECT_TOKEN_RE.test(matchedText)) return true;
	if (name === "Database connection string with credentials" && isLocalhostExampleDatabaseUrl(matchedText)) return true;
	if (GENERATED_SECRET_RE.test(lineText) || GENERATED_SECRET_RE.test(matchedText)) return true;
	if (isHeaderNameConstant(lineText, matchedText)) return true;
	if (isFixtureSecret(relativePath, lineText, matchedText)) return true;
	if ((name === "Hardcoded password/secret" || name === "Authentication token") && isSymbolicConstantValue(matchedText)) return true;
	return false;
};
const scanSecrets = async (context) => {
	const files = getSourceFilesWithExtras(context, [
		".env",
		".yaml",
		".yml",
		".json",
		".toml"
	]);
	const diagnostics = [];
	for (const filePath of files) {
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		content = maskComments(content, path.extname(filePath));
		const relativePath = relativePosix(context.rootDirectory, filePath);
		for (const { pattern, name, keywordPrefixed } of SECRET_PATTERNS) {
			const regex = new RegExp(pattern.source, pattern.flags);
			for (const match of content.matchAll(regex)) {
				const matchedText = match[1] ?? match[0];
				const lineText = lineForMatch(content, match.index);
				if (isPlaceholderValue(matchedText)) continue;
				if (shouldSkipSecretFinding(relativePath, name, lineText, matchedText)) continue;
				if (keywordPrefixed && isInsideStringLiteral(content, match.index)) continue;
				const line = content.slice(0, match.index).split("\n").length;
				diagnostics.push({
					filePath: relativePath,
					engine: "security",
					rule: "security/hardcoded-secret",
					severity: "error",
					message: `Possible ${name} detected in source code`,
					help: "Move secrets to environment variables or a secrets manager",
					line,
					column: 0,
					category: "Security",
					fixable: false
				});
			}
		}
	}
	return diagnostics;
};
//#endregion
//#region src/engines/orchestrator.ts
const ALL_ENGINES = [
	formatEngine,
	lintEngine,
	codeQualityEngine,
	aiSlopEngine,
	architectureEngine,
	{
		name: "security",
		async run(context) {
			const diagnostics = [];
			const promises = [scanSecrets(context), detectRiskyConstructs(context)];
			if (context.config.security.audit) promises.push(runDependencyAudit(context));
			const results = await Promise.allSettled(promises);
			for (const result of results) if (result.status === "fulfilled") diagnostics.push(...result.value);
			return {
				engine: "security",
				diagnostics,
				elapsed: 0,
				skipped: false
			};
		}
	}
];
const runEngines = async (context, enabledEngines, onStart, onComplete) => {
	const engines = ALL_ENGINES.filter((e) => enabledEngines[e.name] !== false);
	return dedupeOverlappingComments(dedupeCSharpAsync((await Promise.allSettled(engines.map(async (engine) => {
		onStart?.(engine.name);
		const start = performance.now();
		try {
			const result = await engine.run(context);
			result.diagnostics = filterExcludedDiagnostics(result.diagnostics, context.rootDirectory, context.excludePatterns);
			result.elapsed = performance.now() - start;
			onComplete?.(result);
			return result;
		} catch (error) {
			const result = {
				engine: engine.name,
				diagnostics: [],
				elapsed: performance.now() - start,
				skipped: true,
				skipReason: error instanceof Error ? error.message : String(error)
			};
			onComplete?.(result);
			return result;
		}
	}))).map((r, i) => r.status === "fulfilled" ? r.value : {
		engine: engines[i].name,
		diagnostics: [],
		elapsed: 0,
		skipped: true,
		skipReason: r.reason instanceof Error ? r.reason.message : String(r.reason)
	})));
};
//#endregion
//#region src/scoring/rule-impact-builders.ts
const strict = (rationale) => ({
	tier: "strict",
	multiplier: 1,
	rationale
});
const standard = (rationale) => ({
	tier: "standard",
	multiplier: 1,
	rationale
});
const maintainability = (rationale, cap = 24) => ({
	tier: "maintainability",
	multiplier: .75,
	cap,
	rationale
});
const mechanical = (rationale, cap = 16) => ({
	tier: "mechanical",
	multiplier: .5,
	cap,
	rationale
});
const style = (rationale, cap = 8) => ({
	tier: "style",
	multiplier: .5,
	cap,
	rationale
});
const advisory = (rationale, cap = 8) => ({
	tier: "advisory",
	multiplier: .25,
	cap,
	rationale
});
//#endregion
//#region src/scoring/rule-impact-ai-slop.ts
const AI_SLOP_RULE_SCORE_IMPACTS = {
	"ai-slop/trivial-comment": style("Restating comments are style noise; keep the finding visible but score gently."),
	"ai-slop/swallowed-exception": strict("Swallowed failures hide real broken states and deserve full scoring impact."),
	"ai-slop/silent-recovery": strict("Logging/defaulting and continuing can corrupt behavior unless handled intentionally."),
	"ai-slop/meta-comment": style("Process narration is cleanup noise and should not make a healthy repo look broken."),
	"ai-slop/hidden-fallback": maintainability("Safe-looking defaults that hide missing or failed state deserve explicit review."),
	"ai-slop/redundant-try-catch": maintainability("Redundant error plumbing adds noise but is usually not a runtime defect."),
	"ai-slop/redundant-type-coercion": maintainability("Redundant coercion is cleanup and readability debt."),
	"ai-slop/duplicate-type-declaration": maintainability("Duplicate types create drift risk but usually need intentional consolidation."),
	"ai-slop/thin-wrapper": maintainability("Thin wrappers add abstraction debt without usually changing behavior."),
	"ai-slop/generic-naming": advisory("Vague names are weak signals and often subjective."),
	"ai-slop/unused-import": mechanical("Unused imports are mechanical cleanup."),
	"ai-slop/unused-css": style("Dead CSS classes are cleanup, not correctness bugs, and dynamic usage can make detection lower-confidence."),
	"ai-slop/console-leftover": style("Leftover debug output is visible cleanup unless it leaks sensitive data."),
	"ai-slop/todo-stub": standard("Unresolved TODO/stub markers often indicate unfinished behavior."),
	"ai-slop/unmarked-debt": standard("Unmarked mock data, stubs, or localhost URLs require AGENT:* tracking tags."),
	"ai-slop/unreachable-code": strict("Unreachable code is a high-confidence logic defect."),
	"ai-slop/constant-condition": strict("Constant conditions usually indicate broken branches."),
	"ai-slop/empty-function": standard("Empty functions may be intentional shims, but often indicate placeholder behavior."),
	"ai-slop/unsafe-type-assertion": maintainability("Unsafe casts bypass type checks and can hide real data-shape bugs."),
	"ai-slop/double-type-assertion": strict("Double assertions deliberately force types through unknown/any and deserve strong impact."),
	"ai-slop/ts-directive": style("TypeScript suppressions need review, but individual directives can be intentional debt."),
	"ai-slop/narrative-comment": style("Narrative comments are cleanup/style findings rather than defects."),
	"ai-slop/duplicate-import": mechanical("Duplicate imports are mechanical cleanup."),
	"ai-slop/hardcoded-url": advisory("Hardcoded URLs are medium-confidence config signals and can be intentional canonical URLs.", 4),
	"ai-slop/hardcoded-id": advisory("Hardcoded provider IDs are config signals, but not all IDs are equally risky.", 4),
	"ai-slop/python-bare-except": strict("Bare except catches system exits and hides real failures."),
	"ai-slop/python-broad-except": standard("Broad exception handling is risky but sometimes intentional at boundaries."),
	"ai-slop/python-mutable-default": strict("Mutable defaults are a high-confidence Python behavior bug."),
	"ai-slop/python-print-debug": style("Debug print output is cleanup unless it leaks sensitive data."),
	"ai-slop/python-range-len-loop": advisory("Index loops are style/readability signals and often not harmful."),
	"ai-slop/python-chained-dict-get": maintainability("Chained dict fallback hides shape assumptions and deserves review."),
	"ai-slop/python-repetitive-dispatch": maintainability("Repetitive dispatch ladders create maintainability debt."),
	"ai-slop/python-isinstance-ladder": maintainability("Long isinstance ladders are brittle polymorphism but not immediate defects."),
	"ai-slop/go-library-panic": maintainability("Go panics in libraries deserve review, but compiler/runtime invariants and test helpers make this lower-confidence than a confirmed defect."),
	"ai-slop/rust-non-test-unwrap": strict("Production unwrap can panic instead of handling expected failure."),
	"ai-slop/rust-todo-stub": standard("Rust todo/unimplemented stubs represent unfinished behavior."),
	"ai-slop/hallucinated-import": strict("Imports missing from the manifest are high-confidence install/runtime failures."),
	"ai-slop/tautological-test": standard("Literal-success assertions are high-confidence test gaps but do not break production directly."),
	"ai-slop/csharp-not-implemented": standard("NotImplementedException stubs usually indicate unfinished behavior."),
	"ai-slop/csharp-async-void": standard("async void can't be awaited and its exceptions crash the process."),
	"ai-slop/csharp-sync-over-async": standard("Blocking on a Task with .Result/.Wait() risks deadlock and burns a thread."),
	"ai-slop/csharp-suppressed-warning": maintainability("Unjustified warning suppression hides analyzer findings rather than fixing them."),
	"ai-slop/csharp-empty-catch-rethrow": mechanical("catch (...) { throw; } is pure noise with no behavior change - mechanical cleanup."),
	"ai-slop/csharp-null-forgiving": maintainability("The null-forgiving ! silences nullable safety without proving the value is non-null."),
	"ai-slop/csharp-console-leftover": style("Leftover Console/Debug/Trace output is visible cleanup unless it leaks sensitive data."),
	"ai-slop/csharp-redundant-doc-comment": style("XML-doc that restates the member name is a cleanup/style finding, not a defect."),
	"ai-slop/csharp-broad-catch": standard("catch (Exception) buries specific failures, though it is sometimes intentional at boundaries."),
	"ai-slop/csharp-linq-count": advisory("Comparing .Count() to 0/1 is a readability/perf idiom signal, often harmless."),
	"ai-slop/csharp-index-loop": advisory("Index for-loops over .Length/.Count are style/readability signals, often not harmful."),
	"ai-slop/csharp-if-ladder": maintainability("Repeated if/else-if ladders dispatching on one value create maintainability debt."),
	"ai-slop/csharp-string-concat-in-loop": maintainability("Repeated string += in a loop is O(n^2) allocation churn; a StringBuilder is the fix."),
	"ai-slop/cpp-not-implemented": standard("Stubs that throw or assert 'not implemented' usually indicate unfinished behavior."),
	"ai-slop/cpp-using-namespace-std-in-header": maintainability("A using-directive at header scope leaks std names into every includer, a hygiene debt."),
	"ai-slop/cpp-c-style-cast": style("A C-style cast in C++ is a cleanup/style finding; a named cast makes intent explicit."),
	"ai-slop/cpp-manual-delete": maintainability("Manual delete is a memory-safety hazard; RAII/smart pointers own the resource instead."),
	"ai-slop/cpp-iostream-leftover": style("Leftover std::cout/std::cerr in library code is visible cleanup unless it leaks data."),
	"ai-slop/cpp-null-literal": style("NULL versus nullptr is a modernization/style finding; nullptr avoids integer-overload pitfalls."),
	"ai-slop/cpp-define-constant": style("A macro constant instead of constexpr is a style/hygiene finding, not a behavior bug."),
	"ai-slop/cpp-endl-in-stream": style("std::endl versus '\\n' is a minor performance/style finding from redundant flushes.")
};
//#endregion
//#region src/scoring/rule-impact.ts
const RULE_SCORE_IMPACTS = {
	formatting: mechanical("Formatter output is mechanical cleanup.", 12),
	"import-order": mechanical("Import ordering is mechanical cleanup.", 12),
	"python-formatting": mechanical("Python formatter output is mechanical cleanup.", 12),
	"go-formatting": mechanical("Go formatter output is mechanical cleanup.", 12),
	"rust-formatting": mechanical("Rust formatter output is mechanical cleanup.", 12),
	"ruby-formatting": mechanical("Ruby formatter output is mechanical cleanup.", 12),
	"php-formatting": mechanical("PHP formatter output is mechanical cleanup.", 12),
	"csharp-formatting": mechanical("C# formatter output is mechanical cleanup.", 12),
	"code-quality/duplicate-block": maintainability("Large copy-paste blocks are real maintenance debt, but repeated blocks are less severe than defects."),
	"code-quality/repeated-chained-call": maintainability("Repeated call chains hurt readability and change safety without usually being runtime defects."),
	"code-quality/unused-declaration": mechanical("Unused declarations are cleanup work and often removable, so they should not dominate the score."),
	"complexity/file-too-large": style("Large files are reviewability pressure, but size alone is not a confirmed defect."),
	"complexity/function-too-long": style("Long functions are maintainability pressure, but length alone is not a confirmed defect."),
	"complexity/deep-nesting": maintainability("Deep nesting makes behavior harder to reason about and is more actionable than pure size."),
	"complexity/too-many-params": maintainability("Large parameter lists hurt call-site safety but usually need intentional refactoring."),
	"knip/files": mechanical("Unused files are cleanup work and can repeat heavily in stale repos."),
	"knip/dependencies": mechanical("Unused production dependencies are cleanup and supply-chain surface, but usually mechanical."),
	"knip/devDependencies": mechanical("Unused dev dependencies are low-risk cleanup."),
	"knip/unlisted": strict("A used package missing from the manifest can break installs and CI."),
	"knip/unresolved": strict("An unresolved import is a high-confidence build/runtime failure."),
	"knip/binaries": mechanical("Unused package binaries are manifest cleanup."),
	"knip/exports": mechanical("Unused exports are public-surface cleanup and can be noisy in libraries."),
	"knip/types": mechanical("Unused exported types are low-risk cleanup."),
	"knip/duplicates": maintainability("Duplicate exports are real API hygiene issues."),
	"security/hardcoded-secret": strict("Secret-looking source literals are high-risk."),
	"security/vulnerable-dependency": strict("Known vulnerabilities deserve full impact even when remediation varies."),
	"security/eval": strict("Dynamic code execution can run attacker-controlled input."),
	"security/innerhtml": strict("Raw HTML assignment can become XSS."),
	"security/dangerously-set-innerhtml": strict("React raw HTML escape hatches can become XSS."),
	"security/sql-injection": strict("Interpolated SQL can become data exfiltration or mutation."),
	"security/shell-injection": strict("Interpolated shell commands can become command execution."),
	"security/unsafe-deserialization": strict("Deserializing untrusted data with a legacy .NET formatter can become remote code execution."),
	"security/unsafe-c-call": strict("Unbounded C string and process calls can become buffer overflows or command execution."),
	"security/dependency-audit-skipped": advisory("An unavailable audit is visibility loss, not evidence of a vulnerability."),
	"dotnet/projects-skipped": advisory("Skipping unrestored C# projects is visibility loss, not evidence of a defect."),
	"cppcheck/chunks-skipped": advisory("A skipped cppcheck chunk is visibility loss, not evidence that the skipped files have a defect."),
	"eslint/no-undef": strict("Undefined identifiers are high-confidence runtime failures."),
	"eslint/no-unused-vars": mechanical("Unused variables are mechanical cleanup."),
	"eslint/no-unassigned-vars": strict("Variables that are never assigned point to broken logic."),
	"eslint/no-empty": style("Empty blocks can be intentional placeholders but should be reviewed."),
	"eslint/no-useless-escape": mechanical("Useless escapes are mechanical cleanup."),
	"eslint/no-unused-expressions": maintainability("Unused expressions often indicate dropped logic."),
	"eslint/no-shadow-restricted-names": strict("Shadowing restricted names can break runtime behavior."),
	"eslint/no-constant-binary-expression": strict("Constant binary expressions usually indicate broken conditions."),
	"eslint/no-unsafe-optional-chaining": strict("Unsafe optional chaining can throw at runtime."),
	"eslint/require-yield": maintainability("Generators without yield are API-shape mistakes."),
	"import/no-duplicates": mechanical("Duplicate import paths are mechanical cleanup."),
	"import/default": strict("Missing default exports can break module loading."),
	"import/named": strict("Missing named exports can break module loading."),
	"import/namespace": strict("Invalid namespace imports can break module loading."),
	"typescript-eslint/triple-slash-reference": mechanical("Triple-slash references are usually cleanup in modern TypeScript projects."),
	"unicorn/no-useless-fallback-in-spread": maintainability("Useless fallbacks add noise."),
	"unicorn/prefer-string-starts-ends-with": mechanical("String predicate preferences are mechanical readability cleanup."),
	"unicorn/no-invalid-remove-event-listener": strict("Invalid event listener removal can leave behavior broken."),
	"unicorn/no-empty-file": mechanical("Empty files are cleanup work."),
	"unicorn/no-useless-length-check": maintainability("Useless length checks add dead branches."),
	"unicorn/no-new-array": maintainability("Avoiding new Array prevents sparse-array mistakes."),
	"unicorn/no-useless-spread": maintainability("Useless spreads add noise and allocation."),
	"unicorn/no-single-promise-in-promise-methods": maintainability("Single-element Promise combinators add unnecessary structure."),
	...AI_SLOP_RULE_SCORE_IMPACTS
};
const DEFAULT_IMPACT = standard("Unclassified external rule uses standard impact.");
const WILDCARD_RULE_SCORE_IMPACTS = [
	["oxlint/", standard("External oxlint rule uses standard lint impact.")],
	["ruff/", standard("External ruff rule uses standard lint impact.")],
	["go/", standard("External Go lint rule uses standard lint impact.")],
	["clippy/", standard("External clippy rule uses standard lint impact.")],
	["rubocop/", standard("External rubocop rule uses standard lint impact.")],
	["typescript/", strict("TypeScript compiler diagnostics can break builds.")],
	["expo-doctor/", maintainability("Expo Doctor findings are project-configuration hygiene.")]
];
const scoreImpactForRule = (ruleId) => RULE_SCORE_IMPACTS[ruleId] ?? WILDCARD_RULE_SCORE_IMPACTS.find(([prefix]) => ruleId.startsWith(prefix))?.[1] ?? DEFAULT_IMPACT;
//#endregion
//#region src/scoring/index.ts
const PERFECT_SCORE = 100;
const CAP_REFERENCE_FILES = 10;
const DENSITY_SCALE = 5;
const resolveEffectiveFileCount = (diagnostics, sourceFileCount) => {
	if (typeof sourceFileCount === "number" && sourceFileCount > 0) return {
		effectiveSourceFileCount: sourceFileCount,
		sourceFileCountMode: "provided"
	};
	if (typeof sourceFileCount === "number" && sourceFileCount < 0) throw new Error("sourceFileCount cannot be negative.");
	const observedDiagnosticFiles = new Set(diagnostics.map((d) => d.filePath).filter(Boolean)).size;
	if (observedDiagnosticFiles === 0) throw new Error("Cannot score diagnostics without sourceFileCount or diagnostic file paths.");
	return {
		effectiveSourceFileCount: observedDiagnosticFiles,
		sourceFileCountMode: "estimated-from-diagnostics"
	};
};
const calculateScore = (diagnostics, weights, thresholds, sourceFileCount, smoothing, maxPerRule) => {
	if (diagnostics.length === 0) return {
		score: PERFECT_SCORE,
		label: "Healthy",
		sourceFileCountMode: "not-needed"
	};
	const deductionsByRule = /* @__PURE__ */ new Map();
	for (const d of diagnostics) {
		const engineWeight = weights[d.engine] ?? 1;
		const severityPenalty = d.severity === "error" ? 3 : d.severity === "warning" ? 1 : .25;
		const ruleImpact = scoreImpactForRule(d.rule);
		const key = `${d.engine}:${d.rule}`;
		deductionsByRule.set(key, (deductionsByRule.get(key) ?? 0) + severityPenalty * engineWeight * ruleImpact.multiplier);
	}
	const fileCount = resolveEffectiveFileCount(diagnostics, sourceFileCount);
	const smoothingConstant = typeof smoothing === "number" ? smoothing : 10;
	const capScale = Math.max(1, fileCount.effectiveSourceFileCount / CAP_REFERENCE_FILES);
	const defaultRuleCap = typeof maxPerRule === "number" && maxPerRule > 0 ? maxPerRule : null;
	const capForRule = (key) => {
		const ruleCap = scoreImpactForRule(key.slice(key.indexOf(":") + 1)).cap;
		if (typeof ruleCap === "number") return defaultRuleCap ? Math.min(defaultRuleCap, ruleCap) : ruleCap;
		return defaultRuleCap;
	};
	const scaledDeductions = [...deductionsByRule.entries()].reduce((total, [key, value]) => {
		const cap = capForRule(key);
		return total + (cap ? Math.min(value, cap * capScale) : value);
	}, 0) / (fileCount.effectiveSourceFileCount + smoothingConstant) * DENSITY_SCALE;
	const score = Math.max(0, Math.round(PERFECT_SCORE - PERFECT_SCORE * Math.log1p(scaledDeductions) / Math.log1p(PERFECT_SCORE + scaledDeductions)));
	return {
		score,
		label: score >= thresholds.good ? "Healthy" : score >= thresholds.ok ? "Needs Work" : "Critical",
		...fileCount
	};
};
//#endregion
//#region src/scoring/rule-severity.ts
/**
* Apply per-rule severity overrides from config: "off" drops the diagnostic,
* "error"/"warning" rewrite its severity before scoring and rendering.
*/
const applyRuleSeverities = (diagnostics, overrides) => {
	if (Object.keys(overrides).length === 0) return diagnostics;
	const result = [];
	for (const diagnostic of diagnostics) {
		const override = overrides[diagnostic.rule];
		if (!override) {
			result.push(diagnostic);
			continue;
		}
		if (override === "off") continue;
		result.push(override === diagnostic.severity ? diagnostic : {
			...diagnostic,
			severity: override
		});
	}
	return result;
};
//#endregion
//#region src/utils/discovery-classifiers.ts
const LANGUAGE_SIGNALS = {
	"tsconfig.json": "typescript",
	"go.mod": "go",
	"Cargo.toml": "rust",
	Gemfile: "ruby",
	"composer.json": "php"
};
const PYTHON_SIGNALS = [
	"requirements.txt",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"Pipfile",
	"poetry.lock"
];
const JAVA_SIGNALS = [
	"pom.xml",
	"build.gradle",
	"build.gradle.kts"
];
const EXTENSION_LANGUAGES = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".rb": "ruby",
	".java": "java",
	".php": "php",
	".c": "cpp",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".h": "cpp",
	".hh": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".cs": "csharp"
};
const FRAMEWORK_PACKAGES = {
	next: "nextjs",
	react: "react",
	vite: "vite",
	"@remix-run/react": "remix",
	expo: "expo",
	astro: "astro"
};
const ASTRO_CONFIG_FILENAMES = [
	"astro.config.mjs",
	"astro.config.js",
	"astro.config.ts",
	"astro.config.cjs"
];
const PYTHON_FRAMEWORKS = {
	django: "django",
	flask: "flask",
	fastapi: "fastapi"
};
const NEXT_CONFIG_FILENAMES = [
	"next.config.js",
	"next.config.mjs",
	"next.config.ts",
	"next.config.cjs"
];
const readTextFile = (filePath) => {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
};
const readPackageJson = (filePath) => {
	const content = readTextFile(filePath);
	if (content === null) return null;
	try {
		return JSON.parse(content);
	} catch {
		return null;
	}
};
const detectSourceLanguages = (sourceFiles) => {
	const languages = /* @__PURE__ */ new Set();
	for (const sourceFile of sourceFiles) {
		const lang = EXTENSION_LANGUAGES[path.extname(sourceFile).toLowerCase()];
		if (lang) languages.add(lang);
	}
	return [...languages];
};
const detectLanguages = (directory, sourceFiles) => {
	const languages = new Set(detectSourceLanguages(sourceFiles));
	for (const [file, lang] of Object.entries(LANGUAGE_SIGNALS)) if (fs.existsSync(path.join(directory, file))) languages.add(lang);
	if (readPackageJson(path.join(directory, "package.json"))) if (fs.existsSync(path.join(directory, "tsconfig.json"))) languages.add("typescript");
	else languages.add("javascript");
	for (const signal of PYTHON_SIGNALS) if (fs.existsSync(path.join(directory, signal))) {
		languages.add("python");
		break;
	}
	for (const signal of JAVA_SIGNALS) if (fs.existsSync(path.join(directory, signal))) {
		languages.add("java");
		break;
	}
	if ((() => {
		if (fs.existsSync(path.join(directory, "global.json"))) return true;
		try {
			return fs.readdirSync(directory).some((name) => name.endsWith(".csproj") || name.endsWith(".sln") || name.endsWith(".slnx"));
		} catch {
			return false;
		}
	})()) languages.add("csharp");
	if ((() => {
		if (fs.existsSync(path.join(directory, "CMakeLists.txt"))) return true;
		if (fs.existsSync(path.join(directory, "compile_commands.json"))) return true;
		try {
			return fs.readdirSync(directory).some((name) => name.endsWith(".vcxproj"));
		} catch {
			return false;
		}
	})()) languages.add("cpp");
	return [...languages];
};
const detectFrameworks = (directory) => {
	const frameworks = /* @__PURE__ */ new Set();
	const packageJson = readPackageJson(path.join(directory, "package.json"));
	if (packageJson) {
		const allDeps = {
			...packageJson.dependencies,
			...packageJson.devDependencies
		};
		for (const [pkg, fw] of Object.entries(FRAMEWORK_PACKAGES)) if (allDeps[pkg]) frameworks.add(fw);
	}
	for (const configFile of NEXT_CONFIG_FILENAMES) if (fs.existsSync(path.join(directory, configFile))) {
		frameworks.add("nextjs");
		break;
	}
	for (const configFile of ASTRO_CONFIG_FILENAMES) if (fs.existsSync(path.join(directory, configFile))) {
		frameworks.add("astro");
		break;
	}
	const requirementsPath = path.join(directory, "requirements.txt");
	const requirements = readTextFile(requirementsPath)?.toLowerCase();
	if (requirements) {
		for (const [pkg, fw] of Object.entries(PYTHON_FRAMEWORKS)) if (requirements.includes(pkg)) frameworks.add(fw);
	}
	if (frameworks.size === 0) frameworks.add("none");
	return [...frameworks];
};
//#endregion
//#region src/utils/discovery-coverage.ts
const UNSUPPORTED_CODE_EXTENSIONS = {
	".swift": "Swift",
	".kt": "Kotlin",
	".kts": "Kotlin",
	".m": "Objective-C",
	".mm": "Objective-C",
	".scala": "Scala",
	".dart": "Dart",
	".ex": "Elixir",
	".exs": "Elixir",
	".erl": "Erlang",
	".hs": "Haskell",
	".clj": "Clojure",
	".cljs": "Clojure",
	".lua": "Lua",
	".jl": "Julia",
	".zig": "Zig",
	".nim": "Nim",
	".ml": "OCaml",
	".fs": "F#",
	".sol": "Solidity",
	".groovy": "Groovy"
};
const analyzeCoverage = (rootDirectory, selection) => {
	const allFiles = selection.projectFiles ?? listProjectFiles(rootDirectory);
	const selectFiles = selection.projectFiles ? filterEnumeratedProjectFiles : filterProjectFiles;
	const supportedFiles = selectFiles(rootDirectory, allFiles, [], selection.excludePatterns, selection.includePatterns).length;
	const counts = /* @__PURE__ */ new Map();
	let unsupportedFiles = 0;
	const candidates = selectFiles(rootDirectory, allFiles, Object.keys(UNSUPPORTED_CODE_EXTENSIONS), selection.excludePatterns, selection.includePatterns);
	for (const file of candidates) {
		const language = UNSUPPORTED_CODE_EXTENSIONS[path.extname(file).toLowerCase()];
		if (!language) continue;
		unsupportedFiles++;
		counts.set(language, (counts.get(language) ?? 0) + 1);
	}
	let dominantUnsupported = null;
	let largestCount = 0;
	for (const [language, count] of counts) {
		if (count <= largestCount) continue;
		largestCount = count;
		dominantUnsupported = language;
	}
	const scoreable = !(supportedFiles === 0 || unsupportedFiles >= 10 && unsupportedFiles > supportedFiles * 3);
	return {
		supportedFiles,
		unsupportedFiles,
		dominantUnsupported,
		scoreable
	};
};
//#endregion
//#region src/utils/discovery-tools.ts
const TOOLS_TO_CHECK = [
	"oxlint",
	"biome",
	"ruff",
	"golangci-lint",
	"npm",
	"pnpm",
	"govulncheck",
	"gofmt",
	"pip-audit",
	"cargo",
	"cargo-audit",
	"clippy-driver",
	"rustfmt",
	"rubocop",
	"phpcs",
	"php-cs-fixer",
	"dotnet",
	"roslynator",
	"jb",
	"cppcheck",
	"clang-format",
	"clang-tidy"
];
const checkInstalledTools = async () => {
	const results = {};
	await Promise.all(TOOLS_TO_CHECK.map(async (tool) => {
		results[tool] = await isToolAvailable(tool);
	}));
	return results;
};
//#endregion
//#region src/utils/discover.ts
const discoverProject = async (directory, excludePatterns = [], inputs = {}) => {
	const resolvedDir = path.resolve(directory);
	resetGitIgnoreSnapshots();
	const sourceFiles = inputs.sourceFiles ?? getSourceFilesForRoot(resolvedDir);
	const coverage = analyzeCoverage(resolvedDir, {
		excludePatterns,
		includePatterns: inputs.includePatterns ?? [],
		...inputs.projectFiles ? { projectFiles: inputs.projectFiles } : {}
	});
	const installedTools = inputs.installedTools ?? await checkInstalledTools();
	return {
		rootDirectory: resolvedDir,
		projectName: readPackageJson(path.join(resolvedDir, "package.json"))?.name ?? path.basename(resolvedDir),
		languages: detectLanguages(resolvedDir, sourceFiles),
		frameworks: detectFrameworks(resolvedDir),
		sourceFileCount: sourceFiles.length,
		coverage,
		installedTools
	};
};
//#endregion
//#region src/hooks/io/scoped-scan.ts
const isWithinDirectory = (rootDirectory, candidate) => {
	const relative = path.relative(rootDirectory, candidate);
	return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};
const existingAbsolutePaths = (cwd, files) => {
	try {
		const absoluteRoot = path.resolve(cwd);
		const realRoot = fs.realpathSync(cwd);
		return files.flatMap((filePath) => {
			const absolutePath = path.resolve(cwd, filePath);
			if (!isWithinDirectory(absoluteRoot, absolutePath)) return [];
			try {
				if (!fs.statSync(absolutePath).isFile()) return [];
				const realPath = fs.realpathSync(absolutePath);
				return isWithinDirectory(realRoot, realPath) ? [absolutePath] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
};
const resolveHookFiles = (cwd, files) => {
	return existingAbsolutePaths(cwd, files);
};
const runScopedScan = async (cwd, filePaths) => {
	const rootDirectory = path.resolve(cwd);
	const config = loadConfig(rootDirectory);
	const excludePatterns = [...config.exclude, ...readAislopIgnorePatterns(rootDirectory)];
	const projectCandidates = listProjectFilesFromDisk(rootDirectory);
	const projectSourceFiles = filterEnumeratedProjectFiles(rootDirectory, projectCandidates, [], excludePatterns, config.include);
	const projectTestFiles = filterEnumeratedTestFiles(rootDirectory, projectCandidates, excludePatterns, config.include);
	const project = await discoverProject(rootDirectory, excludePatterns, {
		installedTools: {},
		projectFiles: projectCandidates,
		sourceFiles: projectSourceFiles
	});
	const configDir = findConfigDir(rootDirectory);
	const rulesPath = configDir ? path.join(configDir, RULES_FILE) : void 0;
	const enumeratedPaths = new Set(projectCandidates.map((filePath) => path.resolve(rootDirectory, filePath)));
	const scopedCandidates = filePaths.filter((filePath) => enumeratedPaths.has(path.resolve(rootDirectory, filePath)));
	const diagnostics = applyRuleSeverities((await runEngines({
		rootDirectory: project.rootDirectory,
		languages: project.languages,
		frameworks: project.frameworks,
		files: filterEnumeratedProjectFiles(project.rootDirectory, scopedCandidates, [], excludePatterns, config.include),
		testFiles: filterEnumeratedTestFiles(project.rootDirectory, scopedCandidates, excludePatterns, config.include),
		projectFiles: [.../* @__PURE__ */ new Set([...projectSourceFiles, ...filterProjectDeclarationFiles(project.rootDirectory, projectCandidates, excludePatterns, config.include)])],
		installedTools: project.installedTools,
		config: {
			quality: config.quality,
			security: {
				audit: false,
				auditTimeout: 0
			},
			lint: {
				typecheck: false,
				expoDoctor: false
			},
			allowProjectLocalTools: false,
			architectureRulesPath: config.engines.architecture ? rulesPath : void 0
		}
	}, {
		format: false,
		lint: false,
		"code-quality": config.engines["code-quality"],
		"ai-slop": config.engines["ai-slop"],
		architecture: config.engines.architecture,
		security: false
	})).flatMap((result) => result.diagnostics), config.rules);
	const { score } = calculateScore(diagnostics, config.scoring.weights, config.scoring.thresholds, projectSourceFiles.length + projectTestFiles.length, config.scoring.smoothing, config.scoring.maxPerRule);
	return {
		diagnostics,
		score,
		rootDirectory: project.rootDirectory
	};
};
//#endregion
//#region src/hooks/io/atomic-write.ts
const atomicWrite = (targetPath, content) => {
	const dir = path.dirname(targetPath);
	fs.mkdirSync(dir, { recursive: true });
	const rand = Math.random().toString(36).slice(2, 10);
	const tmp = path.join(dir, `.aislop-tmp-${process.pid}-${rand}`);
	fs.writeFileSync(tmp, content, "utf-8");
	fs.renameSync(tmp, targetPath);
};
const readIfExists = (targetPath) => {
	try {
		return fs.readFileSync(targetPath, "utf-8");
	} catch {
		return null;
	}
};
//#endregion
//#region src/hooks/quality-gate/baseline.ts
const fingerprintDiagnostic = (d, rootDirectory) => {
	return `${toPosix(path.isAbsolute(d.filePath) ? path.relative(rootDirectory, d.filePath) : d.filePath)}:${d.line}:${d.rule}`;
};
const normalizeLegacyFingerprint = (fingerprint) => fingerprint.replace(/\\/g, "/");
const hasExistingLiteralBackslashPath = (cwd, fingerprint) => {
	if (process.platform === "win32") return false;
	const fingerprintPath = fingerprint.match(/^(.*):\d+:[^:]+$/)?.[1];
	if (!fingerprintPath?.includes("\\")) return false;
	try {
		const absolutePath = path.resolve(cwd, fingerprintPath);
		const stats = fs.lstatSync(absolutePath);
		if (!stats.isFile() || stats.isSymbolicLink()) return false;
		const realRoot = fs.realpathSync(cwd);
		const realPath = fs.realpathSync(absolutePath);
		const relativePath = path.relative(realRoot, realPath);
		return !path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`);
	} catch {
		return false;
	}
};
const migrateMarkerlessFingerprint = (cwd, fingerprint) => hasExistingLiteralBackslashPath(cwd, fingerprint) ? fingerprint : normalizeLegacyFingerprint(fingerprint);
const BASELINE_REL = path.join(".aislop", "baseline.json");
const baselinePath = (cwd) => path.join(cwd, BASELINE_REL);
const readBaseline = (cwd) => {
	const raw = readIfExists(baselinePath(cwd));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.schema !== "aislop.baseline.v2" && parsed.schema !== "aislop.baseline.v1") return null;
		const findingFingerprints = parsed.findingFingerprints ?? [];
		const needsWindowsMigration = parsed.pathFormat !== "posix";
		return {
			schema: "aislop.baseline.v2",
			pathFormat: "posix",
			updatedAt: parsed.updatedAt ?? "",
			score: parsed.score ?? 0,
			byEngine: parsed.byEngine ?? {},
			fileCount: parsed.fileCount ?? 0,
			commit: parsed.commit,
			findingFingerprints: needsWindowsMigration ? findingFingerprints.map((fingerprint) => migrateMarkerlessFingerprint(cwd, fingerprint)) : findingFingerprints
		};
	} catch {
		return null;
	}
};
const writeBaseline = (cwd, baseline) => {
	const target = baselinePath(cwd);
	atomicWrite(target, `${JSON.stringify({
		...baseline,
		pathFormat: "posix"
	}, null, 2)}\n`);
	return target;
};
const captureBaseline = async (cwd) => {
	const project = await discoverProject(cwd);
	const config = loadConfig(cwd);
	const results = await runEngines({
		rootDirectory: project.rootDirectory,
		languages: project.languages,
		frameworks: project.frameworks,
		files: [],
		installedTools: project.installedTools,
		config: {
			quality: config.quality,
			security: {
				audit: false,
				auditTimeout: 0
			},
			lint: {
				typecheck: false,
				expoDoctor: false
			},
			allowProjectLocalTools: false
		}
	}, {
		format: false,
		lint: false,
		"code-quality": config.engines["code-quality"],
		"ai-slop": config.engines["ai-slop"],
		architecture: config.engines.architecture,
		security: false
	});
	const diagnostics = results.flatMap((r) => r.diagnostics);
	const { score } = calculateScore(diagnostics, config.scoring.weights, config.scoring.thresholds, project.sourceFileCount, config.scoring.smoothing, config.scoring.maxPerRule);
	const byEngine = {};
	for (const r of results) {
		const { score: engineScore } = calculateScore(diagnostics.filter((d) => r.diagnostics.includes(d)), config.scoring.weights, config.scoring.thresholds, project.sourceFileCount, config.scoring.smoothing, config.scoring.maxPerRule);
		byEngine[r.engine] = engineScore;
	}
	const findingFingerprints = diagnostics.filter((d) => d.severity === "error" || d.severity === "warning").map((d) => fingerprintDiagnostic(d, project.rootDirectory));
	const baseline = {
		schema: "aislop.baseline.v2",
		pathFormat: "posix",
		updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		score,
		byEngine,
		fileCount: project.sourceFileCount,
		findingFingerprints
	};
	const target = writeBaseline(cwd, baseline);
	return {
		score,
		fileCount: project.sourceFileCount,
		path: target
	};
};
const appendSessionFiles = (cwd, files) => {
	if (files.length === 0) return;
	const target = path.join(cwd, ".aislop", "session.jsonl");
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const line = `${JSON.stringify({
			ts: Date.now(),
			files
		})}\n`;
		fs.appendFileSync(target, line);
	} catch {}
};
const readSessionFiles = (cwd) => {
	const raw = readIfExists(path.join(cwd, ".aislop", "session.jsonl"));
	if (!raw) return [];
	const files = /* @__PURE__ */ new Set();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			for (const f of entry.files ?? []) files.add(f);
		} catch {}
	}
	return Array.from(files);
};
const clearSessionFiles = (cwd) => {
	const target = path.join(cwd, ".aislop", "session.jsonl");
	try {
		fs.unlinkSync(target);
	} catch {}
};
//#endregion
//#region src/hooks/adapters/claude.ts
const extractFiles$2 = (stdin) => {
	const files = /* @__PURE__ */ new Set();
	const input = stdin.tool_input ?? {};
	if (typeof input.file_path === "string" && input.file_path.length > 0) files.add(input.file_path);
	if (Array.isArray(input.edits)) {
		for (const e of input.edits) if (e && typeof e.file_path === "string" && e.file_path.length > 0) files.add(e.file_path);
	}
	return Array.from(files);
};
const parseClaudeStdin = (raw) => {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
};
const readStdin$3 = async () => {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
};
const renderClaudeOutput = (additional, block) => {
	const out = { hookSpecificOutput: {
		hookEventName: "PostToolUse",
		additionalContext: additional
	} };
	if (block) {
		out.decision = "block";
		out.reason = block.reason;
	}
	return out;
};
const runClaudeHook = async (deps = {}) => {
	const getStdin = deps.stdin ?? readStdin$3;
	const write = deps.write ?? ((s) => process.stdout.write(s));
	const raw = await getStdin();
	const input = parseClaudeStdin(raw);
	const cwd = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
	const files = resolveHookFiles(cwd, extractFiles$2(input));
	if (files.length === 0) return 0;
	const release = acquireHookLock(cwd);
	if (!release) return 0;
	try {
		const { diagnostics, score, rootDirectory } = await runScopedScan(cwd, files);
		const baseline = readBaseline(cwd);
		appendSessionFiles(cwd, files);
		const feedback = buildFeedback(diagnostics, score, rootDirectory, baseline ? {
			score: baseline.score,
			findingFingerprints: baseline.findingFingerprints
		} : void 0, {
			agent: "claude",
			touchedFiles: files
		});
		track({
			event: "hook_scan_completed",
			properties: buildHookScanCompletedProps({
				agent: "claude",
				score,
				scoreDelta: baseline ? score - baseline.score : null,
				findingCount: diagnostics.length,
				fileCount: files.length
			})
		});
		const envelope = renderClaudeOutput(JSON.stringify(feedback));
		write(JSON.stringify(envelope));
		return 0;
	} catch {
		return 0;
	} finally {
		release();
	}
};
const parseClaudeFileChangedStdin = (raw) => {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
};
const runClaudeFileChangedHook = async (deps = {}) => {
	const getStdin = deps.stdin ?? readStdin$3;
	const write = deps.write ?? ((s) => process.stdout.write(s));
	const raw = await getStdin();
	const input = parseClaudeFileChangedStdin(raw);
	const cwd = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
	const release = acquireHookLock(cwd);
	if (!release) return 0;
	try {
		const result = await captureBaseline(cwd);
		const changed = input.file_path ? path.relative(cwd, input.file_path) || input.file_path : "<unknown>";
		const additional = JSON.stringify({
			schema: "aislop.hook.v2",
			event: "file_changed",
			file: changed,
			message: `Watched file changed (${changed}). aislop refreshed the baseline — score: ${result.score}.`,
			baseline: {
				score: result.score,
				fileCount: result.fileCount
			}
		});
		const envelope = renderClaudeOutput(additional);
		write(JSON.stringify(envelope));
		return 0;
	} catch {
		return 0;
	} finally {
		release();
	}
};
const parseClaudeStopStdin = (raw) => {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
};
const runClaudeStopHook = async (deps = {}) => {
	const getStdin = deps.stdin ?? readStdin$3;
	const write = deps.write ?? ((s) => process.stdout.write(s));
	const raw = await getStdin();
	const input = parseClaudeStopStdin(raw);
	const cwd = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
	if (input.stop_hook_active) return 0;
	const baseline = readBaseline(cwd);
	if (!baseline) return 0;
	const sessionFiles = readSessionFiles(cwd);
	if (sessionFiles.length === 0) return 0;
	const release = acquireHookLock(cwd);
	if (!release) return 0;
	try {
		const { diagnostics, score, rootDirectory } = await runScopedScan(cwd, sessionFiles);
		const feedback = buildFeedback(diagnostics, score, rootDirectory, {
			score: baseline.score,
			findingFingerprints: baseline.findingFingerprints
		}, {
			agent: "claude",
			touchedFiles: sessionFiles
		});
		if (!feedback.regressed) {
			clearSessionFiles(cwd);
			return 0;
		}
		const envelope = renderClaudeOutput(JSON.stringify(feedback), { reason: `aislop: score dropped from ${baseline.score} to ${score}. Fix the ${feedback.counts.total} finding${feedback.counts.total === 1 ? "" : "s"} before finishing.` });
		write(JSON.stringify(envelope));
		return 0;
	} catch {
		return 0;
	} finally {
		release();
	}
};
//#endregion
//#region src/hooks/adapters/cursor.ts
const extractFiles$1 = (stdin) => {
	const files = /* @__PURE__ */ new Set();
	if (typeof stdin.file_path === "string" && stdin.file_path.length > 0) files.add(stdin.file_path);
	if (Array.isArray(stdin.edits)) {
		for (const e of stdin.edits) if (e && typeof e.file_path === "string" && e.file_path.length > 0) files.add(e.file_path);
	}
	const input = stdin.tool_input ?? {};
	if (typeof input.file_path === "string" && input.file_path.length > 0) files.add(input.file_path);
	if (Array.isArray(input.edits)) {
		for (const e of input.edits) if (e && typeof e.file_path === "string" && e.file_path.length > 0) files.add(e.file_path);
	}
	return Array.from(files);
};
const parseCursorStdin = (raw) => {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
};
const renderCursorOutput = (additional, event = "afterFileEdit") => ({ hookSpecificOutput: {
	hookEventName: event,
	additionalContext: additional
} });
const readStdin$2 = async () => {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
};
const runCursorHook = async (deps = {}) => {
	const getStdin = deps.stdin ?? readStdin$2;
	const write = deps.write ?? ((s) => process.stdout.write(s));
	const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s));
	const raw = await getStdin();
	const input = parseCursorStdin(raw);
	const cwd = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
	const files = resolveHookFiles(cwd, extractFiles$1(input));
	if (files.length === 0) return 0;
	const release = acquireHookLock(cwd);
	if (!release) return 0;
	try {
		const { diagnostics, score, rootDirectory } = await runScopedScan(cwd, files);
		const feedback = buildFeedback(diagnostics, score, rootDirectory, void 0, {
			agent: "cursor",
			touchedFiles: files
		});
		track({
			event: "hook_scan_completed",
			properties: buildHookScanCompletedProps({
				agent: "cursor",
				score,
				findingCount: diagnostics.length,
				fileCount: files.length
			})
		});
		const serialized = JSON.stringify(feedback);
		write(JSON.stringify(renderCursorOutput(serialized)));
		writeErr(`${serialized}\n`);
		return 0;
	} catch {
		return 0;
	} finally {
		release();
	}
};
//#endregion
//#region src/hooks/adapters/gemini.ts
const extractFiles = (stdin) => {
	const files = /* @__PURE__ */ new Set();
	const input = stdin.tool_input ?? {};
	if (typeof input.file_path === "string" && input.file_path.length > 0) files.add(input.file_path);
	if (typeof input.path === "string" && input.path.length > 0) files.add(input.path);
	return Array.from(files);
};
const parseGeminiStdin = (raw) => {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
};
const renderGeminiOutput = (additional) => ({ hookSpecificOutput: {
	hookEventName: "AfterTool",
	additionalContext: additional
} });
const readStdin$1 = async () => {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
};
const runGeminiHook = async (deps = {}) => {
	const getStdin = deps.stdin ?? readStdin$1;
	const write = deps.write ?? ((s) => process.stdout.write(s));
	const raw = await getStdin();
	const input = parseGeminiStdin(raw);
	const cwd = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
	const files = resolveHookFiles(cwd, extractFiles(input));
	if (files.length === 0) return 0;
	const release = acquireHookLock(cwd);
	if (!release) return 0;
	try {
		const { diagnostics, score, rootDirectory } = await runScopedScan(cwd, files);
		const feedback = buildFeedback(diagnostics, score, rootDirectory, void 0, {
			agent: "gemini",
			touchedFiles: files
		});
		track({
			event: "hook_scan_completed",
			properties: buildHookScanCompletedProps({
				agent: "gemini",
				score,
				findingCount: diagnostics.length,
				fileCount: files.length
			})
		});
		write(JSON.stringify(renderGeminiOutput(JSON.stringify(feedback))));
		return 0;
	} catch {
		return 0;
	} finally {
		release();
	}
};
//#endregion
//#region src/hooks/adapters/pi.ts
const parsePiStdin = (raw) => {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
};
const readStdin = async () => {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
};
const formatPiMessage = (feedback) => {
	if (feedback.counts.total === 0 && !feedback.regressed) return "";
	const { error, warning } = feedback.counts;
	const header = `aislop: score ${feedback.score}/100${feedback.baseline != null ? ` (baseline ${feedback.baseline})` : ""}, ${error} error${error === 1 ? "" : "s"}, ${warning} warning${warning === 1 ? "" : "s"}.`;
	const lines = feedback.findings.map((f) => `  - ${f.file}:${f.line} [${f.severity}] ${f.ruleId}: ${f.message}`);
	if (feedback.elided && feedback.elided > 0) lines.push(`  ...and ${feedback.elided} more.`);
	const tail = feedback.nextSteps.length > 0 ? `\n${feedback.nextSteps.join("\n")}` : "";
	return `${header}\n${lines.join("\n")}${tail}`;
};
const runPiHook = async (deps = {}) => {
	const getStdin = deps.stdin ?? readStdin;
	const write = deps.write ?? ((s) => process.stdout.write(s));
	const raw = await getStdin();
	const input = parsePiStdin(raw);
	const cwd = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
	const files = resolveHookFiles(cwd, input.file_path ? [input.file_path] : []);
	if (files.length === 0) return 0;
	const release = acquireHookLock(cwd);
	if (!release) return 0;
	try {
		const { diagnostics, score, rootDirectory } = await runScopedScan(cwd, files);
		const baseline = readBaseline(cwd);
		appendSessionFiles(cwd, files);
		const feedback = buildFeedback(diagnostics, score, rootDirectory, baseline ? {
			score: baseline.score,
			findingFingerprints: baseline.findingFingerprints
		} : void 0, {
			agent: "pi",
			touchedFiles: files
		});
		track({
			event: "hook_scan_completed",
			properties: buildHookScanCompletedProps({
				agent: "pi",
				score,
				scoreDelta: baseline ? score - baseline.score : null,
				findingCount: diagnostics.length,
				fileCount: files.length
			})
		});
		const output = {
			schema: "aislop.hook.v2",
			block: feedback.counts.error > 0 || feedback.regressed,
			message: formatPiMessage(feedback),
			feedback
		};
		write(JSON.stringify(output));
		return 0;
	} catch {
		return 0;
	} finally {
		release();
	}
};
//#endregion
//#region src/hooks/assets.ts
const AISLOP_MD_BODY = `# aislop — agent instructions

[aislop](https://github.com/scanaislop/aislop) is your guardrail for shipping clean, maintainable, production-grade code. It catches the patterns AI coding tools leave behind: dead imports, redundant code, duplicate logic, unsafe any-typed casts, narrative comments, swallowed errors, hidden fallbacks, oversized functions, risky security constructs — and grades the project out of 100 so regressions are visible. Treat its findings as blocking, not advisory: the goal is code a human maintainer would happily inherit.

## On every edit

A PostToolUse hook runs \`aislop hook claude\` after every Edit, Write, or MultiEdit. It scans the touched files and returns findings as JSON \`additionalContext\` shaped like \`AislopFeedback\` (schema \`aislop.hook.v2\` — score, baseline, delta, regressed, counts, findings, newSinceBaseline, suggestedActions). Act on them the same turn; the \`suggestedActions\` field tells you exactly what to run next.

## Severity ladder

- \`error\` — MUST fix this turn.
- \`warning\` + \`fixable: true\` — MUST fix this turn.
- \`warning\` + \`fixable: false\` — fix if trivially mechanical, otherwise surface in your reply.

## Rules

- \`.aislop/config.yaml\` — thresholds and engine toggles. Treat as authoritative; don't edit without user consent.
- \`.aislop/rules.yaml\` — project-specific architecture rules (may be absent). When a finding cites \`architecture/*\`, open this file and follow it.
- Custom rules can change between sessions. Trust what the scan returns, not a cached understanding of what the rules are.

## Principles

- Do not disable rules to pass the scan. Fix the underlying issue.
- If a finding is a false positive, leave it and explain in your reply — do not delete the rule config.
- The findings payload includes \`nextSteps[]\` — treat those as your plan for the turn.
`;
//#endregion
//#region src/hooks/io/sentinel.ts
const sentinelHash = (content) => `sha256:${crypto.createHash("sha256").update(content).digest("hex").slice(0, 32)}`;
const BEGIN_RE = /<!--\s*aislop:begin\s+v(\d+)(?:\s+hash=([^\s>]+))?\s*-->/;
const END_RE = /<!--\s*aislop:end\s+v\d+\s*-->/;
const renderFence = (body, hash) => [
	`<!-- aislop:begin v1 hash=${hash} -->`,
	body.trimEnd(),
	"<!-- aislop:end v1 -->"
].join("\n");
const upsertMarkdownFence = (existing, body, hash) => {
	const fenced = renderFence(body, hash);
	if (existing == null || existing.length === 0) return {
		nextContent: `${fenced}\n`,
		replaced: false
	};
	const begin = existing.match(BEGIN_RE);
	const end = existing.match(END_RE);
	if (begin && end && (end.index ?? 0) > (begin.index ?? 0)) return {
		nextContent: `${existing.slice(0, begin.index)}${fenced}${existing.slice((end.index ?? 0) + end[0].length)}`,
		replaced: true
	};
	return {
		nextContent: `${existing}${existing.endsWith("\n") ? "" : "\n"}\n${fenced}\n`,
		replaced: false
	};
};
//#endregion
//#region src/hooks/install/types.ts
const emptyResult = () => ({
	wrote: [],
	skipped: [],
	planned: []
});
const applyContent = (result, opts, target, nextContent, summary) => {
	if (readIfExists(target) === nextContent) {
		result.skipped.push(target);
		return;
	}
	if (opts.dryRun) {
		result.planned.push({
			path: target,
			summary
		});
		return;
	}
	atomicWrite(target, nextContent);
	result.wrote.push(target);
};
const applyRemoval = (result, opts, target, nextContent) => {
	const existing = readIfExists(target);
	if (existing == null) {
		result.skipped.push(target);
		return;
	}
	if (existing === (nextContent ?? "")) {
		result.skipped.push(target);
		return;
	}
	if (opts.dryRun) {
		result.removed.push(target);
		return;
	}
	if (nextContent == null) try {
		fs.unlinkSync(target);
	} catch {}
	else atomicWrite(target, nextContent);
	result.removed.push(target);
};
//#endregion
//#region src/hooks/install/rules-only.ts
const installRulesOnly = (opts, paths, summary) => {
	const result = emptyResult();
	const next = upsertMarkdownFence(readIfExists(paths.rules), AISLOP_MD_BODY, sentinelHash(AISLOP_MD_BODY)).nextContent;
	applyContent(result, opts, paths.rules, next, summary);
	if (paths.host && paths.marker) {
		const host = readIfExists(paths.host) ?? "";
		if (!host.includes(paths.marker)) {
			const joiner = host.endsWith("\n") || host.length === 0 ? "" : "\n";
			const prefix = host.length === 0 ? "" : `${host}${joiner}\n`;
			applyContent(result, opts, paths.host, `${prefix}${paths.marker}\n`, `append ${paths.marker} reference`);
		} else result.skipped.push(paths.host);
	}
	return result;
};
const uninstallRulesOnly = (opts, paths) => {
	const result = {
		removed: [],
		skipped: []
	};
	if (readIfExists(paths.rules) != null) applyRemoval(result, opts, paths.rules, null);
	else result.skipped.push(paths.rules);
	if (paths.host && paths.marker) {
		const host = readIfExists(paths.host);
		if (host?.includes(paths.marker)) {
			const stripped = host.split("\n").filter((l) => l.trim() !== paths.marker).join("\n").replace(/\n{3,}/g, "\n\n").trim();
			applyRemoval(result, opts, paths.host, stripped.length === 0 ? null : `${stripped}\n`);
		} else result.skipped.push(paths.host);
	}
	return result;
};
//#endregion
//#region src/hooks/install/antigravity.ts
const resolveAntigravityPaths = (opts) => ({ rules: path.join(opts.cwd, ".agents", "rules", "antigravity-aislop-rules.md") });
const installAntigravity = (opts) => {
	if (opts.scope !== "project") return {
		wrote: [],
		skipped: [],
		planned: [{
			path: ".agents/rules/antigravity-aislop-rules.md",
			summary: "Antigravity is project-scope only; pass --project"
		}]
	};
	return installRulesOnly(opts, resolveAntigravityPaths(opts), "write .agents/rules/antigravity-aislop-rules.md");
};
const uninstallAntigravity = (opts) => {
	if (opts.scope !== "project") return {
		removed: [],
		skipped: []
	};
	return uninstallRulesOnly(opts, resolveAntigravityPaths(opts));
};
//#endregion
//#region src/hooks/io/json-patch.ts
const AISLOP_SENTINEL_KEY = "__aislop";
const isAislopManaged = (x) => typeof x === "object" && x !== null && "__aislop" in x && x["__aislop"] != null;
const groupIsAislop = (group) => {
	if (typeof group !== "object" || group === null) return false;
	const hooks = group.hooks;
	if (!Array.isArray(hooks)) return false;
	return hooks.some((h) => isAislopManaged(h));
};
const upsertHookGroup = (config, event, group) => {
	const next = { ...config };
	const hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
	const cleaned = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((g) => !groupIsAislop(g));
	next.hooks = {
		...hooks,
		[event]: [...cleaned, group]
	};
	return next;
};
const upsertFlatHook = (config, event, entry) => {
	const next = { ...config };
	const hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
	const cleaned = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isAislopManaged(e));
	next.hooks = {
		...hooks,
		[event]: [...cleaned, entry]
	};
	return next;
};
const removeAislopEntries = (config, event) => {
	const next = { ...config };
	const hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
	const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
	const cleaned = existing.filter((e) => !isAislopManaged(e) && !groupIsAislop(e));
	const removed = existing.length - cleaned.length;
	const nextHooks = { ...hooks };
	if (cleaned.length === 0) delete nextHooks[event];
	else nextHooks[event] = cleaned;
	if (Object.keys(nextHooks).length === 0) delete next.hooks;
	else next.hooks = nextHooks;
	return {
		next,
		removed
	};
};
//#endregion
//#region src/hooks/install/claude.ts
const resolveClaudePaths = (opts) => {
	const root = opts.scope === "project" ? path.join(opts.cwd, ".claude") : path.join(opts.home, ".claude");
	return {
		settings: path.join(root, "settings.json"),
		aislopMd: path.join(root, "AISLOP.md"),
		claudeMd: path.join(root, "CLAUDE.md")
	};
};
const buildHookGroup$1 = () => {
	const hashBody = JSON.stringify({
		command: "aislop hook claude",
		matcher: "Edit|Write|MultiEdit"
	});
	return {
		matcher: "Edit|Write|MultiEdit",
		hooks: [{
			type: "command",
			command: "aislop hook claude",
			[AISLOP_SENTINEL_KEY]: {
				v: 1,
				managed: true,
				hash: sentinelHash(hashBody)
			}
		}]
	};
};
const buildStopHookGroup = () => {
	const hashBody = JSON.stringify({ command: "aislop hook claude --stop" });
	return {
		matcher: "",
		hooks: [{
			type: "command",
			command: "aislop hook claude --stop",
			[AISLOP_SENTINEL_KEY]: {
				v: 1,
				managed: true,
				hash: sentinelHash(hashBody)
			}
		}]
	};
};
const FILE_CHANGED_MATCHER = ".aislop/config.yml|.aislop/rules.yml|package.json";
const buildFileChangedHookGroup = () => {
	const hashBody = JSON.stringify({
		command: "aislop hook claude --on-file-changed",
		matcher: FILE_CHANGED_MATCHER
	});
	return {
		matcher: FILE_CHANGED_MATCHER,
		hooks: [{
			type: "command",
			command: "aislop hook claude --on-file-changed",
			[AISLOP_SENTINEL_KEY]: {
				v: 1,
				managed: true,
				hash: sentinelHash(hashBody)
			}
		}]
	};
};
const renderSettings$1 = (existingRaw, qualityGate) => {
	let obj = {};
	if (existingRaw) try {
		obj = JSON.parse(existingRaw);
	} catch {
		obj = {};
	}
	let next = upsertHookGroup(obj, "PostToolUse", buildHookGroup$1());
	next = upsertHookGroup(next, "FileChanged", buildFileChangedHookGroup());
	if (qualityGate) next = upsertHookGroup(next, "Stop", buildStopHookGroup());
	else next = removeAislopEntries(next, "Stop").next;
	return `${JSON.stringify(next, null, 2)}\n`;
};
const installClaude = (opts) => {
	const paths = resolveClaudePaths(opts);
	const result = emptyResult();
	const nextSettings = renderSettings$1(readIfExists(paths.settings), Boolean(opts.qualityGate));
	applyContent(result, opts, paths.settings, nextSettings, "register PostToolUse + FileChanged hooks");
	const mdHash = sentinelHash(AISLOP_MD_BODY);
	const fenced = upsertMarkdownFence(readIfExists(paths.aislopMd), AISLOP_MD_BODY, mdHash);
	applyContent(result, opts, paths.aislopMd, fenced.nextContent, "write AISLOP.md rules");
	const existingClaudeMd = readIfExists(paths.claudeMd) ?? "";
	const marker = "@AISLOP.md";
	if (!existingClaudeMd.includes(marker)) {
		const joiner = existingClaudeMd.endsWith("\n") || existingClaudeMd.length === 0 ? "" : "\n";
		const prefix = existingClaudeMd.length === 0 ? "" : `${existingClaudeMd}${joiner}\n`;
		applyContent(result, opts, paths.claudeMd, `${prefix}${marker}\n`, "append @AISLOP.md reference");
	} else result.skipped.push(paths.claudeMd);
	return result;
};
const uninstallClaude = (opts) => {
	const paths = resolveClaudePaths({
		...opts,
		qualityGate: false
	});
	const result = {
		removed: [],
		skipped: []
	};
	const settingsRaw = readIfExists(paths.settings);
	if (settingsRaw) {
		let obj = {};
		try {
			obj = JSON.parse(settingsRaw);
		} catch {
			obj = {};
		}
		const afterPostToolUse = removeAislopEntries(obj, "PostToolUse").next;
		const afterFileChanged = removeAislopEntries(afterPostToolUse, "FileChanged").next;
		const stripped = removeAislopEntries(afterFileChanged, "Stop").next;
		const stillHasHooks = stripped.hooks && typeof stripped.hooks === "object" && Object.keys(stripped.hooks).length > 0;
		const otherKeys = Object.keys(stripped).filter((k) => k !== "hooks");
		if (!stillHasHooks && otherKeys.length === 0) applyRemoval(result, opts, paths.settings, null);
		else applyRemoval(result, opts, paths.settings, `${JSON.stringify(stripped, null, 2)}\n`);
	} else result.skipped.push(paths.settings);
	if (readIfExists(paths.aislopMd) != null) applyRemoval(result, opts, paths.aislopMd, null);
	else result.skipped.push(paths.aislopMd);
	const claudeMd = readIfExists(paths.claudeMd);
	if (claudeMd?.includes("@AISLOP.md")) {
		const stripped = claudeMd.split("\n").filter((line) => line.trim() !== "@AISLOP.md").join("\n").replace(/\n{3,}/g, "\n\n").trim();
		applyRemoval(result, opts, paths.claudeMd, stripped.length === 0 ? null : `${stripped}\n`);
	} else result.skipped.push(paths.claudeMd);
	return result;
};
//#endregion
//#region src/hooks/install/cline.ts
const resolveClinePaths = (opts) => ({ rules: path.join(opts.cwd, ".clinerules") });
const resolveRooPaths = (opts) => ({ rules: path.join(opts.cwd, ".roo", "rules", "aislop.md") });
const installCline = (opts) => {
	if (opts.scope !== "project") return {
		wrote: [],
		skipped: [],
		planned: [{
			path: ".clinerules",
			summary: "Cline is project-scope only; pass --project"
		}]
	};
	const cline = installRulesOnly(opts, resolveClinePaths(opts), "write .clinerules");
	const roo = installRulesOnly(opts, resolveRooPaths(opts), "write .roo/rules/aislop.md");
	return {
		wrote: [...cline.wrote, ...roo.wrote],
		skipped: [...cline.skipped, ...roo.skipped],
		planned: [...cline.planned, ...roo.planned]
	};
};
const uninstallCline = (opts) => {
	if (opts.scope !== "project") return {
		removed: [],
		skipped: []
	};
	const a = uninstallRulesOnly(opts, resolveClinePaths(opts));
	const b = uninstallRulesOnly(opts, resolveRooPaths(opts));
	return {
		removed: [...a.removed, ...b.removed],
		skipped: [...a.skipped, ...b.skipped]
	};
};
//#endregion
//#region src/hooks/install/codex.ts
const resolveCodexPaths = (opts) => ({ rules: opts.scope === "project" ? path.join(opts.cwd, "AGENTS.md") : path.join(opts.home, ".codex", "AGENTS.md") });
const installCodex = (opts) => installRulesOnly(opts, resolveCodexPaths(opts), "write AGENTS.md rules for Codex");
const uninstallCodex = (opts) => uninstallRulesOnly(opts, resolveCodexPaths(opts));
//#endregion
//#region src/hooks/install/copilot.ts
const resolveCopilotPaths = (opts) => ({ rules: path.join(opts.cwd, ".github", "copilot-instructions.md") });
const installCopilot = (opts) => {
	if (opts.scope !== "project") return {
		wrote: [],
		skipped: [],
		planned: [{
			path: ".github/copilot-instructions.md",
			summary: "Copilot is project-scope only; pass --project"
		}]
	};
	return installRulesOnly(opts, resolveCopilotPaths(opts), "write .github/copilot-instructions.md");
};
const uninstallCopilot = (opts) => {
	if (opts.scope !== "project") return {
		removed: [],
		skipped: []
	};
	return uninstallRulesOnly(opts, resolveCopilotPaths(opts));
};
//#endregion
//#region src/hooks/install/cursor.ts
const resolveCursorPaths = (opts) => {
	const root = opts.scope === "project" ? path.join(opts.cwd, ".cursor") : path.join(opts.home, ".cursor");
	return {
		hooks: path.join(root, "hooks.json"),
		rules: path.join(opts.cwd, ".cursor", "rules", "aislop.mdc")
	};
};
const buildHookEntry = () => {
	const hashBody = JSON.stringify({
		command: "aislop hook cursor",
		timeout: 5e3
	});
	return {
		command: "aislop hook cursor",
		type: "command",
		timeout: 5e3,
		[AISLOP_SENTINEL_KEY]: {
			v: 1,
			managed: true,
			hash: sentinelHash(hashBody)
		}
	};
};
const renderHooksJson = (existingRaw) => {
	let obj = { version: 1 };
	if (existingRaw) try {
		obj = JSON.parse(existingRaw);
	} catch {
		obj = { version: 1 };
	}
	if (typeof obj.version !== "number") obj.version = 1;
	const next = upsertFlatHook(obj, "afterFileEdit", buildHookEntry());
	return `${JSON.stringify(next, null, 2)}\n`;
};
const installCursor = (opts) => {
	const paths = resolveCursorPaths(opts);
	const result = emptyResult();
	const nextHooks = renderHooksJson(readIfExists(paths.hooks));
	applyContent(result, opts, paths.hooks, nextHooks, "register afterFileEdit hook");
	if (opts.scope === "project") {
		const rules = upsertMarkdownFence(readIfExists(paths.rules), AISLOP_MD_BODY, sentinelHash(AISLOP_MD_BODY)).nextContent;
		applyContent(result, opts, paths.rules, rules, "write .cursor/rules/aislop.mdc");
	}
	return result;
};
const uninstallCursor = (opts) => {
	const paths = resolveCursorPaths(opts);
	const result = {
		removed: [],
		skipped: []
	};
	const raw = readIfExists(paths.hooks);
	if (raw) {
		let obj = {};
		try {
			obj = JSON.parse(raw);
		} catch {
			obj = {};
		}
		const stripped = removeAislopEntries(obj, "afterFileEdit").next;
		const stillHasHooks = stripped.hooks && typeof stripped.hooks === "object" && Object.keys(stripped.hooks).length > 0;
		const otherKeys = Object.keys(stripped).filter((k) => k !== "hooks" && k !== "version");
		if (!stillHasHooks && otherKeys.length === 0) applyRemoval(result, opts, paths.hooks, null);
		else applyRemoval(result, opts, paths.hooks, `${JSON.stringify(stripped, null, 2)}\n`);
	} else result.skipped.push(paths.hooks);
	if (opts.scope === "project") applyRemoval(result, opts, paths.rules, null);
	return result;
};
//#endregion
//#region src/hooks/install/gemini.ts
const resolveGeminiPaths = (opts) => {
	const root = opts.scope === "project" ? path.join(opts.cwd, ".gemini") : path.join(opts.home, ".gemini");
	return {
		settings: path.join(root, "settings.json"),
		aislopMd: path.join(root, "AISLOP.md"),
		geminiMd: path.join(root, "GEMINI.md")
	};
};
const buildHookGroup = () => {
	const hashBody = JSON.stringify({
		command: "aislop hook gemini",
		matcher: "write_file|replace"
	});
	return {
		matcher: "write_file|replace",
		hooks: [{
			name: "aislop",
			type: "command",
			command: "aislop hook gemini",
			timeout: 5e3,
			[AISLOP_SENTINEL_KEY]: {
				v: 1,
				managed: true,
				hash: sentinelHash(hashBody)
			}
		}]
	};
};
const renderSettings = (existingRaw) => {
	let obj = {};
	if (existingRaw) try {
		obj = JSON.parse(existingRaw);
	} catch {
		obj = {};
	}
	const next = upsertHookGroup(obj, "AfterTool", buildHookGroup());
	return `${JSON.stringify(next, null, 2)}\n`;
};
const installGemini = (opts) => {
	const paths = resolveGeminiPaths(opts);
	const result = emptyResult();
	const next = renderSettings(readIfExists(paths.settings));
	applyContent(result, opts, paths.settings, next, "register AfterTool hook");
	const fenced = upsertMarkdownFence(readIfExists(paths.aislopMd), AISLOP_MD_BODY, sentinelHash(AISLOP_MD_BODY)).nextContent;
	applyContent(result, opts, paths.aislopMd, fenced, "write AISLOP.md rules");
	const existingGeminiMd = readIfExists(paths.geminiMd) ?? "";
	const marker = "@AISLOP.md";
	if (!existingGeminiMd.includes(marker)) {
		const joiner = existingGeminiMd.endsWith("\n") || existingGeminiMd.length === 0 ? "" : "\n";
		const prefix = existingGeminiMd.length === 0 ? "" : `${existingGeminiMd}${joiner}\n`;
		applyContent(result, opts, paths.geminiMd, `${prefix}${marker}\n`, "append @AISLOP.md reference");
	} else result.skipped.push(paths.geminiMd);
	return result;
};
const uninstallGemini = (opts) => {
	const paths = resolveGeminiPaths(opts);
	const result = {
		removed: [],
		skipped: []
	};
	const raw = readIfExists(paths.settings);
	if (raw) {
		let obj = {};
		try {
			obj = JSON.parse(raw);
		} catch {
			obj = {};
		}
		const stripped = removeAislopEntries(obj, "AfterTool").next;
		const stillHasHooks = stripped.hooks && typeof stripped.hooks === "object" && Object.keys(stripped.hooks).length > 0;
		const otherKeys = Object.keys(stripped).filter((k) => k !== "hooks");
		if (!stillHasHooks && otherKeys.length === 0) applyRemoval(result, opts, paths.settings, null);
		else applyRemoval(result, opts, paths.settings, `${JSON.stringify(stripped, null, 2)}\n`);
	} else result.skipped.push(paths.settings);
	if (readIfExists(paths.aislopMd) != null) applyRemoval(result, opts, paths.aislopMd, null);
	else result.skipped.push(paths.aislopMd);
	const geminiMd = readIfExists(paths.geminiMd);
	if (geminiMd?.includes("@AISLOP.md")) {
		const stripped = geminiMd.split("\n").filter((l) => l.trim() !== "@AISLOP.md").join("\n").replace(/\n{3,}/g, "\n\n").trim();
		applyRemoval(result, opts, paths.geminiMd, stripped.length === 0 ? null : `${stripped}\n`);
	} else result.skipped.push(paths.geminiMd);
	return result;
};
//#endregion
//#region src/hooks/install/kilocode.ts
const resolveKilocodePaths = (opts) => ({ rules: path.join(opts.cwd, ".kilocode", "rules", "aislop-rules.md") });
const installKilocode = (opts) => {
	if (opts.scope !== "project") return {
		wrote: [],
		skipped: [],
		planned: [{
			path: ".kilocode/rules/aislop-rules.md",
			summary: "Kilo Code is project-scope only; pass --project"
		}]
	};
	return installRulesOnly(opts, resolveKilocodePaths(opts), "write .kilocode/rules/aislop-rules.md");
};
const uninstallKilocode = (opts) => {
	if (opts.scope !== "project") return {
		removed: [],
		skipped: []
	};
	return uninstallRulesOnly(opts, resolveKilocodePaths(opts));
};
//#endregion
//#region src/hooks/install/pi.ts
const resolvePiPaths = (opts) => {
	return { extension: opts.scope === "project" ? path.join(opts.cwd, ".pi", "extensions", "aislop.js") : path.join(opts.home, ".pi", "agent", "extensions", "aislop.js") };
};
const PI_EXTENSION_SOURCE = `// aislop — auto-generated pi extension. Do not edit by hand.
// Reinstall with: aislop hook install --pi
import { spawn } from "node:child_process";

// Runs the CLI async so a slow scan never blocks pi's event loop, and forwards
// ctx.signal so Esc actually kills the child instead of it running to completion.
const runHook = (bin, args, input, signal) =>
	new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
		const chunks = [];
		let settled = false;
		let timer;
		const onAbort = () => {
			child.kill();
			finish(null);
		};
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (value) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			child.kill();
			finish(null);
		}, 15000);
		child.stdout.on("data", (c) => chunks.push(c));
		child.on("error", () => finish(null));
		child.on("close", (code) => {
			finish(code === 0 && chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : null);
		});
		child.stdin.end(input);
	});

export default function (pi) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.isError) return;
		const filePath = event.input && event.input.path;
		if (typeof filePath !== "string" || filePath.length === 0) return;

		const bin = process.env.AISLOP_BIN || "aislop";
		const payload = JSON.stringify({
			cwd: ctx.cwd,
			file_path: filePath,
			tool_name: event.toolName,
		});

		let out;
		try {
			const stdout = await runHook(bin, ["hook", "pi"], payload, ctx.signal);
			if (!stdout) return;
			out = JSON.parse(stdout);
		} catch {
			return;
		}
		if (!out || !out.message) return;

		return {
			content: [...event.content, { type: "text", text: out.message }],
			isError: event.isError,
		};
	});
}
`;
const installPi = (opts) => {
	const paths = resolvePiPaths(opts);
	const result = emptyResult();
	applyContent(result, opts, paths.extension, PI_EXTENSION_SOURCE, "write pi aislop extension");
	return result;
};
const uninstallPi = (opts) => {
	const paths = resolvePiPaths(opts);
	const result = {
		removed: [],
		skipped: []
	};
	if (readIfExists(paths.extension) != null) applyRemoval(result, opts, paths.extension, null);
	else result.skipped.push(paths.extension);
	return result;
};
//#endregion
//#region src/hooks/install/windsurf.ts
const resolveWindsurfPaths = (opts) => ({ rules: path.join(opts.cwd, ".windsurfrules") });
const installWindsurf = (opts) => {
	if (opts.scope !== "project") return {
		wrote: [],
		skipped: [],
		planned: [{
			path: ".windsurfrules",
			summary: "Windsurf is project-scope only; pass --project"
		}]
	};
	return installRulesOnly(opts, resolveWindsurfPaths(opts), "write .windsurfrules");
};
const uninstallWindsurf = (opts) => {
	if (opts.scope !== "project") return {
		removed: [],
		skipped: []
	};
	return uninstallRulesOnly(opts, resolveWindsurfPaths(opts));
};
//#endregion
//#region src/hooks/install/registry.ts
const ALL_AGENTS = [
	"claude",
	"cursor",
	"gemini",
	"pi",
	"codex",
	"windsurf",
	"cline",
	"kilocode",
	"antigravity",
	"copilot"
];
const AGENTS_PROJECT_ONLY = [
	"windsurf",
	"cline",
	"kilocode",
	"antigravity",
	"copilot"
];
const AGENTS_SUPPORTING_BOTH_SCOPES = [
	"claude",
	"cursor",
	"gemini",
	"pi",
	"codex"
];
const paths = {
	claude: (opts) => {
		const p = resolveClaudePaths(opts);
		return [
			p.settings,
			p.aislopMd,
			p.claudeMd
		];
	},
	cursor: (opts) => {
		const p = resolveCursorPaths(opts);
		return opts.scope === "project" ? [p.hooks, p.rules] : [p.hooks];
	},
	gemini: (opts) => {
		const p = resolveGeminiPaths(opts);
		return [
			p.settings,
			p.aislopMd,
			p.geminiMd
		];
	},
	pi: (opts) => [resolvePiPaths(opts).extension],
	codex: (opts) => [resolveCodexPaths(opts).rules],
	windsurf: (opts) => [resolveWindsurfPaths(opts).rules],
	cline: (opts) => [resolveClinePaths(opts).rules, resolveRooPaths(opts).rules],
	kilocode: (opts) => [resolveKilocodePaths(opts).rules],
	antigravity: (opts) => [resolveAntigravityPaths(opts).rules],
	copilot: (opts) => [resolveCopilotPaths(opts).rules]
};
const REGISTRY = {
	claude: {
		install: installClaude,
		uninstall: uninstallClaude,
		paths: paths.claude
	},
	cursor: {
		install: installCursor,
		uninstall: uninstallCursor,
		paths: paths.cursor
	},
	gemini: {
		install: installGemini,
		uninstall: uninstallGemini,
		paths: paths.gemini
	},
	pi: {
		install: installPi,
		uninstall: uninstallPi,
		paths: paths.pi
	},
	codex: {
		install: installCodex,
		uninstall: uninstallCodex,
		paths: paths.codex
	},
	windsurf: {
		install: installWindsurf,
		uninstall: uninstallWindsurf,
		paths: paths.windsurf
	},
	cline: {
		install: installCline,
		uninstall: uninstallCline,
		paths: paths.cline
	},
	kilocode: {
		install: installKilocode,
		uninstall: uninstallKilocode,
		paths: paths.kilocode
	},
	antigravity: {
		install: installAntigravity,
		uninstall: uninstallAntigravity,
		paths: paths.antigravity
	},
	copilot: {
		install: installCopilot,
		uninstall: uninstallCopilot,
		paths: paths.copilot
	}
};
const defaultScopeFor = (agent) => AGENTS_PROJECT_ONLY.includes(agent) ? "project" : "global";
const detectInstalledAgents = (opts) => {
	const hits = [];
	for (const agent of ALL_AGENTS) {
		const scope = defaultScopeFor(agent);
		if (REGISTRY[agent].paths({
			home: opts.home,
			cwd: opts.cwd,
			scope
		}).some((p) => fs.existsSync(p))) hits.push(agent);
	}
	return hits;
};
//#endregion
//#region src/ui/search-select.ts
const silentOutput = new Writable({ write(_chunk, _encoding, callback) {
	callback();
} });
const filterSearchItems = (items, query) => {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return items;
	return items.map((item, index) => {
		const label = item.label.toLowerCase();
		const value = String(item.value).toLowerCase();
		const hint = item.hint?.toLowerCase() ?? "";
		const keywords = (item.keywords ?? []).join(" ").toLowerCase();
		const haystack = [
			label,
			value,
			hint,
			keywords
		].filter((v) => v.length > 0).join(" ");
		if (!q.split(/\s+/).every((part) => haystack.includes(part))) return null;
		let rank = 80;
		if (label === q || value === q) rank = 0;
		else if (label.startsWith(q) || value.startsWith(q)) rank = 10;
		else if (label.includes(q) || value.includes(q)) rank = 20;
		else if (keywords.includes(q)) rank = 40;
		else if (hint.includes(q)) rank = 60;
		return {
			item,
			index,
			rank
		};
	}).filter((entry) => entry !== null).sort((a, b) => {
		if (a.rank !== b.rank) return a.rank - b.rank;
		return a.index - b.index;
	}).map((entry) => entry.item);
};
const countRows = (lines, columns) => {
	const width = columns && columns > 0 ? columns : 80;
	return lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / width)), 0);
};
const renderSearchLines = (options) => {
	const maxVisible = options.maxVisible ?? 8;
	const filtered = filterSearchItems(options.items, options.query);
	const cursor = Math.max(0, Math.min(options.cursor, Math.max(0, filtered.length - 1)));
	const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible));
	const visible = filtered.slice(start, start + maxVisible);
	const lines = [];
	const labelWidth = visible.reduce((width, item) => Math.max(width, stringWidth(item.label)), 0);
	const marker = options.state === "cancel" ? style$1(theme, "danger", symbols.fail) : options.state === "submit" ? style$1(theme, "success", symbols.stepDone) : style$1(theme, "accent", symbols.stepActive);
	lines.push(` ${marker} ${style$1(theme, "bold", options.message)}`);
	if (options.state === "cancel") {
		lines.push(` ${style$1(theme, "muted", symbols.rail)} ${style$1(theme, "muted", "Cancelled")}`);
		return lines;
	}
	if (options.state === "submit") {
		const selected = options.items.filter((item) => options.selected.has(item.value));
		const label = selected.length > 0 ? selected.map((item) => item.label).join(", ") : "No selection";
		lines.push(` ${style$1(theme, "muted", symbols.rail)} ${style$1(theme, "muted", label)}`);
		return lines;
	}
	lines.push(` ${style$1(theme, "muted", symbols.rail)} ${style$1(theme, "muted", "Search:")} ${options.query}${style$1(theme, "dim", "_")}`);
	lines.push(` ${style$1(theme, "muted", symbols.rail)} ${style$1(theme, "muted", options.mode === "multi" ? "type to filter, arrows move, space toggles, enter confirms" : "type to filter, arrows move, enter selects")}`);
	lines.push(` ${style$1(theme, "muted", symbols.rail)}`);
	if (visible.length === 0) lines.push(` ${style$1(theme, "muted", symbols.rail)} ${style$1(theme, "muted", "No matches")}`);
	else for (const [offset, item] of visible.entries()) {
		const active = start + offset === cursor;
		const selected = options.selected.has(item.value);
		const pointer = active ? style$1(theme, "info", symbols.engineActive) : " ";
		const radio = options.mode === "multi" ? selected ? style$1(theme, "success", symbols.pass) : style$1(theme, "muted", symbols.pending) : active ? style$1(theme, "accent", symbols.bullet) : style$1(theme, "muted", symbols.pending);
		const paddedLabel = padEnd(item.label, labelWidth);
		const label = active ? style$1(theme, "bold", paddedLabel) : paddedLabel;
		const hint = item.hint ? ` ${highlightAislop(truncate(item.hint, 72), theme, "muted")}` : "";
		lines.push(` ${style$1(theme, "muted", symbols.rail)} ${pointer} ${radio} ${label}${hint}`);
	}
	const hiddenBefore = start;
	const hiddenAfter = Math.max(0, filtered.length - (start + visible.length));
	if (hiddenBefore > 0 || hiddenAfter > 0) {
		const parts = [];
		if (hiddenBefore > 0) parts.push(`up ${hiddenBefore} more`);
		if (hiddenAfter > 0) parts.push(`down ${hiddenAfter} more`);
		lines.push(` ${style$1(theme, "muted", symbols.rail)} ${style$1(theme, "muted", parts.join(" · "))}`);
	}
	if (options.mode === "multi") {
		const picked = options.items.filter((item) => options.selected.has(item.value));
		const summary = picked.length === 0 ? "Selected: none" : picked.length <= 3 ? `Selected: ${picked.map((item) => item.label).join(", ")}` : `Selected: ${picked.slice(0, 3).map((item) => item.label).join(", ")} +${picked.length - 3} more`;
		lines.push(` ${style$1(theme, "muted", symbols.rail)}`);
		lines.push(` ${style$1(theme, "muted", symbols.rail)} ${style$1(theme, "success", summary)}`);
	}
	lines.push(` ${style$1(theme, "muted", symbols.railEnd)}`);
	return lines;
};
const runSearchPrompt = async (options) => {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return options.mode === "multi" ? options.initialSelected ?? [] : null;
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: silentOutput,
			terminal: false
		});
		readline.emitKeypressEvents(process.stdin, rl);
		process.stdin.setRawMode(true);
		let query = "";
		let cursor = 0;
		let lastRows = 0;
		const selected = new Set(options.initialSelected ?? []);
		const clear = () => {
			if (lastRows === 0) return;
			process.stdout.write(`\x1b[${lastRows}A`);
			for (let i = 0; i < lastRows; i++) process.stdout.write("\x1B[2K\x1B[1B");
			process.stdout.write(`\x1b[${lastRows}A`);
		};
		const render = (state = "active") => {
			clear();
			const lines = renderSearchLines({
				...options,
				query,
				cursor,
				selected,
				state
			});
			process.stdout.write(`${lines.join("\n")}\n`);
			lastRows = countRows(lines, process.stdout.columns);
		};
		const cleanup = () => {
			process.stdin.removeListener("keypress", onKeypress);
			process.stdin.setRawMode(false);
			rl.close();
		};
		const submit = () => {
			const item = filterSearchItems(options.items, query)[cursor];
			if (options.mode === "single") {
				if (!item) {
					if (options.required) return;
					render("cancel");
					cleanup();
					resolve(null);
					return;
				}
				selected.clear();
				selected.add(item.value);
				render("submit");
				cleanup();
				resolve(item.value);
				return;
			}
			if (options.required && selected.size === 0) return;
			render("submit");
			cleanup();
			resolve([...selected]);
		};
		const cancel = () => {
			render("cancel");
			cleanup();
			resolve(null);
		};
		const onKeypress = (_str, key) => {
			if (!key) return;
			const filtered = filterSearchItems(options.items, query);
			if (key.name === "return") {
				submit();
				return;
			}
			if (key.name === "escape" || key.ctrl && key.name === "c") {
				cancel();
				return;
			}
			if (key.name === "up") {
				cursor = Math.max(0, cursor - 1);
				render();
				return;
			}
			if (key.name === "down") {
				cursor = Math.min(Math.max(0, filtered.length - 1), cursor + 1);
				render();
				return;
			}
			if (key.name === "space" && options.mode === "multi") {
				const item = filtered[cursor];
				if (item) if (selected.has(item.value)) selected.delete(item.value);
				else selected.add(item.value);
				render();
				return;
			}
			if (key.name === "backspace") {
				query = query.slice(0, -1);
				cursor = 0;
				render();
				return;
			}
			if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
				query += key.sequence;
				cursor = 0;
				render();
			}
		};
		process.stdin.on("keypress", onKeypress);
		render();
	});
};
const searchSelect = async (options) => await runSearchPrompt({
	...options,
	mode: "single"
});
const searchMultiselect = async (options) => await runSearchPrompt({
	...options,
	mode: "multi",
	initialSelected: options.initialSelected
});
//#endregion
//#region src/commands/hook.ts
const HOOK_FLUSH_TIMEOUT_MS = 1500;
const AGENT_LABELS = {
	claude: {
		label: "Claude Code",
		hint: "PostToolUse, runtime"
	},
	cursor: {
		label: "Cursor",
		hint: "afterFileEdit, runtime"
	},
	gemini: {
		label: "Gemini CLI",
		hint: "AfterTool, runtime"
	},
	pi: {
		label: "pi",
		hint: "extension, runtime"
	},
	codex: {
		label: "Codex CLI",
		hint: "rules-only"
	},
	windsurf: {
		label: "Windsurf",
		hint: "rules-only, project"
	},
	cline: {
		label: "Cline + Roo",
		hint: "rules-only, project"
	},
	kilocode: {
		label: "Kilo Code",
		hint: "rules-only, project"
	},
	antigravity: {
		label: "Antigravity",
		hint: "rules-only, project"
	},
	copilot: {
		label: "GitHub Copilot",
		hint: "rules-only, project"
	}
};
const resolveOpts = (agent, flags) => {
	const scope = AGENTS_PROJECT_ONLY.includes(agent) ? "project" : flags.scope;
	return {
		home: os.homedir(),
		cwd: process.cwd(),
		scope,
		dryRun: flags.dryRun,
		qualityGate: flags.qualityGate
	};
};
const hookInstall = async (flags) => {
	const items = [];
	for (const agent of flags.agents) {
		const opts = resolveOpts(agent, flags);
		const result = REGISTRY[agent].install(opts);
		items.push({
			agent,
			scope: opts.scope,
			result
		});
	}
	process.stdout.write(renderHookInstall({
		dryRun: flags.dryRun,
		items
	}));
};
const hookUninstall = async (flags) => {
	const items = [];
	for (const agent of flags.agents) {
		const opts = resolveOpts(agent, flags);
		const result = REGISTRY[agent].uninstall(opts);
		items.push({
			agent,
			scope: opts.scope,
			result
		});
	}
	process.stdout.write(renderHookUninstall({
		dryRun: flags.dryRun,
		items
	}));
};
const installStatus = (item, dryRun) => {
	if (dryRun) return item.result.planned.length > 0 ? "planned" : "up to date";
	return item.result.wrote.length > 0 ? "updated" : "up to date";
};
const hookMarker = (active) => active ? style$1(theme, "success", "✓") : style$1(theme, "muted", "·");
const hookOperationItem = (item) => ({
	marker: hookMarker(item.status !== "up to date" && item.status !== "nothing installed"),
	label: item.agent,
	rows: [{
		label: "Status",
		value: item.status
	}, ...item.rows]
});
const renderHookOperation = (input) => {
	const lines = [
		renderHeader({
			version: APP_VERSION,
			command: input.command,
			context: input.dryRun ? ["dry-run"] : []
		}).trimEnd(),
		"",
		renderDisplaySection("Agents"),
		...renderDisplayStatusItems(input.items.map(hookOperationItem))
	];
	if (input.dryRun) lines.push("", renderDisplaySection("Next"), ...renderDisplayRows([{
		label: "Apply",
		value: "rerun without --dry-run"
	}]));
	return `${lines.join("\n")}\n`;
};
const installRows = (item, dryRun) => {
	const rows = [{
		label: "Scope",
		value: item.scope
	}];
	if (dryRun) {
		for (const op of item.result.planned) rows.push({
			label: "Path",
			value: op.path
		}, {
			label: "Change",
			value: op.summary
		});
		return rows;
	}
	for (const path of item.result.wrote) rows.push({
		label: "Wrote",
		value: path
	});
	for (const path of item.result.skipped) rows.push({
		label: "Skipped",
		value: path
	});
	return rows;
};
const renderHookInstall = (input) => renderHookOperation({
	command: "Hook install",
	dryRun: input.dryRun,
	items: input.items.map((item) => ({
		agent: item.agent,
		status: installStatus(item, input.dryRun),
		rows: installRows(item, input.dryRun)
	}))
});
const uninstallRows = (item, dryRun) => [
	{
		label: "Scope",
		value: item.scope
	},
	...item.result.removed.map((path) => ({
		label: dryRun ? "Remove" : "Removed",
		value: path
	})),
	...item.result.skipped.map((path) => ({
		label: "Skipped",
		value: path
	}))
];
const renderHookUninstall = (input) => renderHookOperation({
	command: "Hook uninstall",
	dryRun: input.dryRun,
	items: input.items.map((item) => {
		const changed = item.result.removed.length > 0;
		return {
			agent: item.agent,
			status: changed ? input.dryRun ? "planned" : "removed" : "nothing installed",
			rows: uninstallRows(item, input.dryRun)
		};
	})
});
const hookStatus = async () => {
	const home = os.homedir();
	const cwd = process.cwd();
	const installed = new Set(detectInstalledAgents({
		home,
		cwd
	}));
	const items = ALL_AGENTS.map((agent) => {
		const scope = defaultScopeFor(agent);
		const targets = REGISTRY[agent].paths({
			home,
			cwd,
			scope
		});
		return {
			agent,
			scope,
			installed: installed.has(agent),
			paths: targets.filter((p) => fs.existsSync(p))
		};
	});
	process.stdout.write(renderHookStatus(items));
};
const renderHookStatus = (items) => {
	return `${[
		renderHeader({
			version: APP_VERSION,
			command: "Hook status",
			context: []
		}).trimEnd(),
		"",
		renderDisplaySection("Hooks"),
		...renderDisplayStatusItems(items.map((item) => ({
			marker: hookMarker(item.installed),
			label: item.agent,
			rows: [
				{
					label: "Status",
					value: item.installed ? "installed" : "not installed"
				},
				{
					label: "Scope",
					value: item.scope
				},
				...item.paths.map((p) => ({
					label: "Path",
					value: p
				}))
			]
		})))
	].join("\n")}\n`;
};
const hookRun = async (agent, flags) => {
	if (process.stdin.isTTY) {
		process.stderr.write(`aislop hook ${agent} is an internal callback the agent invokes automatically. It reads a payload on stdin and has nothing to do interactively.\n\nYou probably want:\n  aislop hook install --${agent}     (install the hook for ${agent})\n  aislop hook status                   (see what's installed)\n  aislop hook uninstall --${agent}   (remove it)\n`);
		process.exit(0);
	}
	let exitCode = 0;
	if (agent === "claude") if (flags?.onFileChanged) exitCode = await runClaudeFileChangedHook();
	else if (flags?.stop) exitCode = await runClaudeStopHook();
	else exitCode = await runClaudeHook();
	else if (agent === "cursor") exitCode = await runCursorHook();
	else if (agent === "gemini") exitCode = await runGeminiHook();
	else if (agent === "pi") exitCode = await runPiHook();
	else {
		process.stderr.write(`hook: agent "${agent}" has no runtime adapter (rules-file-only)\n`);
		process.exit(0);
	}
	await flushTelemetry(HOOK_FLUSH_TIMEOUT_MS);
	process.exit(exitCode);
};
const hookBaseline = async () => {
	const result = await captureBaseline(process.cwd());
	process.stdout.write(renderHookBaseline({
		score: result.score,
		fileCount: result.fileCount,
		path: result.path
	}));
};
const renderHookBaseline = (input) => [
	renderHeader({
		version: APP_VERSION,
		command: "Hook baseline",
		context: []
	}).trimEnd(),
	"",
	renderDisplaySection("Baseline"),
	...renderDisplayRows([
		{
			label: "Score",
			value: `${input.score}/100`
		},
		{
			label: "Files",
			value: String(input.fileCount)
		},
		{
			label: "Path",
			value: input.path
		}
	]),
	""
].join("\n");
const parseAgentFlag = (raw, fallback) => {
	if (!raw) return fallback;
	const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
	const unknown = parts.filter((p) => !ALL_AGENTS.includes(p));
	if (unknown.length > 0) throw new Error(`Unknown agent(s): ${unknown.join(", ")}. Valid: ${ALL_AGENTS.join(", ")}`);
	return parts;
};
const defaultInstallTargets = () => {
	return AGENTS_SUPPORTING_BOTH_SCOPES;
};
const resolveAgents = (perAgentFlags, positional, agentFlag, fallback) => {
	const flagged = ALL_AGENTS.filter((a) => perAgentFlags[a] === true);
	if (flagged.length > 0) return flagged;
	if (positional.length > 0) {
		const unknown = positional.filter((p) => !ALL_AGENTS.includes(p));
		if (unknown.length > 0) throw new Error(`Unknown agent(s): ${unknown.join(", ")}. Valid: ${ALL_AGENTS.join(", ")}`);
		return positional;
	}
	return parseAgentFlag(agentFlag, fallback);
};
const hasExplicitAgentSelection = (perAgentFlags, positional, agentFlag) => {
	if (ALL_AGENTS.some((a) => perAgentFlags[a] === true)) return true;
	if (positional.length > 0) return true;
	if (typeof agentFlag === "string" && agentFlag.trim().length > 0) return true;
	return false;
};
const promptAgentSelection = async (mode, deps = {}) => {
	const installed = deps.installed ?? [];
	const pool = mode === "uninstall" ? installed : ALL_AGENTS;
	if (pool.length === 0) return [];
	const preChecked = mode === "uninstall" ? installed : AGENTS_SUPPORTING_BOTH_SCOPES;
	return await searchMultiselect({
		message: mode === "install" ? "Which agents should get aislop hooks?" : "Which agent hooks should be removed?",
		items: pool.map((a) => ({
			value: a,
			label: AGENT_LABELS[a].label,
			hint: AGENT_LABELS[a].hint,
			keywords: [a]
		})),
		initialSelected: preChecked.filter((a) => pool.includes(a)),
		required: false
	});
};
//#endregion
//#region src/cli/hook-command.ts
const AGENT_NAMES = [
	"claude",
	"cursor",
	"gemini",
	"pi",
	"codex",
	"windsurf",
	"cline",
	"kilocode",
	"antigravity",
	"copilot"
];
const resolveScope = (flags) => {
	if (flags.project) return "project";
	if (flags.global) return "global";
	return "global";
};
const promptForUninstall = async () => {
	const installed = detectInstalledAgents({
		home: os.homedir(),
		cwd: process.cwd()
	});
	if (installed.length === 0) {
		log.warn("No aislop hooks installed. Nothing to uninstall.");
		return [];
	}
	const picked = await promptAgentSelection("uninstall", { installed });
	if (picked === null) {
		log.warn("Cancelled.");
		return null;
	}
	if (picked.length === 0) {
		log.warn("No agents selected. Nothing to uninstall.");
		return [];
	}
	return picked;
};
const promptForInstall = async () => {
	const picked = await promptAgentSelection("install");
	if (picked === null) {
		log.warn("Cancelled.");
		return null;
	}
	if (picked.length === 0) {
		log.warn("No agents selected. Nothing to install.");
		return [];
	}
	return picked;
};
const pickAgents = async (mode, opts, positional) => {
	if (hasExplicitAgentSelection(opts, positional, opts.agent)) return resolveAgents(opts, positional, opts.agent, defaultInstallTargets());
	if (!process.stdin.isTTY) return defaultInstallTargets();
	return mode === "uninstall" ? promptForUninstall() : promptForInstall();
};
const addAgentShortcutOptions = (command) => {
	for (const a of AGENT_NAMES) command.option(`--${a}`, `shortcut for --agent ${a}`);
	return command;
};
const addInstallOptions = (command) => addAgentShortcutOptions(command.option("--agent <names>", "comma-separated agent list (claude,cursor,gemini,codex,windsurf,cline,kilocode,antigravity,copilot)").option("-g, --global", "install to the user-scope config (default)").option("--project", "install to the project-scope config").option("--dry-run", "print the planned diff without writing").option("--yes", "skip the confirmation prompt (reserved)").option("--quality-gate", "add a Stop hook that blocks when score regresses below baseline (Claude only)"));
const addUninstallOptions = (command) => addAgentShortcutOptions(command.option("--agent <names>", "comma-separated agent list").option("-g, --global", "uninstall from user-scope config").option("--project", "uninstall from project-scope config").option("--dry-run", "print the planned removal without writing"));
const runInstallAction = async (positional, opts) => {
	const agents = await pickAgents("install", opts, positional);
	if (agents === null || agents.length === 0) return;
	await withCommandLifecycle({
		command: "hook_install",
		config: loadConfig(process.cwd()).telemetry
	}, async () => {
		await hookInstall({
			agents,
			scope: resolveScope(opts),
			dryRun: Boolean(opts.dryRun),
			yes: Boolean(opts.yes),
			qualityGate: Boolean(opts.qualityGate)
		});
		return { exitCode: 0 };
	});
};
const runUninstallAction = async (positional, opts) => {
	const agents = await pickAgents("uninstall", opts, positional);
	if (agents === null || agents.length === 0) return;
	await withCommandLifecycle({
		command: "hook_uninstall",
		config: loadConfig(process.cwd()).telemetry
	}, async () => {
		await hookUninstall({
			agents,
			scope: resolveScope(opts),
			dryRun: Boolean(opts.dryRun),
			yes: true,
			qualityGate: false
		});
		return { exitCode: 0 };
	});
};
const normalizeHookAliasAgents = (agents) => {
	const [first, ...rest] = agents;
	return first === "hook" || first === "hooks" ? rest : agents;
};
const registerInstall = (hook) => {
	addInstallOptions(hook.command("install [agents...]").description("Install hooks for one or more coding agents. Use positional agents, per-agent flags, or --agent.")).action(runInstallAction);
};
const registerUninstall = (hook) => {
	addUninstallOptions(hook.command("uninstall [agents...]").description("Remove hooks for one or more coding agents. Use positional agents, per-agent flags, or --agent.")).action(runUninstallAction);
};
const registerCallbacks = (hook) => {
	hook.command("status").description("Show installed agent hooks").action(async () => {
		await withCommandLifecycle({
			command: "hook_status",
			config: loadConfig(process.cwd()).telemetry
		}, async () => {
			await hookStatus();
			return { exitCode: 0 };
		});
	});
	hook.command("baseline").description("Capture the current score as the hook baseline").action(async () => {
		await withCommandLifecycle({
			command: "hook_baseline",
			config: loadConfig(process.cwd()).telemetry
		}, async () => {
			await hookBaseline();
			return { exitCode: 0 };
		});
	});
	hook.command("claude", { hidden: true }).description("Internal: Claude Code PostToolUse / Stop / FileChanged callback (reads stdin)").option("--stop", "run in Stop-hook mode for the quality gate").option("--on-file-changed", "run in FileChanged mode (refresh baseline on watched file change)").action(async (opts) => {
		await hookRun("claude", {
			stop: Boolean(opts.stop),
			onFileChanged: Boolean(opts.onFileChanged)
		});
	});
	hook.command("cursor", { hidden: true }).description("Internal: Cursor afterFileEdit callback (reads stdin)").action(async () => {
		await hookRun("cursor");
	});
	hook.command("gemini", { hidden: true }).description("Internal: Gemini CLI AfterTool callback (reads stdin)").action(async () => {
		await hookRun("gemini");
	});
	hook.command("pi", { hidden: true }).description("Internal: pi extension tool_result callback (reads stdin)").action(async () => {
		await hookRun("pi");
	});
};
const registerHookCommand = (program) => {
	const hook = program.command("hook").alias("hooks").description("Manage per-edit coding-agent hooks");
	registerInstall(hook);
	registerUninstall(hook);
	registerCallbacks(hook);
};
const registerHookAliases = (program) => {
	addInstallOptions(program.command("install [agents...]").description("Install coding-agent hooks (alias: hook install)")).action(async (agents, opts) => {
		await runInstallAction(normalizeHookAliasAgents(agents), opts);
	});
	addUninstallOptions(program.command("uninstall [agents...]").description("Remove coding-agent hooks (alias: hook uninstall)")).action(async (agents, opts) => {
		await runUninstallAction(normalizeHookAliasAgents(agents), opts);
	});
};
//#endregion
//#region src/commands/badge.ts
const GITHUB_REMOTE_RE = /^(?:git@github\.com:|https:\/\/(?:[^@]+@)?github\.com\/)([^/]+)\/([^/.\s]+?)(?:\.git)?\s*$/;
const renderBadgeOutput = ({ owner, repo, svgUrl, pageUrl }) => {
	const slug = `${owner}/${repo}`;
	const markdown = `[![aislop](${svgUrl})](${pageUrl})`;
	return [
		renderHeader({
			version: APP_VERSION,
			command: "Badge",
			context: [slug]
		}).trimEnd(),
		"",
		renderDisplaySection("Badge"),
		...renderDisplayRows([
			{
				label: "Repository",
				value: slug
			},
			{
				label: "Badge URL",
				value: svgUrl
			},
			{
				label: "Page",
				value: pageUrl
			}
		]),
		"",
		renderDisplaySection("Markdown"),
		...renderDisplayRows([{
			label: "README",
			value: markdown
		}]),
		"",
		renderDisplaySection("Next"),
		...renderDisplayRows([{
			label: "Add",
			value: "put the README markdown near your project title"
		}, {
			label: "Refresh",
			value: "run a public scan to update the score behind the badge"
		}]),
		""
	].join("\n");
};
const detectGithubSlugFromGit = (directory) => {
	let raw;
	try {
		raw = execSync("git remote get-url origin", {
			cwd: path.resolve(directory),
			encoding: "utf-8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
	} catch {
		return null;
	}
	const match = raw.trim().match(GITHUB_REMOTE_RE);
	if (!match) return null;
	const owner = match[1];
	const repo = match[2];
	if (!owner || !repo) return null;
	return {
		owner,
		repo
	};
};
const badgeCommand = async (options = {}) => {
	let owner = options.owner?.trim();
	let repo = options.repo?.trim();
	if (!owner || !repo) {
		const detected = detectGithubSlugFromGit(options.directory ?? ".");
		if (!detected) throw new Error("Could not detect a GitHub remote. Run from a repo with `git remote get-url origin` set, or pass --owner and --repo.");
		owner ??= detected.owner;
		repo ??= detected.repo;
	}
	const svgUrl = `https://badges.scanaislop.com/score/${owner}/${repo}.svg`;
	const pageUrl = `https://scanaislop.com/${owner}/${repo}`;
	const output = renderBadgeOutput({
		owner,
		repo,
		svgUrl,
		pageUrl
	});
	if (options.json) process.stdout.write(`${JSON.stringify({
		owner,
		repo,
		svgUrl,
		pageUrl
	})}\n`);
	else process.stdout.write(output);
	return {
		owner,
		repo,
		svgUrl,
		pageUrl,
		output
	};
};
//#endregion
//#region src/output/rule-labels.ts
const RULE_LABELS = {
	formatting: "Code not formatted",
	"code-quality/duplicate-block": "Duplicate code block",
	"code-quality/repeated-chained-call": "Repeated chained call",
	"code-quality/unused-declaration": "Unused declaration",
	"complexity/file-too-large": "File too large",
	"complexity/function-too-long": "Function too long",
	"complexity/deep-nesting": "Deeply nested code",
	"complexity/too-many-params": "Too many parameters",
	"knip/files": "Unused file",
	"knip/dependencies": "Unused dependency",
	"knip/devDependencies": "Unused dev dependency",
	"knip/unlisted": "Used but not in package.json",
	"knip/unresolved": "Unresolved import",
	"knip/binaries": "Unused binary",
	"knip/exports": "Unused export",
	"knip/types": "Unused type",
	"knip/duplicates": "Duplicate export",
	"ai-slop/trivial-comment": "Trivial restating comment",
	"ai-slop/swallowed-exception": "Empty catch (swallowed error)",
	"ai-slop/silent-recovery": "Catch logs then continues",
	"ai-slop/meta-comment": "Meta/plan comment",
	"ai-slop/hidden-fallback": "Hidden fallback",
	"ai-slop/redundant-try-catch": "Redundant try/catch",
	"ai-slop/redundant-type-coercion": "Redundant type coercion",
	"ai-slop/duplicate-type-declaration": "Duplicate exported type",
	"ai-slop/thin-wrapper": "Thin function wrapper",
	"ai-slop/generic-naming": "Generic/vague identifier name",
	"ai-slop/unused-import": "Unused import",
	"ai-slop/unused-css": "Unused CSS class",
	"ai-slop/console-leftover": "console.log left in code",
	"ai-slop/todo-stub": "Unresolved TODO/FIXME",
	"ai-slop/unmarked-debt": "Unmarked agent debt/mock",
	"ai-slop/unreachable-code": "Unreachable code",
	"ai-slop/constant-condition": "Constant condition",
	"ai-slop/empty-function": "Empty function body",
	"ai-slop/unsafe-type-assertion": "Unsafe type cast",
	"ai-slop/double-type-assertion": "Double type cast",
	"ai-slop/ts-directive": "@ts-ignore / @ts-expect-error",
	"ai-slop/narrative-comment": "Narrative comment block",
	"ai-slop/duplicate-import": "Duplicate import statement",
	"ai-slop/hardcoded-url": "Hardcoded URL",
	"ai-slop/hardcoded-id": "Hardcoded provider ID",
	"ai-slop/python-bare-except": "Bare except",
	"ai-slop/python-broad-except": "Broad except",
	"ai-slop/python-mutable-default": "Mutable default argument",
	"ai-slop/python-print-debug": "print() left in code",
	"ai-slop/python-range-len-loop": "range(len(...)) loop",
	"ai-slop/python-chained-dict-get": "Chained dict get",
	"ai-slop/python-repetitive-dispatch": "Repetitive dispatch ladder",
	"ai-slop/python-isinstance-ladder": "isinstance ladder",
	"ai-slop/go-library-panic": "panic() in Go library code",
	"ai-slop/rust-non-test-unwrap": "Rust .unwrap() in production code",
	"ai-slop/rust-todo-stub": "Rust todo!() stub",
	"ai-slop/csharp-not-implemented": "NotImplementedException stub",
	"ai-slop/csharp-redundant-doc-comment": "Redundant XML-doc summary",
	"ai-slop/csharp-async-void": "async void (not an event handler)",
	"ai-slop/csharp-sync-over-async": "Sync-over-async (.Result/.Wait)",
	"ai-slop/csharp-suppressed-warning": "Unjustified warning suppression",
	"ai-slop/csharp-empty-catch-rethrow": "Empty catch that only rethrows",
	"ai-slop/csharp-null-forgiving": "Null-forgiving ! operator",
	"ai-slop/csharp-console-leftover": "Console/Debug/Trace output leftover",
	"ai-slop/csharp-broad-catch": "Broad catch (Exception)",
	"ai-slop/csharp-linq-count": "LINQ .Count() instead of .Any()",
	"ai-slop/csharp-index-loop": "Index for-loop better as foreach",
	"ai-slop/csharp-if-ladder": "if/else-if ladder better as switch",
	"ai-slop/csharp-string-concat-in-loop": "String += in a loop (use StringBuilder)",
	"ai-slop/cpp-not-implemented": "C++ stub throws/asserts not-implemented",
	"ai-slop/cpp-using-namespace-std-in-header": "using namespace std in a header",
	"ai-slop/cpp-c-style-cast": "C-style cast in C++ code",
	"ai-slop/cpp-manual-delete": "Manual delete; prefer a smart pointer",
	"ai-slop/cpp-iostream-leftover": "std::cout/cerr left in library code",
	"ai-slop/cpp-null-literal": "NULL in C++; prefer nullptr",
	"ai-slop/cpp-define-constant": "#define constant; prefer constexpr",
	"ai-slop/cpp-endl-in-stream": "std::endl flushes; prefer '\\n'",
	"ai-slop/hallucinated-import": "Import not in package.json",
	"ai-slop/tautological-test": "Test assertion cannot fail",
	"security/hardcoded-secret": "Possible hardcoded secret",
	"security/vulnerable-dependency": "Vulnerable dependency",
	"security/dependency-audit-skipped": "Dependency audit skipped",
	"security/eval": "eval() usage",
	"security/innerhtml": "innerHTML assignment",
	"security/dangerously-set-innerhtml": "dangerouslySetInnerHTML (XSS risk)",
	"security/sql-injection": "Possible SQL injection",
	"security/shell-injection": "Possible shell injection",
	"security/unsafe-deserialization": "Unsafe deserialization",
	"security/unsafe-c-call": "Memory-unsafe C call",
	"dotnet/projects-skipped": "C# projects skipped by build-backed lint",
	"cppcheck/chunks-skipped": "C/C++ files skipped by cppcheck",
	"eslint/no-undef": "Undefined identifier",
	"eslint/no-unused-vars": "Unused variable",
	"eslint/no-unassigned-vars": "Variable never assigned",
	"eslint/no-empty": "Empty block statement",
	"eslint/no-unused-expressions": "Unused expression",
	"eslint/no-shadow-restricted-names": "Shadowing restricted name",
	"eslint/no-constant-binary-expression": "Constant binary expression",
	"eslint/no-unsafe-optional-chaining": "Unsafe optional chaining",
	"eslint/require-yield": "Generator with no yield",
	"import/no-duplicates": "Duplicate import path",
	"import/default": "Missing default export",
	"import/named": "Missing named export",
	"import/namespace": "Invalid namespace import",
	"typescript-eslint/triple-slash-reference": "Triple-slash reference",
	"unicorn/no-useless-fallback-in-spread": "Useless spread fallback",
	"unicorn/no-invalid-remove-event-listener": "Invalid removeEventListener",
	"unicorn/no-empty-file": "Empty file",
	"unicorn/no-useless-length-check": "Useless array length check",
	"unicorn/no-new-array": "Avoid new Array(n)",
	"unicorn/no-useless-spread": "Useless spread",
	"unicorn/no-single-promise-in-promise-methods": "Single-element Promise.all"
};
const RULE_DESCRIPTIONS = {
	formatting: "File needs standard formatter output.",
	"code-quality/duplicate-block": "Large repeated code block should be shared or simplified.",
	"code-quality/repeated-chained-call": "Same chained call is repeated instead of stored once.",
	"code-quality/unused-declaration": "Declared symbol is not referenced.",
	"complexity/file-too-large": "File is large enough to be hard to review safely.",
	"complexity/function-too-long": "Function is doing too much in one body.",
	"complexity/deep-nesting": "Nested branches make the path hard to follow.",
	"complexity/too-many-params": "Function takes more arguments than readers can track.",
	"knip/files": "Source file is not imported or referenced.",
	"knip/dependencies": "Production dependency is listed but unused.",
	"knip/devDependencies": "Dev dependency is listed but unused.",
	"knip/unlisted": "Code imports a package missing from package.json.",
	"knip/unresolved": "Import cannot be resolved from the project.",
	"knip/binaries": "Package binary is listed but unused.",
	"knip/exports": "Exported value is not imported anywhere.",
	"knip/types": "Exported type is not imported anywhere.",
	"knip/duplicates": "Same export is declared more than once.",
	"ai-slop/trivial-comment": "Comment repeats obvious code instead of explaining intent.",
	"ai-slop/swallowed-exception": "Catch block hides an error without handling it.",
	"ai-slop/silent-recovery": "Error path logs or defaults, then continues as if safe.",
	"ai-slop/meta-comment": "Comment describes editing steps, plans, or generated-code process.",
	"ai-slop/redundant-try-catch": "try/catch only rethrows or adds no useful handling.",
	"ai-slop/redundant-type-coercion": "Conversion does not change the value meaningfully.",
	"ai-slop/duplicate-type-declaration": "Same exported type shape appears more than once.",
	"ai-slop/thin-wrapper": "Wrapper function adds no behavior or clearer contract.",
	"ai-slop/generic-naming": "Name is too vague to explain its role.",
	"ai-slop/unused-import": "Imported symbol is never used.",
	"ai-slop/unused-css": "Custom CSS class is defined but never referenced anywhere in the codebase.",
	"ai-slop/console-leftover": "console/debug output was left in application code.",
	"ai-slop/todo-stub": "TODO/FIXME/stub marks unfinished behavior.",
	"ai-slop/unmarked-debt": "Mock data, stub, or hardcode lacks AGENT:* tracking marker.",
	"ai-slop/unreachable-code": "Code path cannot execute.",
	"ai-slop/constant-condition": "Condition is always true or always false.",
	"ai-slop/empty-function": "Function body is empty or placeholder-only.",
	"ai-slop/unsafe-type-assertion": "Type assertion bypasses useful checking.",
	"ai-slop/double-type-assertion": "Value is cast through unknown/any to force a type.",
	"ai-slop/ts-directive": "TypeScript error is suppressed with a directive.",
	"ai-slop/narrative-comment": "Comment narrates implementation instead of adding context.",
	"ai-slop/duplicate-import": "Same module is imported more than once.",
	"ai-slop/hardcoded-url": "URL-like value is embedded directly in code.",
	"ai-slop/hardcoded-id": "Provider/account/test ID is embedded directly in code.",
	"ai-slop/python-bare-except": "Bare except catches everything, including system exits.",
	"ai-slop/python-broad-except": "Broad exception catch hides specific failure modes.",
	"ai-slop/python-mutable-default": "Mutable default argument is shared across calls.",
	"ai-slop/python-print-debug": "print/debug output was left in Python source.",
	"ai-slop/python-range-len-loop": "Loop uses indexes where direct iteration is clearer.",
	"ai-slop/python-chained-dict-get": "Nested get chain hides shape assumptions.",
	"ai-slop/python-repetitive-dispatch": "Repeated if/elif dispatch should be table-driven.",
	"ai-slop/python-isinstance-ladder": "Long isinstance ladder is brittle polymorphism.",
	"ai-slop/go-library-panic": "Library code panics instead of returning an error.",
	"ai-slop/rust-non-test-unwrap": "Production Rust uses unwrap instead of handling failure.",
	"ai-slop/rust-todo-stub": "Rust todo!/unimplemented! leaves behavior unfinished.",
	"ai-slop/hallucinated-import": "Import names a package not declared by the project.",
	"ai-slop/tautological-test": "Test compares fixed literals and therefore cannot fail.",
	"security/hardcoded-secret": "Secret-looking token is embedded in source.",
	"security/vulnerable-dependency": "Dependency audit reported a known vulnerability.",
	"security/dependency-audit-skipped": "Audit could not run because inputs/tools are missing.",
	"security/eval": "Dynamic code execution can run attacker-controlled input.",
	"security/innerhtml": "Raw HTML assignment can introduce XSS.",
	"security/dangerously-set-innerhtml": "React raw HTML escape hatch can introduce XSS.",
	"security/sql-injection": "SQL is built from interpolated or concatenated input.",
	"security/shell-injection": "Shell command is built from unsanitized input.",
	"security/unsafe-deserialization": "Legacy .NET formatter can deserialize arbitrary types (RCE).",
	"security/unsafe-c-call": "Unbounded C string/exec function with buffer-overflow or shell risk.",
	"dotnet/projects-skipped": "Build-backed C# lint only ran on restored projects; the rest were skipped.",
	"cppcheck/chunks-skipped": "A cppcheck invocation timed out or failed on one or more chunks; their files were not analyzed.",
	"oxlint/*": "JavaScript/TypeScript lint finding from oxlint.",
	"ruff/*": "Python lint finding from ruff.",
	"go/*": "Go lint finding from bundled checks.",
	"clippy/*": "Rust lint finding from clippy.",
	"rubocop/*": "Ruby lint finding from rubocop.",
	"typescript/*": "TypeScript compiler finding.",
	"import-order": "Imports need deterministic ordering.",
	"python-formatting": "Python file needs ruff formatting.",
	"go-formatting": "Go file needs gofmt.",
	"rust-formatting": "Rust file needs rustfmt.",
	"ruby-formatting": "Ruby file needs rubocop formatting.",
	"php-formatting": "PHP file needs php-cs-fixer formatting.",
	"csharp-formatting": "C# file needs dotnet format."
};
const prettifyFallback = (ruleId) => {
	const spaced = (ruleId.includes("/") ? ruleId.slice(ruleId.indexOf("/") + 1) : ruleId).replace(/[-_]/g, " ").replace(/\//g, " · ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
const labelForRule = (ruleId) => RULE_LABELS[ruleId] ?? prettifyFallback(ruleId);
const descriptionForRule = (ruleId) => RULE_DESCRIPTIONS[ruleId] ?? labelForRule(ruleId);
//#endregion
//#region src/commands/rules-entry.ts
const AI_SLOP_FIXABLE = /* @__PURE__ */ new Set([
	"ai-slop/trivial-comment",
	"ai-slop/unused-import",
	"ai-slop/narrative-comment",
	"ai-slop/duplicate-import"
]);
const AI_SLOP_ERRORS = /* @__PURE__ */ new Set(["ai-slop/hallucinated-import"]);
const SECURITY_INFO = /* @__PURE__ */ new Set(["security/dependency-audit-skipped"]);
const toRuleEntry = (engine, ruleId) => {
	if (engine === "format") return {
		id: ruleId,
		engine,
		severity: "warning",
		fixable: true
	};
	if (engine === "security") return {
		id: ruleId,
		engine,
		severity: SECURITY_INFO.has(ruleId) ? "info" : "error",
		fixable: false
	};
	if (engine === "ai-slop") return {
		id: ruleId,
		engine,
		severity: AI_SLOP_ERRORS.has(ruleId) ? "error" : "warning",
		fixable: AI_SLOP_FIXABLE.has(ruleId)
	};
	return {
		id: ruleId,
		engine,
		severity: "warning",
		fixable: false
	};
};
//#endregion
//#region src/commands/rules-render.ts
const ENGINE_PRESENTATION = {
	"ai-slop": {
		label: "AI Slop",
		summary: "Generated-code leftovers: vague comments, unsafe casts, stubs, swallowed errors.",
		order: 10
	},
	security: {
		label: "Security",
		summary: "Secrets, injection, XSS, shell execution, and vulnerable dependencies.",
		order: 20
	},
	"code-quality": {
		label: "Code Quality",
		summary: "Dead code, duplicate code, complexity, and dependency hygiene.",
		order: 30
	},
	format: {
		label: "Format",
		summary: "Formatter and import-order checks that aislop can usually fix.",
		order: 40
	},
	lint: {
		label: "Lint",
		summary: "Language linter and compiler findings from bundled or system tools.",
		order: 50
	},
	architecture: {
		label: "Architecture",
		summary: "Project-specific import and layering rules from .aislop/rules.yml.",
		order: 60
	}
};
const presentationFor = (engine) => ENGINE_PRESENTATION[engine] ?? {
	label: engine,
	summary: "Project-specific rules.",
	order: 100
};
const severityLabel = (severity) => severity === "warning" ? "warn" : severity;
const fixModeLabel = (fixable) => fixable ? "auto" : "review";
const impactLabel = (ruleId) => scoreImpactForRule(ruleId).tier;
const buildRulesRender = (input) => {
	const header = input.includeHeader === false ? "" : renderHeader({
		version: APP_VERSION,
		command: "Rules catalog",
		context: [`${input.rules.length} checks`],
		brand: input.printBrand !== false
	});
	const byEngine = /* @__PURE__ */ new Map();
	for (const r of input.rules) {
		const list = byEngine.get(r.engine) ?? [];
		list.push(r);
		byEngine.set(r.engine, list);
	}
	const engines = [...byEngine.keys()].sort((a, b) => {
		const pa = presentationFor(a);
		const pb = presentationFor(b);
		if (pa.order !== pb.order) return pa.order - pb.order;
		return pa.label.localeCompare(pb.label);
	});
	const idWidth = Math.max(20, ...input.rules.map((r) => r.id.length));
	const lines = [
		` ${style$1(theme, "muted", "auto = aislop fix can change it; review = inspect and fix with a developer or agent.")}`,
		` ${style$1(theme, "muted", "impact = how strongly the finding contributes to the score.")}`,
		""
	];
	for (const engine of engines) {
		const presentation = presentationFor(engine);
		lines.push(` ${style$1(theme, "accent", presentation.label)}`);
		lines.push(`   ${style$1(theme, "muted", presentation.summary)}`);
		lines.push(`   ${style$1(theme, "dim", padEnd("Rule ID", idWidth))}  ${style$1(theme, "dim", "Sev")}    ${style$1(theme, "dim", "Fix")}     ${style$1(theme, "dim", "Impact")}          ${style$1(theme, "dim", "Meaning")}`);
		const rules = (byEngine.get(engine) ?? []).sort((a, b) => a.id.localeCompare(b.id));
		for (const r of rules) {
			const severityText = severityLabel(r.severity);
			const severity = style$1(theme, r.severity === "error" ? "danger" : "warn", padEnd(severityText, 5));
			const fixable = r.fixable ? style$1(theme, "accent", padEnd("auto", 6)) : style$1(theme, "muted", padEnd("review", 6));
			const impact = style$1(theme, "muted", padEnd(impactLabel(r.id), 15));
			lines.push(`   ${padEnd(r.id, idWidth)}  ${severity}  ${fixable}  ${impact}  ${descriptionForRule(r.id)}`);
		}
		lines.push("");
	}
	const invocation = input.invocation ?? detectInvocation();
	const tail = renderHintLine(`Run ${invocation} scan to check your project against these rules`) + renderHintLine(`Run ${invocation} init to choose engines and CI settings`);
	return `${header}${lines.join("\n")}\n${tail}`;
};
const buildRuleDetailRender = (rule, input = {}) => {
	const presentation = presentationFor(rule.engine);
	const header = input.includeHeader === false ? "" : renderHeader({
		version: APP_VERSION,
		command: "Rule detail",
		context: [presentation.label],
		brand: input.printBrand !== false
	});
	const rows = [
		["Rule", rule.id],
		["Engine", `${presentation.label} - ${presentation.summary}`],
		["Severity", severityLabel(rule.severity)],
		["Fix", `${fixModeLabel(rule.fixable)}${rule.fixable ? " (aislop fix can change it)" : " (review and fix intentionally)"}`],
		["Impact", `${impactLabel(rule.id)} - ${scoreImpactForRule(rule.id).rationale}`],
		["Meaning", descriptionForRule(rule.id)]
	];
	const labelWidth = Math.max(...rows.map(([label]) => label.length));
	return `${header}${rows.map(([label, value]) => {
		const valueToken = label === "Severity" && rule.severity === "error" ? "danger" : "fg";
		return ` ${style$1(theme, "muted", padEnd(label, labelWidth))}  ${highlightAislop(value, theme, valueToken)}`;
	}).join("\n")}\n\n${renderHintLine(rule.fixable ? "Run aislop fix to apply the automatic fix" : "Use the meaning above to fix or review the finding")}`;
};
//#endregion
//#region src/commands/rules.ts
const BUILTIN_RULES = [
	{
		engine: "format",
		rules: [
			"formatting",
			"import-order",
			"python-formatting",
			"go-formatting",
			"rust-formatting",
			"ruby-formatting",
			"php-formatting",
			"csharp-formatting",
			"cpp-formatting"
		]
	},
	{
		engine: "lint",
		rules: [
			"oxlint/*",
			"ruff/*",
			"go/*",
			"clippy/*",
			"rubocop/*",
			"typescript/*",
			"dotnet/*",
			"cppcheck/*",
			"clang-tidy/*"
		]
	},
	{
		engine: "code-quality",
		rules: [
			"knip/files",
			"knip/dependencies",
			"knip/devDependencies",
			"knip/unlisted",
			"knip/unresolved",
			"knip/binaries",
			"knip/exports",
			"knip/types",
			"knip/duplicates",
			"code-quality/duplicate-block",
			"code-quality/repeated-chained-call",
			"code-quality/unused-declaration",
			"complexity/file-too-large",
			"complexity/function-too-long",
			"complexity/deep-nesting",
			"complexity/too-many-params"
		]
	},
	{
		engine: "ai-slop",
		rules: [
			"ai-slop/trivial-comment",
			"ai-slop/swallowed-exception",
			"ai-slop/silent-recovery",
			"ai-slop/meta-comment",
			"ai-slop/hidden-fallback",
			"ai-slop/redundant-try-catch",
			"ai-slop/redundant-type-coercion",
			"ai-slop/duplicate-type-declaration",
			"ai-slop/thin-wrapper",
			"ai-slop/generic-naming",
			"ai-slop/unused-import",
			"ai-slop/unused-css",
			"ai-slop/console-leftover",
			"ai-slop/todo-stub",
			"ai-slop/unmarked-debt",
			"ai-slop/unreachable-code",
			"ai-slop/constant-condition",
			"ai-slop/empty-function",
			"ai-slop/unsafe-type-assertion",
			"ai-slop/double-type-assertion",
			"ai-slop/ts-directive",
			"ai-slop/narrative-comment",
			"ai-slop/duplicate-import",
			"ai-slop/hardcoded-url",
			"ai-slop/hardcoded-id",
			"ai-slop/python-bare-except",
			"ai-slop/python-broad-except",
			"ai-slop/python-mutable-default",
			"ai-slop/python-print-debug",
			"ai-slop/python-range-len-loop",
			"ai-slop/python-chained-dict-get",
			"ai-slop/python-repetitive-dispatch",
			"ai-slop/python-isinstance-ladder",
			"ai-slop/go-library-panic",
			"ai-slop/rust-non-test-unwrap",
			"ai-slop/rust-todo-stub",
			"ai-slop/hallucinated-import",
			"ai-slop/tautological-test",
			"ai-slop/csharp-not-implemented",
			"ai-slop/csharp-redundant-doc-comment",
			"ai-slop/csharp-async-void",
			"ai-slop/csharp-sync-over-async",
			"ai-slop/csharp-suppressed-warning",
			"ai-slop/csharp-empty-catch-rethrow",
			"ai-slop/csharp-null-forgiving",
			"ai-slop/csharp-console-leftover",
			"ai-slop/csharp-broad-catch",
			"ai-slop/csharp-linq-count",
			"ai-slop/csharp-index-loop",
			"ai-slop/csharp-if-ladder",
			"ai-slop/csharp-string-concat-in-loop",
			"ai-slop/cpp-not-implemented",
			"ai-slop/cpp-using-namespace-std-in-header",
			"ai-slop/cpp-c-style-cast",
			"ai-slop/cpp-manual-delete",
			"ai-slop/cpp-iostream-leftover",
			"ai-slop/cpp-null-literal",
			"ai-slop/cpp-define-constant",
			"ai-slop/cpp-endl-in-stream"
		]
	},
	{
		engine: "security",
		rules: [
			"security/hardcoded-secret",
			"security/vulnerable-dependency",
			"security/eval",
			"security/innerhtml",
			"security/dangerously-set-innerhtml",
			"security/sql-injection",
			"security/shell-injection",
			"security/unsafe-deserialization",
			"security/unsafe-c-call",
			"security/dependency-audit-skipped"
		]
	}
];
const collectRuleEntries = (directory) => {
	const resolvedDir = path.resolve(directory);
	const entries = [];
	for (const { engine, rules } of BUILTIN_RULES) for (const rule of rules) entries.push(toRuleEntry(engine, rule));
	const configDir = findConfigDir(resolvedDir);
	if (configDir) {
		const archRules = loadArchitectureRules(path.join(configDir, RULES_FILE));
		for (const rule of archRules) entries.push({
			id: `arch/${rule.name}`,
			engine: "architecture",
			severity: rule.severity,
			fixable: false
		});
	}
	return entries;
};
const runRulesExplorer = async (entries, options) => {
	const selected = await searchSelect({
		message: "Search rules",
		items: entries.map((rule) => {
			const presentation = presentationFor(rule.engine);
			return {
				value: rule,
				label: rule.id,
				hint: `${presentation.label} · ${severityLabel(rule.severity)} · ${descriptionForRule(rule.id)}`,
				keywords: [
					presentation.label,
					rule.engine,
					rule.severity,
					fixModeLabel(rule.fixable),
					descriptionForRule(rule.id)
				]
			};
		}),
		maxVisible: 10,
		required: true
	});
	if (selected === null) return;
	process.stdout.write(`${buildRuleDetailRender(selected, {
		printBrand: options.printBrand,
		includeHeader: true
	})}\n`);
};
const rulesCommand = async (directory, options = {}) => {
	const entries = collectRuleEntries(directory);
	if (options.interactive && process.stdin.isTTY && process.stdout.isTTY) {
		await runRulesExplorer(entries, options);
		return;
	}
	process.stdout.write(`${buildRulesRender({
		rules: entries,
		invocation: detectInvocation(),
		printBrand: options.printBrand
	})}\n`);
};
//#endregion
//#region src/utils/history.ts
const HISTORY_FILE = "history.jsonl";
const isHistoryDisabled = (env = process.env) => env.AISLOP_NO_HISTORY === "1";
const historyPath = (directory) => path.join(path.resolve(directory), CONFIG_DIR, HISTORY_FILE);
/**
* Append a compact scan record to .aislop/history.jsonl. Best-effort: never
* throws, so a read-only checkout or missing config dir can't break a scan.
*/
const appendHistory = (input) => {
	if (isHistoryDisabled()) return;
	const configDir = path.join(path.resolve(input.directory), CONFIG_DIR);
	if (!fs.existsSync(configDir)) return;
	const record = {
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		score: input.score,
		errors: input.errors,
		warnings: input.warnings,
		files: input.files,
		cliVersion: APP_VERSION
	};
	try {
		fs.appendFileSync(historyPath(input.directory), `${JSON.stringify(record)}\n`);
	} catch {}
};
const isHistoryRecord = (value) => {
	if (!value || typeof value !== "object") return false;
	const record = value;
	return typeof record.timestamp === "string" && typeof record.score === "number" && typeof record.errors === "number" && typeof record.warnings === "number" && typeof record.files === "number" && typeof record.cliVersion === "string";
};
const readHistory = (directory) => {
	const file = historyPath(directory);
	if (!fs.existsSync(file)) return [];
	const records = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isHistoryRecord(parsed)) records.push(parsed);
		} catch {}
	}
	return records;
};
//#endregion
//#region src/commands/trend.ts
const SPARK_TICKS = [
	"▁",
	"▂",
	"▃",
	"▄",
	"▅",
	"▆",
	"▇",
	"█"
];
const DEFAULT_LIMIT = 20;
const renderSparkline = (scores) => {
	if (scores.length === 0) return "";
	const min = Math.min(...scores);
	const span = Math.max(...scores) - min;
	return scores.map((score) => {
		if (span === 0) return SPARK_TICKS[SPARK_TICKS.length - 1];
		const ratio = (score - min) / span;
		const index = Math.round(ratio * (SPARK_TICKS.length - 1));
		return SPARK_TICKS[index];
	}).join("");
};
const relativePhrase = (count, unit, future) => {
	const phrase = `${count} ${count === 1 ? unit : `${unit}s`}`;
	return future ? `in ${phrase}` : `${phrase} ago`;
};
const formatRelativeTime = (timestamp, now = /* @__PURE__ */ new Date()) => {
	const date = new Date(timestamp);
	const nowMs = now.getTime();
	if (Number.isNaN(date.getTime()) || Number.isNaN(nowMs)) return timestamp;
	const diffMs = nowMs - date.getTime();
	const future = diffMs < 0;
	const absMs = Math.abs(diffMs);
	if (absMs < 45e3) return "just now";
	const minute = 6e4;
	const hour = 60 * minute;
	const day = 24 * hour;
	const week = 7 * day;
	const month = 30 * day;
	const year = 365 * day;
	if (absMs < hour) return relativePhrase(Math.max(1, Math.round(absMs / minute)), "minute", future);
	if (absMs < day) return relativePhrase(Math.max(1, Math.round(absMs / hour)), "hour", future);
	if (absMs < week) return relativePhrase(Math.max(1, Math.round(absMs / day)), "day", future);
	if (absMs < month) return relativePhrase(Math.max(1, Math.round(absMs / week)), "week", future);
	if (absMs < year) return relativePhrase(Math.max(1, Math.round(absMs / month)), "month", future);
	return relativePhrase(Math.max(1, Math.round(absMs / year)), "year", future);
};
const delta = (current, previous) => {
	if (previous === void 0) return "";
	const diff = current - previous;
	if (diff > 0) return style$1(theme, "success", `+${diff}`);
	if (diff < 0) return style$1(theme, "danger", `${diff}`);
	return style$1(theme, "muted", "0");
};
const buildTrendRender = (input) => {
	const header = renderHeader({
		version: APP_VERSION,
		command: "Score history",
		context: [],
		brand: input.printBrand !== false
	});
	if (input.records.length === 0) return `${header.trimEnd()}\n\n  ${style$1(theme, "muted", "No score history yet. Run a scan to start tracking trends.")}\n`;
	const limit = input.limit ?? DEFAULT_LIMIT;
	const recent = input.records.slice(-limit);
	const scores = recent.map((r) => r.score);
	const whenLabels = recent.map((record) => formatRelativeTime(record.timestamp, input.now));
	const whenWidth = Math.max(14, ...whenLabels.map((label) => label.length)) + 2;
	const lines = [header.trimEnd(), ""];
	lines.push(`  ${style$1(theme, "dim", padEnd("When", whenWidth))}${style$1(theme, "dim", padEnd("Score", 8))}${style$1(theme, "dim", padEnd("Change", 8))}${style$1(theme, "dim", padEnd("Err", 6))}${style$1(theme, "dim", "Warn")}`);
	recent.forEach((record, index) => {
		const previous = index > 0 ? recent[index - 1]?.score : void 0;
		lines.push(`  ${padEnd(whenLabels[index] ?? "", whenWidth)}${padEnd(String(record.score), 8)}${padEnd(delta(record.score, previous), 8)}${padEnd(String(record.errors), 6)}${record.warnings}`);
	});
	const latest = recent[recent.length - 1];
	lines.push("");
	lines.push(`  ${style$1(theme, "accent", renderSparkline(scores))}`);
	lines.push(`  ${style$1(theme, "muted", `${recent.length} run(s), latest score ${latest?.score}`)}`);
	lines.push(renderHintLine("Run aislop scan to add a new data point").trimEnd());
	return `${lines.join("\n")}\n`;
};
const trendCommand = (directory, limit) => {
	const records = readHistory(directory);
	process.stdout.write(buildTrendRender({
		records,
		limit
	}));
};
//#endregion
//#region src/update-notifier.ts
const REGISTRY_URL = "https://registry.npmjs.org/aislop/latest";
const CHECK_INTERVAL_MS = 1440 * 60 * 1e3;
const REQUEST_TIMEOUT_MS = 2e3;
const CACHE_BASENAME = "update_check.json";
const isUpdateNotifierDisabled = (env = process.env) => {
	if (env.AISLOP_NO_UPDATE_NOTIFIER === "1") return true;
	if (env.NO_UPDATE_NOTIFIER === "1") return true;
	if (env.DO_NOT_TRACK === "1") return true;
	return isCiEnv(env);
};
const resolveUpdateCachePath = (homedir = os.homedir(), env = process.env) => {
	if (process.platform === "linux" && env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "aislop", CACHE_BASENAME);
	return path.join(homedir, ".aislop", CACHE_BASENAME);
};
const parseVersion = (raw) => {
	const m = raw.trim().replace(/^v/, "").split(/[-+]/, 1)[0].match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3])
	};
};
const isOutdated = (current, latest) => {
	const c = parseVersion(current);
	const l = parseVersion(latest);
	if (!c || !l) return false;
	if (l.major !== c.major) return l.major > c.major;
	if (l.minor !== c.minor) return l.minor > c.minor;
	return l.patch > c.patch;
};
const formatUpdateNotice = (current, latest) => [
	"",
	`Update available: ${current} -> ${latest}.`,
	highlightAislop("Upgrade: npm i -g aislop@latest", theme),
	highlightAislop("One-off: npx aislop@latest", theme),
	""
].join("\n");
const readCache = (cachePath) => {
	try {
		const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		if (typeof parsed?.latest === "string" && typeof parsed?.checkedAt === "number") return {
			latest: parsed.latest,
			checkedAt: parsed.checkedAt
		};
		return null;
	} catch {
		return null;
	}
};
const writeCache = (cachePath, cache) => {
	try {
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify(cache));
		return true;
	} catch {
		return false;
	}
};
const fetchLatestVersion$1 = async () => {
	try {
		const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!res.ok) return null;
		const data = await res.json();
		return typeof data.version === "string" ? data.version : null;
	} catch {
		return null;
	}
};
const maybeNotifyUpdate = async (now = Date.now()) => {
	if (isUpdateNotifierDisabled()) return;
	if (!process.stderr.isTTY) return;
	const cachePath = resolveUpdateCachePath();
	const cache = readCache(cachePath);
	if (cache && isOutdated("0.16.1-agentic", cache.latest)) process.stderr.write(formatUpdateNotice(APP_VERSION, cache.latest));
	if (!cache || now - cache.checkedAt > CHECK_INTERVAL_MS) {
		const latest = await fetchLatestVersion$1();
		if (latest) writeCache(cachePath, {
			latest,
			checkedAt: now
		});
	}
};
//#endregion
//#region src/commands/update.ts
const buildUpdateStatusRender = (input) => {
	const state = !input.latest ? "could not reach the npm registry right now." : isOutdated(input.current, input.latest) ? `update available (${input.current} -> ${input.latest}).` : "aislop is up to date.";
	return `${[
		renderDisplaySection("Status"),
		...renderDisplayRows([
			{
				label: "Current",
				value: input.current
			},
			{
				label: "Latest",
				value: input.latest ?? "unavailable"
			},
			{
				label: "State",
				value: state
			}
		]),
		"",
		renderDisplaySection("Commands"),
		...renderDisplayCommandRows([{
			label: "Upgrade",
			command: "npm i -g aislop@latest"
		}, {
			label: "One-off",
			command: "npx aislop@latest"
		}])
	].join("\n")}\n`;
};
const updateCommand = async (options = {}) => {
	if (options.printBrand !== false) process.stdout.write(renderHeader({
		version: APP_VERSION,
		command: "Update check",
		context: ["npm"]
	}));
	const latest = await fetchLatestVersion$1();
	process.stdout.write(buildUpdateStatusRender({
		current: APP_VERSION,
		latest
	}));
};
//#endregion
//#region src/ui/link.ts
const terminalLink = (url, label = url) => {
	if (!process.stdout.isTTY || process.env.TERM === "dumb") return label;
	return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
};
//#endregion
//#region src/ui/command-reference-data.ts
const SCAN_FLAGS = [
	"--changes",
	"--staged",
	"--base <ref>",
	"-d, --verbose",
	"--json",
	"--sarif",
	"--format <format>",
	"--include <patterns>",
	"--exclude <patterns>"
];
const FIX_FLAGS = [
	"-d, --verbose",
	"-f, --force",
	"--safe",
	"--dry-run",
	"--changes",
	"--staged",
	"--base <ref>",
	"-p, --prompt",
	...[
		"--claude",
		"--codex",
		"--cursor",
		"--windsurf",
		"--vscode",
		"--amp",
		"--antigravity",
		"--deep-agents",
		"--gemini",
		"--kimi",
		"--opencode",
		"--warp",
		"--aider",
		"--goose",
		"--pi",
		"--crush"
	]
];
const AGENT_FLAGS = [
	"--provider <provider>",
	"--target-score <score>",
	"--max-turns <n>",
	"--limit <n>",
	"--in-place",
	"--apply",
	"-y, --yes",
	"--dry-run",
	"--background",
	"--no-fix",
	"--commit",
	"--pr",
	"--branch <name>",
	"--base <branch>",
	"--commit-message <message>",
	"--title <title>",
	"--ready",
	"--no-keep-worktree",
	"--cleanup"
];
const AGENT_MONITOR_FLAGS = [
	"--provider <provider>",
	"--target-score <score>",
	"--max-turns <n>",
	"--limit <n>",
	"--in-place",
	"--dry-run",
	"--no-fix",
	"--repair",
	"--background",
	"--interval <ms>",
	"--debounce <ms>",
	"--once"
];
const CI_FLAGS = [
	"--changes",
	"--staged",
	"--base <ref>",
	"--human",
	"--sarif",
	"--format <format>"
];
const HOOK_INSTALL_FLAGS = [
	"--agent <names>",
	"-g, --global",
	"--project",
	"--dry-run",
	"--yes",
	"--quality-gate",
	"--claude",
	"--cursor",
	"--gemini",
	"--pi",
	"--codex",
	"--windsurf",
	"--cline",
	"--kilocode",
	"--antigravity",
	"--copilot"
];
const HOOK_UNINSTALL_FLAGS = [
	"--agent <names>",
	"-g, --global",
	"--project",
	"--dry-run",
	"--claude",
	"--cursor",
	"--gemini",
	"--pi",
	"--codex",
	"--windsurf",
	"--cline",
	"--kilocode",
	"--antigravity",
	"--copilot"
];
const COMMAND_REFERENCE = [
	{
		command: "aislop [directory]",
		summary: "Open the interactive menu, or scan the current directory in non-TTY shells",
		flags: SCAN_FLAGS
	},
	{
		command: "aislop scan [directory]",
		summary: "Score code quality and show findings",
		flags: SCAN_FLAGS
	},
	{
		command: "aislop agent [directory]",
		summary: "Create a local worktree, stream a provider repair session, verify, and summarize",
		flags: AGENT_FLAGS
	},
	{
		command: "aislop fix [directory]",
		summary: "Apply deterministic auto-fixes, or hand remaining findings to an agent",
		flags: FIX_FLAGS
	},
	{
		command: "aislop agent plan [directory]",
		summary: "Preview provider, worktree, findings, and publish actions without editing",
		flags: AGENT_FLAGS
	},
	{
		command: "aislop agent providers",
		summary: "Show installed local provider status and setup hints"
	},
	{
		command: "aislop agent connect [provider]",
		summary: "Run the selected provider's local CLI login flow",
		flags: ["--dry-run"]
	},
	{
		command: "aislop agent use [provider]",
		summary: "Set or show the repo-local default repair provider",
		flags: ["--root <directory>", "--dry-run"]
	},
	{
		command: "aislop agent switch [provider]",
		summary: "Alias for agent use",
		flags: ["--root <directory>", "--dry-run"]
	},
	{
		command: "aislop agent monitor [directory]",
		summary: "Watch git changes and stream scan or repair cycles",
		flags: AGENT_MONITOR_FLAGS
	},
	{
		command: "aislop agent monitor list [directory]",
		summary: "List local background agent monitors",
		flags: ["--limit <n>"]
	},
	{
		command: "aislop agent monitor show [monitor]",
		summary: "Show a background agent monitor record",
		flags: ["--root <directory>"]
	},
	{
		command: "aislop agent monitor stop [monitor]",
		summary: "Stop a running background agent monitor",
		flags: ["--root <directory>", "--force"]
	},
	{
		command: "aislop agent sessions [directory]",
		summary: "List recent local agent sessions",
		flags: ["--limit <n>"]
	},
	{
		command: "aislop agent show [session]",
		summary: "Show a local agent session summary and timeline",
		flags: ["--root <directory>"]
	},
	{
		command: "aislop agent apply [session]",
		summary: "Apply a reviewed isolated worktree session back to the repo",
		flags: [
			"--root <directory>",
			"--dry-run",
			"-y, --yes"
		]
	},
	{
		command: "aislop agent watch [session]",
		summary: "Watch a local agent session as it streams",
		flags: [
			"--root <directory>",
			"--interval <ms>",
			"--once"
		]
	},
	{
		command: "aislop agent stop [session]",
		summary: "Stop a running background agent session",
		flags: ["--root <directory>", "--force"]
	},
	{
		command: "aislop ci [directory]",
		summary: "Run the CI quality gate with thresholded exit codes",
		flags: CI_FLAGS
	},
	{
		command: "aislop init [directory]",
		summary: "Create config, rules, and optional GitHub Actions workflow",
		flags: ["--strict"]
	},
	{
		command: "aislop doctor [directory]",
		summary: "Check installed engines and project coverage"
	},
	{
		command: "aislop rules [directory]",
		summary: "Explain rule IDs, severity, fixability, and meaning",
		flags: ["--search"]
	},
	{
		command: "aislop hook",
		summary: "Manage per-edit coding-agent hooks"
	},
	{
		command: "aislop hook install [agents...]",
		summary: "Install coding-agent hooks",
		flags: HOOK_INSTALL_FLAGS
	},
	{
		command: "aislop hook uninstall [agents...]",
		summary: "Remove installed coding-agent hooks",
		flags: HOOK_UNINSTALL_FLAGS
	},
	{
		command: "aislop hooks",
		summary: "Alias for hook"
	},
	{
		command: "aislop hook status",
		summary: "Show installed hook status"
	},
	{
		command: "aislop hook baseline",
		summary: "Capture the current score as the hook baseline"
	},
	{
		command: "aislop install [agents...]",
		summary: "Alias for hook install",
		flags: HOOK_INSTALL_FLAGS
	},
	{
		command: "aislop install hooks [agents...]",
		summary: "Natural alias for install; same flags",
		flags: HOOK_INSTALL_FLAGS
	},
	{
		command: "aislop uninstall [agents...]",
		summary: "Alias for hook uninstall",
		flags: HOOK_UNINSTALL_FLAGS
	},
	{
		command: "aislop uninstall hooks [agents...]",
		summary: "Natural alias for uninstall; same flags",
		flags: HOOK_UNINSTALL_FLAGS
	},
	{
		command: "aislop badge [directory]",
		summary: "Print score badge URL and README markdown",
		flags: [
			"--owner <owner>",
			"--repo <repo>",
			"--json"
		]
	},
	{
		command: "aislop trend [directory]",
		summary: "Show recent local scores from .aislop/history.jsonl",
		flags: ["--limit <n>"]
	},
	{
		command: "aislop trends [directory]",
		summary: "Alias for trend",
		flags: ["--limit <n>"]
	},
	{
		command: "aislop update",
		summary: "Show current and latest npm versions"
	},
	{
		command: "aislop upgrade",
		summary: "Alias for update"
	},
	{
		command: "aislop version",
		summary: "Print the installed version"
	},
	{
		command: "aislop commands",
		summary: "Show this command reference"
	}
];
const GUIDE_ROWS = [
	{
		label: "Use",
		value: "aislop commands is the full public command list with major flags."
	},
	{
		label: "Directory",
		value: "[directory] means a repo or path to scan; omit it for the current directory."
	},
	{
		label: "Help",
		value: "run aislop <command> --help for complete command-specific options."
	},
	{
		label: "Aliases",
		value: "natural aliases are listed when they are public entry points."
	}
];
const EXAMPLE_ROWS = [
	{
		label: "Scan",
		value: "aislop scan --changes"
	},
	{
		label: "Fix",
		value: "aislop fix --safe"
	},
	{
		label: "Agent",
		value: "aislop agent plan"
	},
	{
		label: "Hooks",
		value: "aislop hook status"
	},
	{
		label: "Trend",
		value: "aislop trends --limit 10"
	}
];
const FLAG_GUIDE_ROWS = [
	{
		label: "--changes",
		value: "scan or gate files changed from HEAD or --base"
	},
	{
		label: "--staged",
		value: "scan or gate staged files"
	},
	{
		label: "--json",
		value: "emit machine-readable scan output"
	},
	{
		label: "--sarif",
		value: "emit SARIF for code scanning"
	},
	{
		label: "--safe",
		value: "only apply reversible fixes"
	},
	{
		label: "--provider",
		value: "choose auto, codex, claude, or opencode for local agent runs"
	},
	{
		label: "--dry-run",
		value: "preview the action without writing changes"
	}
];
//#endregion
//#region src/ui/command-reference.ts
const MAX_FLAG_LINE_WIDTH = 120;
const commandGroupLabel = (command) => {
	if (command.startsWith("aislop agent")) return "Local Agent";
	if (command.startsWith("aislop scan")) return "Core Workflow";
	if (command.startsWith("aislop fix")) return "Core Workflow";
	if (command.startsWith("aislop ci")) return "Core Workflow";
	if (command.startsWith("aislop hook")) return "Hooks";
	if (command === "aislop hooks") return "Hooks";
	if (command.startsWith("aislop install")) return "Hooks";
	if (command.startsWith("aislop uninstall")) return "Hooks";
	if (command.startsWith("aislop init")) return "Project Setup";
	if (command.startsWith("aislop doctor")) return "Project Setup";
	if (command.startsWith("aislop rules")) return "Project Setup";
	if (command.startsWith("aislop badge")) return "Reporting";
	if (command.startsWith("aislop trend")) return "Reporting";
	return "General";
};
const groupedCommands = () => {
	const order = [
		"General",
		"Core Workflow",
		"Local Agent",
		"Project Setup",
		"Hooks",
		"Reporting"
	];
	const byGroup = /* @__PURE__ */ new Map();
	for (const label of order) byGroup.set(label, []);
	for (const item of COMMAND_REFERENCE) {
		const label = commandGroupLabel(item.command);
		byGroup.set(label, [...byGroup.get(label) ?? [], item]);
	}
	return order.map((label) => ({
		label,
		items: byGroup.get(label) ?? []
	})).filter((group) => group.items.length > 0);
};
const sentenceCase = (value) => value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1).toLowerCase()}`;
const wrapFlags = (flags, commandWidth) => {
	const label = "flags:";
	const flagLabelColumn = commandWidth + 3;
	const flagValueColumn = flagLabelColumn + 6 + 2;
	const firstPrefix = `${" ".repeat(flagLabelColumn)}${label}  `;
	const nextPrefix = `${" ".repeat(flagValueColumn)}`;
	const lines = [];
	let current = firstPrefix;
	for (const flag of flags) {
		const addition = current === firstPrefix || current === nextPrefix ? flag : `  ${flag}`;
		if (current !== firstPrefix && current.length + addition.length > MAX_FLAG_LINE_WIDTH) {
			lines.push(current);
			current = `${nextPrefix}${flag}`;
			continue;
		}
		current += addition;
	}
	if (current.trim()) lines.push(current);
	return lines;
};
const renderFlagLine = (line) => {
	const labelStart = line.indexOf("flags:");
	if (labelStart === -1) return style$1(theme, "dim", line);
	const labelEnd = labelStart + 6;
	return `${line.slice(0, labelStart)}${style$1(theme, "accentDim", "flags:")}${style$1(theme, "dim", line.slice(labelEnd))}`;
};
const renderCommandGroup = (group, commandWidth) => {
	const lines = ["", style$1(theme, "section", sentenceCase(group.label))];
	for (const item of group.items) {
		lines.push(` ${highlightAislop(padEnd(item.command, commandWidth), theme)}  ${style$1(theme, "fg", item.summary)}`);
		if (item.flags?.length) for (const line of wrapFlags(item.flags, commandWidth)) lines.push(renderFlagLine(line));
	}
	return lines;
};
const renderCommandReference = (input = {}) => {
	const version = input.version ?? "0.16.1-agentic";
	const commandWidth = Math.max(...COMMAND_REFERENCE.map((item) => item.command.length));
	const lines = [renderHeader({
		version,
		command: "Commands",
		context: ["full list"]
	}).trimEnd()];
	lines.push("", renderDisplaySection("Guide"), ...renderDisplayRows(GUIDE_ROWS, { labelWidth: 9 }), "", renderDisplaySection("Examples"), ...renderDisplayRows(EXAMPLE_ROWS, { labelWidth: 9 }), "", renderDisplaySection("Flag guide"), ...renderDisplayRows(FLAG_GUIDE_ROWS, { labelWidth: 10 }));
	for (const group of groupedCommands()) lines.push(...renderCommandGroup(group, commandWidth));
	lines.push("", renderDisplaySection("Scope files"), ...renderDisplayRows([{
		label: ".aislopignore",
		value: "skip generated, vendored, or noisy paths"
	}, {
		label: ".gitignore",
		value: "respected for untracked files"
	}], { labelWidth: 13 }));
	lines.push("", renderHintLine("Run aislop <command> --help for complete command-specific options").trimEnd());
	return `${lines.join("\n")}\n`;
};
//#endregion
//#region src/ui/home.ts
const HOME_COMMANDS = [
	{
		command: "aislop scan",
		summary: "Score this project and show findings",
		group: "Run"
	},
	{
		command: "aislop agent",
		summary: "Repair slop with your coding agent in an isolated worktree",
		group: "Run"
	},
	{
		command: "aislop fix",
		summary: "Auto-fix the mechanical issues deterministically",
		group: "Run"
	},
	{
		command: "aislop ci",
		summary: "Run the quality gate for CI",
		group: "Run"
	},
	{
		command: "aislop doctor",
		summary: "Check which engines can run here",
		group: "Run"
	},
	{
		command: "aislop init",
		summary: "Create config and optional CI workflow",
		group: "Setup"
	},
	{
		command: "aislop hook install",
		summary: "Run aislop after coding-agent edits",
		group: "Setup"
	},
	{
		command: "aislop rules",
		summary: "Explain every rule and fix mode",
		group: "Learn"
	},
	{
		command: "aislop trend",
		summary: "Show local score history",
		group: "Learn"
	},
	{
		command: "aislop badge",
		summary: "Print a score badge URL and README markdown",
		group: "Learn"
	},
	{
		command: "aislop commands",
		summary: "List all commands and major flags",
		group: "Utility"
	},
	{
		command: "aislop update",
		summary: "Check the latest npm version",
		group: "Learn"
	},
	{
		command: "aislop version",
		summary: "Print the installed version",
		group: "Utility"
	}
];
const GROUPS = [
	"Run",
	"Setup",
	"Learn",
	"Utility"
];
const COMMAND_PROMPT = ">";
const renderCommandGroups = () => {
	const commandWidth = Math.max(...HOME_COMMANDS.map((c) => c.command.length));
	const lines = [];
	for (const group of GROUPS) {
		lines.push(` ${style$1(theme, "dim", group)}`);
		for (const item of HOME_COMMANDS.filter((c) => c.group === group)) lines.push(`   ${style$1(theme, "muted", COMMAND_PROMPT)} ${highlightAislop(padEnd(item.command, commandWidth), theme)}  ${highlightAislop(item.summary, theme, "muted")}`);
		lines.push("");
	}
	return lines.join("\n");
};
const renderHelpDetails = () => [
	` ${style$1(theme, "dim", "Usage")}`,
	"   aislop                         Open interactive menu",
	"   aislop scan [options] [directory]",
	"   aislop agent [options] [directory]",
	"   aislop fix [options] [directory]",
	"   aislop ci [options] [directory]",
	"   aislop init [options] [directory]",
	"   aislop doctor [directory]",
	"   aislop rules [directory]",
	"   aislop badge [options] [directory]",
	"   aislop trend [options] [directory]",
	"   aislop trends [options] [directory]",
	"   aislop hook [command]",
	"   aislop hook install [agents...]",
	"   aislop install hooks [agents...]",
	"   aislop update",
	"   aislop version",
	"",
	` ${style$1(theme, "dim", "Interactive")}`,
	"   > aislop                       open the menu",
	"   Scan                           Score this project and show findings",
	"   Agent                          Run a coding agent to repair slop",
	"   Fix                            Auto-fix the mechanical issues",
	"   Doctor                         Check installed engines and tools",
	"   Install hooks                  Run aislop after agent edits",
	"",
	` ${style$1(theme, "dim", "Scan flags")}`,
	"   --changes        scan changed files from HEAD",
	"   --staged         scan staged files",
	"   --base           diff base for --changes",
	"   --json           emit machine-readable JSON",
	"   --sarif          emit SARIF 2.1.0",
	"   --format         choose json or sarif",
	"   --exclude        exclude comma-separated or repeated paths",
	"   --include        include comma-separated or repeated paths",
	"",
	` ${style$1(theme, "dim", "Fix flags")}`,
	"   --safe           only reversible fixes",
	"   --force          aggressive dependency and framework fixes",
	"   --prompt         print an agent handoff prompt",
	"   --codex          open Codex to fix remaining findings",
	"   --claude         open Claude Code to fix remaining findings",
	"",
	` ${style$1(theme, "dim", "Agent flags")}`,
	"   --provider       choose auto, codex, claude, or opencode",
	"   --target-score   score to converge toward",
	"   --in-place       edit the current worktree",
	"   --apply          apply the accepted diff back",
	"   --background     start locally and return immediately",
	"   --commit         commit the verified diff",
	"   --pr             push and open a draft pull request",
	"",
	` ${style$1(theme, "dim", "Agent commands")}`,
	"   aislop agent plan             preview provider, worktree, findings, and publish actions",
	"   aislop agent providers        show local provider status",
	"   aislop agent connect          connect Codex, Claude Code, or OpenCode locally",
	"   aislop agent use              set the repo-local default provider",
	"   aislop agent switch           alias for agent use",
	"   aislop agent monitor          watch git changes and stream scan cycles",
	"   aislop agent monitor list     list background monitors",
	"   aislop agent monitor show     show a background monitor",
	"   aislop agent monitor stop     stop a background monitor",
	"   aislop agent sessions         list local session transcripts",
	"   aislop agent show             show a session timeline and summary",
	"   aislop agent apply            apply a reviewed worktree session",
	"   aislop agent watch            stream session transcript updates",
	"   aislop agent stop             stop a background session",
	"",
	` ${style$1(theme, "dim", "Hook commands")}`,
	"   aislop hook                   manage coding-agent hooks",
	"   aislop hook install           install coding-agent hooks",
	"   aislop hook uninstall         remove coding-agent hooks",
	"   aislop hook status            show installed hooks",
	"   aislop hook baseline          capture the current score baseline",
	"   aislop install hooks          natural alias for hook install",
	"   aislop uninstall hooks        natural alias for hook uninstall",
	"",
	` ${style$1(theme, "dim", "Ignore and scope")}`,
	"   .aislopignore    skip generated, vendored, or noisy paths",
	"   .gitignore       respected for untracked files",
	"   --exclude        skip extra paths for this run",
	"   --include        scan only matching paths for this run",
	"",
	` ${style$1(theme, "dim", "More")}`,
	"   aislop commands        show every command and major flag",
	"   aislop <cmd> --help    show detailed help for one command",
	"   -h, --help             show help",
	"   -v, -V, --version      show version",
	"",
	` ${style$1(theme, "dim", "One-off latest run")}`,
	"   npx aislop@latest scan",
	"",
	` ${style$1(theme, "dim", "Examples")}`,
	"   aislop scan --changes",
	"   aislop fix --codex",
	"   aislop agent plan",
	"   aislop agent connect codex",
	"   aislop agent use codex",
	"   aislop agent monitor --once",
	"   aislop agent monitor --background",
	"   aislop agent monitor list",
	"   aislop agent --provider codex",
	"   aislop agent sessions",
	"   aislop agent show",
	"   aislop agent apply",
	"   aislop agent watch",
	"   aislop agent stop",
	"   aislop agent --provider claude --pr",
	"   aislop hook install --claude",
	"   aislop install hooks",
	"   aislop rules --search",
	"   aislop trends --limit 10",
	""
].map((line) => highlightAislop(line, theme)).join("\n");
const renderHome = (input = {}) => {
	let out = renderHeader({
		version: input.version ?? "0.16.1-agentic",
		command: "--bare",
		context: []
	});
	out += `${renderCommandGroups().trimEnd()}\n`;
	out += `\n ${style$1(theme, "dim", "Team platform")}\n   ${style$1(theme, "muted", "Gate every PR and share one standard across your team")}  ${style$1(theme, "accent", terminalLink("https://scanaislop.com"))}\n`;
	if (input.includeHelpDetails) {
		out += `\n${renderHelpDetails().trimEnd()}\n`;
		out += renderHintLine("Run aislop scan to scan your project");
	}
	return out;
};
const renderRootHelp = (input = {}) => `${renderHome({
	version: input.version,
	includeHelpDetails: true
})}\n`;
//#endregion
//#region src/cli-extra-commands.ts
const registerExtraCommands = (program) => {
	program.command("rules [directory]").description("Explain rules, severity, and fix mode").option("-s, --search", "open an interactive searchable rule explorer").action(async (directory = ".", _flags, command) => {
		const flags = command.optsWithGlobals();
		await withCommandLifecycle({
			command: "rules",
			config: loadConfig(directory).telemetry
		}, async () => {
			await rulesCommand(directory, { interactive: Boolean(flags.search) });
			return { exitCode: 0 };
		});
	});
	program.command("badge [directory]").description("Print score badge URL and README markdown").option("--owner <owner>", "GitHub owner (auto-detected from git remote if omitted)").option("--repo <repo>", "GitHub repo name (auto-detected from git remote if omitted)").option("--json", "emit machine-readable JSON instead of the rendered output").action(async (directory = ".", _flags, command) => {
		const flags = command.optsWithGlobals();
		try {
			await withCommandLifecycle({
				command: "badge",
				config: loadConfig(directory).telemetry
			}, async () => {
				await badgeCommand({
					directory,
					owner: flags.owner,
					repo: flags.repo,
					json: Boolean(flags.json)
				});
				return { exitCode: 0 };
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to print badge";
			process.stderr.write(`${message}\n`);
			process.exit(1);
		}
	});
	program.command("trend [directory]").alias("trends").description("Show local score history").option("--limit <n>", "number of recent runs to show", (v) => Number.parseInt(v, 10)).action(async (directory = ".", _flags, command) => {
		const flags = command.optsWithGlobals();
		await withCommandLifecycle({
			command: "trend",
			config: loadConfig(directory).telemetry
		}, async () => {
			trendCommand(directory, flags.limit);
			return { exitCode: 0 };
		});
	});
	program.command("update").alias("upgrade").description("Check npm for the latest aislop version").action(async () => {
		await updateCommand();
	});
	program.command("version").description("Print the installed aislop version").action(() => {
		process.stdout.write(`${APP_VERSION}\n`);
	});
	program.command("commands").description("List all commands and major flags").action(() => {
		process.stdout.write(renderCommandReference({ version: APP_VERSION }));
	});
};
//#endregion
//#region src/cli-fix-agents.ts
const FIX_AGENT_FLAGS = [
	{
		flag: "claude",
		name: "claude",
		help: "open Claude Code to fix remaining issues"
	},
	{
		flag: "codex",
		name: "codex",
		help: "open Codex to fix remaining issues"
	},
	{
		flag: "cursor",
		name: "cursor",
		help: "open Cursor and copy prompt to clipboard"
	},
	{
		flag: "windsurf",
		name: "windsurf",
		help: "open Windsurf and copy prompt to clipboard"
	},
	{
		flag: "vscode",
		name: "vscode",
		help: "open VS Code and copy prompt to clipboard"
	},
	{
		flag: "amp",
		name: "amp",
		help: "open Amp to fix remaining issues"
	},
	{
		flag: "antigravity",
		name: "antigravity",
		help: "open Antigravity to fix remaining issues"
	},
	{
		flag: "deep-agents",
		name: "deepAgents",
		help: "open Deep Agents to fix remaining issues"
	},
	{
		flag: "gemini",
		name: "gemini",
		help: "open Gemini CLI to fix remaining issues"
	},
	{
		flag: "kimi",
		name: "kimi",
		help: "open Kimi Code CLI to fix remaining issues"
	},
	{
		flag: "opencode",
		name: "opencode",
		help: "open OpenCode to fix remaining issues"
	},
	{
		flag: "warp",
		name: "warp",
		help: "open Warp to fix remaining issues"
	},
	{
		flag: "aider",
		name: "aider",
		help: "open Aider to fix remaining issues"
	},
	{
		flag: "goose",
		name: "goose",
		help: "open Goose to fix remaining issues"
	},
	{
		flag: "pi",
		name: "pi",
		help: "open pi to fix remaining issues"
	},
	{
		flag: "crush",
		name: "crush",
		help: "open Crush to fix remaining issues"
	}
];
const matchFixAgent = (flags) => {
	return FIX_AGENT_FLAGS.find((a) => flags[a.name])?.flag;
};
//#endregion
//#region src/engagement/pilot-invitation.ts
const STATE_BASENAME = "pilot_invitation.scans";
const INVITATION_SCAN_THRESHOLD = 3;
const PRIVATE_FILE_MODE = 384;
const SCAN_RECORD = "1\n";
const MAX_COUNTER_BYTES = 4096;
const resolvePilotInvitationStatePath = (homedir = os.homedir(), env = process.env) => {
	if (process.platform === "linux" && env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "aislop", STATE_BASENAME);
	return path.join(homedir, ".aislop", STATE_BASENAME);
};
const readCounter = (fileDescriptor, size) => {
	const buffer = Buffer.alloc(size);
	if (size > 0) fs.readSync(fileDescriptor, buffer, 0, size, 0);
	return buffer.toString("utf8");
};
const resolveNoFollowFlag = () => {
	const value = Reflect.get(fs.constants, "O_NOFOLLOW");
	return typeof value === "number" && value !== 0 ? value : null;
};
const ensureStateDirectory = (directory) => {
	try {
		if (!fs.existsSync(directory)) fs.mkdirSync(directory, {
			recursive: true,
			mode: 448
		});
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory()) return false;
		if ((stat.mode & 511) !== 448) fs.chmodSync(directory, 448);
		return true;
	} catch {
		return false;
	}
};
const appendScan = (statePath, noFollowFlag) => {
	if (noFollowFlag === null) return null;
	let fileDescriptor;
	try {
		if (!ensureStateDirectory(path.dirname(statePath))) return null;
		const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR | noFollowFlag;
		fileDescriptor = fs.openSync(statePath, flags, PRIVATE_FILE_MODE);
		const initialStat = fs.fstatSync(fileDescriptor);
		if (!initialStat.isFile() || initialStat.size > MAX_COUNTER_BYTES) return null;
		fs.fchmodSync(fileDescriptor, PRIVATE_FILE_MODE);
		const existing = readCounter(fileDescriptor, initialStat.size);
		if (!/^(1\n)*$/.test(existing)) return null;
		fs.writeSync(fileDescriptor, SCAN_RECORD);
		fs.fsyncSync(fileDescriptor);
		const finalSize = fs.fstatSync(fileDescriptor).size;
		return Math.floor(finalSize / Buffer.byteLength(SCAN_RECORD));
	} catch {
		return null;
	} finally {
		if (fileDescriptor !== void 0) fs.closeSync(fileDescriptor);
	}
};
const claimInvitation = (statePath) => {
	const claimPath = `${statePath}.shown`;
	try {
		fs.writeFileSync(claimPath, "", {
			flag: "wx",
			mode: PRIVATE_FILE_MODE
		});
		fs.chmodSync(claimPath, PRIVATE_FILE_MODE);
		return true;
	} catch {
		return false;
	}
};
const invitationAlreadyClaimed = (statePath) => {
	const claimPath = `${statePath}.shown`;
	try {
		return fs.lstatSync(claimPath).isFile();
	} catch {
		return false;
	}
};
const recordCompletedFullScan = (statePath = resolvePilotInvitationStatePath(), noFollowFlag = resolveNoFollowFlag()) => {
	if (invitationAlreadyClaimed(statePath)) return false;
	const completedFullScans = appendScan(statePath, noFollowFlag);
	return completedFullScans !== null && completedFullScans >= INVITATION_SCAN_THRESHOLD && claimInvitation(statePath);
};
//#endregion
//#region src/engagement/full-scan-activity.ts
const recordFullScanActivity = (history, allowPilotInvitation, telemetryConfig) => {
	appendHistory(history);
	return allowPilotInvitation && !isHistoryDisabled() && !isTelemetryDisabled(telemetryConfig) && recordCompletedFullScan();
};
//#endregion
//#region src/utils/change-context.ts
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const stripDiffPrefix = (filePath) => {
	if (filePath === "/dev/null") return filePath;
	return filePath.replace(/^[ab]\//, "");
};
const parseHunkRange = (startText, countText) => {
	const start = Number(startText);
	const count = countText === void 0 ? 1 : Number(countText);
	if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) return null;
	return {
		start,
		end: start + count - 1
	};
};
const FILE_HEADER_RE = /^\+\+\+ (?:[ab]\/|\/dev\/null$)/;
const parseUnifiedDiffHunks = (diff) => {
	const byFile = /* @__PURE__ */ new Map();
	let current = null;
	let inHunkBody = false;
	for (const raw of diff.split(/\r?\n/)) {
		if (raw.startsWith("diff --git ") || raw.startsWith("rename to ")) inHunkBody = false;
		if (raw.startsWith("rename to ")) {
			current = toPosix(raw.slice(10).trim());
			if (current && !byFile.has(current)) byFile.set(current, []);
			continue;
		}
		if (!inHunkBody && FILE_HEADER_RE.test(raw)) {
			const name = stripDiffPrefix(raw.slice(4).trim());
			current = name === "/dev/null" ? null : toPosix(name);
			if (current && !byFile.has(current)) byFile.set(current, []);
			continue;
		}
		if (!current) continue;
		const match = HUNK_RE.exec(raw);
		if (!match) continue;
		inHunkBody = true;
		const range = parseHunkRange(match[3], match[4]);
		if (!range) continue;
		const ranges = byFile.get(current);
		if (ranges) ranges.push(range);
	}
	const result = /* @__PURE__ */ new Map();
	for (const [filePath, ranges] of byFile) result.set(filePath, {
		kind: "hunks",
		ranges
	});
	return result;
};
const lookupChangedLines = (map, rootDirectory, filePath) => {
	const slashPath = filePath.split("\\").join("/");
	const relative = projectRelativePosix(rootDirectory, slashPath);
	return map.get(relative) ?? map.get(toPosix(slashPath)) ?? map.get(slashPath);
};
const classifyChangeContext = (diagnostic, map, rootDirectory) => {
	if (diagnostic.line <= 0) return "unknown";
	const entry = lookupChangedLines(map, rootDirectory, diagnostic.filePath);
	if (!entry) return "unknown";
	if (entry.kind === "all") return "changed-line";
	if (entry.ranges.some((range) => diagnostic.line >= range.start && diagnostic.line <= range.end)) return "changed-line";
	return "existing-file-context";
};
const applyChangeContext = (diagnostics, map, rootDirectory) => diagnostics.map((diagnostic) => ({
	...diagnostic,
	changeContext: classifyChangeContext(diagnostic, map, rootDirectory)
}));
const changeContextOrder = (context) => {
	if (context === "changed-line") return 0;
	if (context === "existing-file-context") return 1;
	return 2;
};
//#endregion
//#region src/output/engine-info.ts
const ENGINE_INFO = {
	format: {
		label: "Formatting",
		description: "Whitespace, indentation, line wrapping, and import ordering"
	},
	lint: {
		label: "Linting",
		description: "Static analysis for likely bugs and bad patterns"
	},
	"code-quality": {
		label: "Code Quality",
		description: "Complexity limits, dead code detection, and duplication checks"
	},
	"ai-slop": {
		label: "AI Slop",
		description: "Narrative comments, dead patterns, unsafe type casts, TODO stubs, generic names"
	},
	architecture: {
		label: "Architecture",
		description: "Project-specific import and layering rules"
	},
	security: {
		label: "Security",
		description: "Secret leaks, risky APIs, and dependency vulnerabilities"
	}
};
const getEngineLabel = (engine) => ENGINE_INFO[engine].label;
//#endregion
//#region src/output/terminal.ts
const groupBy = (items, key) => {
	const map = /* @__PURE__ */ new Map();
	for (const item of items) {
		const k = key(item);
		const group = map.get(k) ?? [];
		group.push(item);
		map.set(k, group);
	}
	return map;
};
const colorBySeverity = (text, severity) => severity === "error" ? style$1(theme, "danger", text) : style$1(theme, "warn", text);
const toElapsedLabel = (elapsedMs) => elapsedMs < 1e3 ? `${Math.round(elapsedMs)}ms` : `${(elapsedMs / 1e3).toFixed(1)}s`;
const toSeverityLabel = (severity) => {
	if (severity === "error") return "ERROR";
	if (severity === "warning") return "WARN";
	return "INFO";
};
const toLocationLabel = (diagnostic) => {
	const line = diagnostic.line > 0 ? `:${diagnostic.line}` : "";
	const column = diagnostic.column > 0 ? `:${diagnostic.column}` : "";
	return `${diagnostic.filePath}${line}${column}`;
};
const wrapText = (text, maxWidth, firstIndentWidth, contIndent) => {
	const firstWidth = Math.max(20, maxWidth - firstIndentWidth);
	const contWidth = Math.max(20, maxWidth - contIndent.length);
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	const lines = [];
	let current = "";
	for (const word of words) {
		const budget = lines.length === 0 ? firstWidth : contWidth;
		if (current.length === 0) current = word;
		else if (current.length + 1 + word.length <= budget) current = `${current} ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines.map((line, i) => i === 0 ? line : `${contIndent}${line}`);
};
const wrapHelpText = (text, maxWidth, indent) => {
	return wrapText(text, maxWidth, indent.length, indent).map((seg, i) => i === 0 ? `${indent}${seg}` : seg);
};
const terminalWidth = () => {
	const raw = process.stdout.columns;
	if (typeof raw !== "number" || raw <= 0) return 120;
	return Math.min(raw, 120);
};
const renderRuleHeader = (first, count, lines) => {
	const level = toSeverityLabel(first.severity);
	const countLabel = count > 1 ? ` (${count})` : "";
	const status = colorBySeverity(level, first.severity);
	const fixableTag = first.fixable ? ` ${style$1(theme, "muted", "[auto]")}` : "";
	const fixableWidth = first.fixable ? 7 : 0;
	const badgePrefix = `    [${status}]${fixableTag} `;
	const badgePrefixWidth = 5 + level.length + 1 + fixableWidth + 1;
	const wrapped = wrapText(`${first.message}${countLabel}`, terminalWidth(), badgePrefixWidth, "      ");
	lines.push(`${badgePrefix}${wrapped[0]}`);
	for (let i = 1; i < wrapped.length; i++) lines.push(wrapped[i]);
};
const renderLocations = (ruleDiags, verbose, lines) => {
	const unique = [];
	const seen = /* @__PURE__ */ new Set();
	for (const d of ruleDiags) {
		const label = toLocationLabel(d);
		const detail = d.detail ?? "";
		const key = `${label}|${detail}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push({
			label,
			detail
		});
	}
	const shown = verbose ? unique : unique.slice(0, 3);
	const maxLabel = shown.reduce((w, l) => Math.max(w, l.label.length), 0);
	for (const { label, detail } of shown) {
		const padded = detail ? `${label.padEnd(maxLabel)}  ${detail}` : label;
		lines.push(style$1(theme, "muted", `      ${padded}`));
	}
	if (!verbose && unique.length > shown.length) lines.push(style$1(theme, "muted", `      +${unique.length - shown.length} more location(s), use -d for full list`));
};
const renderHiddenFooter = (sorted, maxRules, lines) => {
	const hidden = sorted.slice(maxRules);
	const hiddenErrors = hidden.reduce((acc, [, diags]) => acc + (diags[0].severity === "error" ? diags.length : 0), 0);
	const hiddenWarnings = hidden.reduce((acc, [, diags]) => acc + (diags[0].severity === "warning" ? diags.length : 0), 0);
	const parts = [];
	if (hiddenErrors > 0) parts.push(`${hiddenErrors} error${hiddenErrors === 1 ? "" : "s"}`);
	if (hiddenWarnings > 0) parts.push(`${hiddenWarnings} warning${hiddenWarnings === 1 ? "" : "s"}`);
	const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	lines.push(style$1(theme, "muted", `    ... and ${hidden.length} more rules hidden${detail}. Run with -v or --verbose to see full output.`));
	lines.push("");
};
const CHANGE_CONTEXT_HEADING = {
	"changed-line": "Changed lines",
	"existing-file-context": "Existing file context",
	unknown: "Unclassified"
};
const renderEngineGroups = (diagnostics, verbose, lines) => {
	const byEngine = groupBy(diagnostics, (d) => d.engine);
	for (const [engine, engineDiags] of byEngine) {
		const label = getEngineLabel(engine);
		lines.push(`  ${style$1(theme, "bold", `${symbols.engineActive} ${label}`)}`);
		const sorted = [...groupBy(engineDiags, (d) => `${d.rule}:${d.message}`).entries()].sort(([, a], [, b]) => {
			const sa = a[0].severity === "error" ? 0 : a[0].severity === "warning" ? 1 : 2;
			const sb = b[0].severity === "error" ? 0 : b[0].severity === "warning" ? 1 : 2;
			if (sa !== sb) return sa - sb;
			return b.length - a.length;
		});
		const maxRules = verbose ? Infinity : 40;
		for (const [, ruleDiags] of sorted.slice(0, maxRules)) {
			const first = ruleDiags[0];
			renderRuleHeader(first, ruleDiags.length, lines);
			renderLocations(ruleDiags, verbose, lines);
			if (first.help) {
				const wrapped = wrapHelpText(first.help, terminalWidth(), "      ");
				for (const line of wrapped) lines.push(highlightAislop(line, theme, "muted"));
			}
			lines.push("");
		}
		if (sorted.length > maxRules) renderHiddenFooter(sorted, maxRules, lines);
	}
};
const renderDiagnostics = (diagnostics, verbose) => {
	const lines = [];
	if (!diagnostics.some((diagnostic) => diagnostic.changeContext)) {
		renderEngineGroups(diagnostics, verbose, lines);
		return `${lines.join("\n")}\n`;
	}
	const partitions = /* @__PURE__ */ new Map();
	for (const diagnostic of [...diagnostics].sort((left, right) => changeContextOrder(left.changeContext) - changeContextOrder(right.changeContext))) {
		const key = diagnostic.changeContext ?? "unknown";
		const group = partitions.get(key) ?? [];
		group.push(diagnostic);
		partitions.set(key, group);
	}
	for (const key of [
		"changed-line",
		"existing-file-context",
		"unknown"
	]) {
		const group = partitions.get(key);
		if (!group || group.length === 0) continue;
		lines.push(`  ${style$1(theme, "section", CHANGE_CONTEXT_HEADING[key])}`);
		renderEngineGroups(group, verbose, lines);
	}
	return `${lines.join("\n")}\n`;
};
const printEngineStatus = (result) => {
	const label = getEngineLabel(result.engine);
	const elapsed = toElapsedLabel(result.elapsed);
	if (result.skipped) log.warn(`${label}: skipped${result.skipReason ? ` (${result.skipReason})` : ""}`);
	else if (result.diagnostics.length === 0) log.success(`${label}: done (0 issues, ${elapsed})`);
	else {
		const errors = result.diagnostics.filter((d) => d.severity === "error").length;
		const warnings = result.diagnostics.filter((d) => d.severity === "warning").length;
		const parts = [];
		if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
		if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
		const statusText = `${parts.join(", ")}, ${elapsed}`;
		if (errors > 0) log.error(`${label}: done (${statusText})`);
		else log.warn(`${label}: done (${statusText})`);
	}
};
//#endregion
//#region src/utils/git.ts
const MAX_BUFFER = 50 * 1024 * 1024;
const baseRefExists = (cwd, ref) => {
	const result = spawnSync("git", [
		"rev-parse",
		"--verify",
		"--quiet",
		`${ref}^{commit}`
	], {
		cwd,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER
	});
	return !result.error && result.status === 0;
};
const getChangedFiles = (cwd, base) => {
	const diff = spawnSync("git", [
		"diff",
		"--no-color",
		"--name-only",
		"--diff-filter=ACMR",
		base ?? "HEAD"
	], {
		cwd,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER
	});
	if (diff.error || diff.status !== 0) return [];
	const untracked = spawnSync("git", [
		"ls-files",
		"--others",
		"--exclude-standard"
	], {
		cwd,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER
	});
	const names = /* @__PURE__ */ new Set();
	for (const line of diff.stdout.split("\n")) if (line.length > 0) names.add(line);
	if (!untracked.error && untracked.status === 0) {
		for (const line of untracked.stdout.split("\n")) if (line.length > 0) names.add(line);
	}
	return Array.from(names).map((f) => path.resolve(cwd, f));
};
const getStagedFiles = (cwd) => {
	const result = spawnSync("git", [
		"diff",
		"--no-color",
		"--cached",
		"--name-only",
		"--diff-filter=ACMR"
	], {
		cwd,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER
	});
	if (result.error || result.status !== 0) return [];
	return result.stdout.split("\n").filter((f) => f.length > 0).map((f) => path.resolve(cwd, f));
};
const listUntrackedFiles = (cwd) => {
	const untracked = spawnSync("git", [
		"ls-files",
		"--others",
		"--exclude-standard"
	], {
		cwd,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER
	});
	if (untracked.error || untracked.status !== 0) return [];
	return untracked.stdout.split("\n").filter((line) => line.length > 0);
};
const getChangedLineMap = (cwd, base) => {
	const diff = spawnSync("git", [
		"diff",
		"--no-color",
		"--no-ext-diff",
		"-U0",
		"--diff-filter=ACMR",
		base ?? "HEAD"
	], {
		cwd,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER
	});
	const map = !diff.error && diff.status === 0 ? parseUnifiedDiffHunks(diff.stdout) : /* @__PURE__ */ new Map();
	for (const name of listUntrackedFiles(cwd)) map.set(projectRelativePosix(cwd, path.resolve(cwd, name)), { kind: "all" });
	return map;
};
//#endregion
//#region src/commands/scan-coverage.ts
const coverageReason = (c) => {
	if (c.supportedFiles === 0 && c.dominantUnsupported) return `This repository is ${c.dominantUnsupported} (${c.unsupportedFiles} files), which aislop does not analyze. No score — it would not reflect this code.`;
	if (c.supportedFiles === 0) return "No files in a language aislop analyzes (TypeScript, JavaScript, Python, Go, Rust, Ruby, PHP, Java). Nothing to score.";
	const lang = c.dominantUnsupported ?? "an unsupported language";
	const files = `${c.supportedFiles} supported file${c.supportedFiles === 1 ? "" : "s"}`;
	return `This repository is mostly ${lang} (${c.unsupportedFiles} files); aislop analyzed only ${files}. Score withheld — it would represent a sliver of the codebase.`;
};
const renderCoverageNotice = (projectInfo, includeHeader) => {
	const deps = {
		theme: createTheme(),
		symbols: createSymbols({ plain: false })
	};
	return `${includeHeader === false ? "" : renderHeader({
		version: APP_VERSION,
		command: "Scan result",
		context: [
			projectInfo.projectName,
			projectInfo.languages[0] ?? "unknown",
			`${projectInfo.sourceFileCount} files`
		],
		brand: true
	}, deps)}  ${coverageReason(projectInfo.coverage)}\n\n`;
};
//#endregion
//#region src/ui/live-grid.ts
const SPINNER = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏"
];
const fmtElapsed = (ms) => ms === void 0 ? "—" : ms < 1e3 ? `${Math.round(ms)}ms` : `${(ms / 1e3).toFixed(1)}s`;
const statusText = (row) => {
	if (row.summary) return row.summary;
	if (row.status === "running") return "running";
	if (row.status === "queued") return "queued";
	if (row.status === "skipped") return "skipped";
	return "done";
};
const isComplete = (row) => row.status === "done" || row.status === "skipped";
const summarizeActiveRows = (rows) => {
	const running = rows.filter((row) => row.status === "running");
	if (running.length > 0) {
		const labels = running.slice(0, 2).map((row) => row.label);
		const extra = running.length > labels.length ? ` +${running.length - labels.length}` : "";
		return `running ${labels.join(", ")}${extra}`;
	}
	if (rows.filter((row) => row.status === "queued").length === rows.length) return "starting";
	const issueRows = rows.filter((row) => isComplete(row) && row.summary && row.summary !== "0 issues").slice(0, 2).map((row) => `${row.label}: ${row.summary}`);
	if (issueRows.length > 0) return issueRows.join(" · ");
	return "finishing";
};
const progressOutcome = (rows) => {
	if (rows.some((row) => row.status === "running")) return "running";
	if (rows.every((row) => row.status === "queued")) return "queued";
	if (rows.some((row) => row.outcome === "fail")) return "fail";
	if (rows.some((row) => row.outcome === "warn")) return "warn";
	return "ok";
};
const renderProgressLine = (input, deps = {}) => {
	const t = deps.theme ?? theme;
	const s = deps.symbols ?? symbols;
	const rows = input.rows;
	const total = rows.length;
	const complete = rows.filter(isComplete).length;
	const outcome = progressOutcome(rows);
	const token = outcome === "fail" ? "danger" : outcome === "warn" ? "warn" : outcome === "running" ? "info" : "muted";
	const glyph = outcome === "running" ? SPINNER[(deps.spinnerFrame ?? 0) % SPINNER.length] : outcome === "fail" ? s.fail : outcome === "warn" ? s.warn : outcome === "ok" ? s.pass : s.pending;
	const raw = `Scan ${complete}/${total} engines · ${summarizeActiveRows(rows)}`;
	const columns = Math.max(32, deps.columns ?? 120);
	const line = truncate(raw, Math.max(12, columns - 3));
	return ` ${style$1(t, token, glyph)} ${style$1(t, "muted", line)}`;
};
var LiveGrid = class {
	rows;
	frame = 0;
	visible = false;
	timer;
	write;
	tty;
	columns;
	constructor(rows, opts = {}) {
		this.rows = rows;
		this.write = opts.write ?? ((s) => process.stderr.write(s));
		this.tty = opts.tty ?? Boolean(process.stderr.isTTY);
		const columns = opts.columns;
		this.columns = typeof columns === "function" ? columns : () => columns ?? process.stderr.columns ?? 120;
	}
	start() {
		if (!this.tty) return;
		this.render();
		this.timer = setInterval(() => {
			this.frame += 1;
			this.render();
		}, 100);
		this.timer.unref();
	}
	update(key, patch) {
		const row = this.rows.find((r) => (r.key ?? r.label) === key);
		if (!row) return;
		Object.assign(row, patch);
		this.render();
	}
	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
		if (!this.tty) {
			for (const row of this.rows) this.write(`${row.label} ${statusText(row)} ${fmtElapsed(row.elapsedMs)}\n`);
			return;
		}
		this.clear();
	}
	render() {
		if (!this.tty) return;
		this.clear();
		this.write(renderProgressLine({ rows: this.rows }, {
			spinnerFrame: this.frame,
			columns: this.columns()
		}));
		this.visible = true;
	}
	clear() {
		if (!this.visible) return;
		this.write("\r\x1B[2K");
		this.visible = false;
	}
};
//#endregion
//#region src/commands/scan-engine-runner.ts
const ALL_ENGINE_NAMES = Object.keys(ENGINE_INFO);
const resultSummary = (result) => {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
	if (errors > 0) return {
		outcome: "fail",
		summary: `${errors} error${errors === 1 ? "" : "s"}`
	};
	const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
	if (warnings > 0) return {
		outcome: "warn",
		summary: `${warnings} warning${warnings === 1 ? "" : "s"}`
	};
	return {
		outcome: "ok",
		summary: "0 issues"
	};
};
const runEnginesWithProgress = async (context, enabled, machineOutput) => {
	const useLiveProgress = !machineOutput && Boolean(process.stderr.isTTY) && process.env.CI !== "true" && process.env.CI !== "1";
	const rows = ALL_ENGINE_NAMES.filter((engine) => enabled[engine] !== false).map((engine) => ({
		key: engine,
		label: getEngineLabel(engine),
		status: "queued"
	}));
	const renderer = useLiveProgress ? new LiveGrid(rows) : null;
	renderer?.start();
	const results = await runEngines(context, enabled, (engine) => renderer?.update(engine, { status: "running" }), (result) => {
		if (result.skipped) renderer?.update(result.engine, {
			status: "skipped",
			summary: "skipped"
		});
		else renderer?.update(result.engine, {
			status: "done",
			...resultSummary(result),
			elapsedMs: result.elapsed
		});
		if (!machineOutput && !renderer) printEngineStatus(result);
	});
	renderer?.stop();
	return results;
};
//#endregion
//#region src/commands/scan-exit-code.ts
const computeScanExitCode = (opts) => opts.hasErrors || opts.scoreable && opts.score < opts.failBelow ? 1 : 0;
//#endregion
//#region src/commands/scan-file-scope.ts
const deriveScanCoverage = (coverage, fileCount) => ({
	...coverage,
	supportedFiles: fileCount,
	scoreable: !(fileCount === 0 || coverage.unsupportedFiles >= 10 && coverage.unsupportedFiles > fileCount * 3)
});
const scopedCandidates = (rootDirectory, projectCandidates, mode) => {
	switch (mode.kind) {
		case "staged": return {
			files: getStagedFiles(rootDirectory),
			label: "staged file(s)"
		};
		case "changes": return {
			files: getChangedFiles(rootDirectory, mode.base),
			label: mode.base ? `changed vs ${mode.base} file(s)` : "changed file(s)"
		};
		case "full": return {
			files: projectCandidates,
			label: "file(s) after exclusions"
		};
		default: return mode;
	}
};
const collectScanFileScope = (request) => {
	const projectCandidates = listProjectFiles(request.rootDirectory);
	const candidates = scopedCandidates(request.rootDirectory, projectCandidates, request.mode);
	const files = filterEnumeratedProjectFiles(request.rootDirectory, candidates.files, [], request.excludePatterns, request.includePatterns);
	const testFiles = filterEnumeratedTestFiles(request.rootDirectory, candidates.files, request.excludePatterns, request.includePatterns);
	const projectSourceFiles = filterEnumeratedProjectFiles(request.rootDirectory, projectCandidates, [], request.excludePatterns, request.includePatterns);
	const projectTestFiles = filterEnumeratedTestFiles(request.rootDirectory, projectCandidates, request.excludePatterns, request.includePatterns);
	const declarations = filterProjectDeclarationFiles(request.rootDirectory, projectCandidates, request.excludePatterns, request.includePatterns);
	return {
		dependencyAuditFiles: filterDependencyAuditFiles(request.rootDirectory, candidates.files, request.excludePatterns, request.includePatterns),
		dependencyAuditScope: request.mode.kind === "full" ? "full" : "files",
		files,
		projectFiles: [.../* @__PURE__ */ new Set([...projectSourceFiles, ...declarations])],
		scoreFileCount: projectSourceFiles.length + projectTestFiles.length,
		scopeLabel: candidates.label,
		testFiles
	};
};
//#endregion
//#region src/commands/scan-options.ts
const isMachineOutput = (options) => Boolean(options.json) || Boolean(options.sarif);
const isHistoryComparableScan = (options) => !options.staged && !options.changes && options.command !== "ci";
const isFullProjectScan = (options) => isHistoryComparableScan(options) && !options.include?.length && !options.exclude?.length;
const resolveScanScopeMode = (options) => {
	if (options.staged) return { kind: "staged" };
	if (options.changes) return options.base ? {
		kind: "changes",
		base: options.base
	} : { kind: "changes" };
	return { kind: "full" };
};
//#endregion
//#region src/output/finding-assessment.ts
const KNIP_FORCE_RULES = /* @__PURE__ */ new Set([
	"knip/files",
	"knip/dependencies",
	"knip/devDependencies"
]);
const isForceFixable = (diagnostic) => {
	if (diagnostic.fixable) return false;
	if (KNIP_FORCE_RULES.has(diagnostic.rule)) return true;
	if (diagnostic.rule === "security/vulnerable-dependency") return diagnostic.detail === "npm" || diagnostic.detail === "pnpm";
	if (diagnostic.rule.startsWith("expo-doctor/")) return diagnostic.rule !== "expo-doctor/config-error";
	return false;
};
const FINDING_KIND_LABELS = {
	"confirmed-defect": "confirmed defects",
	"conservative-security": "conservative security",
	"style-policy": "style/policy",
	"ai-slop-indicator": "AI-slop indicators"
};
const STYLE_POLICY_RULES = /* @__PURE__ */ new Set([
	"ai-slop/trivial-comment",
	"ai-slop/narrative-comment",
	"ai-slop/meta-comment",
	"ai-slop/console-leftover",
	"ai-slop/ts-directive",
	"complexity/file-too-large",
	"complexity/function-too-long",
	"complexity/deep-nesting",
	"complexity/too-many-params",
	"code-quality/duplicate-block",
	"eslint/no-empty",
	"eslint/no-unused-vars",
	"eslint/no-useless-escape",
	"eslint/no-unused-expressions",
	"unicorn/no-useless-fallback-in-spread",
	"unicorn/prefer-string-starts-ends-with",
	"unicorn/no-new-array",
	"unicorn/no-useless-spread"
]);
const CONFIRMED_DEFECT_RULES = /* @__PURE__ */ new Set([
	"ai-slop/hallucinated-import",
	"eslint/no-undef",
	"eslint/no-unreachable",
	"security/vulnerable-dependency"
]);
const LOW_CONFIDENCE_SECURITY_RULES = /* @__PURE__ */ new Set(["security/innerhtml", "security/dangerously-set-innerhtml"]);
const confidenceFor = (diagnostic, kind) => {
	if (kind === "confirmed-defect") return "high";
	if (kind === "style-policy") return "medium";
	if (kind === "conservative-security") {
		if (LOW_CONFIDENCE_SECURITY_RULES.has(diagnostic.rule)) return "medium";
		return diagnostic.severity === "error" ? "high" : "medium";
	}
	return diagnostic.severity === "error" ? "high" : "medium";
};
const classifyKind = (diagnostic) => {
	if (CONFIRMED_DEFECT_RULES.has(diagnostic.rule)) return "confirmed-defect";
	if (diagnostic.engine === "security") return "conservative-security";
	if (STYLE_POLICY_RULES.has(diagnostic.rule)) return "style-policy";
	if (diagnostic.engine === "format" || diagnostic.engine === "code-quality") return "style-policy";
	if (diagnostic.engine === "ai-slop") return "ai-slop-indicator";
	if (diagnostic.severity === "error") return "confirmed-defect";
	return "style-policy";
};
const assessDiagnostic = (diagnostic) => {
	const kind = classifyKind(diagnostic);
	return {
		kind,
		confidence: confidenceFor(diagnostic, kind),
		label: FINDING_KIND_LABELS[kind]
	};
};
const withFindingAssessments = (diagnostics) => diagnostics.map((diagnostic) => ({
	...diagnostic,
	assessment: assessDiagnostic(diagnostic),
	scoreImpact: scoreImpactForRule(diagnostic.rule),
	forceFixable: isForceFixable(diagnostic)
}));
const summarizeFindingAssessments = (diagnostics) => {
	const byKind = {
		"confirmed-defect": 0,
		"conservative-security": 0,
		"style-policy": 0,
		"ai-slop-indicator": 0
	};
	const byConfidence = {
		high: 0,
		medium: 0,
		low: 0
	};
	const rows = /* @__PURE__ */ new Map();
	for (const diagnostic of diagnostics) {
		const assessment = assessDiagnostic(diagnostic);
		byKind[assessment.kind]++;
		byConfidence[assessment.confidence]++;
		const row = rows.get(assessment.kind) ?? {
			kind: assessment.kind,
			label: assessment.label,
			count: 0,
			errors: 0,
			warnings: 0,
			info: 0,
			fixable: 0
		};
		row.count++;
		if (diagnostic.severity === "error") row.errors++;
		else if (diagnostic.severity === "warning") row.warnings++;
		else row.info++;
		if (diagnostic.fixable) row.fixable++;
		rows.set(assessment.kind, row);
	}
	return {
		rows: [...rows.values()].sort((a, b) => b.count - a.count),
		byKind,
		byConfidence
	};
};
//#endregion
//#region src/ui/summary.ts
const elapsed = (ms) => ms < 1e3 ? `${Math.round(ms)}ms` : `${(ms / 1e3).toFixed(1)}s`;
const scoreToken = (score, thresholds) => {
	if (score >= thresholds.good) return "success";
	if (score >= thresholds.ok) return "warn";
	return "danger";
};
const renderFindingAssessment = (assessment, t, sep) => {
	if (assessment.rows.length === 0) return [];
	const parts = assessment.rows.filter((row) => row.count > 0).map((row) => `${row.count} ${row.label}`);
	if (parts.length === 0) return [];
	const high = assessment.byConfidence.high;
	const medium = assessment.byConfidence.medium;
	const confidenceParts = [];
	if (high > 0) confidenceParts.push(`${high} high-confidence`);
	if (medium > 0) confidenceParts.push(`${medium} medium-confidence`);
	const confidence = confidenceParts.length > 0 ? `  ${sep}  ${style$1(t, "muted", confidenceParts.join(", "))}` : "";
	return [`   ${style$1(t, "muted", "Verdict mix:")} ${parts.join(`  ${sep}  `)}${confidence}`];
};
const severitySummary = (row, t, sep) => {
	const tags = [];
	if (row.errors > 0) tags.push(style$1(t, "danger", `${row.errors} err`));
	if (row.warnings > 0) tags.push(style$1(t, "warn", `${row.warnings} warn`));
	if (row.info > 0) tags.push(style$1(t, "muted", `${row.info} info`));
	if (row.fixable > 0) tags.push(style$1(t, "success", `${row.fixable} fixable`));
	return tags.join(` ${sep} `);
};
const renderActionRows = (steps, t) => {
	const actionSteps = steps.filter((step) => step.command && step.label);
	if (actionSteps.length === 0) return [];
	const labelWidth = Math.max(...actionSteps.map((step) => step.label?.length ?? 0));
	const commandWidth = Math.max(...actionSteps.map((step) => step.command?.length ?? 0));
	const lines = [` ${style$1(t, "bold", "Agent repair plan")}`];
	for (const step of actionSteps) {
		const label = padEnd(step.label ?? "", labelWidth);
		const command = padEnd(step.command ?? "", commandWidth);
		const labelToken = step.emphasis === "primary" ? "accent" : "muted";
		const detail = step.detail ? `  ${style$1(t, "muted", step.detail)}` : "";
		lines.push(`   ${style$1(t, labelToken, label)}  ${highlightAislop(command, t)}${detail}`);
	}
	return lines;
};
const renderTextSteps = (steps, t, s) => {
	return steps.filter((step) => step.text).map((step) => {
		const glyph = step.emphasis === "primary" ? s.hint : s.bullet;
		return ` ${style$1(t, step.emphasis === "primary" ? "accent" : "muted", glyph)} ${highlightAislop(step.text ?? "", t)}`;
	});
};
const renderSummary = (input, deps = {}) => {
	const t = deps.theme ?? theme;
	const s = deps.symbols ?? symbols;
	const thresholds = input.thresholds ?? {
		good: 85,
		ok: 65
	};
	const tok = scoreToken(input.score, thresholds);
	const sep = style$1(t, "accent", "·");
	const scoreText = padEnd(`${input.score} / 100`, 10);
	const labelText = padEnd(input.label, 12);
	const counters = `${style$1(t, "danger", `${input.errors} error${input.errors === 1 ? "" : "s"}`)}  ${sep}  ${style$1(t, "warn", `${input.warnings} warning${input.warnings === 1 ? "" : "s"}`)}  ${sep}  ${style$1(t, "success", `${input.fixable} fixable`)}`;
	const lines = [
		"",
		`   ${style$1(t, tok, scoreText)}${style$1(t, tok, labelText)}  ${counters}`,
		`   ${style$1(t, "muted", `${input.files} files`)}  ${sep}  ${style$1(t, "muted", `${input.engines} engines`)}  ${sep}  ${style$1(t, "muted", elapsed(input.elapsedMs))}`,
		""
	];
	if (input.findingAssessment) {
		lines.push(...renderFindingAssessment(input.findingAssessment, t, sep));
		lines.push("");
	}
	if (input.breakdown && input.breakdown.rows.length > 0) {
		lines.push(` ${style$1(t, "bold", "Top findings")}`);
		const maxCountWidth = input.breakdown.rows.reduce((w, r) => Math.max(w, String(r.errors + r.warnings + r.info).length), 0);
		const labels = input.breakdown.rows.map((r) => labelForRule(r.rule));
		const maxLabelWidth = labels.reduce((w, l) => Math.max(w, l.length), 0);
		const maxRuleWidth = input.breakdown.rows.reduce((w, r) => Math.max(w, r.rule.length), 0);
		lines.push(`   ${style$1(t, "muted", padEnd("#", maxCountWidth))}  ${style$1(t, "muted", padEnd("Finding", maxLabelWidth))}  ${style$1(t, "muted", padEnd("Rule", maxRuleWidth))}  ${style$1(t, "muted", "Status")}`);
		for (let i = 0; i < input.breakdown.rows.length; i++) {
			const row = input.breakdown.rows[i];
			const total = row.errors + row.warnings + row.info;
			const count = String(total).padStart(maxCountWidth);
			const label = padEnd(labels[i], maxLabelWidth);
			const rule = padEnd(row.rule, maxRuleWidth);
			lines.push(`   ${style$1(t, "muted", count)}  ${label}  ${style$1(t, "muted", rule)}  ${severitySummary(row, t, sep)}`);
		}
		if (input.breakdown.hiddenRules > 0) {
			const hiddenParts = [];
			if (input.breakdown.hiddenErrors > 0) hiddenParts.push(`${input.breakdown.hiddenErrors} error${input.breakdown.hiddenErrors === 1 ? "" : "s"}`);
			if (input.breakdown.hiddenWarnings > 0) hiddenParts.push(`${input.breakdown.hiddenWarnings} warning${input.breakdown.hiddenWarnings === 1 ? "" : "s"}`);
			const detail = hiddenParts.length > 0 ? ` (${hiddenParts.join(", ")})` : "";
			lines.push(style$1(t, "muted", `   +${input.breakdown.hiddenRules} more rule${input.breakdown.hiddenRules === 1 ? "" : "s"}${detail}. Run with -v for the full list.`));
		}
		lines.push("");
	}
	if (input.nextSteps.length > 0) {
		lines.push(...renderActionRows(input.nextSteps, t));
		lines.push(...renderTextSteps(input.nextSteps, t, s));
		lines.push("");
	}
	return lines.join("\n");
};
const renderStarCta = (deps = {}) => {
	return `\n ${style$1(deps.theme ?? theme, "muted", `★ Found this useful? Star us at ${terminalLink("https://github.com/scanaislop/aislop")}`)}\n`;
};
const renderTeamCta = (deps = {}) => {
	return `\n ${style$1(deps.theme ?? theme, "muted", `→ Using aislop with a team? Get a 14-day team baseline at ${terminalLink("https://scanaislop.com/contact?intent=team-baseline")}`)}\n`;
};
const renderCleanRun = (input, deps = {}) => {
	const t = deps.theme ?? theme;
	const s = deps.symbols ?? symbols;
	const sep = style$1(t, "accent", "·");
	const parts = [style$1(t, "success", `${s.pass} Clean run`)];
	if (input.score !== void 0) parts.push(style$1(t, "success", `${input.score} / 100`));
	if (input.label) parts.push(style$1(t, "success", input.label));
	parts.push(style$1(t, "muted", "no issues"));
	parts.push(style$1(t, "muted", elapsed(input.elapsedMs)));
	return `\n ${parts.join(`  ${sep}  `)}\n`;
};
//#endregion
//#region src/commands/scan-render.ts
const BREAKDOWN_TOP_N = 10;
const computeBreakdown = (diagnostics) => {
	const byRule = /* @__PURE__ */ new Map();
	for (const d of diagnostics) {
		const row = byRule.get(d.rule) ?? {
			rule: d.rule,
			errors: 0,
			warnings: 0,
			info: 0,
			fixable: 0
		};
		if (d.severity === "error") row.errors++;
		else if (d.severity === "warning") row.warnings++;
		else row.info++;
		if (d.fixable) row.fixable++;
		byRule.set(d.rule, row);
	}
	const sorted = [...byRule.values()].sort((a, b) => {
		const aTotal = a.errors + a.warnings + a.info;
		const bTotal = b.errors + b.warnings + b.info;
		if (aTotal !== bTotal) return bTotal - aTotal;
		if (a.errors !== b.errors) return b.errors - a.errors;
		return a.rule.localeCompare(b.rule);
	});
	const rows = sorted.slice(0, BREAKDOWN_TOP_N);
	const hidden = sorted.slice(BREAKDOWN_TOP_N);
	return {
		rows,
		hiddenRules: hidden.length,
		hiddenErrors: hidden.reduce((acc, r) => acc + r.errors, 0),
		hiddenWarnings: hidden.reduce((acc, r) => acc + r.warnings, 0)
	};
};
const buildScanNextSteps = (input) => {
	const nextSteps = [];
	if (input.errors + input.warnings > 0) nextSteps.push({
		emphasis: "primary",
		label: "Agent",
		command: `${input.invocation} agent`,
		detail: "run a local worktree repair session"
	}, {
		emphasis: "primary",
		label: "Provider",
		command: `${input.invocation} agent --provider codex`,
		detail: "or use --provider claude/opencode"
	}, {
		emphasis: "muted",
		label: "Preview",
		command: `${input.invocation} agent plan`,
		detail: "preview provider, worktree, findings, and publish actions"
	});
	if (input.fixable > 0) nextSteps.push({
		emphasis: "primary",
		label: "Auto-fix",
		command: `${input.invocation} fix`,
		detail: `auto-fix ${input.fixable} issue${input.fixable === 1 ? "" : "s"}`
	});
	if (input.hasVulnerableDeps) nextSteps.push({
		emphasis: "primary",
		label: "Force",
		command: `${input.invocation} fix -f`,
		detail: "aggressive fixes: dependency audit, unused files, framework alignment"
	});
	return nextSteps;
};
const buildScanRender = (input) => {
	const deps = {
		theme: createTheme(),
		symbols: createSymbols({ plain: false })
	};
	const invocation = detectInvocation();
	const header = input.includeHeader === false ? "" : renderHeader({
		version: APP_VERSION,
		command: "Scan result",
		context: [
			input.projectName,
			input.language,
			`${input.fileCount} files`
		],
		brand: input.printBrand !== false
	}, deps);
	const errors = input.diagnostics.filter((d) => d.severity === "error").length;
	const warnings = input.diagnostics.filter((d) => d.severity === "warning").length;
	const fixable = input.diagnostics.filter((d) => d.fixable).length;
	const hasVulnerableDeps = input.diagnostics.some((d) => d.rule === "security/vulnerable-dependency");
	const cta = input.printBrand === false ? "" : input.showPilotInvitation === true ? renderTeamCta(deps) : errors + warnings === 0 ? renderStarCta(deps) : "";
	if (input.diagnostics.length === 0 && input.score.score === 100) return `${header}${renderCleanRun({
		score: input.score.score,
		label: input.score.label,
		elapsedMs: input.elapsedMs
	}, deps)}${cta}`;
	return `${header}${input.diagnostics.length === 0 ? "" : renderDiagnostics(input.diagnostics, input.verbose)}${renderSummary({
		score: input.score.score,
		label: input.score.label,
		errors,
		warnings,
		fixable,
		files: input.fileCount,
		engines: input.results.length,
		elapsedMs: input.elapsedMs,
		nextSteps: buildScanNextSteps({
			invocation,
			errors,
			warnings,
			fixable,
			hasVulnerableDeps
		}),
		breakdown: computeBreakdown(input.diagnostics),
		findingAssessment: summarizeFindingAssessments(input.diagnostics),
		thresholds: input.thresholds
	}, deps)}${cta}`;
};
//#endregion
//#region src/commands/scan-validation.ts
const scanTargetError = (resolvedDir, options) => {
	if (!fs.existsSync(resolvedDir)) return `Path does not exist: ${resolvedDir}`;
	if (!fs.statSync(resolvedDir).isDirectory()) return `Not a directory: ${resolvedDir}`;
	if (options.changes && options.base && !baseRefExists(resolvedDir, options.base)) return `Could not resolve base ref "${options.base}". Make sure it exists and was fetched (e.g. \`git fetch origin ${options.base}\`).`;
	return null;
};
//#endregion
//#region src/commands/scan.ts
const renderScopeRow = (value) => `${renderDisplayRows([{
	label: "Scope",
	value
}], { indent: 1 }).join("\n")}\n`;
const scanCommand = async (directory, config, options) => {
	const resolvedDir = path.resolve(directory);
	const targetError = scanTargetError(resolvedDir, options);
	if (targetError) {
		if (options.json) console.log(JSON.stringify({ error: targetError }, null, 2));
		else log.error(targetError);
		return { exitCode: 1 };
	}
	const excludePatterns = [...config.exclude, ...readAislopIgnorePatterns(resolvedDir)];
	const scanScope = collectScanFileScope({
		excludePatterns,
		includePatterns: config.include,
		mode: resolveScanScopeMode(options),
		rootDirectory: resolvedDir
	});
	const discoveredProject = await discoverProject(resolvedDir, excludePatterns, { includePatterns: config.include });
	const projectInfo = {
		...discoveredProject,
		languages: detectSourceLanguages([...scanScope.files, ...scanScope.testFiles])
	};
	return withCommandLifecycle({
		command: options.command ?? "scan",
		config: config.telemetry,
		languages: projectInfo.languages,
		fileCount: scanScope.scoreFileCount
	}, () => runScanBody(resolvedDir, config, options, projectInfo, scanScope, discoveredProject.languages));
};
const runScanBody = async (resolvedDir, config, options, projectInfo, scanScope, dependencyAuditLanguages) => {
	const startTime = performance.now();
	const showHeader = options.showHeader !== false;
	const machineOutput = isMachineOutput(options);
	const projectName = projectInfo.projectName ?? "project";
	const language = projectInfo.languages[0] ?? "unknown";
	const printedHumanHeader = !machineOutput && showHeader;
	const { dependencyAuditFiles, dependencyAuditScope, files, projectFiles, scoreFileCount, scopeLabel, testFiles } = scanScope;
	const excludePatterns = [...config.exclude, ...readAislopIgnorePatterns(resolvedDir)];
	const scanCoverage = deriveScanCoverage(projectInfo.coverage, scoreFileCount);
	const reportProjectInfo = {
		...projectInfo,
		coverage: scanCoverage,
		sourceFileCount: scoreFileCount
	};
	if (printedHumanHeader) process.stdout.write(renderHeader({
		version: APP_VERSION,
		command: "Scan result",
		context: [
			projectName,
			language,
			`${scoreFileCount} files`
		],
		brand: options.printBrand !== false
	}));
	if (!machineOutput) process.stdout.write(renderScopeRow(`${files.length + testFiles.length} ${scopeLabel}`));
	const configDir = findConfigDir(resolvedDir);
	const rulesPath = configDir ? path.join(configDir, RULES_FILE) : void 0;
	const engineConfig = {
		quality: config.quality,
		security: config.security,
		lint: config.lint,
		architectureRulesPath: config.engines.architecture ? rulesPath : void 0
	};
	const { results: unannotated, suppressedCount } = applySuppressions((await runEnginesWithProgress({
		rootDirectory: resolvedDir,
		languages: projectInfo.languages,
		frameworks: projectInfo.frameworks,
		dependencyAuditFiles,
		dependencyAuditLanguages,
		dependencyAuditScope,
		files,
		excludePatterns,
		testFiles,
		projectFiles,
		installedTools: projectInfo.installedTools,
		config: engineConfig
	}, config.engines, machineOutput)).map((result) => ({
		...result,
		diagnostics: applyRuleSeverities(result.diagnostics, config.rules)
	})), resolvedDir);
	if (suppressedCount > 0 && !machineOutput) log.muted(`Suppressed ${suppressedCount} finding(s) via aislop-ignore directives`);
	const changeMap = options.changes && !options.staged ? getChangedLineMap(resolvedDir, options.base) : null;
	const results = changeMap ? unannotated.map((result) => ({
		...result,
		diagnostics: applyChangeContext(result.diagnostics, changeMap, resolvedDir)
	})) : unannotated;
	const allDiagnostics = results.flatMap((r) => r.diagnostics);
	const elapsedMs = performance.now() - startTime;
	const scoreResult = calculateScore(allDiagnostics, config.scoring.weights, config.scoring.thresholds, scoreFileCount, config.scoring.smoothing, config.scoring.maxPerRule);
	const scoreable = scanCoverage.scoreable;
	const exitCode = computeScanExitCode({
		hasErrors: allDiagnostics.some((d) => d.severity === "error"),
		scoreable,
		score: scoreResult.score,
		failBelow: config.ci.failBelow
	});
	const engineIssues = {};
	const engineTimings = {};
	for (const r of results) {
		engineIssues[r.engine] = r.diagnostics.length;
		engineTimings[r.engine] = Math.round(r.elapsed);
	}
	const completion = {
		exitCode,
		score: scoreable ? scoreResult.score : null,
		scoreable,
		findingCount: allDiagnostics.length,
		errorCount: allDiagnostics.filter((d) => d.severity === "error").length,
		warningCount: allDiagnostics.filter((d) => d.severity === "warning").length,
		fixableCount: allDiagnostics.filter((d) => d.fixable).length,
		engineIssues,
		engineTimings
	};
	if (options.sarif) {
		const { buildSarifLog } = await import("./sarif-BW5Earzr.js");
		console.log(JSON.stringify(buildSarifLog(results), null, 2));
		return completion;
	}
	if (options.json) {
		const { buildJsonOutput } = await import("./json-DBN8fnd3.js");
		const jsonOut = buildJsonOutput(results, scoreResult, scoreFileCount, elapsedMs, scanCoverage);
		console.log(JSON.stringify(jsonOut, null, 2));
		return completion;
	}
	if (!scoreable) {
		if (!machineOutput) {
			process.stdout.write(renderCoverageNotice(reportProjectInfo, !printedHumanHeader && showHeader));
			if (allDiagnostics.length > 0) process.stdout.write(renderDiagnostics(allDiagnostics, options.verbose ?? false));
		}
		return completion;
	}
	const showPilotInvitation = isHistoryComparableScan(options) && !isCiEnv() ? recordFullScanActivity({
		directory: resolvedDir,
		score: scoreResult.score,
		errors: completion.errorCount,
		warnings: completion.warningCount,
		files: scoreFileCount
	}, isFullProjectScan(options) && options.printBrand !== false, config.telemetry) : false;
	process.stdout.write(buildScanRender({
		projectName,
		language,
		fileCount: scoreFileCount,
		results,
		diagnostics: allDiagnostics,
		score: scoreResult,
		elapsedMs,
		thresholds: config.scoring.thresholds,
		verbose: options.verbose,
		includeHeader: !printedHumanHeader && showHeader,
		printBrand: options.printBrand,
		showPilotInvitation
	}));
	return completion;
};
//#endregion
//#region src/cli-scan.ts
const commaSeparatedParser = (value, previous = []) => {
	const parts = value.split(",").map((v) => v.trim()).filter(Boolean);
	return [...previous, ...parts];
};
const wantsSarif = (flags) => Boolean(flags.sarif) || flags.format === "sarif";
const wantsJson = (flags) => Boolean(flags.json) || flags.format === "json";
const runScan = async (directory, flags) => {
	const config = loadConfig(directory);
	const finalConfig = {
		...config,
		exclude: [...config.exclude ?? [], ...flags.exclude ?? []],
		include: [...config.include ?? [], ...flags.include ?? []]
	};
	const sarif = wantsSarif(flags);
	const { exitCode } = await scanCommand(directory, finalConfig, {
		changes: Boolean(flags.changes),
		staged: Boolean(flags.staged),
		base: flags.base,
		verbose: Boolean(flags.verbose),
		json: !sarif && wantsJson(flags),
		sarif,
		exclude: flags.exclude,
		include: flags.include
	});
	if (exitCode !== 0) {
		await flushTelemetry();
		process.exitCode = exitCode;
	}
};
const noFlagsPassed = (flags) => !flags.changes && !flags.staged && !flags.verbose && !flags.json && !flags.sarif && !flags.format && !(flags.exclude && flags.exclude.length > 0) && !(flags.include && flags.include.length > 0);
//#endregion
//#region src/ui/error.ts
const renderError = (input, deps = {}) => {
	const t = deps.theme ?? theme;
	const s = deps.symbols ?? symbols;
	const lines = [`\n ${style$1(t, "danger", s.fail)} ${style$1(t, "danger", input.message)}`];
	if (input.cause) lines.push(` ${style$1(t, "muted", s.rail)} ${style$1(t, "muted", input.cause)}`);
	if (input.hints && input.hints.length > 0 || input.docsUrl) lines.push("");
	for (const hint of input.hints ?? []) lines.push(` ${style$1(t, "accent", s.hint)} ${highlightAislop(hint, t)}`);
	if (input.docsUrl) lines.push(` ${style$1(t, "accent", s.hint)} Docs: ${input.docsUrl}`);
	lines.push("");
	return lines.join("\n");
};
//#endregion
//#region src/commands/ci.ts
const ciCommand = async (directory, config, options = {}) => {
	try {
		return await scanCommand(directory, config, {
			changes: Boolean(options.changes),
			staged: Boolean(options.staged),
			base: options.base,
			verbose: false,
			json: !options.human && !options.sarif,
			sarif: options.sarif,
			command: "ci"
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(renderError({
			message: "ci command failed",
			cause: message
		}));
		return { exitCode: 1 };
	}
};
//#endregion
//#region src/commands/doctor-trust-plan.ts
const projectEvaluationGate = () => ({
	tool: "project-backed C# tools",
	status: "skipped",
	skipReason: "set lint.csharp.projectEvaluation: true only for repositories you trust"
});
//#endregion
//#region src/commands/doctor-security-plan.ts
const AUDIT_SPECS = [
	{
		files: ["pnpm-lock.yaml"],
		bundled: "pnpm audit"
	},
	{
		files: ["bun.lock", "bun.lockb"],
		bundled: "bun audit"
	},
	{
		files: ["package-lock.json"],
		bundled: "npm audit"
	},
	{
		files: [
			"requirements.txt",
			"poetry.lock",
			"Pipfile.lock"
		],
		systemTool: {
			binary: "pip-audit",
			toolLabel: "pip-audit",
			remediation: "Install: pipx install pip-audit"
		}
	},
	{
		files: ["Cargo.toml"],
		systemTool: {
			binary: "cargo-audit",
			toolLabel: "cargo audit",
			remediation: "Install: cargo install cargo-audit",
			requiresBinaries: ["cargo", "cargo-audit"]
		}
	},
	{
		files: ["go.mod"],
		systemTool: {
			binary: "govulncheck",
			toolLabel: "govulncheck",
			remediation: "Install: go install golang.org/x/vuln/cmd/govulncheck@latest"
		}
	},
	{
		files: [],
		languages: ["csharp"],
		systemTool: {
			binary: "dotnet",
			toolLabel: "dotnet list package --vulnerable",
			remediation: "Install the .NET SDK: https://dotnet.microsoft.com/download"
		}
	}
];
const planSecurity = (ctx) => {
	const { rootDirectory, projectInfo } = ctx;
	const { installedTools } = projectInfo;
	const hasFile = (relativePath) => fs.existsSync(path.join(rootDirectory, relativePath));
	for (const spec of AUDIT_SPECS) {
		const filesMatch = spec.files.some(hasFile);
		const languageMatch = spec.languages?.some((language) => projectInfo.languages.includes(language));
		if (!filesMatch && !languageMatch) continue;
		if (languageMatch && spec.languages?.includes("csharp") && ctx.config.lint.csharp?.projectEvaluation !== true) return projectEvaluationGate();
		if (spec.bundled) return {
			tool: spec.bundled,
			status: "ok"
		};
		if (spec.systemTool) return (spec.systemTool.requiresBinaries ?? [spec.systemTool.binary]).every((binary) => installedTools[binary]) ? {
			tool: `${spec.systemTool.toolLabel} (system)`,
			status: "ok"
		} : {
			tool: `${spec.systemTool.toolLabel} not found`,
			status: "missing",
			remediation: spec.systemTool.remediation
		};
	}
	return {
		tool: "no auditor",
		status: "skipped",
		skipReason: "no lockfile"
	};
};
//#endregion
//#region src/commands/doctor-tool-plan.ts
const systemToolDecision = (installed, spec) => installed[spec.binary] ? {
	tool: `${spec.toolLabel} (system)`,
	status: "ok"
} : {
	tool: `${spec.toolLabel} not found`,
	status: "missing",
	remediation: spec.remediation
};
const firstMatching = (languages, installed, specs) => {
	let firstLanguageMatch = null;
	for (const spec of specs) {
		if (!languages.includes(spec.language)) continue;
		if (firstLanguageMatch === null) firstLanguageMatch = spec;
		if (installed[spec.binary]) return {
			language: spec.language,
			decision: systemToolDecision(installed, spec)
		};
	}
	return firstLanguageMatch ? {
		language: firstLanguageMatch.language,
		decision: systemToolDecision(installed, firstLanguageMatch)
	} : null;
};
const applyProjectEvaluationGate = (ctx, matched, specs) => {
	if (matched?.language !== "csharp" || ctx.config.lint.csharp?.projectEvaluation === true) return matched?.decision ?? null;
	const fallback = firstMatching(ctx.projectInfo.languages, ctx.projectInfo.installedTools, specs.filter((candidate) => candidate.language !== "csharp"));
	return fallback?.decision.status === "ok" ? fallback.decision : projectEvaluationGate();
};
const spec = (language, binary, toolLabel, remediation) => ({
	language,
	binary,
	toolLabel,
	remediation
});
const FORMAT_SPECS = [
	spec("python", "ruff", "ruff", "Install: pipx install ruff"),
	spec("go", "gofmt", "gofmt", "Install: via go toolchain: https://go.dev/dl/"),
	spec("rust", "cargo", "cargo fmt", "Install: rustup component add rustfmt"),
	spec("ruby", "rubocop", "rubocop", "Install: gem install rubocop"),
	spec("php", "php-cs-fixer", "php-cs-fixer", "Install: composer global require friendsofphp/php-cs-fixer"),
	spec("csharp", "dotnet", "dotnet format whitespace", "Install the .NET SDK: https://dotnet.microsoft.com/download"),
	spec("cpp", "clang-format", "clang-format", "Install LLVM: apt-get install clang-format | brew install clang-format | winget install LLVM.LLVM")
];
const LINT_SPECS = [
	spec("python", "ruff", "ruff", "Install: pipx install ruff"),
	spec("go", "golangci-lint", "golangci-lint", "Install: brew install golangci-lint"),
	spec("rust", "clippy-driver", "clippy", "Install: rustup component add clippy"),
	spec("ruby", "rubocop", "rubocop", "Install: gem install rubocop"),
	spec("csharp", "jb", "jb inspectcode", "Install: dotnet tool install -g JetBrains.ReSharper.GlobalTools"),
	spec("csharp", "roslynator", "roslynator", "Install: dotnet tool install -g roslynator.dotnet.cli"),
	spec("cpp", "cppcheck", "cppcheck", "Install: apt-get install cppcheck | brew install cppcheck | winget install Cppcheck.Cppcheck"),
	spec("cpp", "clang-tidy", "clang-tidy", "Install LLVM: apt-get install clang-tidy | brew install llvm | winget install LLVM.LLVM")
];
const hasJsLike = (languages) => languages.includes("typescript") || languages.includes("javascript");
const planFormat = (ctx) => {
	const { languages, installedTools } = ctx.projectInfo;
	if (hasJsLike(languages)) return {
		tool: "biome (bundled)",
		status: "ok"
	};
	return applyProjectEvaluationGate(ctx, firstMatching(languages, installedTools, FORMAT_SPECS), FORMAT_SPECS) ?? {
		tool: "no formatter",
		status: "skipped",
		skipReason: "no supported language"
	};
};
const withTypecheckSuffix = (baseTool, ctx) => {
	if (!ctx.config.lint?.typecheck) return {
		tool: baseTool,
		status: "ok"
	};
	if (resolveTrustedTscPath()) return {
		tool: `${baseTool} + bundled tsc`,
		status: "ok"
	};
	return {
		tool: `${baseTool} + bundled tsc not found`,
		status: "missing",
		remediation: "Reinstall aislop so its TypeScript dependency is available, or set lint.typecheck: false in .aislop/config.yml."
	};
};
const planLint$1 = (ctx) => {
	const { languages, frameworks, installedTools } = ctx.projectInfo;
	if (frameworks.includes("expo") && ctx.config.lint?.expoDoctor) return withTypecheckSuffix("expo-doctor + oxlint (bundled)", ctx);
	if (hasJsLike(languages)) return withTypecheckSuffix("oxlint (bundled)", ctx);
	return applyProjectEvaluationGate(ctx, firstMatching(languages, installedTools, LINT_SPECS), LINT_SPECS) ?? {
		tool: "no linter",
		status: "skipped",
		skipReason: "no supported language"
	};
};
//#endregion
//#region src/commands/doctor-plan.ts
const primaryLanguage = (langs) => {
	for (const lang of [
		"typescript",
		"javascript",
		"python",
		"go",
		"rust",
		"ruby",
		"php",
		"java",
		"csharp",
		"cpp"
	]) if (langs.includes(lang)) return lang;
	return null;
};
const planCodeQuality = (ctx) => {
	if (ctx.projectInfo.languages.includes("typescript") || ctx.projectInfo.languages.includes("javascript")) return {
		tool: "knip (bundled)",
		status: "ok"
	};
	return {
		tool: "built-in",
		status: "ok"
	};
};
const planAiSlop$1 = (_ctx) => ({
	tool: "built-in",
	status: "ok"
});
const planArchitecture = (ctx) => {
	if (!ctx.config.engines.architecture) return {
		tool: "opt-in",
		status: "skipped",
		skipReason: "not configured"
	};
	const rulesPath = path.join(ctx.rootDirectory, CONFIG_DIR, RULES_FILE);
	if (!fs.existsSync(rulesPath)) return {
		tool: "opt-in",
		status: "skipped",
		skipReason: "no rules file"
	};
	const rules = loadArchitectureRules(rulesPath);
	if (rules.length === 0) return {
		tool: "opt-in",
		status: "skipped",
		skipReason: "rules file empty"
	};
	return {
		tool: `custom rules (${rules.length} defined)`,
		status: "ok"
	};
};
const ENGINE_PLANNERS = {
	format: planFormat,
	lint: planLint$1,
	"code-quality": planCodeQuality,
	"ai-slop": planAiSlop$1,
	architecture: planArchitecture,
	security: planSecurity
};
const ENGINE_ORDER = [
	"format",
	"lint",
	"code-quality",
	"ai-slop",
	"security",
	"architecture"
];
const languageLabelFor = (info) => {
	const langs = info.languages.filter((l) => l !== "java");
	if (langs.length === 0) return info.languages[0] ?? "unknown";
	if (langs.length === 1) return langs[0];
	const primary = primaryLanguage(langs);
	return primary ? `${primary} (mixed)` : "mixed";
};
const buildRows = (ctx) => {
	const rows = [];
	for (const engine of ENGINE_ORDER) {
		if (engine !== "architecture" && ctx.config.engines[engine] === false) continue;
		const decision = ENGINE_PLANNERS[engine](ctx);
		rows.push({
			engine: getEngineLabel(engine),
			tool: decision.tool,
			status: decision.status,
			remediation: decision.remediation,
			skipReason: decision.skipReason
		});
	}
	return rows;
};
//#endregion
//#region src/commands/doctor.ts
const doctorMarker = (row) => {
	if (row.status === "missing") return style$1(theme, "danger", "✗");
	if (row.status === "skipped") return style$1(theme, "muted", "·");
	return style$1(theme, "success", "✓");
};
const doctorState = (row) => {
	if (row.status === "missing") return "missing";
	if (row.status === "skipped") return "skipped";
	return "ready";
};
const renderToolCell = (row) => {
	if (row.status === "missing") return style$1(theme, "danger", row.tool);
	return style$1(theme, "muted", row.tool);
};
const doctorItem = (row) => {
	const rows = [{
		label: "Status",
		value: doctorState(row)
	}, {
		label: "Tool",
		value: renderToolCell(row)
	}];
	if (row.skipReason) rows.push({
		label: "Reason",
		value: row.skipReason
	});
	if (row.remediation) rows.push({
		label: "Fix",
		value: row.remediation
	});
	return {
		marker: doctorMarker(row),
		label: row.engine,
		rows
	};
};
const buildDoctorRender = (input) => {
	const header = renderHeader({
		version: APP_VERSION,
		command: "Doctor report",
		context: [input.projectName, input.languageLabel].filter((s) => s.length > 0),
		brand: input.printBrand !== false
	});
	const enginesRunning = input.rows.filter((r) => r.status === "ok").length;
	const missing = input.rows.filter((r) => r.status === "missing").length;
	const skipped = input.rows.filter((r) => r.status === "skipped").length;
	const nextRows = missing > 0 ? [{
		label: "Action",
		value: "Install the missing tools"
	}, {
		label: "Then",
		value: `${input.invocation} scan`
	}] : [{
		label: "Scan",
		value: `${input.invocation} scan`
	}];
	return `${[
		header.trimEnd(),
		"",
		renderDisplaySection("Engines"),
		...renderDisplayStatusItems(input.rows.map(doctorItem)),
		"",
		renderDisplaySection("Summary"),
		...renderDisplayRows([
			{
				label: "Ready",
				value: `${enginesRunning} engines`
			},
			{
				label: "Missing",
				value: String(missing)
			},
			{
				label: "Skipped",
				value: String(skipped)
			}
		]),
		"",
		renderDisplaySection(missing > 0 ? "Fix" : "Next"),
		...renderDisplayRows(nextRows)
	].join("\n")}\n`;
};
const doctorCommand = async (directory, options = {}) => {
	const resolvedDir = path.resolve(directory);
	const config = loadConfig(resolvedDir);
	const excludePatterns = [...config.exclude, ...readAislopIgnorePatterns(resolvedDir)];
	resetGitIgnoreSnapshots();
	const scanScope = collectScanFileScope({
		excludePatterns,
		includePatterns: config.include,
		mode: { kind: "full" },
		rootDirectory: resolvedDir
	});
	const discoveredProject = await discoverProject(resolvedDir, excludePatterns, {
		includePatterns: config.include,
		sourceFiles: scanScope.files
	});
	const sourceLanguages = detectSourceLanguages([...scanScope.files, ...scanScope.testFiles]);
	const projectInfo = sourceLanguages.length > 0 ? {
		...discoveredProject,
		languages: sourceLanguages
	} : discoveredProject;
	const rows = buildRows({
		rootDirectory: resolvedDir,
		projectInfo,
		config
	});
	process.stdout.write(buildDoctorRender({
		projectName: projectInfo.projectName,
		languageLabel: languageLabelFor(projectInfo),
		rows,
		invocation: detectInvocation(),
		printBrand: options.printBrand
	}));
};
//#endregion
//#region src/commands/fix-code.ts
const CONTEXT_LINES = 3;
const MAX_DIAGNOSTICS_PER_FILE = 10;
const MAX_FILES = 20;
const AGENT_CONFIGS = {
	claude: {
		type: "cli",
		bin: "claude",
		args: (p) => [p]
	},
	codex: {
		type: "cli",
		bin: "codex",
		args: (p) => [p]
	},
	amp: {
		type: "cli",
		bin: "amp",
		args: (p) => [p]
	},
	antigravity: {
		type: "cli",
		bin: "antigravity",
		args: (p) => [p]
	},
	"deep-agents": {
		type: "cli",
		bin: "deep-agents",
		args: (p) => [p]
	},
	gemini: {
		type: "cli",
		bin: "gemini",
		args: (p) => [p]
	},
	kimi: {
		type: "cli",
		bin: "kimi",
		args: (p) => [p]
	},
	opencode: {
		type: "cli",
		bin: "opencode",
		args: (p) => ["run", p]
	},
	warp: {
		type: "cli",
		bin: "warp",
		args: (p) => [p]
	},
	aider: {
		type: "cli",
		bin: "aider",
		args: (p) => ["--message", p]
	},
	goose: {
		type: "cli",
		bin: "goose",
		args: (p) => ["run", p]
	},
	pi: {
		type: "cli",
		bin: "pi",
		args: (p) => ["-p", p]
	},
	crush: {
		type: "cli",
		bin: "crush",
		args: (p) => ["run", p]
	},
	cursor: {
		type: "editor",
		bin: "cursor"
	},
	windsurf: {
		type: "editor",
		bin: "windsurf"
	},
	vscode: {
		type: "editor",
		bin: "code"
	}
};
const getCodeSnippet = (rootDirectory, diagnostic) => {
	if (diagnostic.line <= 0) return null;
	const absolutePath = path.resolve(rootDirectory, diagnostic.filePath);
	let content;
	try {
		content = fs.readFileSync(absolutePath, "utf-8");
	} catch {
		return null;
	}
	const lines = content.split("\n");
	const startLine = Math.max(0, diagnostic.line - 1 - CONTEXT_LINES);
	const endLine = Math.min(lines.length, diagnostic.line + CONTEXT_LINES);
	const snippet = [];
	for (let i = startLine; i < endLine; i++) {
		const lineNum = i + 1;
		const marker = lineNum === diagnostic.line ? "→" : " ";
		snippet.push(`${marker} ${String(lineNum).padStart(4)} │ ${lines[i]}`);
	}
	return snippet.join("\n");
};
const groupByFile = (diagnostics) => {
	const map = /* @__PURE__ */ new Map();
	for (const d of diagnostics) {
		const list = map.get(d.filePath) ?? [];
		list.push(d);
		map.set(d.filePath, list);
	}
	return [...map.entries()].map(([filePath, diags]) => ({
		filePath,
		diagnostics: diags
	})).sort((a, b) => {
		const aErrors = a.diagnostics.filter((d) => d.severity === "error").length;
		const bErrors = b.diagnostics.filter((d) => d.severity === "error").length;
		if (aErrors !== bErrors) return bErrors - aErrors;
		return b.diagnostics.length - a.diagnostics.length;
	});
};
const isInstalled = (bin) => {
	return spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf-8" }).status === 0;
};
const copyToClipboard = (text) => {
	const args = {
		darwin: ["pbcopy"],
		linux: [
			"xclip",
			"-selection",
			"clipboard"
		],
		win32: ["clip"]
	}[process.platform];
	if (!args) return false;
	const [bin, ...rest] = args;
	return spawnSync(bin, rest, {
		input: text,
		encoding: "utf-8"
	}).status === 0;
};
const buildAgentPrompt = (rootDirectory, diagnostics, score) => {
	const groups = groupByFile(diagnostics).slice(0, MAX_FILES);
	const errorCount = diagnostics.filter((d) => d.severity === "error").length;
	const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
	const lines = [
		`Fix the following ${diagnostics.length} code quality issue${diagnostics.length === 1 ? "" : "s"} found by aislop (current score: ${score}/100).`,
		"",
		`Summary: ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"} across ${groups.length} file${groups.length === 1 ? "" : "s"}.`,
		""
	];
	for (const group of groups) {
		lines.push(`## ${group.filePath}`);
		lines.push("");
		const fileDiags = group.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);
		for (const d of fileDiags) {
			const severity = d.severity === "error" ? "ERROR" : d.severity === "warning" ? "WARN" : "INFO";
			const location = d.line > 0 ? ` (line ${d.line})` : "";
			lines.push(`**[${severity}]** \`${d.rule}\`${location}: ${d.message}`);
			if (d.help) lines.push(`> ${d.help}`);
			const snippet = getCodeSnippet(rootDirectory, d);
			if (snippet) {
				lines.push("```");
				lines.push(snippet);
				lines.push("```");
			}
			lines.push("");
		}
		if (group.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
			lines.push(`_...and ${group.diagnostics.length - MAX_DIAGNOSTICS_PER_FILE} more issue${group.diagnostics.length - MAX_DIAGNOSTICS_PER_FILE === 1 ? "" : "s"} in this file._`);
			lines.push("");
		}
	}
	const totalGroups = groupByFile(diagnostics).length;
	if (totalGroups > MAX_FILES) {
		const remaining = totalGroups - MAX_FILES;
		lines.push(`_...and ${remaining} more file${remaining === 1 ? "" : "s"} with issues._`);
		lines.push("");
	}
	lines.push("---");
	lines.push("Fix each issue following the guidance above. Prioritize errors over warnings.");
	lines.push("After making changes, run `aislop scan` to verify all issues are resolved and the score improves.");
	return lines.join("\n");
};
const SUPPORTED_AGENT_NAMES = Object.keys(AGENT_CONFIGS);
const launchAgent = (agent, rootDirectory, diagnostics, score) => {
	if (diagnostics.length === 0) {
		log.success("No remaining issues — nothing to hand off.");
		return;
	}
	const config = AGENT_CONFIGS[agent];
	if (!config) {
		log.error(`Unknown agent: ${agent}`);
		log.muted(`Supported: ${SUPPORTED_AGENT_NAMES.join(", ")}`);
		return;
	}
	if (!isInstalled(config.bin)) {
		log.error(`${agent} is not installed or not in PATH.`);
		log.muted(`Install it first, or use ${style$1(theme, "info", "fix -p")} to print the prompt manually.`);
		return;
	}
	const prompt = buildAgentPrompt(rootDirectory, diagnostics, score);
	if (config.type === "editor") {
		const copied = copyToClipboard(prompt);
		log.break();
		if (copied) log.raw(`  ${style$1(theme, "success", "✓")} Prompt copied to clipboard (${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"})`);
		else log.warn("Could not copy to clipboard. Use fix --prompt to print it instead.");
		log.raw(`  ${style$1(theme, "info", "→")} Opening ${style$1(theme, "bold", agent)}... paste the prompt into the agent chat.`);
		log.break();
		spawnSync(config.bin, ["."], {
			cwd: rootDirectory,
			stdio: "inherit"
		});
		return;
	}
	log.break();
	log.raw(`  ${style$1(theme, "info", "→")} Opening ${style$1(theme, "bold", agent)} with ${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"}...`);
	log.break();
	spawnSync(config.bin, config.args(prompt), {
		cwd: rootDirectory,
		stdio: "inherit"
	});
};
const printPrompt = (rootDirectory, diagnostics, score) => {
	if (diagnostics.length === 0) {
		log.success("No remaining issues — nothing to generate.");
		return;
	}
	const prompt = buildAgentPrompt(rootDirectory, diagnostics, score);
	if (!process.stdout.isTTY) {
		process.stdout.write(prompt);
		return;
	}
	log.break();
	log.raw(style$1(theme, "bold", "Agent prompt"));
	log.raw(style$1(theme, "dim", "  Copy the prompt below, or pipe it: fix -p | pbcopy"));
	log.raw(style$1(theme, "dim", "  Or launch directly: fix --claude, fix --cursor, fix --codex, etc."));
	log.raw(style$1(theme, "dim", "  Editor agents (--cursor, --windsurf, --vscode) auto-copy to clipboard."));
	log.break();
	log.raw(style$1(theme, "dim", "╭─────────────────────────────────────────────────────────╮"));
	for (const line of prompt.split("\n")) log.raw(`  ${line}`);
	log.raw(style$1(theme, "dim", "╰─────────────────────────────────────────────────────────╯"));
	log.break();
};
//#endregion
//#region src/commands/fix-context.ts
const createEngineContext = (rootDirectory, projectInfo, config, options = {}) => ({
	rootDirectory,
	languages: projectInfo.languages,
	frameworks: projectInfo.frameworks,
	excludePatterns: [...config.exclude, ...readAislopIgnorePatterns(rootDirectory)],
	installedTools: options.safe ? {
		...projectInfo.installedTools,
		rubocop: false,
		"php-cs-fixer": false
	} : projectInfo.installedTools,
	config: {
		quality: config.quality,
		security: config.security,
		lint: config.lint
	},
	...options.scope ? {
		files: options.scope.files,
		testFiles: options.scope.testFiles,
		projectFiles: options.scope.projectFiles,
		dependencyAuditFiles: options.scope.dependencyAuditFiles,
		dependencyAuditScope: options.scope.dependencyAuditScope,
		dependencyAuditLanguages: options.dependencyAuditLanguages
	} : {}
});
//#endregion
//#region src/engines/ai-slop/dead-patterns-fix.ts
/**
* Given a starting line that contains an opening `(`, find all lines
* through the matching `)`. Returns the set of 1-based line numbers.
*/
const findStatementSpan = (lines, startIndex) => {
	const span = /* @__PURE__ */ new Set();
	let depth = 0;
	let started = false;
	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		span.add(i + 1);
		for (const ch of line) if (ch === "(") {
			depth++;
			started = true;
		} else if (ch === ")") depth--;
		if (started && depth <= 0) break;
	}
	return span;
};
/**
* Patterns that indicate a console.log is communicating an error or important
* status to the user — should be upgraded to console.error, not removed.
*/
const ERROR_MESSAGE_PATTERNS = [
	/\b(?:error|err|fail|failed|failure|fatal|crash|exception)\b/i,
	/\b(?:not found|missing|invalid|unable|cannot|couldn'?t|won'?t)\b/i,
	/\b(?:denied|unauthorized|forbidden|refused|rejected|timeout|timed?\s*out)\b/i,
	/\bno\s+(?:\w+\s+)*found\b/i,
	/\bprocess\.exit\b/
];
/**
* Extracts the full text of a console statement spanning multiple lines.
*/
const getStatementText = (lines, span) => {
	const spanLines = [];
	for (const lineNo of span) spanLines.push(lines[lineNo - 1]);
	return spanLines.join("\n");
};
/**
* Determine if a console.log should be replaced with console.error
* rather than removed entirely.
*/
const shouldUpgradeToError = (statementText) => {
	return ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(statementText));
};
const DIAGNOSTIC_PATH_RE = /(?:^|\/)(?:tools|scripts|cli|bin)\/|(?:^|\/)test-[^/]*\.[tj]sx?$|[.-](?:test|spec)\.[tj]sx?$/i;
const isDiagnosticScriptPath = (filePath) => DIAGNOSTIC_PATH_RE.test(filePath.replace(/\\/g, "/"));
const firstNonBlank = (lines, from, step, skip) => {
	for (let i = from; i >= 0 && i < lines.length; i += step) {
		if (skip.has(i + 1)) continue;
		if (lines[i].trim() !== "") return lines[i].trim();
	}
	return "";
};
const wouldEmptyEnclosingBlock = (lines, span, removed) => {
	const sorted = [...span].sort((a, b) => a - b);
	const before = firstNonBlank(lines, sorted[0] - 2, -1, removed);
	const after = firstNonBlank(lines, sorted[sorted.length - 1], 1, removed);
	return before.endsWith("{") && after.startsWith("}");
};
const fixDeadPatterns = async (context) => {
	const fixable = [...await detectTrivialComments(context), ...await detectDeadPatterns(context)].filter((d) => d.fixable);
	if (fixable.length === 0) return;
	const byFile = /* @__PURE__ */ new Map();
	for (const d of fixable) {
		const absolute = path.isAbsolute(d.filePath) ? d.filePath : path.join(context.rootDirectory, d.filePath);
		const entries = byFile.get(absolute) ?? [];
		entries.push({
			line: d.line,
			rule: d.rule
		});
		byFile.set(absolute, entries);
	}
	for (const [filePath, entries] of byFile) fixFileDeadPatterns(filePath, entries, context.rootDirectory);
};
const fixFileDeadPatterns = (filePath, entries, rootDirectory) => {
	if (!fs.existsSync(filePath)) return;
	const lines = fs.readFileSync(filePath, "utf-8").split("\n");
	const linesToRemove = /* @__PURE__ */ new Set();
	const lineReplacements = /* @__PURE__ */ new Map();
	const skipConsole = isDiagnosticScriptPath(path.relative(rootDirectory, filePath));
	const consoleSpans = [];
	for (const entry of entries) {
		const index = entry.line - 1;
		if (index < 0 || index >= lines.length) continue;
		if (entry.rule === "ai-slop/console-leftover") {
			if (skipConsole) continue;
			const span = findStatementSpan(lines, index);
			const statementText = getStatementText(lines, span);
			if (shouldUpgradeToError(statementText)) lineReplacements.set(entry.line, lines[index].replace(/console\.(?:log|debug|info|trace|dir|table)\s*\(/, "console.error("));
			else consoleSpans.push(span);
		} else linesToRemove.add(entry.line);
	}
	const candidateLines = /* @__PURE__ */ new Set();
	for (const span of consoleSpans) for (const lineNo of span) candidateLines.add(lineNo);
	for (const span of consoleSpans) {
		if (wouldEmptyEnclosingBlock(lines, span, candidateLines)) continue;
		for (const lineNo of span) linesToRemove.add(lineNo);
	}
	const result = applyEditsAndCollapse(lines, linesToRemove, lineReplacements);
	fs.writeFileSync(filePath, result);
};
const applyEditsAndCollapse = (lines, linesToRemove, lineReplacements) => {
	const result = [];
	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		if (linesToRemove.has(lineNo)) continue;
		result.push(lineReplacements.get(lineNo) ?? lines[i]);
	}
	const collapsed = [];
	for (const line of result) {
		const prevEmpty = collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "";
		if (line.trim() === "" && prevEmpty) continue;
		collapsed.push(line);
	}
	return collapsed.join("\n");
};
//#endregion
//#region src/engines/ai-slop/duplicate-imports-fix.ts
const JS_EXTENSIONS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
const IMPORT_FROM_RE = /^\s*import\s+(.*?)\s+from\s+["']([^"']+)["']\s*;?\s*$/;
const SIDE_EFFECT_RE = /^\s*import\s+["']([^"']+)["']\s*;?\s*$/;
const parseNamedClause = (clause) => {
	const inner = clause.trim().slice(1, -1).trim();
	if (inner.length === 0) return [];
	const items = [];
	for (const part of inner.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		let isType = false;
		let working = trimmed;
		if (/^type\s+/.test(working)) {
			isType = true;
			working = working.replace(/^type\s+/, "");
		}
		const aliasMatch = working.match(/^(\w+)\s+as\s+(\w+)$/);
		if (aliasMatch) {
			items.push({
				name: aliasMatch[1],
				alias: aliasMatch[2],
				isType
			});
			continue;
		}
		if (/^\w+$/.test(working)) items.push({
			name: working,
			isType
		});
	}
	return items;
};
const parseImportClause = (clause) => {
	let rest = clause.trim();
	let isTypeOnly = false;
	if (/^type\s+/.test(rest)) {
		isTypeOnly = true;
		rest = rest.replace(/^type\s+/, "");
	}
	const out = {
		named: [],
		isTypeOnly
	};
	const defMatch = rest.match(/^([A-Za-z_$][\w$]*)\s*(?:,\s*(.+))?$/);
	if (defMatch && !rest.startsWith("{") && !rest.startsWith("*")) {
		out.default = defMatch[1];
		rest = defMatch[2]?.trim() ?? "";
	}
	if (rest.startsWith("*")) {
		const nsMatch = rest.match(/^\*\s+as\s+(\w+)/);
		if (nsMatch) out.namespace = nsMatch[1];
		return out;
	}
	if (rest.startsWith("{")) out.named = parseNamedClause(rest);
	return out;
};
const parseImportLine = (line, lineIndex) => {
	const sideEffect = line.match(SIDE_EFFECT_RE);
	if (sideEffect) return {
		lineIndex,
		module: sideEffect[1],
		named: [],
		isTypeOnly: false,
		isSideEffect: true
	};
	const m = line.match(IMPORT_FROM_RE);
	if (!m) return null;
	return {
		lineIndex,
		module: m[2],
		isSideEffect: false,
		...parseImportClause(m[1])
	};
};
const formatNamed = (n, stripType) => {
	const prefix = n.isType && !stripType ? "type " : "";
	const suffix = n.alias ? ` as ${n.alias}` : "";
	return `${prefix}${n.name}${suffix}`;
};
const mergeImports = (group) => {
	if (group.some((s) => s.isSideEffect)) return null;
	if (group.some((s) => s.namespace !== void 0)) return null;
	if (group.some((s) => s.isTypeOnly && s.default !== void 0)) return null;
	const defaults = group.map((s) => s.default).filter((d) => d !== void 0);
	const uniqueDefaults = Array.from(new Set(defaults));
	if (uniqueDefaults.length > 1) return null;
	const defaultName = uniqueDefaults[0];
	const merged = /* @__PURE__ */ new Map();
	for (const stmt of group) for (const nm of stmt.named) {
		const key = nm.alias ?? nm.name;
		const isType = nm.isType || stmt.isTypeOnly;
		const existing = merged.get(key);
		if (!existing) merged.set(key, {
			...nm,
			isType
		});
		else existing.isType = existing.isType && isType;
	}
	const insertionOrder = Array.from(merged.values());
	const namedList = [...insertionOrder.filter((n) => !n.isType), ...insertionOrder.filter((n) => n.isType)];
	const allTypeOnly = namedList.length > 0 && namedList.every((n) => n.isType);
	const module = group[0].module;
	if (!defaultName && namedList.length === 0) return null;
	if (!defaultName && allTypeOnly) return `import type { ${namedList.map((n) => formatNamed(n, true)).join(", ")} } from "${module}";`;
	const parts = [];
	if (defaultName) parts.push(defaultName);
	if (namedList.length > 0) {
		const items = namedList.map((n) => formatNamed(n, false)).join(", ");
		parts.push(`{ ${items} }`);
	}
	return `import ${parts.join(", ")} from "${module}";`;
};
const fixDuplicateImports = async (context) => {
	const files = getSourceFiles(context);
	for (const filePath of files) {
		if (!JS_EXTENSIONS.has(path.extname(filePath))) continue;
		if (isAutoGenerated(filePath)) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		const imports = [];
		for (let i = 0; i < lines.length; i++) {
			const stmt = parseImportLine(lines[i], i);
			if (stmt) imports.push(stmt);
		}
		if (imports.length < 2) continue;
		const groups = /* @__PURE__ */ new Map();
		for (const stmt of imports) {
			const list = groups.get(stmt.module) ?? [];
			list.push(stmt);
			groups.set(stmt.module, list);
		}
		const linesToRemove = /* @__PURE__ */ new Set();
		const replacements = /* @__PURE__ */ new Map();
		let modified = false;
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			const merged = mergeImports(group);
			if (!merged) continue;
			replacements.set(group[0].lineIndex, merged);
			for (const stmt of group.slice(1)) linesToRemove.add(stmt.lineIndex);
			modified = true;
		}
		if (!modified) continue;
		const next = [...lines];
		for (const [idx, replacement] of replacements) next[idx] = replacement;
		const sortedRemove = Array.from(linesToRemove).sort((a, b) => b - a);
		for (const idx of sortedRemove) next.splice(idx, 1);
		fs.writeFileSync(filePath, next.join("\n"));
	}
};
//#endregion
//#region src/engines/ai-slop/narrative-comments-fix.ts
const fixNarrativeComments = async (context) => {
	const diagnostics = await detectNarrativeComments(context);
	if (diagnostics.length === 0) return;
	const byFile = /* @__PURE__ */ new Map();
	for (const d of diagnostics) {
		const abs = d.filePath.startsWith("/") ? d.filePath : `${context.rootDirectory}/${d.filePath}`;
		const list = byFile.get(abs) ?? [];
		list.push(d);
		byFile.set(abs, list);
	}
	for (const [filePath, diags] of byFile) {
		const syntax = getCommentSyntax(path.extname(filePath));
		if (!syntax) continue;
		let content;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		const blocks = collectBlocks(lines, syntax);
		const toRemove = /* @__PURE__ */ new Set();
		for (const d of diags) {
			const block = blocks.find((b) => b.startLine === d.line);
			if (!block) continue;
			for (let ln = block.startLine; ln <= block.endLine; ln += 1) toRemove.add(ln);
			const prev = block.startLine - 1;
			const next = block.endLine + 1;
			const prevIsBlank = prev >= 1 && lines[prev - 1]?.trim() === "";
			const nextIsBlank = next <= lines.length && lines[next - 1]?.trim() === "";
			if (prevIsBlank && nextIsBlank) toRemove.add(prev);
		}
		const kept = [];
		for (let i = 0; i < lines.length; i += 1) if (!toRemove.has(i + 1)) kept.push(lines[i]);
		const newContent = kept.join("\n");
		if (newContent !== content) fs.writeFileSync(filePath, newContent);
	}
};
//#endregion
//#region src/engines/ai-slop/unused-imports-fix.ts
const fixUnusedImports = async (context) => {
	const files = getSourceFiles(context);
	for (const filePath of files) {
		const analysis = analyzeFile(filePath);
		if (!analysis) continue;
		const unused = getUnusedSymbols(analysis.lines, analysis.symbols, analysis.importLines);
		if (unused.length === 0) continue;
		const unusedNames = new Set(unused.map((u) => u.name));
		const lines = [...analysis.lines];
		const symbolsByLine = /* @__PURE__ */ new Map();
		for (const sym of analysis.symbols) {
			const arr = symbolsByLine.get(sym.line) ?? [];
			arr.push(sym);
			symbolsByLine.set(sym.line, arr);
		}
		const linesToRemove = /* @__PURE__ */ new Set();
		for (const [lineNo, syms] of symbolsByLine) {
			const lineIdx = lineNo - 1;
			const allUnused = syms.every((s) => unusedNames.has(s.name));
			const importSpan = JS_EXTENSIONS$1.has(analysis.ext) ? getJsImportSpan(lines, lineIdx) : [lineIdx];
			if (allUnused) for (const idx of importSpan) linesToRemove.add(idx);
			else if (JS_EXTENSIONS$1.has(analysis.ext)) rewriteJsImportSpan(lines, importSpan, syms, unusedNames);
			else if (PY_EXTENSIONS.has(analysis.ext)) rewritePyImportLine(lines, lineIdx, unusedNames);
		}
		if (linesToRemove.size === 0 && unused.length === 0) continue;
		const sortedRemove = [...linesToRemove].sort((a, b) => b - a);
		for (const idx of sortedRemove) lines.splice(idx, 1);
		const filtered = lines.filter((l) => l !== REMOVE_MARKER);
		while (filtered.length > 0 && filtered[0].trim() === "") filtered.shift();
		fs.writeFileSync(filePath, filtered.join("\n"));
	}
};
const getJsImportSpan = (lines, startIdx) => {
	const span = [startIdx];
	let fullImport = lines[startIdx]?.trim() ?? "";
	if (!fullImport.startsWith("import ")) return span;
	let idx = startIdx + 1;
	while (!fullImport.includes("from") && idx < lines.length) {
		span.push(idx);
		fullImport += ` ${lines[idx].trim()}`;
		idx++;
	}
	return span;
};
const rewriteJsImportSpan = (lines, span, syms, unusedNames) => {
	const fullImport = span.map((i) => lines[i]).join("\n");
	const namedMatch = fullImport.match(/\{([^}]+)\}/s);
	if (!namedMatch) return;
	const unusedNamed = syms.filter((s) => !s.isDefault && !s.isNamespace && unusedNames.has(s.name));
	const defaultUnused = syms.some((s) => s.isDefault && unusedNames.has(s.name));
	if (unusedNamed.length === 0 && !defaultUnused) return;
	const unusedNamedSet = new Set(unusedNamed.map((s) => s.name));
	const keptSpecifiers = namedMatch[1].split(",").map((s) => s.trim()).filter(Boolean).filter((spec) => {
		const parts = spec.split(/\s+as\s+/);
		const localName = parts.length > 1 ? parts[1].trim().replace(/^type\s+/, "") : parts[0].trim().replace(/^type\s+/, "");
		return !unusedNamedSet.has(localName);
	});
	const fromMatch = fullImport.match(/from\s+["']([^"']+)["'];?/);
	const fromClause = fromMatch ? `from "${fromMatch[1]}"` : "";
	if (keptSpecifiers.length === 0) {
		const usedDefault = syms.find((s) => s.isDefault && !unusedNames.has(s.name));
		if (usedDefault) {
			const defaultMatch = fullImport.match(/^import\s+(\w+)/);
			const defaultName = defaultMatch ? defaultMatch[1] : usedDefault.name;
			lines[span[0]] = `import ${defaultName} ${fromClause};`;
			for (let i = 1; i < span.length; i++) lines[span[i]] = REMOVE_MARKER;
		} else for (const idx of span) lines[idx] = REMOVE_MARKER;
		return;
	}
	if (defaultUnused) {
		lines[span[0]] = `import { ${keptSpecifiers.join(", ")} } ${fromClause};`;
		for (let i = 1; i < span.length; i++) lines[span[i]] = REMOVE_MARKER;
		return;
	}
	const importPrefix = fullImport.match(/^(import\s+(?:\w+\s*,\s*)?)/);
	const prefix = importPrefix ? importPrefix[1] : "import ";
	const wasMultiLine = span.length > 1;
	let newImport;
	if (wasMultiLine && keptSpecifiers.length > 2) {
		const indentMatch = lines[span[1]]?.match(/^(\s+)/);
		const indent = indentMatch ? indentMatch[1] : "	";
		newImport = `${prefix}{\n${keptSpecifiers.map((s) => `${indent}${s},`).join("\n")}\n} ${fromClause};`;
	} else newImport = `${prefix}{ ${keptSpecifiers.join(", ")} } ${fromClause};`;
	lines[span[0]] = newImport;
	for (let i = 1; i < span.length; i++) lines[span[i]] = REMOVE_MARKER;
};
const rewritePyImportLine = (lines, lineIdx, unusedNames) => {
	const fromMatch = lines[lineIdx].match(/^(\s*from\s+[\w.]+\s+import\s+)(.+)$/);
	if (!fromMatch) {
		rewritePlainPyImportLine(lines, lineIdx, unusedNames);
		return;
	}
	const prefix = fromMatch[1];
	const importPart = fromMatch[2].replace(/#.*$/, "").trim();
	const hasParen = importPart.startsWith("(");
	const keptSpecifiers = importPart.replace(/[()]/g, "").split(",").map((s) => s.trim()).filter((spec) => {
		const parts = spec.split(/\s+as\s+/);
		const localName = parts.length > 1 ? parts[1].trim() : parts[0].trim();
		return !unusedNames.has(localName);
	});
	if (keptSpecifiers.length === 0) return;
	const joined = keptSpecifiers.join(", ");
	lines[lineIdx] = hasParen ? `${prefix}(${joined})` : `${prefix}${joined}`;
};
const rewritePlainPyImportLine = (lines, lineIdx, unusedNames) => {
	const match = lines[lineIdx].match(/^(\s*import\s+)(.+)$/);
	if (!match) return;
	const prefix = match[1];
	const specifiers = match[2].replace(/#.*$/, "").split(",").map((s) => s.trim()).filter(Boolean);
	const kept = specifiers.filter((spec) => {
		const parts = spec.split(/\s+as\s+/);
		const localName = parts.length > 1 ? parts[1].trim() : parts[0].trim().split(".")[0];
		return !unusedNames.has(localName);
	});
	if (kept.length === 0 || kept.length === specifiers.length) return;
	lines[lineIdx] = `${prefix}${kept.join(", ")}`;
};
//#endregion
//#region src/engines/code-quality/unused-removal-ast.ts
const getLineFromPos = (sourceFile, pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
const nodeContainsLine = (sourceFile, node, targetLine) => {
	const startLine = getLineFromPos(sourceFile, node.getStart(sourceFile));
	const endLine = getLineFromPos(sourceFile, node.getEnd());
	return startLine <= targetLine && targetLine <= endLine;
};
const initializerHasSideEffects = (node) => {
	if (!node) return false;
	let unsafe = false;
	const visit = (n) => {
		if (unsafe) return;
		if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n) || ts.isDeleteExpression(n) || ts.isPostfixUnaryExpression(n)) {
			unsafe = true;
			return;
		}
		if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
			unsafe = true;
			return;
		}
		if (ts.isPrefixUnaryExpression(n) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
			unsafe = true;
			return;
		}
		if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) return;
		ts.forEachChild(n, visit);
	};
	visit(node);
	return unsafe;
};
const computeRemovalRange = (sourceFile, node, content) => {
	const nodeStart = node.getStart(sourceFile);
	const end = node.getEnd();
	let start = nodeStart;
	while (start > 0 && content[start - 1] !== "\n") start--;
	const ranges = ts.getLeadingCommentRanges(content, node.getFullStart()) ?? [];
	if (ranges.length > 0) {
		let cursor = start;
		for (let i = ranges.length - 1; i >= 0; i--) {
			const r = ranges[i];
			const between = content.slice(r.end, cursor);
			if (/^\s*$/.test(between) && (between.match(/\n/g) ?? []).length <= 1) {
				let cs = r.pos;
				while (cs > 0 && content[cs - 1] !== "\n") cs--;
				cursor = cs;
			} else break;
		}
		start = cursor;
	}
	let finalEnd = end;
	if (finalEnd < content.length && content[finalEnd] === "\r") finalEnd++;
	if (finalEnd < content.length && content[finalEnd] === "\n") finalEnd++;
	return {
		start,
		end: finalEnd
	};
};
const kindOfStatement = (node) => {
	if (ts.isVariableStatement(node)) return "variable";
	if (ts.isFunctionDeclaration(node)) return "function";
	if (ts.isClassDeclaration(node)) return "class";
	if (ts.isTypeAliasDeclaration(node)) return "type";
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isEnumDeclaration(node)) return "enum";
	return null;
};
const matchStatement = (sourceFile, statement, content, decl) => {
	if (!kindOfStatement(statement)) return { type: "none" };
	if (ts.isVariableStatement(statement)) {
		const varDecls = statement.declarationList.declarations;
		if (varDecls.length === 0) return { type: "none" };
		const match = varDecls.find((vd) => {
			const nameNode = vd.name;
			if (!ts.isIdentifier(nameNode)) return false;
			if (nameNode.text !== decl.name) return false;
			return nodeContainsLine(sourceFile, vd, decl.line);
		});
		if (!match) return { type: "none" };
		if (varDecls.length > 1) return {
			type: "skip",
			reason: "multi-declaration variable statement",
			declaration: decl
		};
		if (initializerHasSideEffects(match.initializer)) return {
			type: "skip",
			reason: "initializer may have side effects",
			declaration: decl
		};
		return {
			type: "match",
			removal: {
				...computeRemovalRange(sourceFile, statement, content),
				declaration: decl
			}
		};
	}
	if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
		if (!statement.name) return { type: "none" };
		if (statement.name.text !== decl.name) return { type: "none" };
		if (!nodeContainsLine(sourceFile, statement, decl.line)) return { type: "none" };
		return {
			type: "match",
			removal: {
				...computeRemovalRange(sourceFile, statement, content),
				declaration: decl
			}
		};
	}
	if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isEnumDeclaration(statement)) {
		if (statement.name.text !== decl.name) return { type: "none" };
		if (!nodeContainsLine(sourceFile, statement, decl.line)) return { type: "none" };
		return {
			type: "match",
			removal: {
				...computeRemovalRange(sourceFile, statement, content),
				declaration: decl
			}
		};
	}
	return { type: "none" };
};
const applyRemovals = (content, removals) => {
	const ordered = [...removals].sort((a, b) => b.start - a.start);
	let output = content;
	for (const r of ordered) output = output.slice(0, r.start) + output.slice(r.end);
	return output;
};
const hasSyntaxDiagnostics = (filePath, content) => {
	const diagnostics = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true).parseDiagnostics;
	return Array.isArray(diagnostics) && diagnostics.length > 0;
};
//#endregion
//#region src/engines/code-quality/unused-removal-detect.ts
const KNIP_MESSAGE_KIND = {
	"knip/exports": "variable",
	"knip/types": "type",
	"knip/duplicates": "variable"
};
const extractNameFromKnip = (message) => {
	return message.match(/^(?:Unused export|Unused type|Duplicate export):\s*(.+)$/)?.[1]?.trim() ?? null;
};
const extractNameAndKindFromOxlint = (message) => {
	const varMatch = message.match(/Variable '([^']+)' is declared but never used/);
	if (varMatch?.[1]) return {
		name: varMatch[1],
		kind: "variable"
	};
	const funcMatch = message.match(/Function '([^']+)' is declared but never used/);
	if (funcMatch?.[1]) return {
		name: funcMatch[1],
		kind: "function"
	};
	const classMatch = message.match(/Class '([^']+)' is declared but never used/);
	if (classMatch?.[1]) return {
		name: classMatch[1],
		kind: "class"
	};
	const tsValueMatch = message.match(/'([^']+)' is declared but its value is never read/);
	if (tsValueMatch?.[1]) return {
		name: tsValueMatch[1],
		kind: "variable"
	};
	const identMatch = message.match(/'([^']+)' is (?:defined|declared) but never used/);
	if (identMatch?.[1]) return {
		name: identMatch[1],
		kind: "variable"
	};
	return null;
};
const isUnusedVarRule = (rule) => rule === "no-unused-vars" || rule.endsWith("/no-unused-vars");
const detectUnusedDeclarations = async (context) => {
	const [oxlintDiagnostics, knipDiagnostics] = await Promise.all([runOxlint(context).catch(() => []), runKnip(context.rootDirectory).catch(() => [])]);
	const merged = [];
	for (const d of oxlintDiagnostics) {
		if (!isUnusedVarRule(d.rule)) continue;
		const extracted = extractNameAndKindFromOxlint(d.message);
		if (!extracted) continue;
		if (extracted.name.startsWith("_")) continue;
		merged.push({
			filePath: d.filePath,
			engine: "code-quality",
			rule: "code-quality/unused-declaration",
			severity: "warning",
			message: `Unused ${extracted.kind}: ${extracted.name}`,
			help: "This top-level declaration is never used; aislop will remove it.",
			line: d.line,
			column: d.column,
			category: "Dead Code",
			fixable: true
		});
	}
	for (const d of knipDiagnostics) {
		if (!(d.rule in KNIP_MESSAGE_KIND)) continue;
		const name = extractNameFromKnip(d.message);
		if (!name) continue;
		const kind = KNIP_MESSAGE_KIND[d.rule];
		merged.push({
			filePath: d.filePath,
			engine: "code-quality",
			rule: "code-quality/unused-declaration",
			severity: "warning",
			message: `Unused ${kind}: ${name}`,
			help: "This top-level declaration is never imported; aislop will remove it.",
			line: d.line,
			column: d.column,
			category: "Dead Code",
			fixable: true
		});
	}
	const seen = /* @__PURE__ */ new Set();
	return merged.filter((d) => {
		const key = `${d.filePath}:${d.line}:${d.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};
/**
* Convert the detection diagnostics produced above into UnusedDeclaration
* records the remover can consume.
*/
const diagnosticsToDeclarations = (diagnostics) => {
	const result = [];
	for (const d of diagnostics) {
		const match = d.message.match(/^Unused (\w+): (.+)$/);
		if (!match) continue;
		const [, kindWord, name] = match;
		if (kindWord !== "variable" && kindWord !== "function" && kindWord !== "class" && kindWord !== "type" && kindWord !== "interface" && kindWord !== "enum") continue;
		result.push({
			filePath: d.filePath,
			line: d.line,
			column: d.column,
			name: name.trim(),
			kind: kindWord
		});
	}
	return result;
};
//#endregion
//#region src/engines/code-quality/unused-removal.ts
const removeUnusedDeclarations = (rootDirectory, declarations) => {
	const result = {
		removed: 0,
		skipped: []
	};
	const byFile = /* @__PURE__ */ new Map();
	for (const decl of declarations) {
		const absolute = path.isAbsolute(decl.filePath) ? decl.filePath : path.join(rootDirectory, decl.filePath);
		const arr = byFile.get(absolute) ?? [];
		arr.push(decl);
		byFile.set(absolute, arr);
	}
	for (const [filePath, fileDecls] of byFile) {
		if (!fs.existsSync(filePath)) {
			for (const d of fileDecls) result.skipped.push({
				declaration: d,
				reason: "file not found"
			});
			continue;
		}
		const original = fs.readFileSync(filePath, "utf-8");
		const sourceFile = ts.createSourceFile(filePath, original, ts.ScriptTarget.Latest, true);
		const originalHadSyntaxErrors = hasSyntaxDiagnostics(filePath, original);
		const pending = [];
		const pendingSkips = [];
		for (const decl of fileDecls) {
			let matched = { type: "none" };
			for (const statement of sourceFile.statements) {
				const attempt = matchStatement(sourceFile, statement, original, decl);
				if (attempt.type !== "none") {
					matched = attempt;
					break;
				}
			}
			if (matched.type === "match") pending.push(matched.removal);
			else if (matched.type === "skip") pendingSkips.push({
				declaration: matched.declaration,
				reason: matched.reason
			});
			else pendingSkips.push({
				declaration: decl,
				reason: "declaration not found at top level"
			});
		}
		if (pending.length === 0) {
			for (const s of pendingSkips) result.skipped.push(s);
			continue;
		}
		const updated = applyRemovals(original, pending);
		const normalized = updated.trim() === "" ? "\n" : updated;
		if (!originalHadSyntaxErrors && hasSyntaxDiagnostics(filePath, normalized)) {
			for (const p of pending) result.skipped.push({
				declaration: p.declaration,
				reason: "removal would break file syntax"
			});
			for (const s of pendingSkips) result.skipped.push(s);
			continue;
		}
		if (normalized !== original) {
			fs.writeFileSync(filePath, normalized);
			result.removed += pending.length;
		}
		for (const s of pendingSkips) result.skipped.push(s);
	}
	return result;
};
//#endregion
//#region src/commands/fix-expo.ts
const INSTALL_TIMEOUT$1 = 1800 * 1e3;
const fixExpoDependencies = async (context, onProgress) => {
	await removeDisallowedExpoPackages(context.rootDirectory, onProgress);
	onProgress?.("Expo dependency alignment · running expo install --fix (can take a few minutes)");
	if ((await runSubprocess("npx", [
		"--yes",
		"expo",
		"install",
		"--fix"
	], {
		cwd: context.rootDirectory,
		timeout: INSTALL_TIMEOUT$1
	})).exitCode === 0) return;
	onProgress?.("Expo dependency alignment · checking remaining issues");
	const checkResult = await runSubprocess("npx", [
		"--yes",
		"expo",
		"install",
		"--check"
	], {
		cwd: context.rootDirectory,
		timeout: INSTALL_TIMEOUT$1
	});
	if (checkResult.exitCode !== 0) throw new Error(checkResult.stderr || checkResult.stdout || "expo dependency check failed");
};
/**
* Run expo-doctor to detect packages that should not be installed directly,
* then uninstall them. No hardcoded list — expo-doctor is the source of truth.
*/
const removeDisallowedExpoPackages = async (rootDir, onProgress) => {
	try {
		onProgress?.("Expo dependency alignment · running expo-doctor");
		const result = await runSubprocess("npx", [
			"--yes",
			"expo-doctor",
			rootDir
		], {
			cwd: rootDir,
			timeout: INSTALL_TIMEOUT$1
		});
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const packagePattern = /The package "([^"]+)" should not be installed directly/g;
		const toRemove = [];
		for (const match of output.matchAll(packagePattern)) toRemove.push(match[1]);
		if (toRemove.length === 0) return;
		onProgress?.(`Expo dependency alignment · uninstalling ${toRemove.length} package(s)`);
		await runSubprocess("npm", ["uninstall", ...toRemove], {
			cwd: rootDir,
			timeout: INSTALL_TIMEOUT$1
		});
	} catch {}
};
//#endregion
//#region src/commands/fix-force.ts
const INSTALL_TIMEOUT = 1800 * 1e3;
const AUDIT_TIMEOUT = 60 * 1e3;
const detectPackageManager = (rootDirectory) => {
	if (fs.existsSync(path.join(rootDirectory, "pnpm-lock.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(rootDirectory, "package-lock.json")) || fs.existsSync(path.join(rootDirectory, "package.json"))) return "npm";
	return null;
};
const fixDependencyAudit = async (context, onProgress) => {
	const pm = detectPackageManager(context.rootDirectory);
	if (!pm) return;
	if (pm === "npm") {
		await runNpmAuditFix(context.rootDirectory, onProgress);
		await tryNpmOverrides(context.rootDirectory, onProgress);
		return;
	}
	if (await tryPnpmOverrides(context.rootDirectory, onProgress)) return;
	if (fs.existsSync(path.join(context.rootDirectory, "package-lock.json"))) {
		await runNpmAuditFix(context.rootDirectory, onProgress);
		await tryNpmOverrides(context.rootDirectory, onProgress);
		return;
	}
	onProgress?.("Dependency audit fixes · skipping (pnpm audit unavailable and no package-lock.json for npm fallback)");
};
const SEMVER_PREFIX_RE = /^[~^]?/;
const parseSemverMin = (spec) => {
	const match = spec.replace(SEMVER_PREFIX_RE, "").match(/^(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/);
	if (!match) return null;
	const head = match[1];
	if (!/^\d+$/.test(head)) return null;
	const toNum = (part) => {
		if (!part) return 0;
		return /^\d+$/.test(part) ? Number(part) : 0;
	};
	return [
		Number(head),
		toNum(match[2]),
		toNum(match[3])
	];
};
const isDowngrade = (oldSpec, newSpec) => {
	const oldV = parseSemverMin(oldSpec);
	const newV = parseSemverMin(newSpec);
	if (!oldV || !newV) return false;
	for (let i = 0; i < 3; i++) {
		if ((newV[i] ?? 0) < (oldV[i] ?? 0)) return true;
		if ((newV[i] ?? 0) > (oldV[i] ?? 0)) return false;
	}
	return false;
};
const DEP_BUCKETS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies"
];
const snapshotPackageVersions = (pkg) => {
	const map = /* @__PURE__ */ new Map();
	for (const bucket of DEP_BUCKETS) {
		const deps = pkg[bucket];
		if (!deps || typeof deps !== "object") continue;
		for (const [name, version] of Object.entries(deps)) if (typeof version === "string") map.set(`${bucket}:${name}`, version);
	}
	return map;
};
const revertDowngrades = (rootDir, before) => {
	const pkgPath = path.join(rootDir, "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
	const reverted = [];
	for (const bucket of DEP_BUCKETS) {
		const deps = pkg[bucket];
		if (!deps) continue;
		for (const [name, version] of Object.entries(deps)) {
			const prior = before.get(`${bucket}:${name}`);
			if (!prior) continue;
			if (isDowngrade(prior, version)) {
				deps[name] = prior;
				reverted.push(`${name} ${version} → ${prior}`);
			}
		}
	}
	if (reverted.length > 0) fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
	return reverted;
};
const runNpmAuditFix = async (rootDir, onProgress) => {
	const pkgPath = path.join(rootDir, "package.json");
	const before = snapshotPackageVersions(JSON.parse(fs.readFileSync(pkgPath, "utf-8")));
	onProgress?.("Dependency audit fixes · running npm audit fix (can take a few minutes)");
	const result = await runSubprocess("npm", ["audit", "fix"], {
		cwd: rootDir,
		timeout: INSTALL_TIMEOUT
	});
	if (result.exitCode !== 0 && !result.stdout && !result.stderr) throw new Error("npm audit fix failed");
	const reverted = revertDowngrades(rootDir, before);
	if (reverted.length > 0) onProgress?.(`Dependency audit fixes · reverted ${reverted.length} downgrade(s): ${reverted.join(", ")}`);
	onProgress?.("Dependency audit fixes · running npm install");
	const installResult = await runSubprocess("npm", ["install"], {
		cwd: rootDir,
		timeout: INSTALL_TIMEOUT
	});
	if (installResult.exitCode !== 0) throw new Error(installResult.stderr || installResult.stdout || "npm install failed after audit fix");
};
const fetchLatestVersion = async (rootDir, pkgName, pm) => {
	try {
		const result = await runSubprocess(pm, [
			"view",
			pkgName,
			"version",
			"--json"
		], {
			cwd: rootDir,
			timeout: 1e4
		});
		return result.stdout ? JSON.parse(result.stdout) : null;
	} catch {
		return null;
	}
};
const collectOverrides = async (rootDir, vulnerabilities, pm) => {
	const overrides = {};
	for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
		if (vuln.fixAvailable !== false || !vuln.range) continue;
		const latest = await fetchLatestVersion(rootDir, pkgName, pm);
		if (latest) overrides[pkgName] = latest;
	}
	return overrides;
};
const tryNpmOverrides = async (rootDir, onProgress) => {
	try {
		const auditResult = await runSubprocess("npm", ["audit", "--json"], {
			cwd: rootDir,
			timeout: AUDIT_TIMEOUT
		});
		if (!auditResult.stdout) return;
		const vulnerabilities = JSON.parse(auditResult.stdout).vulnerabilities;
		if (!vulnerabilities) return;
		const rawOverrides = await collectOverrides(rootDir, vulnerabilities, "npm");
		if (Object.keys(rawOverrides).length === 0) return;
		const overrides = guardAndReport(rootDir, rawOverrides, onProgress);
		if (Object.keys(overrides).length === 0) return;
		const pkgPath = path.join(rootDir, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		pkg.overrides = {
			...pkg.overrides || {},
			...overrides
		};
		fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
		onProgress?.("Dependency audit fixes · applying npm overrides (npm install)");
		await runSubprocess("npm", ["install"], {
			cwd: rootDir,
			timeout: INSTALL_TIMEOUT
		});
	} catch {}
};
const patchedRangeToVersion = (patched) => {
	const match = patched.match(/^\s*>=?\s*([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/);
	return match ? `^${match[1]}` : null;
};
const overrideKey = (name, vulnerable, patched) => {
	if (vulnerable && vulnerable.trim().length > 0 && !/^\*$/.test(vulnerable.trim())) return `${name}@${vulnerable.trim()}`;
	const first = patched.match(/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
	return first ? `${name}@<${first}` : name;
};
const collectPnpmOverrides = (advisories) => {
	const overrides = {};
	for (const adv of Object.values(advisories)) {
		if (!adv.module_name || !adv.patched_versions) continue;
		const target = patchedRangeToVersion(adv.patched_versions);
		if (!target) continue;
		const key = overrideKey(adv.module_name, adv.vulnerable_versions, adv.patched_versions);
		overrides[key] = target;
	}
	return overrides;
};
const overrideName = (key) => {
	const at = key.lastIndexOf("@");
	return at > 0 ? key.slice(0, at) : key;
};
const guardOverrides = (overrides, installed) => {
	const safe = {};
	const skipped = [];
	for (const [key, target] of Object.entries(overrides)) {
		const current = installed.get(overrideName(key));
		if (current && isDowngrade(current, target)) {
			skipped.push(`${overrideName(key)} ${current} → ${target}`);
			continue;
		}
		safe[key] = target;
	}
	return {
		safe,
		skipped
	};
};
const readRootNodeModulesVersion = (rootDir, name) => {
	try {
		const manifest = path.join(rootDir, "node_modules", name, "package.json");
		const version = JSON.parse(fs.readFileSync(manifest, "utf-8")).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
};
const PNPM_STORE_VERSION_RE = /^(\d+\.\d+\.\d+[^_(]*)/;
const isHigherVersion = (candidate, current) => {
	if (!current) return true;
	const a = parseSemverMin(candidate);
	const b = parseSemverMin(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
		if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
	}
	return false;
};
const readPnpmStoreVersion = (rootDir, name) => {
	let entries;
	try {
		entries = fs.readdirSync(path.join(rootDir, "node_modules", ".pnpm"));
	} catch {
		return null;
	}
	const prefix = name.replace(/\//g, "+") + "@";
	let best = null;
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const match = PNPM_STORE_VERSION_RE.exec(entry.slice(prefix.length));
		if (match && isHigherVersion(match[1], best)) best = match[1];
	}
	return best;
};
const readInstalledVersions = (rootDir, names) => {
	const map = /* @__PURE__ */ new Map();
	for (const name of names) {
		const version = readRootNodeModulesVersion(rootDir, name) ?? readPnpmStoreVersion(rootDir, name);
		if (version) map.set(name, version);
	}
	return map;
};
const guardAndReport = (rootDir, rawOverrides, onProgress) => {
	const installed = readInstalledVersions(rootDir, Object.keys(rawOverrides).map(overrideName));
	const { safe, skipped } = guardOverrides(rawOverrides, installed);
	if (skipped.length > 0) onProgress?.(`Dependency audit fixes · skipped ${skipped.length} downgrade(s), verify intent: ${skipped.join(", ")}`);
	return safe;
};
const isPnpmAuditRetired = (stdout, stderr) => {
	const haystack = `${stdout}\n${stderr}`.toLowerCase();
	return haystack.includes("410") || haystack.includes("gone") || haystack.includes("retired") || haystack.includes("endpoint") || haystack.includes("err_pnpm_audit") || haystack.includes("audit endpoint");
};
const tryPnpmOverrides = async (rootDir, onProgress) => {
	onProgress?.("Dependency audit fixes · running pnpm audit");
	const auditResult = await runSubprocess("pnpm", ["audit", "--json"], {
		cwd: rootDir,
		timeout: AUDIT_TIMEOUT
	});
	if (!auditResult.stdout) {
		if (isPnpmAuditRetired(auditResult.stdout ?? "", auditResult.stderr ?? "")) return false;
		return auditResult.exitCode === 0;
	}
	let parsed;
	try {
		parsed = JSON.parse(auditResult.stdout);
	} catch {
		if (auditResult.exitCode !== 0 || isPnpmAuditRetired(auditResult.stdout, auditResult.stderr ?? "")) return false;
		return true;
	}
	const advisories = parsed.advisories;
	if (!advisories || Object.keys(advisories).length === 0) return true;
	const rawOverrides = collectPnpmOverrides(advisories);
	if (Object.keys(rawOverrides).length === 0) return true;
	const overrides = guardAndReport(rootDir, rawOverrides, onProgress);
	if (Object.keys(overrides).length === 0) return true;
	const pkgPath = path.join(rootDir, "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
	const pnpmBlock = pkg.pnpm ?? {};
	const existing = pnpmBlock.overrides ?? {};
	pkg.pnpm = {
		...pnpmBlock,
		overrides: {
			...existing,
			...overrides
		}
	};
	fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
	onProgress?.("Dependency audit fixes · applying pnpm overrides (pnpm install)");
	await runSubprocess("pnpm", ["install"], {
		cwd: rootDir,
		timeout: INSTALL_TIMEOUT
	});
	return true;
};
//#endregion
//#region src/commands/fix-pipeline-language.ts
const hasJsOrTs = (projectInfo) => projectInfo.languages.includes("typescript") || projectInfo.languages.includes("javascript");
//#endregion
//#region src/commands/fix-scope.ts
const CANNOT_SCOPE_REASON = "cannot honour an explicit file list under --changes/--staged";
const MISSING_MANIFEST_REASON = "no manifest or lockfile in the selected scope";
const fixScopeError = (resolvedDir, flags) => {
	if (flags.changes && flags.staged) return "--changes and --staged cannot be used together.";
	return scanTargetError(resolvedDir, {
		changes: Boolean(flags.changes),
		staged: Boolean(flags.staged),
		base: flags.base,
		verbose: false,
		json: false
	});
};
const collectFixFileScope = (rootDirectory, excludePatterns, includePatterns, flags) => {
	const mode = resolveScanScopeMode({
		changes: Boolean(flags.changes),
		staged: Boolean(flags.staged),
		base: flags.base,
		verbose: false,
		json: false
	});
	if (mode.kind === "full") return null;
	return collectScanFileScope({
		excludePatterns,
		includePatterns,
		mode,
		rootDirectory
	});
};
const isScopedFix = (context) => context.files !== void 0;
const WRITTEN_LOCKFILES = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb"
];
const scopeIncludesManifestWrites = (context) => {
	if (!isScopedFix(context)) return true;
	const selected = new Set((context.dependencyAuditFiles ?? []).map((candidate) => projectRelativePosix(context.rootDirectory, candidate)));
	if (!selected.has("package.json")) return false;
	return WRITTEN_LOCKFILES.every((name) => !fs.existsSync(path.join(context.rootDirectory, name)) || selected.has(name));
};
const isPathInFixScope = (context, filePath) => {
	if (!isScopedFix(context)) return true;
	const relative = projectRelativePosix(context.rootDirectory, filePath);
	return new Set((context.files ?? []).map((candidate) => projectRelativePosix(context.rootDirectory, candidate))).has(relative);
};
//#endregion
//#region src/commands/fix-formatting-pipeline.ts
const skipUnsafeSafeFormatter = (deps, language) => {
	if (!deps.safe) return false;
	const tool = language === "ruby" ? "rubocop" : "php-cs-fixer";
	const label = language === "ruby" ? "Ruby" : "PHP";
	log.warn(`Safe mode skips ${label} formatting because ${tool} can execute project-controlled configuration. Run \`aislop fix\` without --safe if you trust this repository.`);
	return true;
};
const skipUnscopableCsharpFormatter = (deps) => {
	const { unsupportedPatterns } = buildDotnetFormatExcludeScope(deps.context.excludePatterns);
	if (unsupportedPatterns.length === 0) return false;
	log.warn(`Skipping C# formatting: dotnet format cannot exclude ${unsupportedPatterns.join(", ")}. Rewrite those exclude patterns with plain paths, \`*\`, or \`**\` to have C# formatted around them.`);
	return true;
};
const runFormattingStep = async (deps) => {
	if (!deps.config.engines.format) return;
	if (hasJsOrTs(deps.projectInfo)) await deps.runStep("Formatting (js/ts)", () => runBiomeFormat(deps.context), () => fixBiomeFormat(deps.context));
	if (deps.projectInfo.languages.includes("python") && deps.projectInfo.installedTools.ruff) await deps.runStep("Formatting (python)", () => runRuffFormat(deps.context), () => fixRuffFormat(deps.context));
	else if (deps.projectInfo.languages.includes("python")) log.warn("Python detected but ruff is not installed; skipping Python formatting fixes.");
	if (deps.projectInfo.languages.includes("go") && deps.projectInfo.installedTools.gofmt) await deps.runStep("Formatting (go)", () => runGofmt(deps.context), () => fixGofmt(deps.context));
	else if (deps.projectInfo.languages.includes("go")) log.warn("Go detected but gofmt is not installed; skipping Go formatting fixes.");
	if (deps.projectInfo.languages.includes("rust") && deps.projectInfo.installedTools.rustfmt) if (isScopedFix(deps.context)) deps.skipStep?.("Formatting (rust)", CANNOT_SCOPE_REASON);
	else await deps.runStep("Formatting (rust)", () => runGenericFormatter(deps.context, "rust"), () => fixGenericFormatter(deps.context, "rust"));
	else if (deps.projectInfo.languages.includes("rust")) log.warn("Rust detected but rustfmt is not installed; skipping Rust formatting fixes.");
	if (deps.projectInfo.languages.includes("ruby") && deps.projectInfo.installedTools.rubocop) {
		if (!skipUnsafeSafeFormatter(deps, "ruby")) await deps.runStep("Formatting (ruby)", () => runGenericFormatter(deps.context, "ruby"), () => fixGenericFormatter(deps.context, "ruby"));
	} else if (deps.projectInfo.languages.includes("ruby")) log.warn("Ruby detected but rubocop is not installed; skipping Ruby formatting fixes.");
	if (deps.projectInfo.languages.includes("php") && deps.projectInfo.installedTools["php-cs-fixer"]) {
		if (!skipUnsafeSafeFormatter(deps, "php")) await deps.runStep("Formatting (php)", () => runGenericFormatter(deps.context, "php"), () => fixGenericFormatter(deps.context, "php"));
	} else if (deps.projectInfo.languages.includes("php")) log.warn("PHP detected but php-cs-fixer is not installed; skipping PHP formatting fixes.");
	await runNativeFormattingSteps(deps);
};
const runNativeFormattingSteps = async (deps) => {
	if (deps.projectInfo.languages.includes("csharp") && deps.projectInfo.installedTools.dotnet) {
		if (deps.context.config.lint?.csharp?.projectEvaluation !== true) log.warn("Skipping C# formatting: set lint.csharp.projectEvaluation: true only for repositories you trust.");
		else if (isScopedFix(deps.context)) deps.skipStep?.("Formatting (csharp)", CANNOT_SCOPE_REASON);
		else if (!skipUnscopableCsharpFormatter(deps)) await deps.runStep("Formatting (csharp)", () => runDotnetFormat(deps.context), () => fixDotnetFormat(deps.context));
	} else if (deps.projectInfo.languages.includes("csharp")) log.warn("C# detected but dotnet is not installed; skipping C# formatting fixes.");
	if (deps.projectInfo.languages.includes("cpp") && deps.projectInfo.installedTools["clang-format"]) await deps.runStep("Formatting (cpp)", () => runClangFormat(deps.context), () => fixClangFormat(deps.context));
	else if (deps.projectInfo.languages.includes("cpp")) log.warn("C/C++ detected but clang-format is not installed; skipping C/C++ formatting fixes.");
};
//#endregion
//#region src/commands/fix-pipeline.ts
const runAiSlopSteps = async (deps) => {
	if (!deps.config.engines["ai-slop"]) return;
	await deps.runStep("Unused imports", () => detectUnusedImports(deps.context), () => fixUnusedImports(deps.context));
	await deps.runStep("Duplicate imports", () => detectDuplicateImports(deps.context), () => fixDuplicateImports(deps.context));
	if (deps.safe) {
		await deps.runStep("Narrative comments", async () => (await detectNarrativeComments(deps.context)).filter((d) => d.fixable), () => fixNarrativeComments(deps.context));
		return;
	}
	const detectFixableSlop = async () => {
		const [comments, dead, narrative] = await Promise.all([
			detectTrivialComments(deps.context),
			detectDeadPatterns(deps.context),
			detectNarrativeComments(deps.context)
		]);
		return [
			...comments,
			...dead,
			...narrative
		].filter((d) => d.fixable);
	};
	await deps.runStep("Dead code & comments", detectFixableSlop, async () => {
		await fixDeadPatterns(deps.context);
		await fixNarrativeComments(deps.context);
	});
};
const runDeclarationStep = async (deps) => {
	if (!deps.config.engines["code-quality"]) return;
	if (!hasJsOrTs(deps.projectInfo)) return;
	await deps.runStep("Unused declarations", () => detectUnusedDeclarations(deps.context), async () => {
		const declarations = diagnosticsToDeclarations(await detectUnusedDeclarations(deps.context));
		removeUnusedDeclarations(deps.resolvedDir, declarations);
	});
};
const runLintSteps = async (deps) => {
	if (!deps.config.engines.lint) return;
	if (hasJsOrTs(deps.projectInfo)) await deps.runStep("Lint fixes (js/ts)", () => runOxlint(deps.context), () => fixOxlint(deps.context, { force: deps.force }));
	if (deps.projectInfo.languages.includes("python") && deps.projectInfo.installedTools.ruff) await deps.runStep("Lint fixes (python)", () => runRuffLint(deps.context), () => deps.force ? fixRuffLintForce(deps.context) : fixRuffLint(deps.context));
	else if (deps.projectInfo.languages.includes("python")) log.warn("Python detected but ruff is not installed; skipping Python lint fixes.");
	if (deps.projectInfo.languages.includes("ruby") && deps.projectInfo.installedTools.rubocop) await deps.runStep("Lint fixes (ruby)", () => runGenericLinter(deps.context, "ruby"), () => fixRubyLint(deps.context));
	else if (deps.projectInfo.languages.includes("ruby")) log.warn("Ruby detected but rubocop is not installed; skipping Ruby lint fixes.");
};
const dependencyLanguages = (deps) => ({
	...deps.projectInfo,
	languages: deps.context.dependencyAuditLanguages ?? deps.projectInfo.languages
});
const runDependencyStep = async (deps) => {
	if (!deps.config.engines["code-quality"]) return;
	if (!hasJsOrTs(dependencyLanguages(deps))) return;
	if (!scopeIncludesManifestWrites(deps.context)) {
		deps.skipStep?.("Unused dependencies", MISSING_MANIFEST_REASON);
		return;
	}
	await deps.runStep("Unused dependencies", () => runKnipDependencyCheck(deps.resolvedDir), () => fixUnusedDependencies(deps.resolvedDir));
};
const runForceSteps = async (deps) => {
	if (!deps.force) return;
	if (deps.config.engines["code-quality"] && hasJsOrTs(deps.projectInfo)) await deps.runStep("Remove unused files", async () => {
		return (await runKnipUnusedFiles(deps.resolvedDir)).filter((diagnostic) => isPathInFixScope(deps.context, diagnostic.filePath));
	}, () => fixUnusedFiles(deps.resolvedDir, (filePath) => isPathInFixScope(deps.context, filePath)));
	const railUpdate = (label) => deps.rail.setActiveLabel(label);
	if (deps.config.engines.security) if (!scopeIncludesManifestWrites(deps.context)) deps.skipStep?.("Dependency audit fixes", MISSING_MANIFEST_REASON);
	else await deps.runStep("Dependency audit fixes", () => runDependencyAudit(deps.context), () => fixDependencyAudit(deps.context, railUpdate));
	if (deps.projectInfo.frameworks.includes("expo") && deps.config.lint.expoDoctor) if (!scopeIncludesManifestWrites(deps.context)) deps.skipStep?.("Expo dependency alignment", MISSING_MANIFEST_REASON);
	else await deps.runStep("Expo dependency alignment", () => runExpoDoctor(deps.context), () => fixExpoDependencies(deps.context, railUpdate));
};
//#endregion
//#region src/commands/fix-plan.ts
const SKIPPED_BY_SAFE = "skipped by --safe";
const DISABLED_IN_CONFIG = "disabled in config";
const hasJsTs = (projectInfo) => projectInfo.languages.includes("typescript") || projectInfo.languages.includes("javascript");
const planned = (name) => ({
	name,
	status: "planned"
});
const skipped = (name, reason) => ({
	name,
	status: "skipped",
	reason
});
const gated = (name, enabled, reason) => enabled ? planned(name) : skipped(name, reason);
const planAiSlop = (config, safe) => {
	if (!config.engines["ai-slop"]) return (safe ? [
		"Unused imports",
		"Duplicate imports",
		"Narrative comments"
	] : [
		"Unused imports",
		"Duplicate imports",
		"Dead code & comments"
	]).map((name) => skipped(name, DISABLED_IN_CONFIG));
	if (safe) return [
		planned("Unused imports"),
		planned("Duplicate imports"),
		planned("Narrative comments"),
		skipped("Dead code & comments", SKIPPED_BY_SAFE)
	];
	return [
		planned("Unused imports"),
		planned("Duplicate imports"),
		planned("Dead code & comments")
	];
};
const planQualityStep = (name, projectInfo, config, safe) => {
	if (!hasJsTs(projectInfo)) return [];
	const qualityOn = config.engines["code-quality"];
	const reason = safe ? SKIPPED_BY_SAFE : qualityOn ? "" : DISABLED_IN_CONFIG;
	return [reason ? skipped(name, reason) : planned(name)];
};
const planLint = (projectInfo, config, safe) => {
	const steps = [];
	const reason = safe ? SKIPPED_BY_SAFE : config.engines.lint ? "" : DISABLED_IN_CONFIG;
	if (hasJsTs(projectInfo)) steps.push(reason ? skipped("Lint fixes (js/ts)", reason) : planned("Lint fixes (js/ts)"));
	if (projectInfo.languages.includes("python") && projectInfo.installedTools.ruff) steps.push(reason ? skipped("Lint fixes (python)", reason) : planned("Lint fixes (python)"));
	if (projectInfo.languages.includes("ruby") && projectInfo.installedTools.rubocop) steps.push(reason ? skipped("Lint fixes (ruby)", reason) : planned("Lint fixes (ruby)"));
	return steps;
};
const planFormatters = (projectInfo, config, safe) => {
	const steps = [];
	const engineReason = config.engines.format ? "" : DISABLED_IN_CONFIG;
	const add = (name, eligible, extraReason) => {
		if (!eligible) return;
		if (engineReason) {
			steps.push(skipped(name, engineReason));
			return;
		}
		if (extraReason) {
			steps.push(skipped(name, extraReason));
			return;
		}
		steps.push(planned(name));
	};
	add("Formatting (js/ts)", hasJsTs(projectInfo));
	add("Formatting (python)", projectInfo.languages.includes("python") && Boolean(projectInfo.installedTools.ruff));
	add("Formatting (go)", projectInfo.languages.includes("go") && Boolean(projectInfo.installedTools.gofmt));
	add("Formatting (rust)", projectInfo.languages.includes("rust") && Boolean(projectInfo.installedTools.rustfmt));
	add("Formatting (ruby)", projectInfo.languages.includes("ruby") && Boolean(projectInfo.installedTools.rubocop), safe ? SKIPPED_BY_SAFE : void 0);
	add("Formatting (php)", projectInfo.languages.includes("php") && Boolean(projectInfo.installedTools["php-cs-fixer"]), safe ? SKIPPED_BY_SAFE : void 0);
	add("Formatting (csharp)", projectInfo.languages.includes("csharp") && Boolean(projectInfo.installedTools.dotnet) && config.lint?.csharp?.projectEvaluation === true);
	add("Formatting (cpp)", projectInfo.languages.includes("cpp") && Boolean(projectInfo.installedTools["clang-format"]));
	return steps;
};
const planForce = (projectInfo, config, options) => {
	if (!options.forceRequested) return [];
	const reason = options.safe ? SKIPPED_BY_SAFE : "";
	const steps = [];
	if (hasJsTs(projectInfo)) steps.push(reason ? skipped("Remove unused files", reason) : gated("Remove unused files", config.engines["code-quality"], DISABLED_IN_CONFIG));
	steps.push(reason ? skipped("Dependency audit fixes", reason) : gated("Dependency audit fixes", config.engines.security, DISABLED_IN_CONFIG));
	if (projectInfo.frameworks.includes("expo")) {
		const expoOn = config.lint.expoDoctor;
		steps.push(reason ? skipped("Expo dependency alignment", reason) : gated("Expo dependency alignment", expoOn, "Expo Doctor is not enabled"));
	}
	return steps;
};
const buildFixPlan = (projectInfo, config, options = {}) => {
	const safe = Boolean(options.safe);
	const forceRequested = Boolean(options.force);
	return [
		...planAiSlop(config, safe),
		...planQualityStep("Unused declarations", projectInfo, config, safe),
		...planLint(projectInfo, config, safe),
		...planQualityStep("Unused dependencies", projectInfo, config, safe),
		...planFormatters(projectInfo, config, safe),
		...planForce(projectInfo, config, {
			safe,
			forceRequested
		})
	];
};
const skippedFixSteps = (plan) => plan.filter((step) => step.status === "skipped");
//#endregion
//#region src/commands/fix-render.ts
const NO_CHANGES_APPLIED = "No changes were applied.";
//#endregion
//#region src/commands/fix-steps.ts
const uniqueFileCount = (diagnostics) => new Set(diagnostics.map((d) => d.filePath)).size;
const runOneFixStep = async (name, detect, applyFix, options = {}) => {
	const started = performance.now();
	const before = await detect();
	if (options.dryRun) return {
		name,
		beforeIssues: before.length,
		afterIssues: before.length,
		resolvedIssues: 0,
		beforeFiles: uniqueFileCount(before),
		failed: false,
		elapsedMs: performance.now() - started,
		afterDiagnostics: before
	};
	let applyError = null;
	if (before.length > 0) try {
		await applyFix();
	} catch (error) {
		applyError = error;
	}
	const after = before.length > 0 ? await detect() : before;
	return {
		name,
		beforeIssues: before.length,
		afterIssues: after.length,
		resolvedIssues: Math.max(0, before.length - after.length),
		beforeFiles: uniqueFileCount(before),
		failed: applyError !== null && before.length === after.length,
		elapsedMs: performance.now() - started,
		afterDiagnostics: after
	};
};
const describeStep = (result) => {
	if (result.failed) return `${result.name} — failed (${result.afterIssues} remain)`;
	if (result.beforeIssues === 0) return `${result.name} — 0 issues`;
	if (result.afterIssues === 0) return `${result.name} — ${result.resolvedIssues} resolved`;
	if (result.resolvedIssues > 0) return `${result.name} — ${result.resolvedIssues} resolved, ${result.afterIssues} remaining`;
	return `${result.name} — ${result.afterIssues} remain`;
};
const statusFor = (s) => {
	if (s.failed) return "failed";
	if (s.afterIssues > 0) return "warn";
	return "done";
};
const findingLabel = (count) => count === 1 ? "finding" : "findings";
const fileLabel = (count) => count === 1 ? "file" : "files";
const describePreviewStep = (result) => {
	if (result.beforeIssues === 0) return `${result.name} - 0 findings`;
	return `${result.name} - ${result.beforeIssues} ${findingLabel(result.beforeIssues)} in ${result.beforeFiles} ${fileLabel(result.beforeFiles)}`;
};
const describeSkippedStep = (name, reason) => `${name} - ${reason}`;
//#endregion
//#region src/commands/fix.ts
const buildPostFixVerificationEngines = (engines) => ({
	...engines,
	lint: false
});
const collectPostFixLintDiagnostics = (steps) => steps.filter((step) => step.name.startsWith("Lint fixes")).flatMap((step) => step.afterDiagnostics ?? []);
const appendPostFixLintResult = (results, lintDiagnostics) => {
	if (lintDiagnostics.length === 0) return results;
	return [...results, {
		engine: "lint",
		diagnostics: lintDiagnostics,
		elapsed: 0,
		skipped: false
	}];
};
const fixCommand = async (directory, config, options = {
	verbose: false,
	showHeader: true
}) => {
	const resolvedDir = path.resolve(directory);
	const pathExists = fs.existsSync(resolvedDir);
	if (!pathExists || !fs.statSync(resolvedDir).isDirectory()) {
		const msg = !pathExists ? `Path does not exist: ${resolvedDir}` : `Not a directory: ${resolvedDir}`;
		return withCommandLifecycle({
			command: "fix",
			config: config.telemetry
		}, async () => {
			log.error(msg);
			return { exitCode: 1 };
		});
	}
	if (options.dryRun && (options.agent || options.prompt)) return withCommandLifecycle({
		command: "fix",
		config: config.telemetry
	}, async () => {
		log.error("--dry-run cannot be combined with an agent handoff or --prompt.");
		return { exitCode: 1 };
	});
	const scopeError = fixScopeError(resolvedDir, options);
	if (scopeError) return withCommandLifecycle({
		command: "fix",
		config: config.telemetry
	}, async () => {
		log.error(scopeError);
		return { exitCode: 1 };
	});
	const projectInfo = await discoverProject(resolvedDir);
	return withCommandLifecycle({
		command: "fix",
		config: config.telemetry,
		languages: projectInfo.languages,
		fileCount: projectInfo.sourceFileCount,
		properties: options.dryRun ? { dry_run: true } : void 0
	}, () => runFixBody(resolvedDir, config, options, projectInfo));
};
const runFixPipeline = async (deps, safe) => {
	await runAiSlopSteps(deps);
	if (!safe) {
		await runDeclarationStep(deps);
		await runLintSteps(deps);
		await runDependencyStep(deps);
	}
	await runFormattingStep(deps);
	await runForceSteps(deps);
};
const finishDryRun = (input) => {
	const plan = buildFixPlan(input.projectInfo, input.config, {
		force: Boolean(input.options.force),
		safe: Boolean(input.options.safe)
	});
	const ran = new Set(input.steps.map((step) => step.name));
	for (const step of skippedFixSteps(plan)) {
		if (ran.has(step.name)) continue;
		input.rail.complete({
			status: "skipped",
			label: describeSkippedStep(step.name, step.reason ?? "skipped")
		});
	}
	if (input.steps.length === 0 && skippedFixSteps(plan).length === 0) input.rail.complete({
		status: "skipped",
		label: "No applicable auto-fixers found"
	});
	input.rail.finish({ footer: "Preview · no changes applied" });
	process.stdout.write(`\n${renderHintLine(NO_CHANGES_APPLIED)}`);
	return {
		exitCode: 0,
		fixSteps: input.steps.length,
		fixResolved: 0
	};
};
const runFixBody = async (resolvedDir, config, options, projectInfo) => {
	const startTime = performance.now();
	const showHeader = options.showHeader !== false;
	const projectName = projectInfo.projectName ?? "project";
	const dryRun = Boolean(options.dryRun);
	if (showHeader) process.stdout.write(renderHeader({
		version: APP_VERSION,
		command: dryRun ? "Fix plan" : "Fix run",
		context: [projectName],
		brand: options.printBrand !== false
	}));
	const safe = Boolean(options.safe);
	const scope = collectFixFileScope(resolvedDir, [...config.exclude, ...readAislopIgnorePatterns(resolvedDir)], config.include, options);
	const scopedProjectInfo = scope ? {
		...projectInfo,
		languages: detectSourceLanguages([...scope.files, ...scope.testFiles])
	} : projectInfo;
	const context = createEngineContext(resolvedDir, scopedProjectInfo, config, {
		safe,
		scope: scope ?? void 0,
		dependencyAuditLanguages: projectInfo.languages
	});
	if (scope) process.stdout.write(`${renderDisplayRows([{
		label: "Scope",
		value: `${scope.files.length + scope.testFiles.length} ${scope.scopeLabel}`
	}], { indent: 1 }).join("\n")}\n`);
	const steps = [];
	const rail = new LiveRail(process.env.CI === "true" || process.env.CI === "1" ? { tty: false } : {});
	const runStep = async (name, detect, applyFix) => {
		rail.start(name);
		const result = await runOneFixStep(name, detect, applyFix, { dryRun });
		steps.push(result);
		rail.complete({
			status: dryRun ? "done" : statusFor(result),
			label: dryRun ? describePreviewStep(result) : describeStep(result)
		});
		return result;
	};
	const skipStep = (name, reason) => {
		rail.complete({
			status: "skipped",
			label: describeSkippedStep(name, reason)
		});
	};
	const pipelineDeps = {
		rail,
		context,
		config,
		resolvedDir,
		projectInfo: scopedProjectInfo,
		force: safe ? false : Boolean(options.force),
		safe,
		runStep,
		skipStep
	};
	await runFixPipeline(pipelineDeps, safe);
	if (dryRun) return finishDryRun({
		rail,
		steps,
		projectInfo: scopedProjectInfo,
		config,
		options
	});
	const totalResolved = steps.reduce((sum, s) => sum + s.resolvedIssues, 0);
	const configDir = findConfigDir(resolvedDir);
	const rulesPath = configDir ? path.join(configDir, RULES_FILE) : void 0;
	const engineConfig = {
		quality: config.quality,
		security: config.security,
		lint: config.lint,
		architectureRulesPath: config.engines.architecture ? rulesPath : void 0
	};
	rail.start("Verifying results");
	const verificationResults = await runEngines({
		rootDirectory: resolvedDir,
		languages: scopedProjectInfo.languages,
		frameworks: projectInfo.frameworks,
		excludePatterns: context.excludePatterns,
		installedTools: context.installedTools,
		config: engineConfig,
		...scope ? {
			files: context.files,
			testFiles: context.testFiles,
			projectFiles: context.projectFiles,
			dependencyAuditFiles: context.dependencyAuditFiles,
			dependencyAuditScope: context.dependencyAuditScope
		} : {}
	}, buildPostFixVerificationEngines(config.engines), () => {}, () => {});
	rail.complete({
		status: "done",
		label: "Verification complete"
	});
	const scanResults = appendPostFixLintResult(verificationResults, collectPostFixLintDiagnostics(steps));
	const allDiagnostics = scanResults.flatMap((r) => r.diagnostics);
	const scoreResult = calculateScore(allDiagnostics, config.scoring.weights, config.scoring.thresholds, scope ? scope.scoreFileCount : projectInfo.sourceFileCount, config.scoring.smoothing, config.scoring.maxPerRule);
	const errors = allDiagnostics.filter((d) => d.severity === "error").length;
	const warnings = allDiagnostics.filter((d) => d.severity === "warning").length;
	const remaining = errors + warnings;
	const actionableDiagnostics = allDiagnostics.filter((d) => d.severity !== "info");
	if (steps.length === 0) rail.complete({
		status: "skipped",
		label: "No applicable auto-fixers found"
	});
	rail.finish({ footer: `Done · ${totalResolved} fixed · ${remaining} remain` });
	if (!options.agent && !options.prompt) {
		if (totalResolved > 0) {
			const t = theme;
			const arrow = style$1(t, "muted", "→");
			process.stdout.write(`\n ${style$1(t, "success", `Resolved ${totalResolved} issue${totalResolved === 1 ? "" : "s"}`)} ${arrow} ${style$1(t, "success", `${scoreResult.score} / 100 ${scoreResult.label}`)}\n`);
		}
		const language = scopedProjectInfo.languages[0] ?? "unknown";
		process.stdout.write(buildScanRender({
			projectName,
			language,
			fileCount: scope ? scope.files.length + scope.testFiles.length : projectInfo.sourceFileCount,
			results: scanResults,
			diagnostics: actionableDiagnostics,
			score: scoreResult,
			elapsedMs: performance.now() - startTime,
			thresholds: config.scoring.thresholds,
			verbose: options.verbose,
			includeHeader: false,
			printBrand: false
		}));
	}
	if (options.agent) {
		launchAgent(options.agent, resolvedDir, actionableDiagnostics, scoreResult.score);
		return {
			exitCode: 0,
			score: scoreResult.score,
			fixSteps: steps.length,
			fixResolved: totalResolved
		};
	}
	if (options.prompt) {
		printPrompt(resolvedDir, actionableDiagnostics, scoreResult.score);
		return {
			exitCode: 0,
			score: scoreResult.score,
			fixSteps: steps.length,
			fixResolved: totalResolved
		};
	}
	return {
		exitCode: 0,
		score: scoreResult.score,
		findingCount: allDiagnostics.length,
		errorCount: errors,
		warningCount: warnings,
		fixSteps: steps.length,
		fixResolved: totalResolved
	};
};
//#endregion
//#region src/commands/init.ts
const buildInitSuccessRender = (input) => {
	const deps = {
		theme: createTheme(),
		symbols: createSymbols({ plain: false })
	};
	const header = input.includeHeader === false ? "" : renderHeader({
		version: APP_VERSION,
		command: "Setup",
		context: [],
		brand: input.printBrand !== false
	}, deps);
	const writtenCount = input.steps.filter((s) => s.status === "done").length;
	const footer = writtenCount === 0 ? "Nothing to write" : `Done · wrote ${writtenCount} file${writtenCount === 1 ? "" : "s"}`;
	return `${header}${renderRail({
		steps: input.steps,
		footer
	}, deps)}\n${renderHintLine(`Try ${input.nextCommand}`, deps)}`;
};
const ENGINE_CHOICES = [
	{
		value: "format",
		label: "format",
		hint: "Biome / gofmt / ruff"
	},
	{
		value: "lint",
		label: "lint",
		hint: "oxlint / ruff"
	},
	{
		value: "code-quality",
		label: "code-quality",
		hint: "knip / complexity"
	},
	{
		value: "ai-slop",
		label: "ai-slop",
		hint: "dead patterns, unused imports"
	},
	{
		value: "architecture",
		label: "architecture",
		hint: "BYO rules"
	},
	{
		value: "security",
		label: "security",
		hint: "dependency audit"
	}
];
const DEFAULT_ENGINE_SELECTION = Object.keys(DEFAULT_CONFIG.engines).filter((key) => DEFAULT_CONFIG.engines[key]);
const writeGithubWorkflow = (rootDirectory, enabled) => {
	const relativePath = `${GITHUB_WORKFLOW_DIR}/${GITHUB_WORKFLOW_FILE}`;
	if (!enabled) return { status: "declined" };
	const workflowDir = path.join(rootDirectory, GITHUB_WORKFLOW_DIR);
	const workflowPath = path.join(workflowDir, GITHUB_WORKFLOW_FILE);
	if (fs.existsSync(workflowPath)) return {
		status: "skipped-exists",
		relativePath
	};
	fs.mkdirSync(workflowDir, { recursive: true });
	fs.writeFileSync(workflowPath, DEFAULT_GITHUB_WORKFLOW_YAML);
	return {
		status: "written",
		relativePath
	};
};
const promptForConfigChoices = async () => {
	const enginesSelection = await multiselect({
		message: "Which engines should run?",
		options: ENGINE_CHOICES,
		initialValues: DEFAULT_ENGINE_SELECTION,
		required: false
	});
	if (isCancel(enginesSelection)) return null;
	const failBelowRaw = await text({
		message: "CI quality gate — fail the build when the score drops below (0-100)",
		initialValue: "70",
		validate: (v) => {
			const n = Number(v);
			if (!Number.isInteger(n) || n < 0 || n > 100) return "Enter a whole number 0-100";
		}
	});
	if (isCancel(failBelowRaw)) return null;
	const telemetryChoice = await select({
		message: "Share anonymous usage stats so aislop can improve?",
		options: [{
			value: "enabled",
			label: "Yes"
		}, {
			value: "disabled",
			label: "No"
		}],
		initialValue: DEFAULT_CONFIG.telemetry.enabled ? "enabled" : "disabled"
	});
	if (isCancel(telemetryChoice)) return null;
	const workflowChoice = await select({
		message: "Add a GitHub Actions workflow to run aislop on every push and PR?",
		options: [{
			value: "yes",
			label: "Yes — writes .github/workflows/aislop.yml"
		}, {
			value: "no",
			label: "No, I'll wire CI myself"
		}],
		initialValue: "yes"
	});
	if (isCancel(workflowChoice)) return null;
	return {
		engines: enginesSelection,
		failBelow: Number(failBelowRaw),
		typecheck: DEFAULT_CONFIG.lint.typecheck,
		telemetryEnabled: telemetryChoice === "enabled",
		writeGithubWorkflow: workflowChoice === "yes"
	};
};
const strictChoices = () => ({
	engines: Object.keys(DEFAULT_CONFIG.engines),
	failBelow: 85,
	typecheck: true,
	telemetryEnabled: DEFAULT_CONFIG.telemetry.enabled,
	writeGithubWorkflow: true
});
const writeAislopConfig = (configDir, configPath, choices) => {
	const selected = new Set(choices.engines);
	const engines = {
		format: selected.has("format"),
		lint: selected.has("lint"),
		"code-quality": selected.has("code-quality"),
		"ai-slop": selected.has("ai-slop"),
		architecture: selected.has("architecture"),
		security: selected.has("security")
	};
	const configDocument = {
		version: DEFAULT_CONFIG.version,
		engines,
		quality: { ...DEFAULT_CONFIG.quality },
		lint: {
			typecheck: choices.typecheck,
			expoDoctor: DEFAULT_CONFIG.lint.expoDoctor
		},
		security: { ...DEFAULT_CONFIG.security },
		scoring: {
			weights: { ...DEFAULT_CONFIG.scoring.weights },
			thresholds: { ...DEFAULT_CONFIG.scoring.thresholds },
			smoothing: DEFAULT_CONFIG.scoring.smoothing,
			maxPerRule: DEFAULT_CONFIG.scoring.maxPerRule
		},
		ci: {
			failBelow: choices.failBelow,
			format: DEFAULT_CONFIG.ci.format
		},
		telemetry: { enabled: choices.telemetryEnabled }
	};
	if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(configPath, YAML.stringify(configDocument));
};
const initCommand = async (directory, options = {}) => {
	const resolvedDir = path.resolve(directory);
	const printBrand = options.printBrand !== false;
	process.stdout.write(renderHeader({
		version: APP_VERSION,
		command: "Setup",
		context: [],
		brand: printBrand
	}));
	const configDir = path.join(resolvedDir, CONFIG_DIR);
	const configPath = path.join(configDir, CONFIG_FILE);
	const rulesPath = path.join(configDir, RULES_FILE);
	const invocation = detectInvocation();
	if (fs.existsSync(configPath)) {
		const overwrite = await select({
			message: `${CONFIG_DIR}/${CONFIG_FILE} already exists. What now?`,
			options: [{
				value: "keep",
				label: "Keep existing config"
			}, {
				value: "overwrite",
				label: "Overwrite with new answers"
			}],
			initialValue: "keep"
		});
		if (isCancel(overwrite) || overwrite === "keep") {
			process.stdout.write(buildInitSuccessRender({
				steps: [{
					status: "skipped",
					label: `Kept existing ${CONFIG_DIR}/${CONFIG_FILE}`
				}],
				nextCommand: `${invocation} scan`,
				includeHeader: false
			}));
			return;
		}
	}
	const choices = options.strict ? strictChoices() : await promptForConfigChoices();
	if (!choices) return;
	writeAislopConfig(configDir, configPath, choices);
	const steps = [{
		status: "done",
		label: `Wrote ${CONFIG_DIR}/${CONFIG_FILE}`
	}];
	if (choices.engines.includes("architecture")) if (!fs.existsSync(rulesPath)) {
		fs.writeFileSync(rulesPath, DEFAULT_RULES_YAML);
		steps.push({
			status: "done",
			label: `Wrote ${CONFIG_DIR}/${RULES_FILE}`
		});
	} else steps.push({
		status: "skipped",
		label: `${CONFIG_DIR}/${RULES_FILE} already exists`
	});
	const workflowResult = writeGithubWorkflow(resolvedDir, choices.writeGithubWorkflow);
	if (workflowResult.status === "written") steps.push({
		status: "done",
		label: `Wrote ${workflowResult.relativePath}`
	});
	else if (workflowResult.status === "skipped-exists") steps.push({
		status: "skipped",
		label: `${workflowResult.relativePath} already exists`
	});
	process.stdout.write(buildInitSuccessRender({
		steps,
		nextCommand: `${invocation} scan`,
		includeHeader: false
	}));
};
//#endregion
//#region src/ui/action-frame.ts
const renderActionStart = (input) => {
	const hint = input.hint ? ` ${highlightAislop(`· ${input.hint}`, theme, "muted")}` : "";
	return `\n ${style$1(theme, "muted", "┌")} ${style$1(theme, "accent", input.label)}${hint}\n\n`;
};
const renderActionEnd = (input) => {
	const status = input.status ?? "complete";
	const token = status === "complete" ? "success" : "muted";
	const text = status === "complete" ? `${input.label} complete` : `${input.label} skipped`;
	return `\n ${style$1(theme, "muted", "└")} ${style$1(theme, token, text)}\n`;
};
//#endregion
//#region src/commands/interactive.ts
const INTERACTIVE_OPTIONS = [
	{
		value: "scan",
		label: "Scan",
		hint: "Score this project and show findings"
	},
	{
		value: "fix",
		label: "Fix",
		hint: "Auto-fix safe issues or hand off findings"
	},
	{
		value: "agent",
		label: "Agent",
		hint: "Run local worktree repair"
	},
	{
		value: "doctor",
		label: "Doctor",
		hint: "Check installed engines and tools"
	},
	{
		value: "init",
		label: "Setup",
		hint: "Create config and CI workflow"
	},
	{
		value: "rules",
		label: "Rules",
		hint: "Explain every rule and fix mode"
	},
	{
		value: "hook-install",
		label: "Install hooks",
		hint: "Run aislop after agent edits"
	},
	{
		value: "hook-status",
		label: "Hook status",
		hint: "Show installed hook status"
	},
	{
		value: "quit",
		label: "Quit",
		hint: "Exit"
	}
];
const optionFor = (action) => INTERACTIVE_OPTIONS.find((option) => option.value === action);
const run = async (action, directory, config) => {
	switch (action) {
		case "scan":
			await scanCommand(directory, config, {
				changes: false,
				staged: false,
				verbose: false,
				json: false,
				printBrand: false
			});
			return "complete";
		case "fix":
			await fixCommand(directory, config, {
				verbose: false,
				printBrand: false
			});
			return "complete";
		case "agent":
			await agentCommand(directory, {
				provider: "auto",
				providerSource: "auto",
				targetScore: 90,
				maxTurns: 4,
				limit: 8,
				inPlace: false,
				apply: false,
				yes: false,
				dryRun: false,
				background: false,
				noFix: false,
				commit: false,
				pr: false,
				commitMessage: "chore(aislop): repair AI slop findings",
				ready: false,
				keepWorktree: true,
				cleanup: false
			});
			return "complete";
		case "hook-install": {
			const agents = await promptAgentSelection("install");
			if (agents === null || agents.length === 0) return "skipped";
			await hookInstall({
				agents,
				scope: "global",
				dryRun: false,
				yes: false,
				qualityGate: false
			});
			return "complete";
		}
		case "hook-status":
			await hookStatus();
			return "complete";
		case "init":
			await initCommand(directory, { printBrand: false });
			return "complete";
		case "doctor":
			await doctorCommand(directory, { printBrand: false });
			return "complete";
		case "rules":
			await rulesCommand(directory, {
				printBrand: false,
				interactive: true
			});
			return "complete";
		case "quit": return "skipped";
	}
};
const runFramed = async (action, directory, config) => {
	const option = optionFor(action);
	const label = option?.label ?? action;
	process.stdout.write(renderActionStart({
		label,
		hint: option?.hint
	}));
	const status = await run(action, directory, config);
	process.stdout.write(renderActionEnd({
		label,
		status
	}));
};
const interactiveCommand = async (directory, config) => {
	process.stdout.write(`${renderHome({ version: APP_VERSION })}\n`);
	const picked = await searchSelect({
		message: "What would you like to do?",
		items: INTERACTIVE_OPTIONS.map((o) => ({
			value: o.value,
			label: o.label,
			hint: o.hint
		}))
	});
	if (picked === null || picked === "quit") return;
	await runFramed(picked, directory, config);
	while (true) {
		const again = await searchSelect({
			message: "Next action?",
			items: INTERACTIVE_OPTIONS.map((o) => ({
				value: o.value,
				label: o.label,
				hint: o.hint
			}))
		});
		if (again === null || again === "quit") return;
		await runFramed(again, directory, config);
	}
};
//#endregion
//#region src/ui/suggest.ts
const editDistance = (a, b) => {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dist = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
	for (let i = 0; i < rows; i += 1) dist[i][0] = i;
	for (let j = 0; j < cols; j += 1) dist[0][j] = j;
	for (let i = 1; i < rows; i += 1) for (let j = 1; j < cols; j += 1) {
		const cost = a[i - 1] === b[j - 1] ? 0 : 1;
		dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
	}
	return dist[a.length][b.length];
};
const suggestClosest = (token, candidates) => {
	const needle = token.toLowerCase();
	let best = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const distance = editDistance(needle, candidate.toLowerCase());
		if (distance < bestDistance) {
			bestDistance = distance;
			best = candidate;
		}
	}
	if (best === null) return null;
	const budget = Math.max(2, Math.ceil(best.length / 3));
	return bestDistance <= budget ? best : null;
};
//#endregion
//#region src/cli.ts
const handleTerminationSignal = () => {
	killActiveChildren();
	process.exit(0);
};
process.on("SIGINT", handleTerminationSignal);
process.on("SIGTERM", handleTerminationSignal);
const fireInstalledOnce = () => {
	if (isTelemetryDisabled(loadConfig(process.cwd()).telemetry)) return;
	if (ensureInstallId(resolveInstallIdPath()).created) track({
		event: "cli_installed",
		config: loadConfig(process.cwd()).telemetry
	});
};
const hasNoUserArgs = () => process.argv.slice(2).length === 0;
const shouldRenderRootHelp = () => {
	const args = process.argv.slice(2);
	return args.length === 1 && [
		"--help",
		"-h",
		"help"
	].includes(args[0] ?? "");
};
const shouldRenderPlainVersion = () => {
	const args = process.argv.slice(2);
	return args.length === 1 && [
		"-V",
		"-v",
		"--version",
		"version"
	].includes(args[0] ?? "");
};
const program = new Command().name("aislop").description("The quality gate for agentic coding.").version(APP_VERSION, "-v, --version").argument("[directory]", "directory to scan when no command is passed", ".").option("--changes", "only scan changed files (git diff)").option("--staged", "only scan staged files").option("--base <ref>", "diff base for --changes, e.g. origin/main (default HEAD)").option("-d, --verbose", "show file details per rule").option("--json", "output JSON instead of terminal UI").option("--sarif", "output SARIF 2.1.0 (for GitHub code scanning)").option("--format <format>", "output format: json or sarif").option("--exclude <patterns>", "comma-separated or repeatable list of paths and files to exclude", commaSeparatedParser, []).option("--include <patterns>", "comma-separated or repeatable list of paths and files to include", commaSeparatedParser, []).showSuggestionAfterError().action(async (directory, flags) => {
	if (hasNoUserArgs() && noFlagsPassed(flags) && process.stdin.isTTY) try {
		await interactiveCommand(directory, loadConfig(directory));
		return;
	} catch {}
	await runScan(directory, flags);
});
program.command("scan [directory]").description("Score a project and print findings").option("--changes", "only scan changed files").option("--staged", "only scan staged files").option("--base <ref>", "diff base for --changes, e.g. origin/main (default HEAD)").option("-d, --verbose", "show file details per rule").option("--json", "output JSON").option("--sarif", "output SARIF 2.1.0 (for GitHub code scanning)").option("--format <format>", "output format: json or sarif").option("--exclude <patterns>", "comma-separated or repeatable list of paths and files to exclude", commaSeparatedParser, []).option("--include <patterns>", "comma-separated or repeatable list of paths and files to include", commaSeparatedParser, []).action(async (directory = ".", _flags, command) => {
	await runScan(directory, command.optsWithGlobals());
});
const fixProgram = program.command("fix [directory]").description("Auto-fix findings or hand off to a coding agent").option("-d, --verbose", "show detailed fix progress").option("-f, --force", "run aggressive fixes (audit and framework dependency alignment)").option("--safe", "only apply reversible fixes (imports, comment removal, safe formatters); skip anything that deletes code, rewrites behaviour, or runs unsafe formatter configs").option("--dry-run", "print planned fix steps without writing files").addOption(new Option("--changes", "only fix changed files (git diff)").conflicts("staged")).addOption(new Option("--staged", "only fix staged files").conflicts("changes")).option("--base <ref>", "diff base for --changes, e.g. origin/main (default HEAD)").option("-p, --prompt", "print a prompt for your coding agent to fix remaining issues");
for (const a of FIX_AGENT_FLAGS) fixProgram.option(`--${a.flag}`, a.help);
fixProgram.action(async (directory = ".", _flags, command) => {
	const flags = command.optsWithGlobals();
	const { exitCode } = await fixCommand(directory, loadConfig(directory), {
		verbose: Boolean(flags.verbose),
		force: Boolean(flags.force),
		safe: Boolean(flags.safe),
		dryRun: Boolean(flags.dryRun),
		changes: Boolean(flags.changes),
		staged: Boolean(flags.staged),
		base: typeof flags.base === "string" ? flags.base : void 0,
		prompt: Boolean(flags.prompt),
		agent: matchFixAgent(flags)
	});
	if (exitCode !== 0) {
		await flushTelemetry();
		process.exitCode = exitCode;
	}
});
registerAgentCommand(program);
program.command("init [directory]").description("Create aislop config and optional CI workflow").option("--strict", "write an enterprise-grade default config: all engines, typecheck on, CI failBelow 85, workflow included").action(async (directory = ".", _flags, command) => {
	const flags = command.optsWithGlobals();
	await withCommandLifecycle({
		command: "init",
		config: loadConfig(directory).telemetry
	}, async () => {
		await initCommand(directory, { strict: Boolean(flags.strict) });
		return { exitCode: 0 };
	});
});
program.command("doctor [directory]").description("Check toolchain coverage for this project").action(async (directory = ".") => {
	await withCommandLifecycle({
		command: "doctor",
		config: loadConfig(directory).telemetry
	}, async () => {
		await doctorCommand(directory);
		return { exitCode: 0 };
	});
});
const ciProgram = program.command("ci [directory]").description("Run the quality gate for CI");
for (const [flag, description] of [
	["--changes", "only gate files changed vs --base (or HEAD)"],
	["--staged", "only gate staged files"],
	["--base <ref>", "diff base for --changes, e.g. origin/main (default HEAD)"],
	["--human", "render the human-friendly scan design instead of JSON"],
	["--sarif", "output SARIF 2.1.0 (for GitHub code scanning)"],
	["--format <format>", "output format: json or sarif"]
]) ciProgram.option(flag, description);
ciProgram.action(async (directory = ".", _flags, command) => {
	const flags = command.optsWithGlobals();
	const { exitCode } = await ciCommand(directory, loadConfig(directory), {
		changes: Boolean(flags.changes),
		staged: Boolean(flags.staged),
		base: flags.base,
		human: Boolean(flags.human),
		sarif: Boolean(flags.sarif) || flags.format === "sarif"
	});
	if (exitCode !== 0) {
		await flushTelemetry();
		process.exitCode = exitCode;
	}
});
registerExtraCommands(program);
registerHookCommand(program);
registerHookAliases(program);
const main = async () => {
	fireInstalledOnce();
	if (shouldRenderPlainVersion()) {
		process.stdout.write(`${APP_VERSION}\n`);
		return;
	}
	if (shouldRenderRootHelp()) {
		process.stdout.write(renderRootHelp({ version: APP_VERSION }));
		return;
	}
	const firstArg = process.argv[2];
	if (firstArg && !firstArg.startsWith("-")) {
		const known = new Set(program.commands.flatMap((command) => [command.name(), ...command.aliases()]));
		if (!known.has(firstArg) && !existsSync(firstArg)) {
			const guess = suggestClosest(firstArg, [...known]);
			log.error(`"${firstArg}" is not a known command or an existing path.`);
			if (guess) log.muted(`Did you mean \`aislop ${guess}\`?`);
			log.muted("Run `aislop --help` to see all commands.");
			process.exitCode = 1;
			return;
		}
	}
	await program.parseAsync();
	await flushTelemetry();
	await maybeNotifyUpdate();
};
main();
//#endregion
export { APP_VERSION as i, withFindingAssessments as n, ENGINE_INFO as r, summarizeFindingAssessments as t };
