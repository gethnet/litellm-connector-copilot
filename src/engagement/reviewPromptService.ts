import * as vscode from "vscode";
import { StructuredLogger } from "../observability/structuredLogger";
import type { TelemetryService } from "../telemetry/telemetryService";

const INSTALL_DATE_KEY = "litellm-connector.reviewPrompt.installDate.v1";
const SUCCESSFUL_TURNS_KEY = "litellm-connector.reviewPrompt.successfulTurns.v1";
const DO_NOT_ASK_AGAIN_KEY = "litellm-connector.reviewPrompt.doNotAskAgain.v1";
const IDLE_DELAY_MS = 5 * 60 * 1000;
const MINIMUM_SUCCESSFUL_TURNS = 10;
const MARKETPLACE_URL =
    "https://marketplace.visualstudio.com/items?itemName=GethNet.litellm-connector-copilot&ssr=false#review-details";

const LEAVE_A_REVIEW = "Leave a Review";
const MAYBE_LATER = "Maybe Later";
const DO_NOT_ASK_AGAIN = "Don't Ask Again";

type ReviewPromptChoice = "review_or_rated" | "never_again" | "later";

/**
 * Owns local-only review prompt eligibility. The service intentionally records only
 * coarse extension state in globalState and exposes no request content to telemetry or logs.
 */
export class ReviewPromptService implements vscode.Disposable {
    private idleTimer: NodeJS.Timeout | undefined;
    private initialized = false;

    public constructor(
        private readonly globalState: vscode.Memento | undefined,
        private readonly telemetryService: TelemetryService
    ) {}

    /**
     * Creates a durable install timestamp once. Existing valid timestamps are never replaced,
     * allowing time-since-install telemetry to remain stable across extension activation cycles.
     */
    public async initialize(): Promise<void> {
        if (!this.globalState) {
            return;
        }

        const installDate = this.globalState.get<unknown>(INSTALL_DATE_KEY);
        if (typeof installDate !== "number" || !Number.isFinite(installDate)) {
            await this.globalState.update(INSTALL_DATE_KEY, Date.now());
        }
        this.initialized = true;
    }

    /** Clears the idle countdown immediately when a user begins a new chat request. */
    public recordChatRequestStarted(): void {
        this.clearIdleTimer();
        // If the user is already eligible, restart the 5-minute idle timer from now
        if (
            this.initialized &&
            !this.isPermanentlyDismissed() &&
            this.getSuccessfulTurnCount() >= MINIMUM_SUCCESSFUL_TURNS
        ) {
            this.scheduleIdlePrompt();
        }
    }

    /**
     * Persists a successful chat turn, then starts an idle-only countdown once the engagement
     * threshold is met. Failed/cancelled turns never call this method and cannot increase eligibility.
     */
    public async recordSuccessfulChatTurn(): Promise<void> {
        if (!this.initialized || !this.globalState || this.isPermanentlyDismissed()) {
            return;
        }

        const successfulTurnCount = this.getSuccessfulTurnCount() + 1;
        await this.globalState.update(SUCCESSFUL_TURNS_KEY, successfulTurnCount);
        if (successfulTurnCount >= MINIMUM_SUCCESSFUL_TURNS) {
            this.scheduleIdlePrompt();
        }
    }

    public dispose(): void {
        this.clearIdleTimer();
    }

    /**
     * Wipes all durable review-prompt state and cancels any pending idle timer.
     * Intended for local development use only; production callers should prefer
     * "Don't Ask Again" or "Maybe Later" so the user remains in control of their
     * engagement cadence.
     */
    public async clearReviewPromptState(): Promise<void> {
        this.clearIdleTimer();
        this.initialized = false;
        if (!this.globalState) {
            return;
        }

        await this.globalState.update(INSTALL_DATE_KEY, undefined);
        await this.globalState.update(SUCCESSFUL_TURNS_KEY, undefined);
        await this.globalState.update(DO_NOT_ASK_AGAIN_KEY, undefined);
    }

    private getSuccessfulTurnCount(): number {
        const storedCount = this.globalState?.get<unknown>(SUCCESSFUL_TURNS_KEY);
        return typeof storedCount === "number" && Number.isFinite(storedCount) && storedCount >= 0 ? storedCount : 0;
    }

    private getInstallDate(): number {
        const installDate = this.globalState?.get<unknown>(INSTALL_DATE_KEY);
        return typeof installDate === "number" && Number.isFinite(installDate) ? installDate : Date.now();
    }

    private isPermanentlyDismissed(): boolean {
        return this.globalState?.get<boolean>(DO_NOT_ASK_AGAIN_KEY, false) === true;
    }

    private scheduleIdlePrompt(): void {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.idleTimer = undefined;
            void this.showPromptIfEligible();
        }, IDLE_DELAY_MS);
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private async showPromptIfEligible(): Promise<void> {
        if (!this.globalState || this.isPermanentlyDismissed()) {
            return;
        }

        const successfulTurnCount = this.getSuccessfulTurnCount();
        if (successfulTurnCount < MINIMUM_SUCCESSFUL_TURNS) {
            return;
        }

        const installDate = this.getInstallDate();
        this.telemetryService.captureReviewPromptEligible({ installDate, successfulTurnCount });
        StructuredLogger.info("review_prompt.eligible", { installDate, successfulTurnCount });

        const selected = await vscode.window.showInformationMessage(
            "Enjoying LiteLLM Connector? A Marketplace review helps other developers discover it.",
            LEAVE_A_REVIEW,
            MAYBE_LATER,
            DO_NOT_ASK_AGAIN
        );

        if (selected === LEAVE_A_REVIEW) {
            await this.globalState.update(DO_NOT_ASK_AGAIN_KEY, true);
            this.recordChoice("review_or_rated", installDate, successfulTurnCount);
            await vscode.env.openExternal(vscode.Uri.parse(MARKETPLACE_URL));
            return;
        }

        if (selected === DO_NOT_ASK_AGAIN) {
            await this.globalState.update(DO_NOT_ASK_AGAIN_KEY, true);
            this.recordChoice("never_again", installDate, successfulTurnCount);
            return;
        }

        this.recordChoice("later", installDate, successfulTurnCount);
        this.scheduleIdlePrompt();
    }

    private recordChoice(choice: ReviewPromptChoice, installDate: number, successfulTurnCount: number): void {
        this.telemetryService.captureReviewPromptChoice({ choice, installDate, successfulTurnCount });
        StructuredLogger.info("review_prompt.choice_recorded", {
            choice,
            installDate,
            successfulTurnCount,
        });
    }
}
