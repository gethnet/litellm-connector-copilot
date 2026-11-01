/* eslint-disable no-undef */
import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';

// In-repo, version-agnostic reporter (src/test/junitSpecReporter.ts). It
// replaces the mocha-junit-reporter + mocha-multi-reporters pair, whose
// mocha-11-era construction of mocha's Base reporter throws when the
// resolved mocha is v12 (Base is an ES class there). Mocha loads string
// reporters via require.resolve(name), so we pass the absolute compiled path.
const junitSpecReporterPath = fileURLToPath(new URL('./out/src/test/junitSpecReporter.js', import.meta.url));

// Both hosts run the full suite. The versioned run additionally exercises
// minimum-host activation and verifies the requested version and engine floor.
// Run with VSCODE_TEST_VERSION=1.125.0 npm run test:coverage. Its reports and
// profile are under .vscode-test/minimum; npm's precompile still cleans normal
// reports, so CI runs it separately. Discovery and streaming call the provider
// directly; host picker routing needs a VS Code-managed secret and group.
const version = process.env.VSCODE_TEST_VERSION;
export default defineConfig({
  version: version || 'insiders',
  // Never reuse the full suite's profile: model groups and secrets are host state.
  launchArgs: version ? [
    `--user-data-dir=${fileURLToPath(new URL('./.vscode-test/minimum/user-data', import.meta.url))}`,
    `--extensions-dir=${fileURLToPath(new URL('./.vscode-test/minimum/extensions', import.meta.url))}`
  ] : [],
  // The memory profile is a self-executing benchmark with its own npm script.
  // Running it concurrently with Mocha mutates global fetch and makes retry tests flaky.
  files: version ? ['out/src/test/integration/minimumHost.smoke.js', 'out/**/!(memoryProfile).test.js'] : 'out/**/!(memoryProfile).test.js',
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