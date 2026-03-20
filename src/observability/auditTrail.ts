import type { LogEvent, AuditSummary } from "./types";
import { StructuredLogger } from "./structuredLogger";

/**
 * Audit trail system for the v2 provider baseline.
 *
 * Stores events in memory during the request lifecycle and provides
 * a query API to reconstruct the full flow for a given request ID.
 *
 * The audit system enables:
 * - Full request tracking from ingress to completion
 * - Reconstruction of what happened for debugging
 * - Summary statistics (tokens, messages, tool calls, duration, errors)
 */
export class AuditTrail {
    private static events = new Map<string, LogEvent[]>();
    private static startTimes = new Map<string, number>();

    /**
     * Records the start of a request.
     *
     * @param requestId - Stable request ID
     */
    public static startRequest(requestId: string): void {
        this.startTimes.set(requestId, Date.now());
        this.events.set(requestId, []);
    }

    /**
     * Records an event for a request.
     *
     * @param event - Event to record
     */
    public static recordEvent(event: LogEvent): void {
        const events = this.events.get(event.requestId);
        if (events) {
            events.push(event);
        }
    }

    /**
     * Records the end of a request and returns the audit summary.
     *
     * @param requestId - Stable request ID
     * @param modelId - Model ID used
     * @param endpoint - Endpoint path used
     * @param caller - Caller context
     * @param tokensIn - Input token count (optional)
     * @param tokensOut - Output token count (optional)
     * @param messageCount - Total message count
     * @param toolCalls - Tool calls made
     * @returns Audit summary for the completed request
     */
    public static endRequest(
        requestId: string,
        modelId: string,
        endpoint: string,
        caller: string,
        tokensIn?: number,
        tokensOut?: number,
        messageCount = 0,
        toolCalls: string[] = []
    ): AuditSummary {
        const startTime = this.startTimes.get(requestId) ?? Date.now();
        const durationMs = Date.now() - startTime;
        const events = this.events.get(requestId) ?? [];

        const errors: string[] = [];
        const warnings: string[] = [];

        for (const event of events) {
            if (event.level === "error") {
                errors.push(typeof event.data.error === "string" ? event.data.error : JSON.stringify(event.data));
            } else if (event.level === "warn") {
                warnings.push(typeof event.data.message === "string" ? event.data.message : JSON.stringify(event.data));
            }
        }

        const summary: AuditSummary = {
            requestId,
            modelId,
            endpoint,
            caller,
            durationMs,
            tokensIn,
            tokensOut,
            messageCount,
            toolCalls,
            errors,
            warnings,
            events,
        };

        StructuredLogger.info(
            "request.complete",
            {
                durationMs,
                tokensIn,
                tokensOut,
                messageCount,
                toolCallCount: toolCalls.length,
                errorCount: errors.length,
                warningCount: warnings.length,
            },
            { requestId, model: modelId, endpoint, caller }
        );

        // Clean up
        this.startTimes.delete(requestId);
        this.events.delete(requestId);

        return summary;
    }

    /**
     * Retrieves all events for a given request ID.
     *
     * @param requestId - Request ID to query
     * @returns Array of events for the request, or empty array if not found
     */
    public static getEvents(requestId: string): LogEvent[] {
        return this.events.get(requestId) ?? [];
    }

    /**
     * Checks if a request is currently being tracked.
     *
     * @param requestId - Request ID to check
     * @returns true if the request is being tracked
     */
    public static isTracking(requestId: string): boolean {
        return this.events.has(requestId);
    }

    /**
     * Returns the number of currently tracked requests.
     *
     * @returns Number of tracked requests
     */
    public static activeRequestCount(): number {
        return this.events.size;
    }

    /**
     * Clears all tracked requests. Use with caution.
     */
    public static clear(): void {
        this.events.clear();
        this.startTimes.clear();
    }
}
