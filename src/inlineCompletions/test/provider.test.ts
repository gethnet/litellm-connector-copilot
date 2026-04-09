import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import type { LiteLLMConfig } from "../../types";
import { LiteLLMInlineCompletionProvider, buildInlineCompletionPrompt } from "../liteLLMInlineCompletionProvider";
import type { InlineCompletionsDependencies } from "../liteLLMInlineCompletionProvider";

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
            availableTokens: 500,
            modelId: "test-model",
        });

        assert.ok(prompt.includes("<prefix>"));
        assert.ok(prompt.includes("<suffix>"));
        assert.ok(prefixTokens + suffixTokens <= 1024);
    });

    test("provideInlineCompletionItems returns null when disabled", async () => {
        const completionProvider: InlineCompletionsDependencies["completionProvider"] = {
            provideTextCompletion: async () => ({ insertText: "x" }),
        };

        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: async () => ({ inlineCompletionsEnabled: false }) as LiteLLMConfig,
            completionProvider,
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
            completionProvider: {
                provideTextCompletion:
                    provideTextCompletion as InlineCompletionsDependencies["completionProvider"]["provideTextCompletion"],
            } as InlineCompletionsDependencies["completionProvider"],
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
            completionProvider: {
                provideTextCompletion:
                    provideTextCompletion as InlineCompletionsDependencies["completionProvider"]["provideTextCompletion"],
            } as InlineCompletionsDependencies["completionProvider"],
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
            completionProvider: {
                provideTextCompletion:
                    provideTextCompletion as InlineCompletionsDependencies["completionProvider"]["provideTextCompletion"],
            } as InlineCompletionsDependencies["completionProvider"],
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
            completionProvider: {
                provideTextCompletion:
                    provideTextCompletion as InlineCompletionsDependencies["completionProvider"]["provideTextCompletion"],
            } as InlineCompletionsDependencies["completionProvider"],
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
            completionProvider: {
                provideTextCompletion:
                    provideTextCompletion as InlineCompletionsDependencies["completionProvider"]["provideTextCompletion"],
            } as InlineCompletionsDependencies["completionProvider"],
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

    test("provideInlineCompletionItems returns null when token is already cancelled", async () => {
        const provideTextCompletion = sandbox.stub().resolves({ insertText: "hello" });

        const provider = new LiteLLMInlineCompletionProvider({
            getConfig: async () =>
                ({
                    url: "http://localhost:4000",
                    key: "k",
                    inlineCompletionsEnabled: true,
                    inlineCompletionsModelId: "m1",
                }) as LiteLLMConfig,
            completionProvider: {
                provideTextCompletion:
                    provideTextCompletion as InlineCompletionsDependencies["completionProvider"]["provideTextCompletion"],
            } as InlineCompletionsDependencies["completionProvider"],
        });

        const result = await provider.provideInlineCompletionItems(
            {
                getText: () => "const a = ",
                offsetAt: () => 10,
            } as unknown as vscode.TextDocument,
            new vscode.Position(0, 10),
            {} as vscode.InlineCompletionContext,
            {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(result, null);
        assert.strictEqual(provideTextCompletion.called, false);
    });

    test("buildInlineCompletionPrompt handles empty document text", () => {
        const doc = {
            getText: () => "",
            offsetAt: () => 0,
        } as unknown as vscode.TextDocument;

        const result = buildInlineCompletionPrompt(doc, new vscode.Position(0, 0), {
            reservedOutputTokens: 128,
            maxContextTokens: 512,
            availableTokens: 256,
            modelId: "test-model",
        });

        assert.ok(result.prompt.includes("<prefix>"));
        assert.ok(result.prompt.includes("<suffix>"));
        assert.strictEqual(result.prefixTokens >= 0, true);
        assert.strictEqual(result.suffixTokens >= 0, true);
    });
});
