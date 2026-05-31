const DISCOVERY_BACKOFF_STEP_MS = 500;
const DISCOVERY_BACKOFF_MAX_DELAY_MS = 5_000;
const DISCOVERY_BACKOFF_RESET_WINDOW_MS = 5_000;
const DISCOVERY_BACKOFF_BLOCK_AFTER_FAILURES = 10;

export interface DiscoveryBackoffDecision {
    readonly attempt: number;
    readonly delayMs: number;
    readonly shouldBlock: boolean;
}

export class DiscoveryBackoffController {
    private consecutiveFailures = 0;
    private lastFailureAtMs = 0;
    private blockedUntilMs = 0;

    public recordFailure(nowMs = Date.now()): DiscoveryBackoffDecision {
        // Lazy reset: if discovery has been quiet for long enough, start fresh on the next hit.
        if (this.lastFailureAtMs > 0 && nowMs - this.lastFailureAtMs >= DISCOVERY_BACKOFF_RESET_WINDOW_MS) {
            this.consecutiveFailures = 0;
        }

        // Once we hit the block threshold, keep rejecting until the quiet window has elapsed.
        if (this.blockedUntilMs > 0 && nowMs < this.blockedUntilMs) {
            return {
                attempt: 10,
                delayMs: 0,
                shouldBlock: true,
            };
        }

        this.consecutiveFailures += 1;
        this.lastFailureAtMs = nowMs;

        const delayMs = Math.min(this.consecutiveFailures * DISCOVERY_BACKOFF_STEP_MS, DISCOVERY_BACKOFF_MAX_DELAY_MS);
        const shouldBlock = this.consecutiveFailures >= DISCOVERY_BACKOFF_BLOCK_AFTER_FAILURES;

        if (shouldBlock) {
            this.blockedUntilMs = nowMs + DISCOVERY_BACKOFF_MAX_DELAY_MS;
        }

        return {
            attempt: this.consecutiveFailures,
            delayMs,
            shouldBlock,
        };
    }

    public reset(): void {
        this.consecutiveFailures = 0;
        this.lastFailureAtMs = 0;
        this.blockedUntilMs = 0;
    }
}

export const sharedDiscoveryBackoff = new DiscoveryBackoffController();
