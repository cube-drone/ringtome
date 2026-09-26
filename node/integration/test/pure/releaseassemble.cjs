/*
    Releases are all or nothing (Curtis, 2026-09-25; node/tools/release-assemble.mjs). The builds
    only stash their artifacts, and the release workflow's `publish` job lays them out, refuses an
    incomplete set, and writes the desktop updater's `latest.json` - which tauri-action used to write,
    racing itself once per platform.

    The invariant worth pinning is that nothing changes for an installed app: laid out the way the
    bundler names things (spaces and all, and the Mac update with no architecture - names copied from
    the real stashes of 0.1.12's run, not from a release page), 0.1.7's artifacts - the last release every platform
    reached - with 0.1.7's real signatures must assemble into exactly the `latest.json` tauri-action
    published for it (`fixtures/latest-0.1.7.json`): every key, every URL, every signature.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TAG = 'v0.1.7-cloth-vowel';
const PUBLISHED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'latest-0.1.7.json'), 'utf8'));

let assemble;
before(async () => {
    ({ assemble } = await import('../../../tools/release-assemble.mjs'));
});

/// Where each file sits in the stashes, under the name the bundler gives it, and which published
/// platform key's signature is its `.sig`.
const DESKTOP = [
    ['desktop-macos-latest/universal-apple-darwin/release/bundle/dmg', 'Horse Drawing Tycoon 2_0.1.7_universal.dmg', null],
    // The bundler's own name, WITHOUT the `_universal` the release page shows: tauri-action added
    // that on upload (0.1.12 found out the hard way - see release-assemble.mjs, `publishedName`).
    ['desktop-macos-latest/universal-apple-darwin/release/bundle/macos', 'Horse Drawing Tycoon 2.app.tar.gz', 'darwin-aarch64'],
    ['desktop-ubuntu-22.04/release/bundle/appimage', 'Horse Drawing Tycoon 2_0.1.7_amd64.AppImage', 'linux-x86_64-appimage'],
    ['desktop-ubuntu-22.04/release/bundle/deb', 'Horse Drawing Tycoon 2_0.1.7_amd64.deb', 'linux-x86_64-deb'],
    ['desktop-ubuntu-22.04/release/bundle/rpm', 'Horse Drawing Tycoon 2-0.1.7-1.x86_64.rpm', 'linux-x86_64-rpm'],
    ['desktop-windows-latest/release/bundle/msi', 'Horse Drawing Tycoon 2_0.1.7_x64_en-US.msi', 'windows-x86_64-msi'],
    ['desktop-windows-latest/release/bundle/nsis', 'Horse Drawing Tycoon 2_0.1.7_x64-setup.exe', 'windows-x86_64-nsis'],
];

function stashes(leaveOut = () => false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-assemble-'));
    const artifacts = path.join(root, 'artifacts');
    for (const [dir, name, key] of DESKTOP) {
        const full = path.join(artifacts, dir);
        fs.mkdirSync(full, { recursive: true });
        if (!leaveOut(name)) fs.writeFileSync(path.join(full, name), 'the bytes');
        if (key && !leaveOut(`${name}.sig`)) fs.writeFileSync(path.join(full, `${name}.sig`), PUBLISHED.platforms[key].signature);
    }
    const server = path.join(artifacts, 'server-release');
    fs.mkdirSync(server, { recursive: true });
    for (const arch of ['x86_64', 'aarch64']) {
        const name = `ringtome-server-0.1.7-cloth-vowel-linux-${arch}.tar.gz`;
        for (const suffix of ['', '.sig', '.sha256']) {
            if (!leaveOut(name + suffix)) fs.writeFileSync(path.join(server, name + suffix), 'x');
        }
    }
    fs.writeFileSync(path.join(server, 'server-latest.json'), '{}');
    return { root, artifacts, out: path.join(root, 'release') };
}

describe('assembling a release', () => {
    it("writes exactly the latest.json tauri-action published, and lays every file out under GitHub's name", () => {
        const { root, artifacts, out } = stashes();
        try {
            const { problems, latest } = assemble(TAG, artifacts, out, PUBLISHED.notes);
            assert.deepEqual(problems, []);
            assert.deepEqual(latest.platforms, PUBLISHED.platforms, 'every key, URL and signature');
            assert.equal(latest.version, '0.1.7');
            assert.equal(latest.notes, PUBLISHED.notes);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8')).platforms, PUBLISHED.platforms, 'and on disk');
            const laid = fs.readdirSync(out);
            assert.ok(laid.includes('Horse.Drawing.Tycoon.2_0.1.7_universal.dmg'), 'spaces become dots, as GitHub would');
            assert.ok(laid.every((n) => !n.includes(' ')));
            assert.ok(laid.includes('server-latest.json') && laid.includes('ringtome-server-0.1.7-cloth-vowel-linux-aarch64.tar.gz.sha256'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses the set 0.1.10 shipped: everything but the Mac', () => {
        const { root, artifacts, out } = stashes((n) => /universal|\.app\.tar\.gz/.test(n)); // every Mac file
        try {
            const { problems } = assemble(TAG, artifacts, out, '');
            assert.deepEqual(problems.map((p) => p.split(':')[0]).sort(), ['the Mac disk image', 'the Mac update']);
            assert.ok(!fs.existsSync(path.join(out, 'latest.json')), 'and writes no manifest');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("publishes the Mac update under the name every release has used, whatever the bundler called it", async () => {
        const { publishedName } = await import('../../../tools/release-assemble.mjs');
        assert.equal(publishedName('x/Horse Drawing Tycoon 2.app.tar.gz'), 'Horse.Drawing.Tycoon.2_universal.app.tar.gz');
        assert.equal(publishedName('x/Horse Drawing Tycoon 2.app.tar.gz.sig'), 'Horse.Drawing.Tycoon.2_universal.app.tar.gz.sig');
        assert.equal(publishedName('x/Horse Drawing Tycoon 2_universal.app.tar.gz'), 'Horse.Drawing.Tycoon.2_universal.app.tar.gz', 'never twice');
        assert.equal(publishedName('x/Horse Drawing Tycoon 2_0.1.12_universal.dmg'), 'Horse.Drawing.Tycoon.2_0.1.12_universal.dmg', 'the disk image is left alone');
    });

    it('refuses an updater file without its signature, a server node without its checksum, and a stale build', () => {
        let s = stashes((n) => n.endsWith('.msi.sig') || n === 'ringtome-server-0.1.7-cloth-vowel-linux-x86_64.tar.gz.sha256');
        try {
            const { problems } = assemble(TAG, s.artifacts, s.out, '');
            assert.equal(problems.length, 2, problems.join('\n'));
            assert.ok(problems.some((p) => /Windows \.msi: .* has no \.sig/.test(p)));
            assert.ok(problems.some((p) => /x86_64 server node: .* has no \.sha256/.test(p)));
        } finally {
            fs.rmSync(s.root, { recursive: true, force: true });
        }
        s = stashes();
        try {
            // Last release's artifacts under this release's tag: every versioned file is "missing".
            const { problems } = assemble('v0.1.8-evoke-cloak', s.artifacts, s.out, '');
            assert.ok(problems.length >= 7, problems.join('\n'));
        } finally {
            fs.rmSync(s.root, { recursive: true, force: true });
        }
    });
});
