import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const config = readFileSync(new URL("../../codecov.yml", import.meta.url), "utf8");

function job(name, nextJob) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing job ${name}`);
  const end = nextJob ? workflow.indexOf(`  ${nextJob}:\n`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `missing job ${nextJob}`);
  return workflow.slice(start, end);
}

function upload(jobText, stepName, file, flag, type) {
  const start = jobText.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(start, -1, `missing ${stepName}`);
  const next = jobText.indexOf("\n      - name:", start + 1);
  const step = jobText.slice(start, next === -1 ? undefined : next);
  assert.match(step, /uses: codecov\/codecov-action@v7/);
  assert.ok(step.includes(`files: \${{ github.workspace }}/${file}`));
  assert.ok(step.includes(`flags: ${flag}`));
  assert.match(step, /disable_search: true/);
  if (type === "test_results") {
    assert.match(step, /report_type: test_results/);
    assert.match(step, /if: always\(\)/);
  } else {
    assert.doesNotMatch(step, /report_type: test_results/);
  }
}

test("minimum and Insiders uploads use separate exact paths and flags", () => {
  const minimum = job("minimum-vscode-host", "build-and-test");
  const insiders = job("build-and-test");
  upload(minimum, "Upload minimum-host coverage to Codecov", ".vscode-test/minimum/coverage/lcov.info", "vscode-minimum", "coverage");
  upload(minimum, "Upload minimum-host test results to Codecov", ".vscode-test/minimum/test-results/test-results.xml", "vscode-minimum", "test_results");
  upload(insiders, "Upload coverage to Codecov", "coverage/lcov.info", "vscode-insiders", "coverage");
  upload(insiders, "Upload test results to Codecov", "test-results/test-results.xml", "vscode-insiders", "test_results");
});

test("minimum-host coverage does not alter the default aggregate", () => {
  assert.match(config, /flags:\s*\n\s+vscode-minimum:\s*\n\s+joined: false/);
});