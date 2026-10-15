#!/usr/bin/env node
/**
 * Stop/SubagentStop hook: run format, lint and test coverage after an agent session.
 *
 * Node (not bash) so it runs identically on Windows, Linux and macOS.
 *
 * Contract: stdout carries ONLY the final JSON verdict (progress goes to stderr);
 * exit 2 is a blocking error when any check fails, 0 otherwise.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

const CHECKS = [
	{ name: "format", cmd: "npm run format" },
	{ name: "lint", cmd: "npm run lint" },
	{ name: "test coverage", cmd: "npm run test:coverage" },
];

function runCheck({ name, cmd }) {
	process.stderr.write(`Running ${name}...\n`);
	// shell: true resolves `npm` to npm.cmd on Windows.
	const result = spawnSync(cmd, { shell: true, encoding: "utf8", windowsHide: true });
	if (result.status === 0) {
		process.stderr.write(`PASS ${name}\n`);
		return true;
	}
	process.stderr.write(`FAIL ${name}:\n${result.stdout ?? ""}${result.stderr ?? ""}\n`);
	return false;
}

const failed = CHECKS.filter((check) => !runCheck(check)).map((check) => check.name);

if (failed.length > 0) {
	const details = failed.map((name) => `- ${name}`).join("\n");
	process.stdout.write(
		JSON.stringify({
			decision: "fail",
			reason: `Post-session validation failed: ${failed.join(", ")}`,
			systemMessage: `Agent session ended with validation failures. Please resolve the following issues before continuing:\n\n${details}\n\nRun the following commands to see details:\n- npm run format\n- npm run lint\n- npm run test:coverage\n\nFix the issues and try again.`,
		})
	);
	process.exit(2);
}

process.stdout.write(
	JSON.stringify({
		decision: "pass",
		systemMessage: "All post-session validation checks passed: format, lint, test coverage.",
	})
);
