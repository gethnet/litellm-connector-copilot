/**
 * Memory Profile Test for 500-Turn Agentic Session
 *
 * This test simulates the unbounded memory collections identified in Phase 0
 * without requiring VS Code context. It measures baseline memory growth
 * to prove the issue before fixes are applied.
 *
 * Collections being tested (simulated):
 * - tokenCountCache (in LiteLLMProviderBase) - unbounded token count cache
 * - pendingRequests (in LiteLLMProviderBase) - unbounded pending promises map
 * - auditTrail events (in AuditTrail) - unbounded event logs
 * - reasoningEffortFallback failures (in ReasoningEffortFallback) - bounded but accumulating
 *
 * Output: memory-profile-results.json
 *
 * Usage:
 *   npm run memory-profile
 */

import MockLiteLLMBackend from "./mockLiteLLMBackend";
import * as fs from "fs";
import * as path from "path";

interface MemorySnapshot {
    turn: number;
    timestamp: number;
    heapUsedMB: number;
    externalMB: number;
    rssMemoryMB: number;
}

interface TestResult {
    timestamp: string;
    testDuration: number;
    completed: boolean;
    hangs: { turn: number; message: string }[];
    crashes: { turn: number; error: string }[];
    memorySnapshots: MemorySnapshot[];
    requestStats: {
        total: number;
        succeeded: number;
        failed: number;
        httpCalls: number;
    };
}

/**
 * Captures current process memory usage
 */
function captureMemory(): Omit<MemorySnapshot, "turn" | "timestamp"> {
    const memUsage = process.memoryUsage();
    return {
        heapUsedMB: memUsage.heapUsed / 1024 / 1024,
        externalMB: memUsage.external / 1024 / 1024,
        rssMemoryMB: memUsage.rss / 1024 / 1024,
    };
}

/**
 * Main memory profile test - simulates unbounded collection growth
 */
