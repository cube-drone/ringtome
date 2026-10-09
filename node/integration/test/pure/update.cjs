/*
    The update notice's two questions (js/pure/update.js; Curtis, 2026-10-09): is the newest
    release newer than what's running - read off a release tag and a bare version alike, and never
    "yes" on a guess, since the notice can't be dismissed - and which download is this system's.
*/
const assert = require('node:assert');

let versionOf, isNewer, downloadFor, RELEASES_PAGE;
before(async () => {
    ({ versionOf, isNewer, downloadFor, RELEASES_PAGE } =
        await import('../../../js/pure/update.js'));
});

describe('the update notice', () => {
    it('reads a version out of a release tag or a bare version', () => {
        assert.deepEqual(versionOf('v0.3.1-keep-large'), [0, 3, 1]);
        assert.deepEqual(versionOf('0.10.2'), [0, 10, 2]);
        assert.equal(versionOf('main'), null);
        assert.equal(versionOf(null), null);
    });

    it('says newer only when the release is', () => {
        assert.equal(isNewer('v0.3.2-x', '0.3.1'), true);
        assert.equal(isNewer('v0.4.0-x', '0.3.9'), true);
        assert.equal(isNewer('v0.10.0-x', '0.9.9'), true, 'numbers, not strings');
        assert.equal(isNewer('v0.3.1-x', '0.3.1'), false, 'the same release');
        assert.equal(isNewer('v0.3.0-x', '0.3.1'), false, 'running ahead of the release');
    });

    it('never says newer on a guess', () => {
        assert.equal(isNewer(null, '0.3.1'), false, 'GitHub out of reach');
        assert.equal(isNewer('v0.3.2-x', ''), false, 'a running version it cannot read');
    });

    it('gives each system its own download, and every release to the rest', () => {
        const found = {
            mac: 'm.dmg',
            windows: 'w.exe',
            linux: 'l.AppImage',
            android: 'a.apk',
            releases: 'all',
        };
        assert.equal(downloadFor('android', found), 'a.apk');
        assert.equal(downloadFor('macos', found), 'm.dmg');
        assert.equal(downloadFor('windows', found), 'w.exe');
        assert.equal(downloadFor('linux', found), 'l.AppImage');
        assert.equal(downloadFor('ios', found), 'all');
        assert.equal(downloadFor('android', { releases: 'all' }), 'all', 'no APK this release');
        assert.equal(downloadFor('android', null), RELEASES_PAGE);
    });
});
