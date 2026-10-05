import * as assert from "assert";
import { resolveRegisteredModelId } from "../registeredModelId";

suite("Registered harness model IDs", () => {
    const canonical = "conduit.geth.cc/azure_ai/claude-sonnet-5-5";
    const entries = (ids: readonly string[]): ReadonlyMap<string, unknown> => new Map(ids.map((id) => [id, true]));

    test("exact registered input wins even when it begins with the vendor", () => {
        const wrapped = `litellm-connector/Conduit/${canonical}`;
        assert.strictEqual(resolveRegisteredModelId(wrapped, entries([canonical, wrapped])), wrapped);
        assert.strictEqual(resolveRegisteredModelId(canonical, entries([canonical])), canonical);
    });

    test("vendor-stripped exact registered remainder wins before suffix candidates", () => {
        const longer = `Dept/${canonical}`;
        assert.strictEqual(
            resolveRegisteredModelId(`litellm-connector/${longer}`, entries([canonical, longer])),
            longer
        );
        assert.strictEqual(resolveRegisteredModelId(`litellm-connector/${canonical}`, entries([canonical])), canonical);
    });

    test("reported Conduit wrapper resolves to the complete registered ID", () => {
        assert.strictEqual(
            resolveRegisteredModelId(`litellm-connector/Conduit/${canonical}`, entries([canonical])),
            canonical
        );
    });

    test("group labels are opaque literal strings including slashes and Unicode", () => {
        for (const group of ["Team East", "Ops [A]+(B)?", "研发/Équipe 🚀", "%2F#x", "A\\B", "A//B", " Team "]) {
            assert.strictEqual(
                resolveRegisteredModelId(`litellm-connector/${group}/${canonical}`, entries([canonical])),
                canonical,
                group
            );
        }
    });

    test("nested raw segments survive and shared raw names do not select another backend", () => {
        const nested = "conduit.geth.cc/azure_ai/us-central/claude-sonnet-5-5";
        const other = "other.geth.cc/azure_ai/us-central/claude-sonnet-5-5";
        assert.strictEqual(
            resolveRegisteredModelId(`litellm-connector/Team/Dept/${nested}`, entries([other, nested])),
            nested
        );
    });

    test("overlapping full registered suffixes fail closed regardless of insertion order", () => {
        const longer = `Dept/${canonical}`;
        const input = `litellm-connector/Team/${longer}`;
        assert.strictEqual(resolveRegisteredModelId(input, entries([canonical, longer])), undefined);
        assert.strictEqual(resolveRegisteredModelId(input, entries([longer, canonical])), undefined);
    });

    test("unknown and malformed IDs are never guessed or decoded", () => {
        for (const input of [
            "",
            "plain-model",
            `Conduit/${canonical}`,
            `other-vendor/Conduit/${canonical}`,
            `litellm-connector//${canonical}`,
            `litellm-connector/Conduit${canonical}`,
            "litellm-connector/Conduit/missing.geth.cc/azure_ai/claude-sonnet-5-5",
            "litellm-connector/Conduit/conduit.geth.cc/azure_ai/unknown",
            "litellm-connector/Conduit/CONDUIT.geth.cc/azure_ai/claude-sonnet-5-5",
            "litellm-connector/Conduit/conduit.geth.cc%2Fazure_ai%2Fclaude-sonnet-5-5",
        ]) {
            assert.strictEqual(resolveRegisteredModelId(input, entries([canonical])), undefined, input);
        }
        assert.strictEqual(resolveRegisteredModelId(`litellm-connector/Conduit/${canonical}`, entries([])), undefined);
        assert.strictEqual(
            resolveRegisteredModelId(`litellm-connector/Conduit/${canonical}`, entries(["", canonical])),
            canonical
        );
    });
});
