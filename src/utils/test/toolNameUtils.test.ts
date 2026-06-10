import * as assert from "assert";
import { sanitizeToolName, TOOL_NAME_MAX_LENGTH } from "../toolNameUtils";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("sanitizeToolName", () => {
    test("truncates names longer than 64 characters to exactly 64 characters", () => {
        const longName = "a".repeat(100);
        const result = sanitizeToolName(longName);
        assert.strictEqual(result.name.length, TOOL_NAME_MAX_LENGTH);
        assert.strictEqual(result.name, "a".repeat(TOOL_NAME_MAX_LENGTH));
        assert.strictEqual(result.wasTruncated, true);
    });

    test("does not truncate names exactly at 64 characters", () => {
        const exactly64 = "a".repeat(TOOL_NAME_MAX_LENGTH);
        const result = sanitizeToolName(exactly64);
        assert.strictEqual(result.name.length, TOOL_NAME_MAX_LENGTH);
        assert.strictEqual(result.name, exactly64);
        assert.strictEqual(result.wasTruncated, false);
    });

    test("does not truncate names shorter than 64 characters", () => {
        const shortName = "my_tool";
        const result = sanitizeToolName(shortName);
        assert.strictEqual(result.name, shortName);
        assert.strictEqual(result.wasTruncated, false);
    });

    test("normalizes non-string inputs to 'tool'", () => {
        const result1 = sanitizeToolName(null);
        assert.strictEqual(result1.name, "tool");
        assert.strictEqual(result1.wasTruncated, false);

        const result2 = sanitizeToolName(undefined);
        assert.strictEqual(result2.name, "tool");
        assert.strictEqual(result2.wasTruncated, false);

        const result3 = sanitizeToolName(123);
        assert.strictEqual(result3.name, "tool");
        assert.strictEqual(result3.wasTruncated, false);

        const result4 = sanitizeToolName({ name: "tool" });
        assert.strictEqual(result4.name, "tool");
        assert.strictEqual(result4.wasTruncated, false);
    });

    test("handles empty string gracefully", () => {
        const result = sanitizeToolName("");
        assert.strictEqual(result.name, "tool");
        assert.strictEqual(result.wasTruncated, false);
    });

    test("handles strings starting with a number by prefixing with 'tool_'", () => {
        const name = "123toolstart";
        const result = sanitizeToolName(name);
        assert.ok(result.name.startsWith("tool_"));
        assert.strictEqual(result.name.substring(5), "123toolstart");
        assert.strictEqual(result.wasTruncated, false);
    });

    test("handles alphanumeric plus underscore/dash characters", () => {
        const name = "tool-with-dashes-and_underscores";
        const result = sanitizeToolName(name);
        const expected = "tool-with-dashes-and_underscores";
        assert.strictEqual(result.name, expected);
        assert.strictEqual(result.wasTruncated, false);
    });

    test("handles consecutive special characters including dashes and underscores", () => {
        const name = "tool_---__tool";
        const result = sanitizeToolName(name);
        // Implementation collapses consecutive underscores to a single underscore
        const expected = "tool_---_tool";
        assert.strictEqual(result.name, expected);
        assert.strictEqual(result.wasTruncated, false);
    });

    test("truncates after all normalization steps (including non-alphanumeric replacement)", () => {
        const longName = "a".repeat(80);
        const result = sanitizeToolName(longName);
        assert.strictEqual(result.name.length, TOOL_NAME_MAX_LENGTH);
        assert.strictEqual(result.name, "a".repeat(TOOL_NAME_MAX_LENGTH));
        assert.strictEqual(result.wasTruncated, true);
    });
});
