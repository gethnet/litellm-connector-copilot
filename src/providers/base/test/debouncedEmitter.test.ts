import * as assert from "assert";
import * as vscode from "vscode";
import { DebouncedEmitter } from "../debouncedEmitter";

/**
 * Tests for the DebouncedEmitter utility.
 * Verifies trailing-edge debounce with minimum fire interval.
 */
suite("DebouncedEmitter", () => {
    test("fires_once_when_multiple_events_within_debounce_window", async () => {
        // Arrange
        const fireEmitter = new vscode.EventEmitter<void>();
        let fireCount = 0;

        const emitter = new DebouncedEmitter(
            () => {
                fireCount++;
                fireEmitter.fire();
            },
            100, // debounceMs
            0, // minIntervalMs
            (reasons) => {
                // onCoalesced callback
            }
        );

        // Act - fire multiple times within debounce window
        emitter.fire("reason1");
        emitter.fire("reason2");
        emitter.fire("reason3");

        // Wait for debounce to elapse
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Assert - only one fire
        assert.strictEqual(fireCount, 1);
        emitter.dispose();
    });

    test("dispose_cancels_pending_timer", async () => {
        // Arrange
        const fireEmitter = new vscode.EventEmitter<void>();
        let fireCount = 0;

        const emitter = new DebouncedEmitter(
            () => {
                fireCount++;
                fireEmitter.fire();
            },
            100, // debounceMs
            0, // minIntervalMs
            () => {}
        );

        // Act - fire once and dispose immediately without waiting
        emitter.fire("reason1");
        emitter.dispose();

        // Wait to see if any fire happens
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Assert - no fire after dispose
        assert.strictEqual(fireCount, 0);
    });

    test("both_zero_behaves_like_immediate_emitter", async () => {
        // Arrange - no debounce, no min interval
        const fireEmitter = new vscode.EventEmitter<void>();
        let fireCount = 0;

        const emitter = new DebouncedEmitter(
            () => {
                fireCount++;
                fireEmitter.fire();
            },
            0, // debounceMs
            0, // minIntervalMs
            () => {}
        );

        // Note: Even with 0 debounce, there's still a setTimeout in the
        // implementation (to check min interval), so we wait for that.
        // Act - fire multiple times
        emitter.fire("reason1");
        emitter.fire("reason2");
        emitter.fire("reason3");

        // Wait for event loop to process
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Assert - all fires happen (each fire triggers fireNow after setTimeout)
        assert.strictEqual(fireCount, 3);
        emitter.dispose();
    });
});
