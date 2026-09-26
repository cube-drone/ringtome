#!/usr/bin/env node
// Cut a release: bump every version in step, write the notes, commit, tag, push.
//
// The tag is what starts the expensive half (DESKTOP.md, Stage 4) - a full optimized build of four
// targets, signed, notarized, and pushed at every installed copy as a whole new application - so the
// act of making one should be deliberate, should be one command, and should never be something a
// push to main can do by accident. Hence: tags, made here, by hand, on purpose.
//
//   node tools/release.mjs minor            # 0.0.1 -> 0.1.0, asks before it acts
//   node tools/release.mjs micro --dry-run  # says what it would do and touches nothing
//   node tools/release.mjs major --yes      # for the fifth time today
//
// The version stays strict semver everywhere a toolchain reads it and the NAME rides alongside in
// the tag and the title - see js/pure/releasename.js for why that split is not decoration.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { bumpVersion, parseVersion, releaseName } from '../js/pure/releasename.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/// Every file that spells the version, and how to find it in each. One release, one number: a
/// desktop bundle whose Cargo version disagrees with its `tauri.conf.json` version is two answers
/// to "what is running", and the updater believes the wrong one.
const VERSIONED = [
    { file: 'node/Cargo.toml', find: /^version = "([^"]+)"$/m, source: true },
    { file: 'proto/Cargo.toml', find: /^version = "([^"]+)"$/m },
    { file: 'supervisor/Cargo.toml', find: /^version = "([^"]+)"$/m },
    { file: 'desktop/Cargo.toml', find: /^version = "([^"]+)"$/m },
    { file: 'desktop/tauri.conf.json', find: /"version": "([^"]+)"/ },
    { file: 'node/js/package.json', find: /"version": "([^"]+)"/ },
];

// Deliberately NOT bumped: `spike-tauri/` (a spike, pinned at 0.0.0) and `node/integration/package.json`
// (a test harness that ships to nobody). A version means "what a
// user is running"; nothing there is run by a user.

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function currentVersion() {
    const source = VERSIONED.find((v) => v.source);
    const found = source.find.exec(read(source.file));
    if (!found) throw new Error(`no version found in ${source.file}`);
    return found[1];
}

/// Refuse to release from a tree that is not exactly what is on the remote. A release is a promise
/// that this commit is what people are running; it cannot be kept from a dirty tree, a side branch,
/// or a commit that never reached the remote.
function insist(dryRun) {
    // A dry run answers "what would this do", which has to be answerable from whatever tree you
    // happen to be standing in - so it warns where a real release refuses.
    const complain = (message) => {
        if (dryRun) {
            console.warn(`  (dry run) would refuse: ${message}`);
            return;
        }
        throw new Error(message);
    };
    const dirty = git('status', '--porcelain');
    if (dirty) {
        complain(`the tree has uncommitted changes:\n${dirty}\n  commit or stash them first.`);
    }
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch !== 'main') {
        complain(`on branch ${branch}; releases are cut from main.`);
    }
    if (dryRun) return;
    git('fetch', '--tags', '--quiet');
    const behind = git('rev-list', '--count', 'HEAD..@{upstream}');
    if (behind !== '0') {
        throw new Error(`${behind} commit(s) on the remote are not here; pull first.`);
    }
}

/// The newest release tag, or null on the first release ever.
function lastTag() {
    const tags = git('tag', '--list', 'v*', '--sort=-creatordate');
    return tags ? tags.split('\n')[0].trim() : null;
}

/// What has happened since the last release, in the words the commits used. A release's notes are
/// the one part of this that a person reads, so they are subjects rather than hashes, merges are
/// dropped (they say nothing a human wants), and the previous release commits with them.
function notesSince(tag) {
    if (!tag) return 'initial';
    const range = `${tag}..HEAD`;
    const log = git('log', range, '--no-merges', '--pretty=format:%s');
    const lines = log
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !/^release \d+\.\d+\.\d+/.test(l));
    if (lines.length === 0) return 'no changes recorded since the last release';
    const CAP = 200;
    const shown = lines.slice(0, CAP).map((l) => `- ${l}`);
    if (lines.length > CAP) shown.push(`- ...and ${lines.length - CAP} more`);
    return shown.join('\n');
}

/// Write the new number into every file that spells it, and say which changed.
function writeVersions(next, dryRun) {
    const touched = [];
    for (const spot of VERSIONED) {
        const full = path.join(ROOT, spot.file);
        const before = fs.readFileSync(full, 'utf8');
        const found = spot.find.exec(before);
        if (!found) throw new Error(`no version found in ${spot.file}`);
        const after = before.replace(found[0], found[0].replace(found[1], next));
        if (after !== before) {
            if (!dryRun) fs.writeFileSync(full, after);
            touched.push(`${spot.file} (${found[1]} -> ${next})`);
        }
    }
    return touched;
}

