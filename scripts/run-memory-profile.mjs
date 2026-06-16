#!/usr/bin/env node

/**
 * Memory Profile Test Runner
 *
 * Runs a 500-turn memory profile test independently of the VS Code test framework.
 * This allows better memory monitoring and JSON result output.
 *
 * Usage:
 *   node scripts/run-memory-profile.mjs
 *   # Output: memory-profile-results.json
 *
 * With pre-compiled TypeScript:
 *   npm run compile && node dist/test/integration/memoryProfile.test.js
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// Check if compiled test exists (tsconfig outputs to 'out/' with preserved src/ structure)
const testPath = join(projectRoot, "out", "src", "test", "integration", "memoryProfile.test.js");

if (!existsSync(testPath)) {
    console.error("❌ Compiled test not found. Please run: npm run compile");
    console.error(`Expected: ${testPath}`);
    process.exit(1);
}

console.log("[MemoryProfile] Starting memory profile test runner...");
console.log(`[MemoryProfile] Using compiled test: ${testPath}`);
console.log(`[MemoryProfile] Node version: ${process.version}`);
console.log(
    `[MemoryProfile] Initial memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB\n`
);

// Import and run the test
try {
    const { default: testModule } = await import(`file://${testPath}`);
    // Test is self-executing, no need to call anything
    void testModule;
} catch (err) {
    console.error("❌ Failed to run memory profile test:", err);
    process.exit(1);
}
