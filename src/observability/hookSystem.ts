import type * as vscode from "vscode";
import type { HookPoint, HookHandler, HookContext } from "./types";
import { StructuredLogger } from "./structuredLogger";

/**
 * Lifecycle hook system for the v2 provider baseline.
 *
 * Allows observers to inspect or modify requests/responses at defined points
 * in the request lifecycle. Hooks are registered via the registration API
 * and invoked automatically by the connection pipeline.
 *
 * Hook points:
 * - before:prepare: Before request normalization and preparation
 * - before:transform: Before endpoint-specific transforms are applied
 * - before:transmit: Before the request is sent to LiteLLM
 * - after:transmit: After the request is sent (before response is received)
 * - after:receive: After the response is received from LiteLLM
 * - after:transform: After response transforms are applied
 */
export class HookSystem {
    private static handlers = new Map<HookPoint, HookHandler[]>();

    /**
     * Registers a hook handler for the specified hook point.
     *
     * @param point - Hook point to register for
     * @param handler - Handler function to invoke
     * @returns Disposable to unregister the handler
     */
    public static register(point: HookPoint, handler: HookHandler): vscode.Disposable {
        const handlers = this.handlers.get(point) ?? [];
        handlers.push(handler);
        this.handlers.set(point, handlers);

        return {
            dispose: () => {
                const current = this.handlers.get(point);
                if (current) {
                    const index = current.indexOf(handler);
                    if (index >= 0) {
                        current.splice(index, 1);
                    }
                }
            },
        };
    }

    /**
     * Invokes all registered handlers for the specified hook point.
     *
     * @param point - Hook point to invoke
     * @param context - Context to pass to handlers
     */
    public static async invoke(point: HookPoint, context: HookContext): Promise<void> {
        const handlers = this.handlers.get(point);
        if (!handlers || handlers.length === 0) {
            return;
        }

        StructuredLogger.trace(
            "hook.invoked",
            {
                point,
                handlerCount: handlers.length,
                requestId: context.requestId,
            },
            {
                requestId: context.requestId,
                model: context.modelId,
                endpoint: context.endpoint,
                caller: context.caller,
            }
        );

        for (const handler of handlers) {
            try {
                await handler(point, context);
            } catch (err) {
                StructuredLogger.warn(
                    "hook.invoked",
                    {
                        point,
                        error: err instanceof Error ? err.message : String(err),
                        requestId: context.requestId,
                    },
                    {
                        requestId: context.requestId,
                        model: context.modelId,
                        endpoint: context.endpoint,
                        caller: context.caller,
                    }
                );
            }
        }
    }

    /**
     * Removes all registered handlers.
     */
    public static clear(): void {
        this.handlers.clear();
    }

    /**
     * Returns the number of handlers registered for a hook point.
     *
     * @param point - Hook point to check
     * @returns Number of registered handlers
     */
    public static handlerCount(point: HookPoint): number {
        return this.handlers.get(point)?.length ?? 0;
    }
}