/// Pin the migration rungs this release ships (node/src/migrations.rs): every rung already in
/// `released.txt` must still hash the same - a release is refused rather than ship an edited rung
/// to machines that already climbed the old one - and every rung not yet listed is appended,
/// which freezes it from here on. Lines are only ever added, never rewritten.
const PINS = 'node/migrations/released.txt';
function pinMigrations(dryRun) {
    const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'node/migrations', file))).digest('hex');
    const text = read(PINS);
    const pinned = new Map();
    for (const line of text.split('\n').map((l) => l.trim())) {
        if (!line || line.startsWith('#')) continue;
        const [file, hash] = line.split(/\s+/);
        pinned.set(file, hash);
    }
    for (const [file, hash] of pinned) {
        if (!fs.existsSync(path.join(ROOT, 'node/migrations', file))) {
            throw new Error(`released migration ${file} is gone; a shipped rung is never deleted.`);
        }
        if (sha256(file) !== hash) {
            throw new Error(`released migration ${file} has changed since it shipped; put it back and write the change as a new rung.`);
        }
    }
    const fresh = [];
    for (const kind of ['node', 'user']) {
        const dir = path.join(ROOT, 'node/migrations', kind);
        for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
            const file = `${kind}/${name}`;
            if (!pinned.has(file)) fresh.push(`${file} ${sha256(file)}`);
        }
    }
    if (fresh.length && !dryRun) {
        fs.writeFileSync(path.join(ROOT, PINS), text.replace(/\n*$/, '\n') + fresh.join('\n') + '\n');
    }
    return fresh.map((l) => l.split(' ')[0]);
}

/// The lockfiles carry our own crates' versions, so a release that did not refresh them would
/// leave the next `cargo` command with a diff to commit. Two workspaces, because the desktop shell
/// is its own (DESKTOP.md, Stage 2).
function refreshLocks(dryRun) {
    if (dryRun) return;
    for (const dir of ['.', 'desktop']) {
        try {
            execFileSync('cargo', ['metadata', '--format-version', '1', '--offline'], {
                cwd: path.join(ROOT, dir),
                stdio: 'ignore',
            });
        } catch {
            // Offline resolution can fail on a cold cache; online is the fallback, and a lockfile
            // left stale is a nuisance rather than a broken release.
            try {
                execFileSync('cargo', ['metadata', '--format-version', '1'], {
                    cwd: path.join(ROOT, dir),
                    stdio: 'ignore',
                });
            } catch {
                console.warn(`  (could not refresh ${dir}/Cargo.lock - check it by hand)`);
            }
        }
    }
}

try {
    await main();
} catch (e) {
    console.error(`\nerror: ${e.message}\n`);
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    const part = args.find((a) => !a.startsWith('-')) || 'minor';
    const dryRun = args.includes('--dry-run') || args.includes('-n');
    const assumeYes = args.includes('--yes') || args.includes('-y');

    const from = currentVersion();
    if (!parseVersion(from)) throw new Error(`the current version is not a version: ${from}`);
    const next = bumpVersion(from, part);
    const name = releaseName(next);
    const tag = `v${next}-${name}`;

    insist(dryRun);
    if (git('tag', '--list', tag)) throw new Error(`the tag ${tag} already exists.`);

    const since = lastTag();
    const notes = notesSince(since);
    const subject = `release ${next} - ${name}`;

    console.log(`\n  ${from}  ->  ${next}-${name}`);
    console.log(`  tag:   ${tag}`);
    console.log(`  since: ${since || 'the beginning'}\n`);
    console.log(notes.split('\n').map((l) => `    ${l}`).join('\n'));
    console.log('');

    const touched = writeVersions(next, dryRun);
    for (const t of touched) console.log(`  ${dryRun ? 'would write' : 'wrote'} ${t}`);
    const rungs = pinMigrations(dryRun);
    for (const r of rungs) console.log(`  ${dryRun ? 'would freeze' : 'froze'} migration ${r}`);
    if (rungs.length === 0) console.log('  no new migrations to freeze');

    if (dryRun) {
    console.log('\n  --dry-run: nothing written, nothing committed, nothing pushed.\n');
    process.exit(0);
}

    if (!assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\n  release ${next}-${name}? this builds, signs and ships. [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
        for (const spot of VERSIONED) git('checkout', '--', spot.file);
        git('checkout', '--', PINS);
        console.log('  nothing released; the version files are back as they were.');
        process.exit(1);
    }
}

    refreshLocks(dryRun);
    git('add', '--all');
    git('commit', '-m', `${subject}\n\n${notes}`);
    git('tag', '-a', tag, '-m', `${subject}\n\n${notes}`);
    git('push', '--follow-tags');
    console.log(`\n  released ${next}-${name}. The build is running; watch it on GitHub.\n`);
}
