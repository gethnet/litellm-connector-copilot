import * as assert from "assert";
import { LanguageModelChatMessageRole } from "vscode";
import { lmcr_toString, lmcr_fromString } from "../mapChatRoles";

suite("mapChatRoles", () => {
    suite("lmcr_toString", () => {
        test("converts User role to 'user'", () => {
            assert.strictEqual(lmcr_toString(LanguageModelChatMessageRole.User), "user");
        });

        test("converts Assistant role to 'assistant'", () => {
            assert.strictEqual(lmcr_toString(LanguageModelChatMessageRole.Assistant), "assistant");
        });

        test("converts numeric system role (3) to 'system'", () => {
            // Using cast since it might be proposed or not in the stable API yet
            assert.strictEqual(lmcr_toString(3 as LanguageModelChatMessageRole), "system");
        });

        test("defaults unknown roles to 'system'", () => {
            assert.strictEqual(lmcr_toString(99 as unknown as LanguageModelChatMessageRole), "system");
        });
    });

    suite("lmcr_fromString", () => {
        test("converts 'user' to User role", () => {
            assert.strictEqual(lmcr_fromString("user"), LanguageModelChatMessageRole.User);
        });

        test("converts 'assistant' to Assistant role", () => {
            assert.strictEqual(lmcr_fromString("assistant"), LanguageModelChatMessageRole.Assistant);
        });

        test("converts 'system' to system role", () => {
            assert.strictEqual(lmcr_fromString("system") as number, 3);
        });

        test("defaults empty string to User role", () => {
            assert.strictEqual(lmcr_fromString(""), LanguageModelChatMessageRole.User);
        });

        test("defaults unknown string to User role", () => {
            assert.strictEqual(lmcr_fromString("unknown"), LanguageModelChatMessageRole.User);
        });

        test("handles case-insensitive input", () => {
            assert.strictEqual(lmcr_fromString("USER"), LanguageModelChatMessageRole.User);
            assert.strictEqual(lmcr_fromString("Assistant"), LanguageModelChatMessageRole.Assistant);
        });
    });
});
