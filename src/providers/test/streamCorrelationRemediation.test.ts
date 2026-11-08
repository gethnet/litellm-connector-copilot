import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { StructuredLogger } from "../../observability/structuredLogger";
import { createMockSecrets } from "../../test/utils/testMocks";
import { createTelemetryMocks } from "../../test/utils/telemetryMock";
import { TelemetryService } from "../../telemetry/telemetryService";
import { PostHogAdapter } from "../../telemetry/posthogAdapter";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { Logger } from "../../utils/logger";
import { createPartReportTrace } from "../../adapters/streaming/partReportTrace";

suite("stream correlation remediation", () => {
    let sandbox: sinon.SinonSandbox;
    let log: sinon.SinonStub;
    let telemetry: ReturnType<typeof createTelemetryMocks>;
    const model = (id: string): vscode.LanguageModelChatInformation => ({
        id,
        name: id,
        tooltip: "",
        family: "litellm",
        version: "1",
        maxInputTokens: 4096,
        maxOutputTokens: 512,
        capabilities: { toolCalling: true, imageInput: false },
    });
    const messages = [vscode.LanguageModelChatMessage.User("hello")];
    const options = {
        modelOptions: {},
        tools: [],
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        configuration: { baseUrl: "http://localhost:4000", apiKey: "test" },
    } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
    const encoder = new TextEncoder();
    const chatFrames = (value: string) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: value } }] })}\n\n` +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n";
    const stream = (text: string): ReadableStream<Uint8Array> =>
        new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(text));
                controller.close();
            },
        });
    const provider = (config: Record<string, unknown> = {}) => {
        const instance = new LiteLLMChatProvider(createMockSecrets(), "test");
        const internals = instance as unknown as {
            _configManager: { getConfig: () => Promise<unknown> };
            _registry: { getModelInfo: (id: string) => unknown; findBackendForRawName: (id: string) => unknown };
        };
        sandbox.stub(internals._configManager, "getConfig").resolves({ inactivityTimeout: 60, ...config });
        sandbox.stub(internals._registry, "getModelInfo").callsFake(() => ({ mode: "responses" }));
        sandbox.stub(internals._registry, "findBackendForRawName").returns({});
        return instance;
    };
    const run = (instance: LiteLLMChatProvider, id: string, parts: vscode.LanguageModelResponsePart[] = []) =>
        instance.provideLanguageModelChatResponse(
            model(id),
            messages,
            options,
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );
    const calls = (event: string) => log.getCalls().filter((call) => call.args[1] === event);
    const argsOf = (stub: sinon.SinonStub): unknown[][] => stub.getCalls().map((call) => call.args as unknown[]);
    const assertAgreement = (id: string, endpoint: string | undefined, includeHost = true) => {
        const events = [
            "vscode.part_reported",
            "stream.processing_start",
            "stream.event_received",
            "stream.started",
            "stream.payload_yielded",
            "stream.event_processed",
            "vscode.emit_parts_start",
            "vscode.text_part_emitted",
            "stream.terminal_fingerprint",
        ];
        if (!includeHost) {
            events.shift();
        }
        events.push(endpoint === "responses" ? "stream.responses_text_delta" : "stream.text_emitted");
        let requestId: unknown;
        for (const event of events) {
            const matching = calls(event).filter(
                (call) => (call.args[3] as { model?: string } | undefined)?.model === id
            );
            assert.ok(matching.length, `${event} missing for ${id}`);
            for (const call of matching) {
                const context = call.args[3] as { requestId?: string; model?: string; endpoint?: string };
                assert.ok(context.requestId, `${event} missing request id`);
                requestId ??= context.requestId;
                assert.strictEqual(context.requestId, requestId, event);
                assert.strictEqual(context.endpoint, endpoint, event);
            }
        }
        return requestId;
    };
    setup(() => {
        sandbox = sinon.createSandbox();
        log = sandbox.stub(StructuredLogger, "log");
        telemetry = createTelemetryMocks(sandbox);
        telemetry.setup();
    });
    teardown(() => {
        telemetry.teardown();
        sandbox.restore();
    });

    test("override and real responses-to-chat transport fallback agree across boundaries and do not export trace payload", async () => {
        const instance = provider({ modelIdOverride: "override", allowChatCompletionsFallback: true });
        const fetch = sandbox.stub(LiteLLMClient.prototype, "fetchWithRateLimit");
        fetch.onFirstCall().resolves(new Response("upstream unavailable", { status: 500 }));
        fetch.onSecondCall().resolves(new Response(stream(chatFrames("private-visible-preview")), { status: 200 }));
        const reported: vscode.LanguageModelResponsePart[] = [];
        await run(instance, "selected", reported);
        assert.ok(String(fetch.firstCall.args[0]).endsWith("/responses"));
        assert.ok(String(fetch.secondCall.args[0]).endsWith("/chat/completions"));
        assertAgreement("override", "chat");
        assert.ok(calls("vscode.part_reported").length);
        assert.ok(!JSON.stringify(argsOf(log)).includes("private-visible-preview"));
        assert.ok(telemetry.captureRequestCompletedWithCacheStub.called);
        const exported = [
            telemetry.captureStub,
            telemetry.captureRequestCompletedWithCacheStub,
            telemetry.captureRequestFailedStub,
            telemetry.captureChatRequestStub,
            telemetry.captureModelUsedStub,
        ].flatMap(argsOf);
        assert.ok(!JSON.stringify(exported).includes("private-visible-preview"));
        assert.ok(
            reported.some(
                (part) => part instanceof vscode.LanguageModelTextPart && part.value === "private-visible-preview"
            )
        );
    });

    test("concurrent interleaved requests retain independent context and monotonic sequences", async () => {
        const uuid = sandbox.stub(globalThis.crypto, "randomUUID");
        uuid.onFirstCall().returns("00000000-0000-4000-8000-000000000001");
        uuid.onSecondCall().returns("00000000-0000-4000-8000-000000000002");
        const instance = provider();
        const controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
        const ready: (() => void)[] = [];
        const bothReady = new Promise<void>((resolve) => ready.push(resolve));
        sandbox.stub(LiteLLMClient.prototype, "fetchWithRateLimit").callsFake(async (_url, init) => {
            const body = JSON.parse(String(init.body)) as { model: string };
            const responseStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controllers.set(body.model, controller);
                    if (controllers.size === 2) {
                        ready[0]();
                    }
                },
            });
            return new Response(responseStream, { status: 200 });
        });
        const a = run(instance, "model-a");
        const b = run(instance, "model-b");
        await bothReady;
        for (const id of ["model-a", "model-b", "model-a", "model-b"]) {
            controllers
                .get(id)
                ?.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: id })}\n\n`)
                );
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        for (const controller of controllers.values()) {
            controller.enqueue(
                encoder.encode(
                    'data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n'
                )
            );
            controller.close();
        }
        await Promise.all([a, b]);
        assert.strictEqual(assertAgreement("model-a", "responses"), "00000000-0000-4000-8000-000000000001");
        assert.strictEqual(assertAgreement("model-b", "responses"), "00000000-0000-4000-8000-000000000002");
        for (const id of ["model-a", "model-b"]) {
            const reports = calls("vscode.part_reported").filter(
                (call) => (call.args[3] as { model?: string }).model === id
            );
            assert.deepStrictEqual(
                reports.map((call) => (call.args[2] as { reportSeq: number }).reportSeq),
                reports.map((_, index) => index + 1)
            );
        }
    });

    test("recovery emitter retains the request context and reports buffered tool calls", async () => {
        const instance = provider();
        const process = (
            instance as unknown as {
                processStreamingResponse: (
                    body: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken,
                    context: object
                ) => Promise<void>;
            }
        ).processStreamingResponse.bind(instance);
        const recovered: vscode.LanguageModelResponsePart[] = [];
        const context = {
            requestId: "recovery",
            model: "recovery-model",
            endpoint: "chat",
            requestHadThinkingBlocks: false,
            requestToolCallCount: 0,
        };
        const body = stream(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"tool","arguments":"{}"}}]}}]}\n\ndata: {'
        );
        await process(
            body,
            createPartReportTrace({ report: (part) => recovered.push(part) }, context),
            new vscode.CancellationTokenSource().token,
            context
        );
        assert.ok(recovered.some((part) => part instanceof vscode.LanguageModelToolCallPart));
        assert.deepStrictEqual(calls("vscode.part_reported")[0].args[3], {
            requestId: "recovery",
            model: "recovery-model",
            endpoint: "chat",
        });
        const emitted = calls("vscode.tool_call_part_emitted");
        assert.ok(emitted.length);
        assert.deepStrictEqual(emitted[0].args[3], {
            requestId: "recovery",
            model: "recovery-model",
            endpoint: "chat",
        });
        assert.deepStrictEqual(calls("stream.terminal_fingerprint")[0].args[3], {
            requestId: "recovery",
            model: "recovery-model",
            endpoint: "chat",
        });
    });

    test("malformed SSE event diagnostics record length without leaking its contents", async () => {
        const instance = provider();
        sandbox
            .stub(LiteLLMClient.prototype, "fetchWithRateLimit")
            .resolves(
                new Response(
                    stream(
                        'data: {"opaque":"malformed-private-secret"\n\n' +
                            'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
                            'data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n'
                    ),
                    { status: 200 }
                )
            );
        const legacy = sandbox.stub(Logger, "trace");
        await run(instance, "model-private");
        assert.strictEqual(calls("stream.event_parse_skipped").length, 1);
        const logs = JSON.stringify([...argsOf(log), ...argsOf(legacy)]);
        assert.ok(!logs.includes("malformed-private-secret"));
    });

    test("real unsupported-parameter retry retains correlation and actual responses route", async () => {
        const instance = provider();
        const fetch = sandbox.stub(LiteLLMClient.prototype, "fetchWithRateLimit");
        fetch
            .onFirstCall()
            .resolves(new Response('{"error":{"message":"unsupported parameter temperature"}}', { status: 400 }));
        fetch
            .onSecondCall()
            .resolves(
                new Response(
                    stream(
                        'data: {"type":"response.output_text.delta","delta":"retry-output"}\n\n' +
                            'data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n'
                    ),
                    { status: 200 }
                )
            );
        const reported: vscode.LanguageModelResponsePart[] = [];
        await run(instance, "retry-model", reported);
        assert.strictEqual(fetch.callCount, 2);
        assert.ok(fetch.getCalls().every((call) => String(call.args[0]).endsWith("/responses")));
        assertAgreement("retry-model", "responses");
        assert.ok(
            reported.some((part) => part instanceof vscode.LanguageModelTextPart && part.value === "retry-output")
        );
    });

    test("direct emission after an override has no fabricated route and keeps sequence across retry", async () => {
        const instance = provider({ modelIdOverride: "override" });
        const internal = instance as unknown as {
            sendRequestWithRetry: (typeof LiteLLMChatProvider.prototype)["sendRequestWithRetry"];
        };
        const send = sandbox.stub(internal, "sendRequestWithRetry");
        send.onFirstCall().callsFake(
            async (_request, _messages, _model, _options, progress, _token, _caller, _info, _attempt, route) => {
                route?.("responses");
                progress.report(new vscode.LanguageModelTextPart("direct-before-retry"));
                throw new Error("LiteLLM API error\nunsupported parameter");
            }
        );
        send.onSecondCall().callsFake(async (_request, _messages, _model, _options, progress) => {
            progress.report(new vscode.LanguageModelTextPart("direct-after-retry"));
            return stream(chatFrames("stream-after-retry"));
        });
        const parts: vscode.LanguageModelResponsePart[] = [];
        await run(instance, "selected", parts);
        const reports = calls("vscode.part_reported");
        assert.deepStrictEqual(
            reports.map((call) => (call.args[2] as { reportSeq: number }).reportSeq),
            reports.map((_, index) => index + 1)
        );
        assert.deepStrictEqual(
            parts
                .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
                .map((part) => part.value),
            ["direct-before-retry", "direct-after-retry", "stream-after-retry"]
        );
        assert.strictEqual((reports[0].args[3] as { endpoint?: string }).endpoint, "responses");
        assert.ok(reports.slice(1).every((call) => (call.args[3] as { endpoint?: string }).endpoint === undefined));
        assertAgreement("override", undefined, false);
    });

    test("text and reasoning content stay out of local traces and the PostHog adapter", async () => {
        const service = new TelemetryService();
        const adapter = sandbox.createStubInstance(PostHogAdapter);
        (service as unknown as { adapter: PostHogAdapter }).adapter = adapter;
        sandbox.stub(vscode.env, "isTelemetryEnabled").get(() => true);
        service.initialize({ extension: { packageJSON: { version: "test" } } } as unknown as vscode.ExtensionContext);
        LiteLLMTelemetry.setTelemetryService(service);
        const instance = provider();
        sandbox
            .stub(LiteLLMClient.prototype, "fetchWithRateLimit")
            .resolves(
                new Response(
                    stream(
                        'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"secret-thought-preview"}\n\n' +
                            'data: {"type":"response.output_text.delta","delta":"secret-text-preview"}\n\n' +
                            'data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n'
                    ),
                    { status: 200 }
                )
            );
        try {
            await run(instance, "model-private");
            assert.ok(calls("stream.responses_reasoning_delta").length);
            assert.ok(calls("vscode.part_reported").length);
            const local = JSON.stringify(argsOf(log));
            assert.ok(!local.includes("secret-thought-preview"));
            assert.ok(!local.includes("secret-text-preview"));
            assert.ok(adapter.capture.called, "real telemetry service must reach the adapter boundary");
            const exported = JSON.stringify(adapter.capture.getCalls().map((call) => call.args));
            assert.ok(!exported.includes("secret-thought-preview"));
            assert.ok(!exported.includes("secret-text-preview"));
            assert.ok(!exported.includes("rs_1"));
        } finally {
            service.dispose();
        }
    });

    test("hostile usage remains host-visible but never reaches diagnostics or the PostHog adapter", async () => {
        const service = new TelemetryService();
        const adapter = sandbox.createStubInstance(PostHogAdapter);
        (service as unknown as { adapter: PostHogAdapter }).adapter = adapter;
        sandbox.stub(vscode.env, "isTelemetryEnabled").get(() => true);
        service.initialize({ extension: { packageJSON: { version: "test" } } } as unknown as vscode.ExtensionContext);
        LiteLLMTelemetry.setTelemetryService(service);
        const legacy = ["trace", "debug", "info", "warn", "error"].map((level) =>
            sandbox.stub(Logger, level as "trace" | "debug" | "info" | "warn" | "error")
        );
        const instance = provider();
        sandbox
            .stub(LiteLLMClient.prototype, "fetchWithRateLimit")
            .resolves(
                new Response(
                    stream(
                        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
                            'data: {"usage":{"prompt_tokens":"hostile-usage-secret","completion_tokens":7}}\n\n' +
                            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
                    ),
                    { status: 200 }
                )
            );
        const parts: vscode.LanguageModelResponsePart[] = [];
        try {
            await run(instance, "usage-model", parts);
            const usage = parts.find(
                (part): part is vscode.LanguageModelDataPart =>
                    part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage"
            );
            assert.ok(usage);
            assert.deepStrictEqual(JSON.parse(Buffer.from(usage.data).toString("utf8")), {
                prompt_tokens: "hostile-usage-secret",
                completion_tokens: 7,
                total_tokens: "hostile-usage-secret7",
                reserved_output_tokens: 512,
                total_token_max: 4096,
                estimated_input_cost: 0,
                estimated_output_cost: 0,
                estimated_total_cost: 0,
            });
            assert.ok(adapter.capture.called, "real service must reach the adapter");
            assert.ok(!JSON.stringify([...argsOf(log), ...legacy.flatMap(argsOf)]).includes("hostile-usage-secret"));
            assert.ok(!JSON.stringify(argsOf(adapter.capture)).includes("hostile-usage-secret"));
        } finally {
            service.dispose();
        }
    });

    test("an upstream failure echo is not exported in request failure telemetry", async () => {
        const service = new TelemetryService();
        const adapter = sandbox.createStubInstance(PostHogAdapter);
        (service as unknown as { adapter: PostHogAdapter }).adapter = adapter;
        sandbox.stub(vscode.env, "isTelemetryEnabled").get(() => true);
        service.initialize({ extension: { packageJSON: { version: "test" } } } as unknown as vscode.ExtensionContext);
        LiteLLMTelemetry.setTelemetryService(service);
        const instance = provider();
        sandbox.stub(LiteLLMClient.prototype, "fetchWithRateLimit").resolves(
            new Response('{"error":{"message":"secret-api-key opaque-signature private@example.com"}}', {
                status: 400,
            })
        );
        try {
            await assert.rejects(run(instance, "model-private"));
            const failures = adapter.capture
                .getCalls()
                .map((call) => call.args[0])
                .filter((event) => event.event === "request_failed");
            assert.strictEqual(failures.length, 1);
            assert.strictEqual(failures[0].properties.error_type, "request_failed");
            const exported = JSON.stringify(adapter.capture.getCalls().map((call) => call.args));
            assert.ok(!exported.includes("secret-api-key"));
            assert.ok(!exported.includes("opaque-signature"));
            assert.ok(!exported.includes("private@example.com"));
        } finally {
            service.dispose();
        }
    });
});
