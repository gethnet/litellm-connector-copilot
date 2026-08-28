#!/usr/bin/env node
/**
 * PostToolUse hook: auto-run Prettier on files the agent just edited.
 *
 * Why: AGENTS.md requires `npm run format` to pass before finishing any task.
 * This hook makes that deterministic instead of advisory by formatting each
 * edited file immediately after the edit tool succeeds.
 *
 * Contract (see .github/hooks/format-on-edit.json):
 * - Receives the PostToolUse event JSON on stdin.
 * - Only reacts to file-editing tools; ignores everything else.
 * - Formats ONLY the edited file (never the whole repo) to keep the hook fast.
 * - Always exits 0: formatting is a convenience, never a blocker. A Prettier
 *   failure here (e.g. syntax error mid-edit) must not abort the agent's flow —
 *   the `npm run format` validation gate will still catch real problems.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Tool names that modify file contents. Kept broad to cover alias variants. */
const EDIT_TOOL_PATTERN = /edit|replace|insert|create_file|write/i;

/** Extensions Prettier handles in this repo (mirrors `prettier --write .`). */
const FORMATTABLE = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);

function readStdin() {
	try {
		// Hook payloads are small; a synchronous read keeps the script simple.
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

/** Pull every plausible file path out of the tool input, schema-agnostically. */
function collectFilePaths(toolInput) {
	if (!toolInput || typeof toolInput !== "object") return [];
	const keys = ["filePath", "file_path", "path", "uri"];
	const found = [];
	for (const key of keys) {
		const value = toolInput[key];
		if (typeof value === "string" && value.length > 0) {
			// Strip a file:// scheme if the tool passed a URI.
			found.push(value.replace(/^file:\/\//, ""));
		}
	}
	return found;
}

function main() {
	const raw = readStdin();
	if (!raw) return;

	let event;
	try {
		event = JSON.parse(raw);
	} catch {
		return; // Malformed payload — nothing to do.
	}

	const toolName = event.tool_name ?? event.toolName ?? "";
	if (!EDIT_TOOL_PATTERN.test(String(toolName))) return;

	const repoRoot = process.cwd();
	const candidates = collectFilePaths(event.tool_input ?? event.toolInput);

	for (const candidate of candidates) {
		const absolute = path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate);
		// Only format files that exist, live inside the repo, and Prettier supports.
		if (!absolute.startsWith(repoRoot)) continue;
		if (!FORMATTABLE.has(path.extname(absolute))) continue;
		if (!existsSync(absolute)) continue;

		try {
			execFileSync("npx", ["--no-install", "prettier", "--write", "--log-level", "warn", absolute], {
				cwd: repoRoot,
				stdio: "ignore",
				timeout: 20_000,
			});
		} catch {
			// Never block the agent on a formatting failure (see header comment).
		}
	}
}

main();
process.exit(0);
