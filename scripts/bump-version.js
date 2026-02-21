#!/usr/bin/env node
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");

const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

// Get the version bump type from command line args (patch, minor, major, dev)
const args = process.argv.slice(2);
const isDevRequested = args.includes("dev");
const bumpType = args.find((arg) => ["patch", "minor", "major"].includes(arg)) || (isDevRequested ? "none" : "patch");

if (!["patch", "minor", "major", "none"].includes(bumpType) && !isDevRequested) {
    console.error("Usage: npm run bump-version [patch|minor|major] [dev]");
    console.error("  patch: 0.1.0 -> 0.1.1");
    console.error("  minor: 0.1.0 -> 0.2.0");
    console.error("  major: 0.1.0 -> 1.0.0");
    console.error("  dev:   0.1.0 -> 0.1.0-dev1 (or increments -devN if present)");
    console.error("  patch dev: 0.1.0 -> 0.1.1-dev1");
    process.exit(1);
}

// Parse current version
const versionMatch = packageJson.version.match(/^(\d+)\.(\d+)\.(\d+)(-dev(\d+)?)?$/);
if (!versionMatch) {
    console.error(`Invalid version format in package.json: ${packageJson.version}`);
    process.exit(1);
}

const major = parseInt(versionMatch[1]);
const minor = parseInt(versionMatch[2]);
const patch = parseInt(versionMatch[3]);
const isCurrentlyDev = !!versionMatch[4];
const currentDevNumber = versionMatch[5] ? parseInt(versionMatch[5]) : isCurrentlyDev ? 0 : null;

// Calculate new version
let nextMajor = major;
let nextMinor = minor;
let nextPatch = patch;
let nextDevNumber = null;

if (isDevRequested) {
    if (bumpType === "none" && isCurrentlyDev) {
        // Just increment dev number if no major/minor/patch bump requested
        nextDevNumber = (currentDevNumber || 0) + 1;
    } else {
        // New dev cycle
        nextDevNumber = 1;
    }
}

switch (bumpType) {
    case "major":
        nextMajor++;
        nextMinor = 0;
        nextPatch = 0;
        break;
    case "minor":
        nextMinor++;
        nextPatch = 0;
        break;
    case "patch":
        nextPatch++;
        break;
}

let newVersion = `${nextMajor}.${nextMinor}.${nextPatch}`;
if (isDevRequested) {
    newVersion += `-dev${nextDevNumber || 1}`;
}

// Update package.json
const oldVersion = packageJson.version;
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, "\t") + "\n");
console.log(`Version bumped: ${oldVersion} -> ${newVersion}`);

// Return the new version for use in scripts
process.stdout.write(`${oldVersion} -> ${newVersion}`);
