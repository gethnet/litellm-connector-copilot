/**
 * Observability layer for the v2 provider baseline.
 *
 * Provides structured JSONL logging, lifecycle hooks, audit trails,
 * and telemetry for end-to-end request visibility.
 */

export { StructuredLogger } from "./structuredLogger";
export { HookSystem } from "./hookSystem";
export { AuditTrail } from "./auditTrail";
export type {
    LogLevel,
    EventType,
    LogEvent,
    HookPoint,
    HookContext,
    HookHandler,
    AuditSummary,
    TelemetryMetric,
} from "./types";
