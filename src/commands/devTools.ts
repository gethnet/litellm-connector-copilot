import * as vscode from "vscode";
import type { ReviewPromptService } from "../engagement/reviewPromptService";
import { StructuredLogger } from "../observability";

const DEV_VERSION_PATTERN = /-dev\d*$/;

/**
 * Context key that controls visibility of dev-only commands in the Command
 * Palette. Set to `true` during activation when the running extension reports
 * a `-devN` version suffix; remains absent (falsy) on production builds so the
 * `commandPalette` menu `when` clause hides the entries.
 */
export const DEV_BUILD_CONTEXT_KEY = "litellm-connector.isDevBuild";

/**
 * Module-level reference to the activation context. Stored once during
 * activation so command handlers can re-check the live extension version at
 * invocation time without being re-passed the context on every call.
 */
let activationContext: vscode.ExtensionContext | undefined;

/**
 * Returns true when the installed extension reports a `-devN` version suffix.
 * Dev builds are produced by `npm run bump-version dev`; the trailing marker is
 * the only reliable signal for "incremental install" since users run a
 * pre-compiled extension rather than attaching a debugger.
 */
export function isDevVersion(version: string | undefined): boolean {
    return typeof version === "string" && DEV_VERSION_PATTERN.test(version);
}

/**
 * Reads the installed extension's package version from the VS Code extension
 * host. Falls back to `undefined` when the lookup fails so callers can treat
 * missing metadata as "not a dev build" without throwing. `context.extension`
 * may be missing on partial test stubs, so guard the read with `?.`.
 */
function readInstalledExtensionVersion(context: vscode.ExtensionContext): string | undefined {
    const id = context.extension?.id;
    const ext = id ? vscode.extensions.getExtension(id) : undefined;
    const pkg: unknown = ext?.packageJSON;
    if (typeof pkg !== "object" || pkg === null) {
        return undefined;
    }
    const version = (pkg as Record<string, unknown>).version;
    return typeof version === "string" ? version : undefined;
}

/** Internal helper: read version without propagating exceptions. */
function safeReadVersion(context: vscode.ExtensionContext): string | undefined {
    try {
        return readInstalledExtensionVersion(context);
    } catch {
        return undefined;
    }
}

/**
 * Sets the `litellm-connector.isDevBuild` context key so the `commandPalette`
 * menu `when` clause shows/hides dev-only commands. Also stores the context for
 * the command handler's defense-in-depth version re-check. Safe to call from
 * synchronous `activate()`; never throws.
 *
 * @returns `true` when the running build is a `-devN` version, else `false`.
 */
export async function setDevBuildContextKey(context: vscode.ExtensionContext): Promise<boolean> {
    activationContext = context;
    const version = safeReadVersion(context);
    const isDev = isDevVersion(version);
    StructuredLogger.info("dev_tools.set_context", { context: DEV_BUILD_CONTEXT_KEY, isDev, version });
    try {
        await vscode.commands.executeCommand("setContext", DEV_BUILD_CONTEXT_KEY, isDev);
    } catch (setCtxErr) {
        // setContext must be available on the extension host; guard anyway so a
        // rare API failure never breaks activation.
        StructuredLogger.info("dev_tools.set_context_failed", {
            context: DEV_BUILD_CONTEXT_KEY,
            error: setCtxErr instanceof Error ? setCtxErr.message : String(setCtxErr),
        });
    }
    return isDev;
}

/**
 * Registers the `litellm-connector.dev.resetReviewPrompt` command. The command
 * is always registered so VS Code can execute it once the `commandPalette`
 * `when` clause surfaces it. The handler re-checks the live extension version
 * at invocation time as a defense-in-depth guard against stale context keys
 * (e.g. a user updating from a dev build to a production build without
 * reloading, which would leave `litellm-connector.isDevBuild` true until the
 * next activation).
 *
 * @returns A disposable for the registered command.
 */
export function registerDevResetReviewPromptCommand(reviewPromptService: ReviewPromptService): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.dev.resetReviewPrompt", async () => {
        // Re-check at invocation time: setContext is only refreshed on activation,
        // so a stale key could still surface the command after a hot-swap update.
        const liveVersion = activationContext ? safeReadVersion(activationContext) : undefined;
        if (!isDevVersion(liveVersion)) {
            StructuredLogger.info("dev_tools.handler_blocked_in_production", {
                command: "dev.resetReviewPrompt",
                version: liveVersion,
            });
            vscode.window.showWarningMessage(
                "LiteLLM: dev-only commands are disabled in this build. " +
                    "Install a -devN version to use reset tools."
            );
            return;
        }

        await reviewPromptService.clearReviewPromptState();
        StructuredLogger.info("dev_tools.review_prompt_state_reset", { version: liveVersion });
        vscode.window.showInformationMessage(
            "LiteLLM: review-prompt state cleared. " + "Next successful chat turn will start a fresh eligibility cycle."
        );
    });
}
