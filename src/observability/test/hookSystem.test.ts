import * as assert from "assert";
import * as sinon from "sinon";
import { HookSystem } from "../hookSystem";
import type { HookPoint, HookContext } from "../types";
import { StructuredLogger } from "../structuredLogger";

suite("HookSystem", () => {
    setup(() => {
        HookSystem.clear();
    });

    teardown(() => {
        sinon.restore();
        HookSystem.clear();
    });

    test("register adds handler and returns disposable", async () => {
        const point: HookPoint = "before:prepare";
        const handler = sinon.stub().resolves();

        const disposable = HookSystem.register(point, handler);
        assert.strictEqual(HookSystem.handlerCount(point), 1);

        const context: HookContext = {
            requestId: "test-id",
            modelId: "test-model",
            endpoint: "test-endpoint",
            caller: "test-caller",
            metadata: {},
        };

        await HookSystem.invoke(point, context);
        assert.ok(handler.calledOnce);

        disposable.dispose();
        assert.strictEqual(HookSystem.handlerCount(point), 0);
    });

    test("disposable removes only its own handler", () => {
        const point: HookPoint = "before:prepare";
        const h1 = sinon.stub();
        const h2 = sinon.stub();

        const d1 = HookSystem.register(point, h1);
        HookSystem.register(point, h2);

        assert.strictEqual(HookSystem.handlerCount(point), 2);

        d1.dispose();
        assert.strictEqual(HookSystem.handlerCount(point), 1);

        // Call again to ensure it doesn't crash
        d1.dispose();
        assert.strictEqual(HookSystem.handlerCount(point), 1);
    });

    test("invoke calls all handlers for the point", async () => {
        const point: HookPoint = "before:prepare";
        const h1 = sinon.stub().resolves();
        const h2 = sinon.stub().resolves();

        HookSystem.register(point, h1);
        HookSystem.register(point, h2);

        const context: HookContext = {
            requestId: "test-id",
            modelId: "test-model",
            endpoint: "test-endpoint",
            caller: "test-caller",
            metadata: {},
        };

        await HookSystem.invoke(point, context);
        assert.ok(h1.calledOnce);
        assert.ok(h2.calledOnce);
    });

    test("invoke does nothing when no handlers registered", async () => {
        const point: HookPoint = "before:prepare";
        const traceStub = sinon.stub(StructuredLogger, "trace");

        const context: HookContext = {
            requestId: "test-id",
            modelId: "test-model",
            endpoint: "test-endpoint",
            caller: "test-caller",
            metadata: {},
        };

        await HookSystem.invoke(point, context);
        assert.ok(traceStub.notCalled);
    });

    test("invoke catches handler errors and continues", async () => {
        const point: HookPoint = "before:prepare";
        const h1 = sinon.stub().throws(new Error("h1 error"));
        const h2 = sinon.stub().resolves();

        HookSystem.register(point, h1);
        HookSystem.register(point, h2);

        const warnStub = sinon.stub(StructuredLogger, "warn");

        const context: HookContext = {
            requestId: "test-id",
            modelId: "test-model",
            endpoint: "test-endpoint",
            caller: "test-caller",
            metadata: {},
        };

        await HookSystem.invoke(point, context);
        assert.ok(h1.calledOnce);
        assert.ok(h2.calledOnce);
        assert.ok(warnStub.calledOnce);
        const data = warnStub.firstCall.args[1] as Record<string, unknown>;
        assert.ok(typeof data.error === "string" && data.error.includes("h1 error"));
    });

    test("invoke handles non-Error objects thrown by handlers", async () => {
        const point: HookPoint = "before:prepare";
        const h1 = sinon.stub().throws("string error");
        HookSystem.register(point, h1);

        const warnStub = sinon.stub(StructuredLogger, "warn");
        const context: HookContext = {
            requestId: "id",
            modelId: "m",
            endpoint: "e",
            caller: "c",
            metadata: {},
        };

        await HookSystem.invoke(point, context);
        const data = warnStub.firstCall.args[1] as Record<string, unknown>;
        assert.ok(typeof data.error === "string" && data.error.includes("string error"));
    });

    test("clear removes all handlers", () => {
        HookSystem.register("before:prepare", sinon.stub());
        HookSystem.register("after:receive", sinon.stub());

        assert.strictEqual(HookSystem.handlerCount("before:prepare"), 1);
        assert.strictEqual(HookSystem.handlerCount("after:receive"), 1);

        HookSystem.clear();

        assert.strictEqual(HookSystem.handlerCount("before:prepare"), 0);
        assert.strictEqual(HookSystem.handlerCount("after:receive"), 0);
    });

    test("handlerCount returns 0 for unregistered points", () => {
        assert.strictEqual(HookSystem.handlerCount("before:prepare"), 0);
    });
});
