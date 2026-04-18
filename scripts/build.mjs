#!/usr/bin/env node
/* global console, process */

/**
 * Unified build script for litellm-connector-copilot.
 *
 * Usage:
 *   zx scripts/build.mjs [command] [options]
 *
 * Commands:
 *   (default)           Full build: lint + format check + typecheck + esbuild
 *   dev                 Dev build: typecheck + esbuild (no lint/format)
 *   ci                  CI pipeline: lint + format + test:coverage + package:marketplace
 *   package             Package for marketplace (strip proposals, swap README)
 *   package:dev         Package for dev/test (no stripping)
 *   validate            Post-session validation (format + lint + test:coverage)
 *   update:check        Check for dependency updates (npm outdated + check npm registry)
 *   upgrade             Full upgrade of all dependencies
 *   upgrade:npm         Upgrade npm/node dependencies only
 *   upgrade:vsc         Upgrade VS Code engine + @types/vscode
 *   upgrade:ci          Upgrade CI workflow action versions
 *   version             Show current version
 *   version:set <ver>   Set version to exact string
 *
 *   Prefix any command with --dry-run to see what would happen.
 */

import { $, fs, path, argv, glob } from 'zx';
import { parseVersion, formatVersion } from './versionUtils.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');

function readPkg() {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function writePkg(data) {
    fs.writeFileSync(pkgPath, JSON.stringify(data, null, '\t') + '\n');
}

function logStep(msg) {
    console.log(`\n▸ ${msg}\n`);
}

// ─── Version Commands ────────────────────────────────────────────────────────

function handleVersionCommand(args) {
    const pkg = readPkg();
    const subcmd = args[0];

    if (!subcmd) {
        console.log(pkg.version);
        return;
    }

    if (subcmd === 'set') {
        const target = args[1];
        if (!target || !/^\d+\.\d+\.\d+(-\w+\d*)?$/.test(target)) {
            throw new Error(`Invalid version string: ${target}`);
        }
        const old = pkg.version;
        pkg.version = target;
        writePkg(pkg);
        console.log(`Version set: ${old} → ${target}`);
        return;
    }

    // Parse: version:<segment>[:<prerelease>[:<mode>]]
    // segment: major | minor | patch
    // prerelease: dev | beta | pr
    // mode: bump (default) | inc
    const [segment, prerelease, mode = 'bump'] = subcmd.split(':');

    if (!['major', 'minor', 'patch'].includes(segment)) {
        throw new Error(`Unknown version segment: ${segment}. Use major, minor, or patch.`);
    }

    const cur = parseVersion(pkg.version);
    let next = { ...cur };

    if (mode === 'inc' && cur.suffix === prerelease) {
        // Increment-only mode: bump suffixNum, do NOT touch major/minor/patch
        next.suffixNum = (cur.suffixNum || 0) + 1;
    } else {
        if (segment === 'major') {
            next.major++;
            next.minor = 0;
            next.patch = 0;
        } else if (segment === 'minor') {
            next.minor++;
            next.patch = 0;
        } else if (segment === 'patch') {
            next.patch++;
        }

        if (prerelease) {
            if (!['dev', 'beta', 'pr'].includes(prerelease)) {
                throw new Error(`Unknown prerelease: ${prerelease}. Use dev, beta, or pr.`);
            }
            next.suffix = prerelease;
            next.suffixNum = 1;
        } else {
            next.suffix = null;
            next.suffixNum = null;
        }
    }

    const oldVer = pkg.version;
    const newVer = formatVersion(next);
    pkg.version = newVer;
    writePkg(pkg);
    console.log(`Version bumped: ${oldVer} → ${newVer}`);
}

function handleVersionBump() {
    // Increment the last numeric segment (patch if stable, suffixNum if prerelease)
    const pkg = readPkg();
    const cur = parseVersion(pkg.version);
    let next = { ...cur };

    if (cur.suffix && cur.suffixNum !== null) {
        next.suffixNum = cur.suffixNum + 1;
    } else {
        next.patch++;
    }

    const oldVer = pkg.version;
    const newVer = formatVersion(next);
    pkg.version = newVer;
    writePkg(pkg);
    console.log(`Version bumped: ${oldVer} → ${newVer}`);
}

// ─── Build Steps ─────────────────────────────────────────────────────────────

async function stepLint() {
    logStep('Linting...');
    await $`npx eslint`;
}

async function stepFormatCheck() {
    logStep('Checking formatting...');
    await $`npx prettier --check .`;
}

async function stepTypecheck() {
    logStep('Type checking...');
    await $`npx tsc --noEmit`;
}

async function stepEsbuild(production = false) {
    logStep(`Building${production ? ' (production)' : ''}...`);
    const args = production ? ['--production'] : [];
    await $`node esbuild.js ${args}`;
}

async function stepTest() {
    logStep('Running tests...');
    await $`xvfb-run npx vscode-test --args="--no-sandbox"`;
}

async function stepTestCoverage() {
    logStep('Running tests with coverage...');
    const testResultsDir = path.join(ROOT, 'test-results');
    await $`mkdir -p ${testResultsDir}`;

    const coveragePath = path.join(ROOT, 'coverage');
    if (fs.existsSync(coveragePath)) {
        fs.rmSync(coveragePath, { recursive: true, force: true });
    }

    await $({
        env: { ...process.env, VSCODE_TEST_RESULTS_DIR: testResultsDir },
    })`xvfb-run npx vscode-test --args="--no-sandbox" --coverage --coverage-output coverage --coverage-reporter lcovonly --coverage-reporter html --coverage-reporter text-summary`;
}

async function stepClean(what = 'all') {
    logStep(`Cleaning (${what})...`);
    if (what === 'all' || what === 'build') {
        await $`rm -rf dist out`;
    }
    if (what === 'all' || what === 'tests') {
        await $`rm -rf coverage test-results`;
    }
}

async function stripProposals() {
    logStep('Stripping enabledApiProposals for marketplace build...');
    const pkg = readPkg();
    delete pkg.enabledApiProposals;
    writePkg(pkg);
}

async function restoreProposals(proposals) {
    logStep('Restoring enabledApiProposals...');
    const pkg = readPkg();
    pkg.enabledApiProposals = proposals;
    writePkg(pkg);
}

async function stepVscePackage(production = false) {
    logStep(`Packaging VSIX${production ? ' (production)' : ''}...`);
    const args = production ? [] : [];
    await $`npx vsce package ${args}`;
}

async function swapReadme(mode) {
    if (mode === 'marketplace') {
        logStep('Swapping README for marketplace...');
        await $`cp README.md README.github.md`;
        await $`cp README.marketplace.md README.md`;
    } else if (mode === 'restore') {
        logStep('Restoring README...');
        await $`cp README.github.md README.md`;
        await $`rm README.github.md`;
    }
}

// ─── Update/Upgrade Commands ─────────────────────────────────────────────────

async function updateCheck() {
    logStep('Checking for dependency updates...');
    try {
        await $`npm outdated || true`;
    } catch {
        // npm outdated exits 1 when outdated deps exist
    }

    // Check for npm registry updates
    logStep('Checking npm registry...');
    await $`npm view vscode versions --json | tail -5`;

    // Check @vscode/dts latest
    await $`npm view @vscode/dts version`;
}

async function upgradeNpm() {
    logStep('Upgrading npm dependencies...');
    await $`npm update`;
    await $`npm install`;
}

async function upgradeVsc() {
    logStep('Upgrading VS Code types...');
    await $`npm update @types/vscode @vscode/dts`;
    await $`npm run postinstall`;
}

async function upgradeCi() {
    logStep('Checking CI workflow action versions...');
    const workflowDir = path.join(ROOT, '.github/workflows');
    const files = await glob('*.yml', { cwd: workflowDir });
    for (const f of files) {
        const content = fs.readFileSync(path.join(workflowDir, f), 'utf8');
        const uses = [...content.matchAll(/uses:\s*(\S+@\S+)/g)];
        for (const match of uses) {
            console.log(`  ${f}: ${match[1]}`);
        }
    }
    console.log('\n  ℹ️  Review these versions and update manually in workflow files.');
}

// ─── Post-session Validation ─────────────────────────────────────────────────

async function postSessionValidation() {
    logStep('Running post-session validation...');
    await $`bash scripts/post-session-validation.sh`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const cmd = argv._[0] || 'build';
    const dryRun = argv['dry-run'] || false;

    if (dryRun) {
        console.log(`[dry-run] Would execute: ${cmd}`);
        return;
    }

    $.cwd = ROOT;

    switch (cmd) {
        // ── Build commands ──
        case 'build': {
            await stepClean('build');
            await stepLint();
            await stepFormatCheck();
            await stepTypecheck();
            await stepEsbuild(true);
            break;
        }
        case 'dev': {
            await stepClean('build');
            await stepTypecheck();
            await stepEsbuild(false);
            break;
        }
        case 'ci': {
            await stepClean('all');
            await stepLint();
            await stepFormatCheck();
            await stepTestCoverage();
            // Marketplace build: strip proposals + swap readme
            const savedProposals = readPkg().enabledApiProposals;
            try {
                await stripProposals();
                await swapReadme('marketplace');
                await stepTypecheck();
                await stepEsbuild(true);
                await stepVscePackage(true);
            } finally {
                await restoreProposals(savedProposals);
                await swapReadme('restore');
            }
            break;
        }
        case 'package': {
            const savedProposals = readPkg().enabledApiProposals;
            try {
                await stripProposals();
                await swapReadme('marketplace');
                await stepClean('build');
                await stepTypecheck();
                await stepEsbuild(true);
                await stepVscePackage(true);
            } finally {
                await restoreProposals(savedProposals);
                await swapReadme('restore');
            }
            break;
        }
        case 'package:dev': {
            await stepClean('build');
            await stepTypecheck();
            await stepEsbuild(false);
            await stepVscePackage(false);
            break;
        }
        case 'test': {
            await stepClean('tests');
            await stepTest();
            break;
        }
        case 'test:coverage': {
            await stepClean('tests');
            await stepTestCoverage();
            break;
        }
        case 'validate': {
            await postSessionValidation();
            break;
        }

        // ── Version commands ──
        case 'version': {
            handleVersionCommand(argv._.slice(1));
            break;
        }
        case 'version:set': {
            handleVersionCommand(['set', argv._[1]]);
            break;
        }
        case 'version:bump': {
            handleVersionBump();
            break;
        }

        // ── Update/upgrade commands ──
        case 'update:check': {
            await updateCheck();
            break;
        }
        case 'upgrade': {
            await upgradeNpm();
            await upgradeVsc();
            await upgradeCi();
            break;
        }
        case 'upgrade:npm': {
            await upgradeNpm();
            break;
        }
        case 'upgrade:vsc': {
            await upgradeVsc();
            break;
        }
        case 'upgrade:ci': {
            await upgradeCi();
            break;
        }

        // ── Utility ──
        case 'lint': {
            await stepLint();
            break;
        }
        case 'format': {
            logStep('Formatting...');
            await $`npx prettier --write .`;
            break;
        }
        case 'format:check': {
            await stepFormatCheck();
            break;
        }

        default: {
            console.error(`Unknown command: ${cmd}`);
            console.error('Available commands: build, dev, ci, package, package:dev, test, test:coverage, validate, version, version:set, version:bump, update:check, upgrade, upgrade:npm, upgrade:vsc, upgrade:ci, lint, format, format:check');
            process.exit(1);
        }
    }

    console.log('\n✅ Done.');
}

main().catch((err) => {
    console.error(`\n❌ Failed: ${err.message}`);
    process.exit(1);
});
