import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../../providers/liteLLMChatProvider";
import { LiteLLMClient } from "../../adapters/litellmClient";
import {
    buildCommitMessages,
    prepareCommitRequest,
    shrinkCommitDiff,
    type CommitPreparationProvider,
} from "../commitRequestPreparation";
import { countTokens } from "../../adapters/tokenUtils";
import { recordCalibrationObservation, resetCalibration } from "../../adapters/tokenizers/tokenCalibration";
import { createMockSecrets } from "../../test/utils/testMocks";
import type { LiteLLMModelInfo } from "../../types";

suite("Commit request preparation (#180)", () => {
    let sandbox: sinon.SinonSandbox;
    let source: vscode.CancellationTokenSource;
    setup(() => {
        sandbox = sinon.createSandbox();
        source = new vscode.CancellationTokenSource();
        resetCalibration();
    });
    teardown(() => {
        source.dispose();
        resetCalibration();
        sandbox.restore();
    });
    const hostId = "proxy.example/azure_ai/model";
    const rawId = "azure_ai/model";
    const system = "Keep the full system instruction.";
    const instruction = "Keep the full user instruction.";
    const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n+" + "x".repeat(24000);
    function provider(info?: LiteLLMModelInfo): {
        value: CommitPreparationProvider;
        remote: sinon.SinonStub;
    } {
        const remote = sandbox.stub().resolves(undefined);
        return {
            value: {
                getModelInfo: () => info,
                getRawModelName: () => rawId,
                remoteCountTokens: remote,
            },
            remote,
        };
    }
    test("recounts complete messages and verifies the reduced candidate before returning", async () => {
        const { value, remote } = provider();
        remote.callsFake(async (_id: string, input: readonly vscode.LanguageModelChatRequestMessage[]) =>
            Math.ceil(countTokens(input, rawId) * 1.5)
        );
        const result = await prepareCommitRequest(
            value,
            hostId,
            8000,
            diff,
            system,
            instruction,
            undefined,
            source.token
        );
        assert.ok(remote.callCount >= 2 && remote.callCount <= 3);
        for (const call of remote.getCalls()) {
            assert.strictEqual(call.args[0], hostId);
            const messages = call.args[1] as readonly vscode.LanguageModelChatRequestMessage[];
            assert.strictEqual((messages[0].content[0] as vscode.LanguageModelTextPart).value, system);
            assert.ok((messages[1].content[0] as vscode.LanguageModelTextPart).value.startsWith(instruction));
            assert.strictEqual(call.args[3], source.token);
        }
        const last = remote.lastCall.args[1] as readonly vscode.LanguageModelChatRequestMessage[];
        assert.deepStrictEqual(last, buildCommitMessages(result.diff, system, instruction));
        assert.ok(Math.ceil(countTokens(last, rawId) * 1.5) <= result.inputBudget);
    });
    test("uses raw calibration rather than the namespaced selection ID", async () => {
        recordCalibrationObservation(rawId, 200, 100);
        const { value } = provider();
        const result = await prepareCommitRequest(
            value,
            hostId,
            8000,
            diff,
            system,
            instruction,
            undefined,
            source.token
        );
        assert.strictEqual(result.rawModelId, rawId);
        assert.strictEqual(result.estimatedDiffTokens, countTokens(diff, rawId));
        assert.ok(result.estimatedDiffTokens > countTokens(diff, hostId));
    });
    test("unknown raw metadata retains the selected independent input maximum", async () => {
        const { value } = provider();
        const result = await prepareCommitRequest(value, hostId, 8000, diff, system, instruction, 8000, source.token);
        assert.strictEqual(result.maxInputTokens, 8000);
        assert.strictEqual(result.inputBudget, 7200);
        assert.strictEqual(result.outputReserve, 8000);
        assert.strictEqual(result.modelInfo, undefined);
    });
    test("subtracts output only from proven combined context and does not mutate metadata", async () => {
        const info = Object.freeze({
            max_input_tokens: 8000,
            max_output_tokens: 500,
            context_window_tokens: 8500,
        });
        const { value } = provider(info);
        const result = await prepareCommitRequest(value, hostId, 8000, diff, system, instruction, 8000, source.token);
        assert.strictEqual(result.outputReserve, 500);
        assert.strictEqual(result.inputBudget, 7200);
        assert.strictEqual(info.context_window_tokens, 8500);
    });
    test("shrinks actual input even when the initial diff is far below the nominal budget", () => {
        const initial = "+" + "x".repeat(1400);
        const next = shrinkCommitDiff(initial, 1_000_000, rawId);
        assert.ok(next.length < initial.length);
        assert.ok(countTokens(next, rawId) < countTokens(initial, rawId));
        assert.strictEqual(shrinkCommitDiff(next, 1_000_000, rawId).includes("x".repeat(1400)), false);
    });
    test("remote unavailable or rejection falls back to locally fitting full prompts", async () => {
        for (const rejected of [false, true]) {
            const { value, remote } = provider();
            if (rejected) {
                remote.rejects(new Error("blocked route with private response"));
            }
            const result = await prepareCommitRequest(
                value,
                hostId,
                8000,
                diff,
                system,
                instruction,
                undefined,
                source.token
            );
            assert.ok(countTokens(buildCommitMessages(result.diff, system, instruction), rawId) <= result.inputBudget);
            assert.strictEqual(remote.callCount, 1);
        }
    });
    test("never returns a known-over-budget final recount and bounds count attempts", async () => {
        const { value, remote } = provider();
        remote.resolves(1_000_000);
        await assert.rejects(
            () => prepareCommitRequest(value, hostId, 8000, diff, system, instruction, undefined, source.token),
            /Context window exceeded/
        );
        assert.ok(remote.callCount <= 3);
    });
    test("static prompts alone cannot fit and are never shortened", async () => {
        const { value, remote } = provider();
        await assert.rejects(
            () =>
                prepareCommitRequest(value, hostId, 100, "+x", "s".repeat(1000), instruction, undefined, source.token),
            /Commit instructions exceed/
        );
        assert.ok(remote.notCalled);
    });
    test("already cancelled preparation never calls the remote counter", async () => {
        const { value, remote } = provider();
        source.cancel();
        await assert.rejects(
            () => prepareCommitRequest(value, hostId, 8000, diff, system, instruction, undefined, source.token),
            /cancelled/
        );
        assert.ok(remote.notCalled);
    });
    test("empty real registry retains host input and skips remote HTTP without discovery", async () => {
        const active = new LiteLLMChatProvider(createMockSecrets(), "test");
        const counter = sandbox.stub(LiteLLMClient.prototype, "countTokens");
        const configStub = sandbox.stub(active.getConfigManager(), "getConfig");
        const access = active as unknown as { _registry: { dispose(): void } };
        try {
            const result = await prepareCommitRequest(
                active,
                "model",
                8000,
                diff,
                system,
                instruction,
                8000,
                source.token
            );
            assert.strictEqual(result.maxInputTokens, 8000);
            assert.strictEqual(result.inputBudget, 7200);
            assert.strictEqual(result.outputReserve, 8000);
            assert.strictEqual(result.modelInfo, undefined);
            assert.strictEqual(result.rawModelId, "model");
            assert.ok(countTokens(buildCommitMessages(result.diff, system, instruction), "model") <= 7200);
            assert.ok(counter.notCalled);
            assert.ok(configStub.notCalled);
        } finally {
            access._registry.dispose();
        }
    });
});
