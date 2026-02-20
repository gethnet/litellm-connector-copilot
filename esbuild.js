const esbuild = require("esbuild");

const production = (process.argv.includes("--production") || process.env.NODE_ENV === "production") ? true : false;
const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const shared = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "warning",
    treeShaking: true,
    define: {
        "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
    },
    external: ["vscode"],
};

/** @type {esbuild.BuildOptions[]} */
const buildTargets = [
    {
        ...shared,
        platform: "node",
        format: "cjs",
        target: "node20",
        conditions: ["node"],
        external: [
            ...shared.external,
            "crypto",
            "path",
            "fs",
            "readline",
            "async_hooks",
            "node:crypto",
            "node:path",
            "node:fs",
            "node:readline",
            "node:async_hooks",
        ],
        outfile: "dist/extension.js",
        plugins: [createProblemMatcherPlugin("node")]
    },
    {
        ...shared,
        platform: "browser",
        format: "esm",
        target: ["chrome120", "firefox120", "safari17"],
        // Web build cannot include node-only deps (PostHog SDK, node builtins).
        // Keep these as externals so the web bundle can still build.
        external: [
            ...shared.external,
            "posthog-node",
            "crypto",
            "path",
            "fs",
            "readline",
            "async_hooks",
            "node:crypto",
            "node:path",
            "node:fs",
            "node:readline",
            "node:async_hooks",
        ],
        outfile: "dist/web/extension.js",
        plugins: [createProblemMatcherPlugin("web")],
        conditions: ["browser"],
    },
];

async function main() {
    const contexts = await Promise.all(buildTargets.map((opts) => esbuild.context(opts)));

    if (watch) {
        await Promise.all(contexts.map((ctx) => ctx.watch()));
    } else {
        await Promise.all(contexts.map((ctx) => ctx.rebuild()));
        await Promise.all(contexts.map((ctx) => ctx.dispose()));
    }
}

/**
 * @type {import('esbuild').Plugin}
 */
function createProblemMatcherPlugin(label) {
    /** @type {import('esbuild').Plugin} */
    return {
        name: `esbuild-problem-matcher-${label}`,
        setup(build) {
            build.onStart(() => {
                console.log(`[${label}] build started`);
            });
            build.onEnd((result) => {
                result.errors.forEach(({ text, location }) => {
                    console.error(`✘ [${label}] ${text}`);
                    if (!location) return;
                    console.error(`    ${location.file}:${location.line}:${location.column}:`);
                });
                console.log(`[${label}] build finished`);
            });
        },
    };
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
