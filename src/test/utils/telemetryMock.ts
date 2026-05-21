import * as sinon from "sinon";
import type { TelemetryService } from "../../telemetry/telemetryService";
import { LiteLLMTelemetry } from "../../utils/telemetry";

/**
 * Creates a stubbed TelemetryService for testing.
 * This centralizes the mock interface so all test files use a consistent shape.
 *
 * Usage:
 *   const sandbox = sinon.createSandbox();
 *   const mocks = createTelemetryMocks(sandbox);
 *   // mocks.telemetryServiceStub contains the stubbed service
 *   // mocks.setup() registers it with LiteLLMTelemetry
 *   // mocks.teardown() cleans up
 */
export interface TelemetryMocks {
    telemetryServiceStub: TelemetryService;
    captureStub: sinon.SinonStub;
    captureRequestCompletedWithCacheStub: sinon.SinonStub;
    captureRequestFailedStub: sinon.SinonStub;
    captureChatRequestStub: sinon.SinonStub;
    setup: () => void;
    teardown: () => void;
}

export function createTelemetryMocks(sandbox: sinon.SinonSandbox): TelemetryMocks {
    const captureStub = sandbox.stub();
    const captureRequestCompletedWithCacheStub = sandbox.stub();
    const captureRequestFailedStub = sandbox.stub();
    const captureChatRequestStub = sandbox.stub();

    const telemetryServiceStub = {
        capture: captureStub,
        captureRequestCompletedWithCache: captureRequestCompletedWithCacheStub,
        captureRequestFailed: captureRequestFailedStub,
        captureChatRequest: captureChatRequestStub,
    } as unknown as TelemetryService;

    return {
        telemetryServiceStub,
        captureStub,
        captureRequestCompletedWithCacheStub,
        captureRequestFailedStub,
        captureChatRequestStub,
        setup: () => {
            LiteLLMTelemetry.setTelemetryService(telemetryServiceStub);
        },
        teardown: () => {
            LiteLLMTelemetry.setTelemetryService(undefined as unknown as TelemetryService);
        },
    };
}
