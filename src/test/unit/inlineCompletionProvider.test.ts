import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import type { LiteLLMConfig } from "../../types";
import {
    LiteLLMInlineCompletionProvider,
    buildInlineCompletionPrompt,
} from "../../inlineCompletions/liteLLMInlineCompletionProvider";

suite("LiteLLMInlineCompletionProvider Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("buildInlineCompletionPrompt trims to token budget", async () => {
        const text = "a".repeat(100_000);
        const doc = {
            getText: () => text,
            offsetAt: () => Math.floor(text.length / 2),
        } as unknown as vscode.TextDocument;

        const { prompt, prefixTokens, suffixTokens } = buildInlineCompletionPrompt(doc, new vscode.Position(0, 0), {
            reservedOutputTokens: 256,
            maxContextTokens: 1024,
        });

        assert.ok(prompt.includes("<prefix>"));
        assert.ok(prompt.includes("<suffix>"));
        assert.ok(prefixTokens + suffixTokens <= 1024);
    });

    test("provideInlineCompletionItems returns null when disabled", async () => {
        const completionProvider = {
            provideTextCompletion: async () => ({ insertText: "x" }),
        } as unknown as { provideTextCompletion: () => Promise<{ insertText: string }> };

        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: async () => ({ inlineCompletionsEnabled: false }) as LiteLLMConfig,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            completionProvider: completionProvider as any,
        });

        const res = await provider.provideInlineCompletionItems(
            {
                getText: () => "",
                offsetAt: () => 0,
            } as unknown as vscode.TextDocument,
            new vscode.Position(0, 0),
            {} as vscode.InlineCompletionContext,
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(res, null);
    });

    test("provideInlineCompletionItems returns item when enabled and configured", async () => {
        const provideTextCompletion = sandbox.stub().resolves({ insertText: "hello" });

        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: async () =>
                ({
                    url: "http://localhost:4000",
                    key: "k",
                    inlineCompletionsEnabled: true,
                    inlineCompletionsModelId: "m1",
                }) as LiteLLMConfig,
            completionProvider: { provideTextCompletion } as unknown as {
                provideTextCompletion: () => Promise<{ insertText: string }>;
            },
        });

        const res = await provider.provideInlineCompletionItems(
            {
                getText: () => "const a = ",
                offsetAt: () => 10,
            } as unknown as vscode.TextDocument,
            new vscode.Position(0, 10),
            {} as vscode.InlineCompletionContext,
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.ok(Array.isArray(res));
        assert.strictEqual((res as vscode.InlineCompletionItem[])[0].insertText, "hello");
        assert.ok(provideTextCompletion.calledOnce);
    });

    test("provideInlineCompletionItems returns null when missing baseUrl", async () => {
        const provideTextCompletion = sandbox.stub().resolves({ insertText: "hello" });

        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: async () =>
                ({
                    url: "",
                    key: "k",
                    inlineCompletionsEnabled: true,
                    inlineCompletionsModelId: "m1",
                }) as LiteLLMConfig,
            completionProvider: { provideTextCompletion } as unknown as {
                provideTextCompletion: () => Promise<{ insertText: string }>;
            },
        });

        const res = await provider.provideInlineCompletionItems(
            {
                getText: () => "const a = ",
                offsetAt: () => 10,
            } as unknown as vscode.TextDocument,
            new vscode.Position(0, 10),
            {} as vscode.InlineCompletionContext,
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(res, null);
        assert.strictEqual(provideTextCompletion.called, false);
    });

    test("provideInlineCompletionItems returns null when model not selected", async () => {
        const provideTextCompletion = sandbox.stub().resolves({ insertText: "hello" });

        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: async () =>
                ({
                    url: "http://localhost:4000",
                    key: "k",
                    inlineCompletionsEnabled: true,
                    inlineCompletionsModelId: undefined,
                }) as LiteLLMConfig,
            completionProvider: { provideTextCompletion } as unknown as {
                provideTextCompletion: () => Promise<{ insertText: string }>;
            },
        });

        const res = await provider.provideInlineCompletionItems(
            {
                getText: () => "const a = ",
                offsetAt: () => 10,
            } as unknown as vscode.TextDocument,
            new vscode.Position(0, 10),
            {} as vscode.InlineCompletionContext,
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(res, null);
        assert.strictEqual(provideTextCompletion.called, false);
    });

    test("provideInlineCompletionItems returns null when completion is whitespace", async () => {
        const provideTextCompletion = sandbox.stub().resolves({ insertText: "   \n\t" });

        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: async () =>
                ({
                    url: "http://localhost:4000",
                    key: "k",
                    inlineCompletionsEnabled: true,
                    inlineCompletionsModelId: "m1",
                }) as LiteLLMConfig,
            completionProvider: { provideTextCompletion } as unknown as {
                provideTextCompletion: () => Promise<{ insertText: string }>;
            },
        });

        const res = await provider.provideInlineCompletionItems(
            {
                getText: () => "const a = ",
                offsetAt: () => 10,
            } as unknown as vscode.TextDocument,
            new vscode.Position(0, 10),
            {} as vscode.InlineCompletionContext,
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(res, null);
        assert.ok(provideTextCompletion.calledOnce);
    });

    test("provideInlineCompletionItems returns null and reports failure when completion provider throws", async () => {
        const provideTextCompletion = sandbox.stub().rejects(new Error("boom"));

        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: async () =>
                ({
                    url: "http://localhost:4000",
                    key: "k",
                    inlineCompletionsEnabled: true,
                    inlineCompletionsModelId: "m1",
                }) as LiteLLMConfig,
            completionProvider: { provideTextCompletion } as unknown as {
                provideTextCompletion: () => Promise<{ insertText: string }>;
            },
        });

        const res = await provider.provideInlineCompletionItems(
            {
                getText: () => "const a = ",
                offsetAt: () => 10,
            } as unknown as vscode.TextDocument,
            new vscode.Position(0, 10),
            {} as vscode.InlineCompletionContext,
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(res, null);
        assert.ok(provideTextCompletion.calledOnce);
    });
});
