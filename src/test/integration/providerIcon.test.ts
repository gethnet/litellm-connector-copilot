import * as assert from "assert";
import { existsSync, readFileSync } from "fs";
import * as path from "path";

suite("Provider icon manifest", () => {
    test("references the packaged PNG asset", () => {
        const root = path.resolve(__dirname, "../../../..");
        const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
            contributes: { languageModelChatProviders: { vendor: string; icon?: string }[] };
        };
        const provider = manifest.contributes.languageModelChatProviders.find(
            (entry) => entry.vendor === "litellm-connector"
        );
        assert.strictEqual(provider?.icon, "assets/logo.png");
        assert.ok(existsSync(path.join(root, provider.icon)), "provider icon must exist in the extension");
        const ignore = readFileSync(path.join(root, ".vscodeignore"), "utf8");
        assert.match(ignore, /^!assets\/\*\*$/m, "assets must be included in the VSIX");
    });
});
