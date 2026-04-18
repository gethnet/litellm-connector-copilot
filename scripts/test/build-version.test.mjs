#!/usr/bin/env node
/* global console, process */

/**
 * Unit tests for the version logic in build.mjs.
 * Run: node scripts/test/build-version.test.mjs
 */

import { parseVersion, formatVersion, bumpVersion, autoBump } from '../versionUtils.mjs';

// ── Tests ──

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
    if (actual === expected) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`);
        console.error(`     expected: ${expected}`);
        console.error(`     actual:   ${actual}`);
        failed++;
    }
}

console.log('Version bump tests:\n');

// Stable version bumps
assert('patch 1.0.0 → 1.0.1', bumpVersion('1.0.0', 'patch'), '1.0.1');
assert('minor 1.0.0 → 1.1.0', bumpVersion('1.0.0', 'minor'), '1.1.0');
assert('major 1.0.0 → 2.0.0', bumpVersion('1.0.0', 'major'), '2.0.0');

// Prerelease from stable
assert('patch:dev 1.0.0 → 1.0.1-dev1', bumpVersion('1.0.0', 'patch', 'dev'), '1.0.1-dev1');
assert('minor:beta 1.0.0 → 1.1.0-beta1', bumpVersion('1.0.0', 'minor', 'beta'), '1.1.0-beta1');
assert('major:pr 1.0.0 → 2.0.0-pr1', bumpVersion('1.0.0', 'major', 'pr'), '2.0.0-pr1');

// Prerelease increment
assert('patch:dev:inc 1.0.1-dev1 → 1.0.1-dev2', bumpVersion('1.0.1-dev1', 'patch', 'dev', 'inc'), '1.0.1-dev2');
assert('patch:dev:inc 1.0.1-dev3 → 1.0.1-dev4', bumpVersion('1.0.1-dev3', 'patch', 'dev', 'inc'), '1.0.1-dev4');

// Prerelease segment change resets suffixNum
assert('minor:dev from dev 1.0.1-dev3 → 1.1.0-dev1', bumpVersion('1.0.1-dev3', 'minor', 'dev'), '1.1.0-dev1');

// Auto bump (version:bump)
assert('auto bump stable 1.0.5 → 1.0.6', autoBump('1.0.5'), '1.0.6');
assert('auto bump prerelease 1.0.5-dev3 → 1.0.5-dev4', autoBump('1.0.5-dev3'), '1.0.5-dev4');

// Parse/format roundtrip
assert('parse+format roundtrip', formatVersion(parseVersion('1.2.3-beta5')), '1.2.3-beta5');
assert('parse+format no suffix', formatVersion(parseVersion('1.2.3')), '1.2.3');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
