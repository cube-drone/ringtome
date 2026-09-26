#!/usr/bin/env node
// What HISTORY.md gained since the last release, for the release page (Curtis, 2026-09-25).
//
// HISTORY.md is append-only, so the lines a release added to it are the lines `git diff` marks
// with `+` - the entries themselves, in order. The release workflow's `publish` job runs this over
// `git diff <previous tag> <this tag> -- HISTORY.md` and puts the result under the notes. Mechanical
// on purpose: no summarizing, nothing in the pipeline that calls a model.
//
// GitHub caps a release's text at 125,000 characters, so a long gap keeps only its NEWEST
// `limit` characters, cut at an entry's heading where one falls inside the kept part (at a line
// otherwise), with a pointer to the file for the rest.
//
//   git diff v0.1.10-cape-jab v0.1.11-x -- HISTORY.md | node node/tools/release-history.mjs <tag> [limit]

import fs from 'node:fs';

export const DEFAULT_LIMIT = 80_000;

/// The added text of a unified diff: `+` lines, minus the `+++` file header, prefix removed.
export function added(diff) {
    return diff
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .map((line) => line.slice(1))
        .join('\n')
        .trim();
}

/// The release page's section, or '' when HISTORY gained nothing.
export function historySection(diff, historyUrl, limit = DEFAULT_LIMIT) {
    let text = added(diff);
    if (!text) return '';
    let note = '';
    if (text.length > limit) {
        text = text.slice(-limit);
        const heading = text.indexOf('\n## ');
        const line = text.indexOf('\n');
        text = text.slice((heading >= 0 ? heading : line) + 1);
        note = `_The newest entries only; the rest since the last release are in [HISTORY.md](${historyUrl})._\n\n`;
    }
    return `### What happened (from HISTORY.md)\n\n${note}${text}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [tag, limit] = process.argv.slice(2);
    if (!tag) {
        console.error('usage: git diff <previous tag> <tag> -- HISTORY.md | release-history.mjs <tag> [limit]');
        process.exit(2);
    }
    const repo = process.env.GITHUB_REPOSITORY || 'cube-drone/ringtome';
    const diff = fs.readFileSync(0, 'utf8');
    process.stdout.write(historySection(diff, `https://github.com/${repo}/blob/${tag}/HISTORY.md`, limit ? Number(limit) : DEFAULT_LIMIT));
}
