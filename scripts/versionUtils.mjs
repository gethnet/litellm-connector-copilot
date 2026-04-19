/**
 * Version utilities shared between build scripts and tests.
 */

/**
 * Parse a semver-style string with optional prerelease suffix and numeric suffix.
 * Examples: 1.2.3, 1.2.3-dev1, 1.2.3-beta5
 */
export function parseVersion(ver) {
    const m = ver.match(/^(\d+)\.(\d+)\.(\d+)(-([a-zA-Z]+)(\d+)?)?$/);
    if (!m) {
        throw new Error(`Invalid version: ${ver}`);
    }
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        suffix: m[5] || null,
        suffixNum: m[6] ? Number(m[6]) : null,
    };
}

export function formatVersion({ major, minor, patch, suffix, suffixNum }) {
    let v = `${major}.${minor}.${patch}`;
    if (suffix) {
        v += `-${suffix}${suffixNum ?? ''}`;
    }
    return v;
}

export function bumpVersion(current, segment, prerelease, mode = 'bump') {
    const cur = parseVersion(current);
    let next = { ...cur };

    if (mode === 'inc' && cur.suffix === prerelease) {
        // Increment-only mode: bump suffixNum, do NOT touch major/minor/patch
        next.suffixNum = (cur.suffixNum || 0) + 1;
    } else {
        if (segment === 'major') {
            next.major += 1;
            next.minor = 0;
            next.patch = 0;
        } else if (segment === 'minor') {
            next.minor += 1;
            next.patch = 0;
        } else if (segment === 'patch') {
            next.patch += 1;
        }

        if (prerelease) {
            next.suffix = prerelease;
            next.suffixNum = 1;
        } else {
            next.suffix = null;
            next.suffixNum = null;
        }
    }

    return formatVersion(next);
}

export function autoBump(current) {
    const cur = parseVersion(current);
    let next = { ...cur };
    if (cur.suffix !== null && cur.suffixNum !== null) {
        next.suffixNum = cur.suffixNum + 1;
    } else {
        next.patch += 1;
    }
    return formatVersion(next);
}
