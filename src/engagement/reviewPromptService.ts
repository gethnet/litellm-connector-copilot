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
 *
 * Session-scoped suppression: "Maybe Later" (or a dismissed notification) suppresses
 * further prompts for the remainder of the current VS Code session only. The session
 * marker is read from `vscode.env.sessionId` and kept entirely in memory — it is never
 * persisted to durable `globalState`. When the session changes (VS Code restart), the
 * user is treated as if they had never deferred, so the eligibility cycle restarts.
 */
export class ReviewPromptService implements vscode.Disposable {
    private idleTimer: NodeJS.Timeout | undefined;
    private initialized = false;
    /**
     * In-memory-only record of the session that last deferred the prompt. Stored as a
     * field (not in durable `globalState`) so it evaporates on extension deactivation.
     * When `vscode.env.sessionId` differs from this value, the deferral is cleared.
     */
    private deferredSessionId: string | undefined;

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
        // If the user is already eligible and has not deferred this session, restart the 5-minute idle timer.
        if (
            this.initialized &&
            !this.isPermanentlyDismissed() &&
            !this.isSessionDeferred() &&
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
        if (successfulTurnCount >= MINIMUM_SUCCESSFUL_TURNS && !this.isSessionDeferred()) {
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

    /**
     * Returns true when the current VS Code session has already deferred the prompt via
     * "Maybe Later" or dismissal. The deferral is kept in memory only (never durable), so a
     * new session — even one that reuses a stale `sessionId` after a restart — clears it
     * because the field is reset on construction. The check compares the live
     * `vscode.env.sessionId` against the stored deferral marker.
     */
    private isSessionDeferred(): boolean {
        if (this.deferredSessionId === undefined) {
            return false;
        }
        return vscode.env.sessionId === this.deferredSessionId;
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

        // "Maybe Later" or a dismissed (undefined) notification: suppress for the remainder of
        // this VS Code session only. The deferral is stored in memory keyed by the current
        // sessionId; it is NOT persisted to durable globalState, so a session change (restart)
        // treats the user as if they had never deferred.
        this.deferredSessionId = vscode.env.sessionId;
        this.recordChoice("later", installDate, successfulTurnCount);
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
