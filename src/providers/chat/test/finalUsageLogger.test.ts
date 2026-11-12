import * as assert from "assert";
import * as sinon from "sinon";
import { Logger } from "../../../utils/logger";
import { logFinalUsageEnvelope } from "../finalUsageLogger";

suite("final usage logging", () => {
    let sandbox: sinon.SinonSandbox;
    let debug: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        debug = sandbox.stub(Logger, "debug");
    });

    teardown(() => sandbox.restore());

    test("preserves every populated usage field, including zero values", () => {
        logFinalUsageEnvelope("request-1", "model-1", "chat", {
            tokensIn: 0,
            tokensOut: 2,
            cachedTokens: 3,
            cacheCreationInputTokens: 4,
            reasoningTokens: 5,
            toolTokens: 6,
            acceptedPredictionTokens: 7,
            rejectedPredictionTokens: 8,
            systemPromptTokens: 9,
            reservedOutputTokens: 10,
            totalTokenMax: 11,
            sawUsageDataPart: true,
            estimatedInputCost: 0,
            estimatedOutputCost: 0.2,
            estimatedTotalCost: 0.2,
        });

        sinon.assert.calledOnceWithExactly(
            debug,
            "[TokenUsage][Final] request_id=request-1 model=model-1 caller=chat " +
                "tokens_in=0 tokens_out=2 cached_tokens=3 cache_creation_input_tokens=4 " +
                "reasoning_tokens=5 tool_tokens=6 accepted_prediction_tokens=7 rejected_prediction_tokens=8 " +
                "system_prompt_tokens=9 reserved_output_tokens=10 total_token_max=11 streamed_usage=true " +
                "estimated_input_cost=0 estimated_output_cost=0.2 estimated_total_cost=0.2"
        );
    });

    test("preserves placeholders for unavailable fields on the retry path", () => {
        logFinalUsageEnvelope("request-2", "model-2", "chat", { sawUsageDataPart: false });

        sinon.assert.calledOnce(debug);
        assert.strictEqual(
            debug.firstCall.args[0],
            "[TokenUsage][Final] request_id=request-2 model=model-2 caller=chat " +
                "tokens_in=n/a tokens_out=n/a cached_tokens=n/a cache_creation_input_tokens=n/a " +
                "reasoning_tokens=n/a tool_tokens=n/a accepted_prediction_tokens=n/a rejected_prediction_tokens=n/a " +
                "system_prompt_tokens=n/a reserved_output_tokens=n/a total_token_max=n/a streamed_usage=false " +
                "estimated_input_cost=n/a estimated_output_cost=n/a estimated_total_cost=n/a"
        );
    });
});
