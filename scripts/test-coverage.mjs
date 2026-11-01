import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";
import process from "node:process";
import console from "node:console";
import { resolveTestVersion } from "./test-coverage-options.mjs";

if (process.argv.slice(2).includes("--minimum-host")) {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    process.env.VSCODE_TEST_VERSION = resolveTestVersion(process.argv.slice(2), process.env.VSCODE_TEST_VERSION, manifest.engines?.vscode);
    console.log(`Testing against minimum VS Code host ${process.env.VSCODE_TEST_VERSION}`);
  } catch (error) {
    console.error(`Cannot determine minimum VS Code host: ${error.message}`);
    process.exit(1);
  }
}

// Exit code for test timeout (unique identifier for timeout-related failures)
const TIMEOUT_EXIT_CODE = 124; // Traditional timeout command uses 124

// Maximum time to allow the test process to run (in milliseconds)
const TEST_TIMEOUT_MS = process.env.VSCODE_TEST_VERSION ? 180000 : 60000;

/**
 * Remove directory contents without removing the directory itself.
 * This handles mount points where we cannot remove the mount point directory.
 */
function clearDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    return;
  }

  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    try {
      rmSync(fullPath, { recursive: true, force: true });
    } catch (err) {
      // If we can't remove it (e.g., mount point), log and continue
      console.warn(`Warning: Could not remove ${fullPath}: ${err.message}`);
    }
  }
}

// Keep floor-host reports separate from the full-suite coverage and JUnit data.
const minimumHost = Boolean(process.env.VSCODE_TEST_VERSION);
const coverageDir = minimumHost ? ".vscode-test/minimum/coverage" : "coverage";
const coveragePath = join(process.cwd(), coverageDir);
clearDirectory(coveragePath);
if (!existsSync(coveragePath)) {
  mkdirSync(coveragePath, { recursive: true });
}

const testResultsDir = join(process.cwd(), minimumHost ? ".vscode-test/minimum/test-results" : "test-results");
process.env.VSCODE_TEST_RESULTS_DIR = testResultsDir;
// Disable PostHog telemetry during tests to prevent fetch mock interference
// and avoid real HTTP requests during test execution
process.env.POSTHOG_MOCK = "true";
clearDirectory(testResultsDir);
if (!existsSync(testResultsDir)) {
  mkdirSync(testResultsDir, { recursive: true });
}

if (minimumHost) {
  // Compile alone does not produce package.json's dist/extension.js entrypoint.
  // Build the production bundle so activation exercises the shipped entrypoint.
  const build = spawnSync(process.execPath, ["esbuild.js", "--production"], { stdio: "inherit", env: process.env });
  if (build.error || build.status !== 0) {
    console.error("Failed to build the extension for the minimum host", build.error ?? `exit ${build.status}`);
    process.exit(build.status || 1);
  }
}

const testArgs = [
  "--args=--no-sandbox",
  "--coverage",
  "--coverage-output",
  coverageDir,
  "--coverage-reporter",
  "lcovonly",
  "--coverage-reporter",
  "html",
  "--coverage-reporter",
  "text-summary",
];

const hasXvfb =
  process.platform === "linux" &&
  spawnSync("sh", ["-lc", "command -v xvfb-run >/dev/null 2>&1"]).status === 0;

let child;
if (hasXvfb) {
  // Pick an unused display so stale or parallel WSL test sessions cannot
  // collide with xvfb-run's default :99 display.
  child = spawn("xvfb-run", ["-a", "vscode-test", ...testArgs], {
    stdio: "inherit",
    env: process.env,
  });
} else {
  child = spawn("vscode-test", testArgs, {
    stdio: "inherit",
    env: process.env,
    // Windows resolves node_modules/.bin shims via .cmd files; spawn only
    // finds them through the shell, otherwise it fails with ENOENT.
    shell: process.platform === "win32",
  });
}

// Set a timeout to kill the process if it runs too long
const timeoutId = setTimeout(() => {
  timedOut = true;
  console.error(`Test process timed out after ${TEST_TIMEOUT_MS}ms, terminating...`);
  child.kill("SIGTERM");

  // Force kill after 5 seconds if SIGTERM doesn't work
  setTimeout(() => {
    if (!child.killed) {
      console.error("Process did not terminate gracefully, force killing...");
      child.kill("SIGKILL");
    }
  }, 5000);
}, TEST_TIMEOUT_MS);

let timedOut = false;

// Handle process exit
child.on("exit", (code, signal) => {
  clearTimeout(timeoutId);
  if (timedOut) {
    console.error("Test process terminated due to timeout.");
    process.exit(TIMEOUT_EXIT_CODE);
  }
  if (typeof code === "number") {
    if (minimumHost && code === 0) {
      // Reject empty or smoke-only runs even if the runner exits successfully.
      const reportPath = join(testResultsDir, "test-results.xml");
      const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
      if (!report.includes("runs on the requested host and activates the installed extension") ||
          !report.includes("discovers a model and streams a response using minimum-host API objects") ||
          !report.includes('name="Provider icon manifest"') ||
          !report.includes('skipped="0"')) {
        console.error("Minimum-host full suite did not produce complete JUnit results.");
        process.exit(1);
      }
    }
    process.exit(code);
  } else if (signal) {
    console.error(`Process terminated by signal: ${signal}`);
    process.exit(1);
  }
  process.exit(1);
});

// Handle process errors
child.on("error", (err) => {
  clearTimeout(timeoutId);
  console.error(`Failed to start test process: ${err.message}`);
  process.exit(1);
});
