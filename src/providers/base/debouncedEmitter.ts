/**
 * A debounced emitter that coalesces multiple fire() calls into a single
 * actual emission after a debounce window, subject to a minimum interval
 * between actual fires.
 */
export class DebouncedEmitter {
    private timer: NodeJS.Timeout | undefined;
    private lastFireAtMs = 0;
    private pendingReasons: string[] = [];

    public constructor(
        private readonly fireNow: () => void,
        private readonly debounceMs: number,
        private readonly minIntervalMs: number,
        private readonly onCoalesced: (reasons: readonly string[]) => void
    ) {}

    /**
     * Fire an event. Multiple calls within the debounce window are coalesced
     * into a single actual fire after the window elapses.
     */
    public fire(reason: string): void {
        // When delay would be 0 (both debounceMs=0 and minIntervalMs=0), fire immediately
        // without deferring - behaves like an immediate emitter where each fire fires
        const sinceLastFireMs = Date.now() - this.lastFireAtMs;
        const delayMs = Math.max(this.debounceMs, Math.max(0, this.minIntervalMs - sinceLastFireMs));

        if (delayMs === 0) {
            // Immediate mode: fire right away without any debouncing
            // Each fire() triggers a fire - no coalescing in this mode
            this.pendingReasons.push(reason);
            const reasons = [reason]; // Fire just this reason, not all pending
            this.onCoalesced(reasons);
            this.fireNow();
            // Don't update lastFireAtMs for immediate mode - allows rapid successive fires
            return;
        }

        // Normal debounced mode: defer the fire until delay elapses
        this.pendingReasons.push(reason);
        if (this.timer) {
            return;
        }

        this.timer = setTimeout(() => {
            const reasons = [...this.pendingReasons];
            this.pendingReasons = [];
            this.timer = undefined;
            this.lastFireAtMs = Date.now();
            this.onCoalesced(reasons);
            this.fireNow();
        }, delayMs);
    }

    /**
     * Dispose of the debounced emitter, canceling any pending fire.
     */
    public dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.pendingReasons = [];
    }
}
