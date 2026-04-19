import * as assert from "assert";
import * as sinon from "sinon";
import { AuditTrail } from "../auditTrail";
import { StructuredLogger } from "../structuredLogger";
import type { LogEvent } from "../types";

suite("AuditTrail", () => {
    setup(() => {
        AuditTrail["events"].clear();
        AuditTrail["startTimes"].clear();
    });

    teardown(() => {
        sinon.restore();
        AuditTrail["events"].clear();
        AuditTrail["startTimes"].clear();
    });

    test("startRequest initializes tracking", () => {
        const requestId = "test-request-id";
        AuditTrail.startRequest(requestId);

        assert.strictEqual(AuditTrail["startTimes"].has(requestId), true);
        assert.strictEqual(AuditTrail["events"].has(requestId), true);
        assert.deepStrictEqual(AuditTrail["events"].get(requestId), []);
    });

    test("recordEvent appends to correct request", () => {
        const requestId = "test-request-id";
        AuditTrail.startRequest(requestId);

        const event: LogEvent = {
            timestamp: new Date().toISOString(),
            requestId,
            level: "info",
            event: "request.ingress",
            data: { foo: "bar" },
        };

        AuditTrail.recordEvent(event);

        const events = AuditTrail["events"].get(requestId);
        assert.strictEqual(events?.length, 1);
        assert.strictEqual(events[0], event);
    });

    test("recordEvent ignores unknown requestId", () => {
        const event: LogEvent = {
            timestamp: new Date().toISOString(),
            requestId: "unknown-id",
            level: "info",
            event: "request.ingress",
            data: { foo: "bar" },
        };

        AuditTrail.recordEvent(event);
        assert.strictEqual(AuditTrail["events"].has("unknown-id"), false);
    });

    test("endRequest returns summary with duration, errors, warnings", () => {
        const requestId = "test-request-id";
        AuditTrail.startRequest(requestId);

        const errorEvent: LogEvent = {
            timestamp: new Date().toISOString(),
            requestId,
            level: "error",
            event: "request.error",
            data: { error: "test error" },
        };

        const warnEvent: LogEvent = {
            timestamp: new Date().toISOString(),
            requestId,
            level: "warn",
            event: "param.suppressed",
            data: { message: "test warning" },
        };

        AuditTrail.recordEvent(errorEvent);
        AuditTrail.recordEvent(warnEvent);

        const infoStub = sinon.stub(StructuredLogger, "info");

        const summary = AuditTrail.endRequest(requestId, "test-model", "/chat/completions", "test-caller", 10, 20, 2, [
            "tool1",
        ]);

        assert.strictEqual(summary.requestId, requestId);
        assert.strictEqual(summary.modelId, "test-model");
        assert.strictEqual(summary.endpoint, "/chat/completions");
        assert.strictEqual(summary.caller, "test-caller");
        assert.strictEqual(summary.tokensIn, 10);
        assert.strictEqual(summary.tokensOut, 20);
        assert.strictEqual(summary.messageCount, 2);
        assert.deepStrictEqual(summary.toolCalls, ["tool1"]);
        assert.deepStrictEqual(summary.errors, ["test error"]);
        assert.deepStrictEqual(summary.warnings, ["test warning"]);
        assert.strictEqual(summary.events.length, 2);
        assert.ok(summary.durationMs >= 0);

        assert.ok(infoStub.calledOnce);
        assert.strictEqual(infoStub.firstCall.args[0], "request.complete");
    });

    test("endRequest handles events with missing error/message fields in data", () => {
        const requestId = "test-request-id";
        AuditTrail.startRequest(requestId);

        const errorEvent: LogEvent = {
            timestamp: new Date().toISOString(),
            requestId,
            level: "error",
            event: "request.error",
            data: { foo: "bar" },
        };

        AuditTrail.recordEvent(errorEvent);
        sinon.stub(StructuredLogger, "info");

        const summary = AuditTrail.endRequest(requestId, "m", "e", "c");
        assert.strictEqual(summary.errors[0], JSON.stringify({ foo: "bar" }));
    });

    test("endRequest uses current time if startRequest was not called", () => {
        const requestId = "untracked-id";
        sinon.stub(StructuredLogger, "info");

        const summary = AuditTrail.endRequest(requestId, "m", "e", "c");
        assert.ok(summary.durationMs >= 0);
        assert.deepStrictEqual(summary.events, []);
    });

    test("clear removes all state", () => {
        AuditTrail.startRequest("id1");
        AuditTrail.startRequest("id2");

        AuditTrail["clear"](); // Assuming there's a clear method or we use private access

        assert.strictEqual(AuditTrail["startTimes"].size, 0);
        assert.strictEqual(AuditTrail["events"].size, 0);
    });
});
