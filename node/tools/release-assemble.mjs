#!/usr/bin/env node
// Assemble a release from what every build stashed, and refuse if any of it is missing.
//
// A release is all or nothing (Curtis, 2026-09-25): 0.1.10 shipped to Linux and Windows while its
// Mac build - compiled, notarized, then felled by one failed DNS lookup while uploading - never
// arrived, so the two platforms' updaters moved and the Mac's did not. Six of the nine tagged
// releases before this had some part fail. So no build job touches the GitHub release any more: each
// stashes its artifacts on the run, and the workflow's `publish` job - which runs only when every
// build, the server signing and the image all succeeded - calls this to lay them out, check the set
// is whole, and write the desktop updater's `latest.json` (which the builds used to race each other
// to rewrite in place). Only then does anything become visible.
//
//   node node/tools/release-assemble.mjs <tag> <artifacts dir> <out dir> [notes file]
//
// The artifacts dir is whatever the stashes unpacked to, in any layout; every file is found by its
// name. The out dir receives each file ONCE, flat, spaces turned to dots - the name GitHub would
// give the asset anyway, and the name `latest.json` must point at - plus `latest.json` itself.
// Exits non-zero, naming every missing piece, when the set is not whole.

import fs from 'node:fs';
import path from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY || 'cube-drone/ringtome';

/// Everything a release carries, by what it is. `updater` marks the files an installed copy
/// downloads to update itself: each must arrive with its `.sig`, or `latest.json` could not name it.
function expected(tag) {
    const full = tag.replace(/^v/, '');
    const version = full.split('-')[0];
    const v = version.replaceAll('.', '\\.');
    const f = full.replaceAll('.', '\\.');
    return [
        { what: 'the Mac disk image', pattern: new RegExp(`_${v}_universal\\.dmg$`) },
        { what: 'the Mac update', pattern: /_universal\.app\.tar\.gz$/, updater: true },
        { what: 'the Linux AppImage', pattern: new RegExp(`_${v}_amd64\\.AppImage$`), updater: true },
        { what: 'the Linux .deb', pattern: new RegExp(`_${v}_amd64\\.deb$`), updater: true },
        { what: 'the Linux .rpm', pattern: new RegExp(`-${v}-1\\.x86_64\\.rpm$`), updater: true },
        { what: 'the Windows .msi', pattern: new RegExp(`_${v}_x64_en-US\\.msi$`), updater: true },
        { what: 'the Windows installer', pattern: new RegExp(`_${v}_x64-setup\\.exe$`), updater: true },
        { what: 'the x86_64 server node', pattern: new RegExp(`^ringtome-server-${f}-linux-x86_64\\.tar\\.gz$`), updater: true, sha256: true },
        { what: 'the aarch64 server node', pattern: new RegExp(`^ringtome-server-${f}-linux-aarch64\\.tar\\.gz$`), updater: true, sha256: true },
        { what: 'the server manifest', pattern: /^server-latest\.json$/ },
    ];
}

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
    });
}

/// Lay the artifacts out flat under `out`. Returns the set of names, or the problems.
function gather(artifacts, out) {
    const names = new Map();
    const problems = [];
    for (const file of walk(artifacts)) {
        const name = path.basename(file).replaceAll(' ', '.');
        if (names.has(name)) {
            problems.push(`two artifacts would both be ${name}: ${names.get(name)} and ${file}`);
            continue;
        }
        names.set(name, file);
    }
    fs.mkdirSync(out, { recursive: true });
    for (const [name, file] of names) fs.copyFileSync(file, path.join(out, name));
    return { names: new Set(names.keys()), problems };
}

/// The desktop updater's manifest, in the shape tauri-action wrote (checked against the
/// `latest.json` of 0.1.7, the last release every platform reached): the plain `<os>-<arch>` keys
/// an older updater reads, and the `-<installer>` keys a newer one prefers.
function latestJson(tag, out, found, notes) {
    const version = tag.replace(/^v/, '').split('-')[0];
    const entry = (what) => ({
        signature: fs.readFileSync(path.join(out, `${found[what]}.sig`), 'utf8').trim(),
        url: `https://github.com/${REPO}/releases/download/${tag}/${found[what]}`,
    });
    const mac = entry('the Mac update');
    const appImage = entry('the Linux AppImage');
    const msi = entry('the Windows .msi');
    return {
        version,
        notes,
        pub_date: new Date().toISOString(),
        platforms: {
            'darwin-aarch64': mac,
            'darwin-aarch64-app': mac,
            'darwin-x86_64': mac,
            'darwin-x86_64-app': mac,
            'linux-x86_64': appImage,
            'linux-x86_64-appimage': appImage,
            'linux-x86_64-deb': entry('the Linux .deb'),
            'linux-x86_64-rpm': entry('the Linux .rpm'),
            'windows-x86_64': msi,
            'windows-x86_64-msi': msi,
            'windows-x86_64-nsis': entry('the Windows installer'),
        },
    };
}

export function assemble(tag, artifacts, out, notes) {
    const { names, problems } = gather(artifacts, out);
    const found = {};
    for (const want of expected(tag)) {
        const hits = [...names].filter((n) => want.pattern.test(n));
        if (hits.length !== 1) {
            problems.push(`${want.what}: expected one file, found ${hits.length ? hits.join(', ') : 'none'}`);
            continue;
        }
        found[want.what] = hits[0];
        if (want.updater && !names.has(`${hits[0]}.sig`)) problems.push(`${want.what}: ${hits[0]} has no .sig (is TAURI_SIGNING_PRIVATE_KEY set?)`);
        if (want.sha256 && !names.has(`${hits[0]}.sha256`)) problems.push(`${want.what}: ${hits[0]} has no .sha256`);
    }
    if (problems.length) return { problems };
    const latest = latestJson(tag, out, found, notes);
    fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
    return { problems, found, latest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [tag, artifacts, out, notesFile] = process.argv.slice(2);
    if (!tag || !artifacts || !out) {
        console.error('usage: release-assemble.mjs <tag> <artifacts dir> <out dir> [notes file]');
        process.exit(2);
    }
    const notes = notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : '';
    const { problems, found } = assemble(tag, artifacts, out, notes);
    if (problems.length) {
        console.error(`not releasing ${tag} - the set is not whole:`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
    }
    console.log(`${tag} is whole:`);
    for (const [what, name] of Object.entries(found)) console.log(`  ${what}: ${name}`);
    console.log(`  and latest.json, for the desktop updater`);
}
