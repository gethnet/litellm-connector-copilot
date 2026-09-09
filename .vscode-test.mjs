/* eslint-disable no-undef */
import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';

// In-repo, version-agnostic reporter (src/test/junitSpecReporter.ts). It
// replaces the mocha-junit-reporter + mocha-multi-reporters pair, whose
// mocha-11-era construction of mocha's Base reporter throws when the
// resolved mocha is v12 (Base is an ES class there). Mocha loads string
// reporters via require.resolve(name), so we pass the absolute compiled path.
const junitSpecReporterPath = fileURLToPath(new URL('./out/src/test/junitSpecReporter.js', import.meta.url));

// Use VS Code Insiders so the test host matches the extension's `engines.vscode: ^1.120.0`
// requirement. Stable VS Code lags behind 1.120 at this point so the regular test runner
// would skip our extension entirely. Switch back to "stable" once 1.120.0 ships.
export default defineConfig({
  version: 'insiders',
  // The memory profile is a self-executing benchmark with its own npm script.
  // Running it concurrently with Mocha mutates global fetch and makes retry tests flaky.
  files: 'out/**/!(memoryProfile).test.js',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true,
    // JunitSpecReporter extends mocha's built-in Spec, so console output
    // stays human-readable while the JUnit XML is written in parallel —
    // no multi-reporter wrapper needed.
    reporter: process.env.VSCODE_TEST_RESULTS_DIR ? junitSpecReporterPath : 'spec',
    reporterOptions: process.env.VSCODE_TEST_RESULTS_DIR ? {
      mochaFile: `${process.env.VSCODE_TEST_RESULTS_DIR}/test-results.xml`
    } : undefined
  }
});