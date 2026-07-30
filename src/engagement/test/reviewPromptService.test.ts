import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ReviewPromptService } from "../reviewPromptService";
import type { TelemetryService } from "../../telemetry/telemetryService";
import { StructuredLogger } from "../../observability/structuredLogger";
import { createMockMemento } from "../../test/utils/testMocks";

suite("ReviewPromptService", () => {
    let sandbox: sinon.SinonSandbox;
    let clock: sinon.SinonFakeTimers;
    let globalState: vscode.Memento;
    let telemetryService: sinon.SinonStubbedInstance<TelemetryService>;
    let showInformationMessage: sinon.SinonStub;
    let openExternal: sinon.SinonStub;
    let sessionIdStub: sinon.SinonStub;
    let service: ReviewPromptService;

    function createService(seed: Record<string, unknown> = {}): ReviewPromptService {
        globalState = createMockMemento(seed);
        telemetryService = {
            captureReviewPromptEligible: sandbox.stub(),
            captureReviewPromptChoice: sandbox.stub(),
        } as unknown as sinon.SinonStubbedInstance<TelemetryService>;
        showInformationMessage = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);
        openExternal = sandbox.stub(vscode.env, "openExternal").resolves(true);
        sessionIdStub = sandbox.stub(vscode.env, "sessionId").get(() => "test-session-id");
        return new ReviewPromptService(globalState, telemetryService as unknown as TelemetryService);
    }

    async function recordSuccessfulTurns(instance: ReviewPromptService, count: number): Promise<void> {
        for (let index = 0; index < count; index += 1) {
            await instance.recordSuccessfulChatTurn();
        }
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        clock = sandbox.useFakeTimers({ now: new Date("2026-07-26T12:00:00.000Z") });
        sandbox.stub(StructuredLogger, "info");
    });

    teardown(() => {
        service?.dispose();
        sandbox.restore();
    });

    test("records the install date once and does not prompt before ten successful turns", async () => {
        service = createService();

        await service.initialize();
        await recordSuccessfulTurns(service, 9);
        await clock.tickAsync(5 * 60 * 1000);

        assert.strictEqual(typeof globalState.get<number>("litellm-connector.reviewPrompt.installDate.v1"), "number");
        assert.strictEqual(showInformationMessage.called, false);
        assert.strictEqual(telemetryService.captureReviewPromptEligible.called, false);
    });

    test("prompts after ten successful turns and five minutes without a new request", async () => {
        service = createService();
        await service.initialize();
        await recordSuccessfulTurns(service, 10);

        await clock.tickAsync(5 * 60 * 1000);

        assert.strictEqual(showInformationMessage.calledOnce, true);
        assert.strictEqual(telemetryService.captureReviewPromptEligible.calledOnce, true);
        assert.deepStrictEqual(telemetryService.captureReviewPromptEligible.firstCall.args[0], {
            installDate: new Date("2026-07-26T12:00:00.000Z").getTime(),
            successfulTurnCount: 10,
        });
    });

    test("restarts the five-minute countdown when a new request begins", async () => {
        service = createService();
        await service.initialize();
        await recordSuccessfulTurns(service, 10);

        await clock.tickAsync(4 * 60 * 1000);
        service.recordChatRequestStarted();
        await clock.tickAsync(60 * 1000);
        assert.strictEqual(showInformationMessage.called, false);

        await clock.tickAsync(4 * 60 * 1000);
        assert.strictEqual(showInformationMessage.calledOnce, true);
    });

    test("opens the extension Marketplace page and permanently suppresses later prompts after Leave a Review", async () => {
        service = createService();
        showInformationMessage.resolves("Leave a Review");
        await service.initialize();
        await recordSuccessfulTurns(service, 10);

        await clock.tickAsync(5 * 60 * 1000);

        assert.strictEqual(globalState.get<boolean>("litellm-connector.reviewPrompt.doNotAskAgain.v1"), true);
        assert.strictEqual(openExternal.calledOnce, true);
        assert.strictEqual(
            decodeURIComponent(openExternal.firstCall.args[0].toString()),
            "https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot&ssr=false#review-details"
        );
        assert.deepStrictEqual(telemetryService.captureReviewPromptChoice.firstCall.args[0], {
            choice: "review_or_rated",
            installDate: new Date("2026-07-26T12:00:00.000Z").getTime(),
            successfulTurnCount: 10,
        });

        await service.recordSuccessfulChatTurn();
        await clock.tickAsync(5 * 60 * 1000);
        assert.strictEqual(showInformationMessage.calledOnce, true);
    });

    test("permanently suppresses later prompts after Don't Ask Again", async () => {
        service = createService();
        showInformationMessage.resolves("Don't Ask Again");
        await service.initialize();
        await recordSuccessfulTurns(service, 10);

        await clock.tickAsync(5 * 60 * 1000);

        assert.strictEqual(globalState.get<boolean>("litellm-connector.reviewPrompt.doNotAskAgain.v1"), true);
        assert.strictEqual(openExternal.called, false);
        assert.deepStrictEqual(telemetryService.captureReviewPromptChoice.firstCall.args[0], {
            choice: "never_again",
            installDate: new Date("2026-07-26T12:00:00.000Z").getTime(),
            successfulTurnCount: 10,
        });
    });

    test("suppresses further prompts for the remainder of the active session after Maybe Later", async () => {
        service = createService();
        showInformationMessage.resolves("Maybe Later");
        await service.initialize();
        await recordSuccessfulTurns(service, 10);

        await clock.tickAsync(5 * 60 * 1000);
        assert.strictEqual(globalState.get<boolean>("litellm-connector.reviewPrompt.doNotAskAgain.v1", false), false);
        assert.deepStrictEqual(telemetryService.captureReviewPromptChoice.firstCall.args[0], {
            choice: "later",
            installDate: new Date("2026-07-26T12:00:00.000Z").getTime(),
            successfulTurnCount: 10,
        });

        // Further idle periods and chat turns in the SAME session must not re-prompt.
        await recordSuccessfulTurns(service, 5);
        await clock.tickAsync(5 * 60 * 1000);
        assert.strictEqual(showInformationMessage.calledOnce, true);
    });

    test("dismissed notification also suppresses further prompts for the active session", async () => {
        service = createService();
        showInformationMessage.resolves(undefined);
        await service.initialize();
        await recordSuccessfulTurns(service, 10);

        await clock.tickAsync(5 * 60 * 1000);
        assert.strictEqual(telemetryService.captureReviewPromptChoice.firstCall.args[0].choice, "later");

        await recordSuccessfulTurns(service, 5);
        await clock.tickAsync(5 * 60 * 1000);
        assert.strictEqual(showInformationMessage.calledOnce, true);
    });

    test("re-prompts after a session change even if the user previously chose Maybe Later", async () => {
        service = createService();
        showInformationMessage.resolves("Maybe Later");
        await service.initialize();
        await recordSuccessfulTurns(service, 10);

        await clock.tickAsync(5 * 60 * 1000);
        assert.strictEqual(showInformationMessage.calledOnce, true);

        // Simulate a new VS Code session with a different sessionId.
        sessionIdStub.get(() => "new-session-id");
        await recordSuccessfulTurns(service, 5);
        await clock.tickAsync(5 * 60 * 1000);
        assert.strictEqual(showInformationMessage.calledTwice, true);
    });

    test("does not initialize or schedule a prompt when global state is unavailable", async () => {
        createService();
        service = new ReviewPromptService(undefined, telemetryService as unknown as TelemetryService);

        await service.initialize();
        await service.recordSuccessfulChatTurn();
        await clock.tickAsync(5 * 60 * 1000);

        assert.strictEqual(showInformationMessage.called, false);
        assert.strictEqual(telemetryService.captureReviewPromptEligible.called, false);
    });

    test("clears a pending idle timer when disposed", async () => {
        service = createService();
        await service.initialize();
        await recordSuccessfulTurns(service, 10);
        service.dispose();

        await clock.tickAsync(5 * 60 * 1000);
        assert.strictEqual(showInformationMessage.called, false);
    });
});
