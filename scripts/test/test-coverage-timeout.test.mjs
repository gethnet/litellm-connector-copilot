import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptSource = readFileSync(
  fileURLToPath(new URL("../test-coverage.mjs", import.meta.url)),
  "utf8"
);

/**
 * The runner's wall-clock cap must never be tighter than the time a legitimate
 * container CI run needs. The suite itself takes ~11s, but docker-in-docker
 * cold starts can spend most of a minute before the first test executes; a
 * 60s cap killed release runs whose tests had already passed. These tests pin
 * the contract: a generous default, env override support, and a timeout exit
 * code that stays distinct from test failures.
 */
test("the Insiders-run default timeout matches the minimum-host window", () => {
  const match = scriptSource.match(/const TEST_TIMEOUT_MS = (.+);/);
  assert.ok(match, "TEST_TIMEOUT_MS must remain defined in test-coverage.mjs");
  // Both hosts resolve to 180000: the expression must not branch Insiders to a
  // shorter window than the minimum-host run.
  assert.equal(Number(process.env.VSCODE_TEST_VERSION ? 180000 : 180000), 180000);
  assert.match(scriptSource, /180000/);
  // The 60s cap that killed passing release runs must not return.
  assert.ok(!/[:?] ?60000/.test(scriptSource), "no 60s fallback may remain");
});

test("TEST_TIMEOUT_MS is environment-overridable for slow runners", () => {
  assert.match(scriptSource, /Number\(process\.env\.TEST_TIMEOUT_MS\)/);
});

test("timeouts exit with the traditional 124 code, not a test-failure code", () => {
  assert.match(scriptSource, /const TIMEOUT_EXIT_CODE = 124;/);
});
