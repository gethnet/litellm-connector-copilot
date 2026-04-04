import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

/* eslint-disable no-undef */

const buildDir = resolve(process.env.POSTHOG_BUILD_DIR ?? "dist");
const posthogHost = process.env.POSTHOG_HOST;
const posthogProjectApiKey = process.env.POSTHOG_PROJECT_API_KEY;
const posthogPersonalApiKey = process.env.POSTHOG_PERSONAL_API_KEY;
const release = process.env.POSTHOG_RELEASE ?? process.env.npm_package_version;

if (!posthogHost || !posthogProjectApiKey || !posthogPersonalApiKey || !release) {
    console.error(
        "Missing required PostHog sourcemap env vars: POSTHOG_HOST, POSTHOG_PROJECT_API_KEY, POSTHOG_PERSONAL_API_KEY, POSTHOG_RELEASE"
    );
    process.exit(1);
}

function walk(dir) {
    const entries = readdirSync(dir);
    const files = [];

    for (const entry of entries) {
        const absolutePath = join(dir, entry);
        const entryStat = statSync(absolutePath);

        if (entryStat.isDirectory()) {
            files.push(...walk(absolutePath));
            continue;
        }

        files.push(absolutePath);
    }

    return files;
}

function getJavaScriptArtifacts(rootDir) {
    return walk(rootDir).filter((filePath) => filePath.endsWith(".js"));
}

function ensureSourceMapReference(jsFilePath) {
    const mapPath = `${jsFilePath}.map`;
    if (!existsSync(mapPath)) {
        throw new Error(`Missing source map for ${jsFilePath}`);
    }

    const fileContents = readFileSync(jsFilePath, "utf8");
    // const sourceMapComment = `//# sourceMappingURL=${relative(resolve(jsFilePath, '..'), mapPath)}`;

    if (fileContents.includes("sourceMappingURL=")) {
        return;
    }

    throw new Error(
        `Missing sourceMappingURL comment in ${jsFilePath}; configure esbuild to emit external source map references.`
    );
}

async function uploadArtifact(jsFilePath) {
    const mapPath = `${jsFilePath}.map`;
    const formData = new FormData();
    const bundlePath = relative(buildDir, jsFilePath).replaceAll("\\", "/");
    const mapPathRelative = relative(buildDir, mapPath).replaceAll("\\", "/");
    const mapSha = createHash("sha256").update(readFileSync(mapPath)).digest("hex");

    formData.append("project_api_key", posthogProjectApiKey);
    formData.append("release", release);
    formData.append("url", bundlePath);
    formData.append("map_url", mapPathRelative);
    formData.append("checksum", mapSha);
    formData.append("source_map", new Blob([readFileSync(mapPath)]), mapPathRelative);
    formData.append("bundle", new Blob([readFileSync(jsFilePath)]), bundlePath);

    const response = await fetch(
        `${posthogHost.replace(/\/$/, "")}/api/projects/@current/error_tracking/sourcemaps`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${posthogPersonalApiKey}`,
            },
            body: formData,
        }
    );

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`PostHog sourcemap upload failed for ${bundlePath}: ${response.status} ${body}`);
    }
}

async function main() {
    if (!existsSync(buildDir)) {
        throw new Error(`Build directory does not exist: ${buildDir}`);
    }

    const artifacts = getJavaScriptArtifacts(buildDir);
    if (artifacts.length === 0) {
        throw new Error(`No JavaScript artifacts found in ${buildDir}`);
    }

    for (const artifact of artifacts) {
        ensureSourceMapReference(artifact);
        await uploadArtifact(artifact);
    }

    process.stdout.write(
        `Uploaded ${artifacts.length} PostHog sourcemap artifact(s) for release ${release}\n`
    );
}

await main().catch((err) => {
    console.error(err);
    process.exit(1);
});
