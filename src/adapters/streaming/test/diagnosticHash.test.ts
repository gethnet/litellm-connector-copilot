import * as assert from "assert";
import * as sinon from "sinon";
import { sha256 } from "js-sha256";
import { diagnosticHash } from "../diagnosticHash";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;

suite("diagnosticHash", () => {
    test("only hashes strings without coercing hostile or unsupported values", () => {
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        const hostile = {
            toString: () => {
                throw new Error("must not coerce");
            },
        };

        for (const value of [
            undefined,
            null,
            42,
            false,
            1n,
            Symbol("private"),
            [],
            new Uint8Array([1]),
            hostile,
            revoked.proxy,
        ]) {
            assert.strictEqual(diagnosticHash(value), undefined);
        }
        const fingerprint = diagnosticHash("private");
        assert.match(fingerprint ?? "", /^[a-f0-9]{64}$/);
        assert.strictEqual(diagnosticHash("private"), fingerprint);
        assert.notStrictEqual(diagnosticHash("other"), fingerprint);
        assert.match(diagnosticHash("") ?? "", /^[a-f0-9]{64}$/);
    });

    test("hashing failures omit diagnostics instead of propagating", () => {
        const stub = sinon.stub(sha256, "hmac").throws(new Error("hash unavailable"));
        try {
            assert.strictEqual(diagnosticHash("private"), undefined);
        } finally {
            stub.restore();
        }
    });

    test("unavailable random key omits fingerprints without breaking module loading", async () => {
        const modulePath = require.resolve("../diagnosticHash");
        const cached = require.cache[modulePath];
        const randomStub = sinon.stub(globalThis.crypto, "getRandomValues").throws(new Error("random unavailable"));
        try {
            delete require.cache[modulePath];
            const reloaded = await import("../diagnosticHash.js");
            assert.strictEqual(reloaded.diagnosticHash("private"), undefined);
        } finally {
            randomStub.restore();
            if (cached) {
                require.cache[modulePath] = cached;
            } else {
                delete require.cache[modulePath];
            }
        }
    });
});