async function runMemoryProfileTest(): Promise<void> {
    console.log("[MemoryProfile] Starting 500-turn session test...");

    const testStartTime = Date.now();
    const results: TestResult = {
        timestamp: new Date().toISOString(),
        testDuration: 0,
        completed: false,
        hangs: [],
        crashes: [],
        memorySnapshots: [],
        requestStats: {
            total: 0,
            succeeded: 0,
            failed: 0,
            httpCalls: 0,
        },
    };

    // Simulate the unbounded collections identified in Phase 0
    // These are NOT the actual collections, but they mimic their growth patterns
    const tokenCountCache = new Map<string, { count: number; timestamp: number }>();
    const pendingRequests = new Map<string, Promise<number>>();
    const auditEvents: Array<{ id: string; turn: number; timestamp: number }> = [];

    // Start mock backend
    const backend = new MockLiteLLMBackend({
        port: 4444,
        latencyMs: 10,
        toolCallSupport: true,
        reasoningSupport: true,
    });

    try {
        console.log("[MemoryProfile] Starting mock LiteLLM backend...");
        await backend.start();

        // Capture baseline memory
        const baseline = captureMemory();
        console.log(`[MemoryProfile] Baseline memory: ${baseline.heapUsedMB.toFixed(2)} MB heap`);

        // Define snapshot turns
        const snapshotTurns = [10, 50, 100, 200, 300, 500];

        // Run 500 turns and simulate unbounded collection growth
        for (let turn = 1; turn <= 500; turn++) {
            try {
                // Simulate tokenCountCache growth (unbounded in current code)
                for (let i = 0; i < 5; i++) {
                    const key = `model_${turn}_token_${i}`;
                    tokenCountCache.set(key, {
                        count: Math.floor(Math.random() * 1000),
                        timestamp: Date.now(),
                    });
                }

                // Simulate pendingRequests growth (unbounded in current code)
                for (let i = 0; i < 3; i++) {
                    const key = `request_${turn}_${i}`;
                    pendingRequests.set(key, Promise.resolve(Math.random() * 100));
                }

                // Simulate auditTrail growth (unbounded in current code)
                for (let i = 0; i < 4; i++) {
                    auditEvents.push({
                        id: `event_${turn}_${i}`,
                        turn,
                        timestamp: Date.now(),
                    });
                }

                // Simulate an HTTP call to the backend (every turn - realistic agentic session)
                try {
                    // Make a simple HTTP call to verify backend is responsive
                    const response = await fetch(`http://localhost:4444/models`);
                    if (response.ok) {
                        results.requestStats.httpCalls++;
                        results.requestStats.succeeded++;
                    } else {
                        results.requestStats.failed++;
                    }
                } catch (httpErr) {
                    results.requestStats.failed++;
                    console.warn(`[MemoryProfile] HTTP call failed at turn ${turn}`);
                }

                results.requestStats.total++;

                // Capture memory snapshot at key turns
                if (snapshotTurns.includes(turn)) {
                    const memory = captureMemory();
                    results.memorySnapshots.push({
                        turn,
                        timestamp: Date.now(),
                        ...memory,
                    });

                    const growthMB = memory.heapUsedMB - baseline.heapUsedMB;
                    console.log(
                        `[MemoryProfile] Turn ${turn}: heap=${memory.heapUsedMB.toFixed(2)} MB (growth: ${growthMB > 0 ? "+" : ""}${growthMB.toFixed(2)} MB)`
                    );

                    // Check for excessive growth (potential hang indicator)
                    if (growthMB > 500) {
                        results.hangs.push({
                            turn,
                            message: `Excessive memory growth detected: ${growthMB.toFixed(2)} MB`,
                        });
                    }

                    // Log collection sizes
                    console.log(
                        `[MemoryProfile]   Collections: tokenCache=${tokenCountCache.size}, pendingReqs=${pendingRequests.size}, auditEvents=${auditEvents.length}`
                    );
                }

                // Periodic GC suggestion (not forced, just logged)
                if (turn % 100 === 0) {
                    if (global.gc) {
                        global.gc();
                        console.log(`[MemoryProfile] Turn ${turn}: Ran garbage collection`);
                    }
                }
            } catch (err) {
                results.crashes.push({
                    turn,
                    error: err instanceof Error ? err.message : String(err),
                });
                console.error(`[MemoryProfile] Crash at turn ${turn}:`, err);

                // If we crash, report and stop
                break;
            }
        }

        results.completed = results.crashes.length === 0 && results.requestStats.total === 500;

        // Final memory capture
        const finalMemory = captureMemory();
        console.log(`[MemoryProfile] Final memory: ${finalMemory.heapUsedMB.toFixed(2)} MB heap`);

        results.testDuration = Date.now() - testStartTime;
        console.log(`[MemoryProfile] Test completed in ${(results.testDuration / 1000).toFixed(2)} seconds`);

        // Write results to file
        const resultsPath = path.join(process.cwd(), "memory-profile-results.json");
        fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
        console.log(`[MemoryProfile] Results written to: ${resultsPath}`);

        // Print summary
        console.log("\n=== MEMORY PROFILE TEST SUMMARY ===");
        console.log(`Completed: ${results.completed ? "✅ YES" : "❌ NO"}`);
        console.log(`Total iterations: ${results.requestStats.total}`);
        console.log(`HTTP calls succeeded: ${results.requestStats.succeeded}`);
        console.log(`HTTP calls failed: ${results.requestStats.failed}`);
        console.log(`Collection sizes:`);
        console.log(`  - tokenCountCache: ${tokenCountCache.size} entries`);
        console.log(`  - pendingRequests: ${pendingRequests.size} entries`);
        console.log(`  - auditEvents: ${auditEvents.length} entries`);

        if (results.memorySnapshots.length > 0) {
            const first = results.memorySnapshots[0];
            const last = results.memorySnapshots[results.memorySnapshots.length - 1];
            const growth = last.heapUsedMB - first.heapUsedMB;
            const growthRate = (growth / last.turn) * 10; // MB per 10 turns
            console.log(
                `\nMemory at turn ${first.turn}: ${first.heapUsedMB.toFixed(2)} MB → turn ${last.turn}: ${last.heapUsedMB.toFixed(2)} MB`
            );
            console.log(`Total heap growth: ${growth > 0 ? "+" : ""}${growth.toFixed(2)} MB`);
            console.log(`Growth rate: ${growthRate.toFixed(2)} MB per 10 turns`);

            // Analyze memory trend
            if (results.memorySnapshots.length >= 2) {
                const diffs = [];
                for (let i = 1; i < results.memorySnapshots.length; i++) {
                    const diff =
                        results.memorySnapshots[i].heapUsedMB - results.memorySnapshots[i - 1].heapUsedMB;
                    diffs.push(diff);
                }
                const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
                console.log(`Average growth per snapshot: ${avgDiff > 0 ? "+" : ""}${avgDiff.toFixed(2)} MB`);

                // Detect if memory is plateauing (good sign)
                if (diffs[diffs.length - 1] < diffs[0]) {
                    console.log("Memory trend: ✅ PLATEAUING (good - indicates bounded caching)");
                } else if (diffs[diffs.length - 1] > diffs[0] * 1.5) {
                    console.log("Memory trend: ❌ ACCELERATING (bad - indicates unbounded growth)");
                } else {
                    console.log("Memory trend: ⚠️ STEADY (mixed - could be linear growth)");
                }
            }
        }

        if (results.hangs.length > 0) {
            console.log(`\nHangs detected: ${results.hangs.length}`);
            results.hangs.forEach((h) => console.log(`  - Turn ${h.turn}: ${h.message}`));
        }

        if (results.crashes.length > 0) {
            console.log(`\nCrashes detected: ${results.crashes.length}`);
            results.crashes.forEach((c) => console.log(`  - Turn ${c.turn}: ${c.error}`));
        }

        console.log("====================================\n");
    } finally {
        console.log("[MemoryProfile] Stopping mock backend...");
        await backend.stop();
    }
}

// Run the test
runMemoryProfileTest().catch((err) => {
    console.error("[MemoryProfile] Fatal error:", err);
    process.exit(1);
});
