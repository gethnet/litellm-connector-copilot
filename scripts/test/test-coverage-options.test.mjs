import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTestVersion } from "../test-coverage-options.mjs";

test("the default run keeps the Insiders host", () => {
  assert.equal(resolveTestVersion([], undefined), undefined);
});

test("an explicit environment version remains supported", () => {
  assert.equal(resolveTestVersion([], "1.123.4"), "1.123.4");
});

test("the minimum-host flag selects the version from the engine range", () => {
  assert.equal(resolveTestVersion(["--minimum-host"], undefined, "^1.125.0"), "1.125.0");
  assert.equal(resolveTestVersion(["--minimum-host"], undefined, "^1.150.2"), "1.150.2");
});

test("the minimum-host flag takes precedence over the environment", () => {
  assert.equal(resolveTestVersion(["--minimum-host"], "1.999.0", "^1.125.0"), "1.125.0");
});

test("the minimum-host flag rejects missing or unsupported engine ranges", () => {
  for (const range of [undefined, "", "*", ">=1.125.0", "^1.125", "^1.125.0 || ^2.0.0"]) {
    assert.throws(() => resolveTestVersion(["--minimum-host"], undefined, range), /engines\.vscode/);
  }
});