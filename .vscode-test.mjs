/* eslint-disable no-undef */
import { defineConfig } from '@vscode/test-cli';

// Use VS Code Insiders so the test host matches the extension's `engines.vscode: ^1.120.0`
// requirement. Stable VS Code lags behind 1.120 at this point so the regular test runner
// would skip our extension entirely. Switch back to "stable" once 1.120.0 ships.
export default defineConfig({
  version: 'insiders',
  files: 'out/**/*.test.js',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true,
    reporter: process.env.VSCODE_TEST_RESULTS_DIR ? 'mocha-multi-reporters' : 'spec',
    reporterOptions: process.env.VSCODE_TEST_RESULTS_DIR ? {
      reporterEnabled: 'spec, mocha-junit-reporter',
      mochaJunitReporterReporterOptions: {
        mochaFile: `${process.env.VSCODE_TEST_RESULTS_DIR}/test-results.xml`
      }
    } : undefined
  }
});