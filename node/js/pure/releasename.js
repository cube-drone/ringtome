// What a release is called, and what the next one's number is.
//
// Every release gets a NAME as well as a number (Curtis, 2026-09-22): `0.1.0` is what the machines
// compare and `lady-smirk` is what people say out loud - "the lady-smirk build" - which is the
// difference between a release you can talk about and a number nobody remembers. The words come
// from the same pinned list the speakable addresses and the test-data personas draw on, so the
// whole system sounds like one thing.
//
// The name is DERIVED from the version rather than drawn at random, which matters more than it
// looks: a release's name is in its tag forever, and a name that had to be stored somewhere is a
// name that can disagree with what is in the tag. Same version, same name, on any machine, forever.
//
// The number stays strict semver everywhere a toolchain reads it. `0.1.0-lady-smirk` would be a
// semver PRERELEASE - it sorts *before* `0.1.0`, so mixing decorated and undecorated versions would
// order releases wrongly - and macOS requires `CFBundleShortVersionString` to be at most three
// integers, which a word breaks outright. So the name rides in the tag, the release title and the
// notes, and never in the version field.
import { WORDS } from './words.js';

/// A version string, taken apart. Returns null for anything that is not `major.minor.patch`.
export function parseVersion(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec((version || '').trim());
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/// The next version, by part. A major bump zeroes the minor and the patch, a minor bump zeroes the
/// patch: the ordinary semver rule, spelled out because the alternative is a release numbered
/// `1.4.7` that nobody meant.
export function bumpVersion(version, part) {
    const at = parseVersion(version);
    if (!at) throw new Error(`not a version: ${version}`);
    if (part === 'major') return `${at.major + 1}.0.0`;
    if (part === 'minor') return `${at.major}.${at.minor + 1}.0`;
    if (part === 'micro' || part === 'patch') return `${at.major}.${at.minor}.${at.patch + 1}`;
    throw new Error(`not a release part: ${part}`);
}

/// A stable 32-bit hash of a string (FNV-1a). Not a security primitive and not trying to be: it
/// exists so that a version string picks the same two words on every machine.
function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/// The name for a version: two distinct words from the pinned list, chosen by the version itself.
/// The second word is picked from a different part of the hash, and nudged along if the two
/// collide - the same "walk one forward" the test-data namer uses, for the same reason.
export function releaseName(version) {
    const h = hash32(`ringtome/${version}`);
    const first = h % WORDS.length;
    let second = ((h >>> 16) * 2654435761) % WORDS.length;
    if (second === first) second = (second + 1) % WORDS.length;
    return `${WORDS[first]}-${WORDS[second]}`;
}

/// What a release is called in full, for a tag or a title: `0.1.0-lady-smirk`.
export const releaseTag = (version) => `${version}-${releaseName(version)}`;

/// Where a release's notes live: its GitHub release page, by the tag `just release-*` pushed
/// (`v` + the full name - node/tools/release.mjs). The UI's version link opens it.
export const releaseUrl = (version) => `https://github.com/cube-drone/ringtome/releases/tag/v${releaseTag(version)}`;
