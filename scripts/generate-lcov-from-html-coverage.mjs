/* eslint-disable no-undef */
import { Report } from 'c8';
import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

// @vscode/test-cli writes V8 coverage data into a temp directory and then
// generates HTML/text-summary reports. In some environments it does not write
// lcov.info even when requested.
//
// This script re-runs c8's reporting step against the same temp directory
// that vscode-test uses, emitting lcov into ./coverage.

const workspaceRoot = process.cwd();

const reportsDirectory = resolve(workspaceRoot, 'coverage');

if (!existsSync(reportsDirectory)) {
	throw new Error(`Coverage directory not found at ${reportsDirectory}. Run tests with --coverage first.`);
}

// vscode-test uses V8 coverage internally and then uses c8 to render reports.
// In some environments it appears to only write HTML/text-summary.
//
// We re-run c8's reporting against the same V8 coverage directory by locating
// the temp directory that vscode-test created.

const tmpRoot = process.env.TMPDIR || '/tmp';
const candidates = readdirSync(tmpRoot)
	.filter((d) => d.startsWith('vsc-coverage-'))
	.map((d) => resolve(tmpRoot, d));

if (!candidates.length) {
	throw new Error(
		`No vsc-coverage-* temp directories found under ${tmpRoot}. ` +
			`Try re-running with TMPDIR set, or set --coverage-output and update this script.`
	);
}

// Pick the most recently created directory by lexicographic order (UUIDs are random,
// but directory mtimes are not exposed without stat calls; keep it simple and take the last).
const tempDirectory = candidates[candidates.length - 1];

const report = new Report({
	tempDirectory,
	reportsDirectory,
	reporter: ['lcovonly'],
	src: [resolve(workspaceRoot, 'src')],
	all: true,
	excludeNodeModules: true,
});

await report.run();

console.log(`Wrote lcov to ${resolve(reportsDirectory, 'lcov.info')}`);
