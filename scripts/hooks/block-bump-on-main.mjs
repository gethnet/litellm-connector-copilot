#!/usr/bin/env node
/**
 * PreToolUse hook: block `npm run bump-version` while on the main branch.
 *
 * Version bumps must happen on a dev/* branch (see
 * .github/prompts/start-next-dev-version.prompt.md).
 *
 * Node (not bash) so it runs identically on Windows, where a bash hook spawns
 * a visible Git Bash window for every tool call.
 *
 * Contract: reads the PreToolUse JSON payload on stdin; emits a
 * hookSpecificOutput permissionDecision on stdout only to deny. Always exits 0.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

function readCommand() {
	try {
		const payload = JSON.parse(readFileSync(0, "utf8"));
		// Tool input shape varies; check the common command-bearing fields.
		const input = payload.tool_input ?? payload.toolInput ?? {};
		return String(input.command ?? "");
	} catch {
		return "";
	}
}

function currentBranch() {
	try {
		return execFileSync("git", ["branch", "--show-current"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		}).trim();
	} catch {
		return "";
	}
}

if (readCommand().includes("bump-version") && currentBranch() === "main") {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason:
					"Version bumps are not allowed on main. Create a dev branch first (run the start-next-dev-version prompt), then bump the version there.",
			},
		})
	);
}
