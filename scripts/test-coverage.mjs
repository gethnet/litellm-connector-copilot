import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import process from "node:process";
import console from "node:console";

// Exit code for test timeout (unique identifier for timeout-related failures)
const TIMEOUT_EXIT_CODE = 124; // Traditional timeout command uses 124

// Maximum time to allow the test process to run (in milliseconds)
const TEST_TIMEOUT_MS = 60000; // 60 seconds

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

const coveragePath = join(process.cwd(), "coverage");
clearDirectory(coveragePath);
if (!existsSync(coveragePath)) {
  mkdirSync(coveragePath, { recursive: true });
}

const testResultsDir = join(process.cwd(), "test-results");
process.env.VSCODE_TEST_RESULTS_DIR = testResultsDir;
// Disable PostHog telemetry during tests to prevent fetch mock interference
// and avoid real HTTP requests during test execution
process.env.POSTHOG_MOCK = "true";
clearDirectory(testResultsDir);
if (!existsSync(testResultsDir)) {
  mkdirSync(testResultsDir, { recursive: true });
}

const testArgs = [
  "--args=--no-sandbox",
  "--coverage",
  "--coverage-output",
  "coverage",
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
  // xvfb-run wraps the entire command
  child = spawn("xvfb-run", ["vscode-test", ...testArgs], {
    stdio: "inherit",
    env: process.env,
  });
} else {
  child = spawn("vscode-test", testArgs, {
    stdio: "inherit",
    env: process.env,
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
