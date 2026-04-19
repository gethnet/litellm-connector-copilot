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

const esbuild = require("esbuild");
const path = require("path");

const production = (process.argv.includes("--production") || process.env.NODE_ENV === "production") ? true : false;
const watch = process.argv.includes("--watch");
const generateSourceMaps = process.env.POSTHOG_SOURCEMAPS === "true" || !production;

/** @type {esbuild.BuildOptions} */
const shared = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    minify: production,
    sourcemap: generateSourceMaps ? "external" : false,
    sourcesContent: true,
    logLevel: "warning",
    treeShaking: true,
    define: {
        "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
    },
    external: ["vscode"],
    metafile: true,
};

/** @type {esbuild.BuildOptions[]} */
const buildTargets = [
    {
        ...shared,
        platform: "node",
        format: "cjs",
        target: "node20",
        outfile: "dist/extension.js",
        plugins: [createProblemMatcherPlugin("node")],
    },
    {
        ...shared,
        platform: "browser",
        format: "esm",
        target: ["chrome120", "firefox120", "safari17"],
        outfile: "dist/web/extension.js",
        plugins: [
            createProblemMatcherPlugin("web"),
            {
                name: "telemetry-web-swap",
                setup(build) {
                    build.onResolve({ filter: /\/posthogAdapter$/ }, (args) => {
                        if (args.path.endsWith("./posthogAdapter")) {
                            return {
                                path: path.join(args.resolveDir, "posthogAdapter.web.ts"),
                                external: false
                            };
                        }
                    });
                },
            },
        ],
        conditions: ["browser"],
    },
];

async function main() {
    console.log("Starting build targets...");
    const contexts = await Promise.all(buildTargets.map((opts) => esbuild.context(opts)));

    if (watch) {
        console.log("Watching for changes...");
        await Promise.all(contexts.map((ctx) => ctx.watch()));
    } else {
        console.log("Running rebuild...");
        await Promise.all(contexts.map((ctx) => ctx.rebuild()));
        console.log("Rebuild complete, disposing contexts...");
        await Promise.all(contexts.map((ctx) => ctx.dispose()));
        console.log("Done.");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
