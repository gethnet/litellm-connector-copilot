/* eslint-disable no-undef */
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  installExtensions: [
    'GitHub.copilot',
    'GitHub.copilot-chat'
  ],
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