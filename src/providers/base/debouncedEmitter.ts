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
        this.pendingReasons.push(reason);

        if (this.timer) {
            return;
        }

        const sinceLastFireMs = Date.now() - this.lastFireAtMs;
        const delayMs = Math.max(this.debounceMs, Math.max(0, this.minIntervalMs - sinceLastFireMs));

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
