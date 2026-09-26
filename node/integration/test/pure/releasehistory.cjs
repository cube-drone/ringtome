/*
    The release page carries what HISTORY.md gained since the last release (Curtis, 2026-09-25;
    node/tools/release-history.mjs): the `+` lines of the diff, the newest 80,000 characters of them
    at most, cut at an entry's heading.
*/
const assert = require('node:assert');

let added, historySection;
before(async () => {
    ({ added, historySection } = await import('../../../tools/release-history.mjs'));
});

const URL = 'https://github.com/cube-drone/ringtome/blob/v0.1.11-x/HISTORY.md';

const diffOf = (lines) =>
    ['diff --git a/HISTORY.md b/HISTORY.md', 'index 1111111..2222222 100644', '--- a/HISTORY.md', '+++ b/HISTORY.md', '@@ -10,3 +10,9 @@', ' an old line, context only', ...lines.map((l) => `+${l}`), ''].join('\n');

describe('the release history section', () => {
    it("is exactly the added lines - not the file header, the hunk header, context or removals", () => {
        const diff = diffOf(['', '## 2026-09-26: a thing', '', 'It happened.']).replace(' an old line', '-a removed line\n an old line');
        assert.equal(added(diff), '## 2026-09-26: a thing\n\nIt happened.');
        assert.equal(historySection(diff, URL), '### What happened (from HISTORY.md)\n\n## 2026-09-26: a thing\n\nIt happened.\n');
    });

    it('is nothing when HISTORY gained nothing', () => {
        assert.equal(historySection('', URL), '');
        assert.equal(historySection(diffOf([]), URL), '');
    });

    it('keeps the NEWEST entries when long, from a heading, and points at the rest', () => {
        const entries = [];
        for (let i = 1; i <= 20; i++) entries.push(`## entry ${i}`, '', 'x'.repeat(100), '');
        const section = historySection(diffOf(entries), URL, 500);
        assert.ok(section.includes('## entry 20'), 'the newest is kept');
        assert.ok(!section.includes('## entry 1\n'), 'the oldest is not');
        const body = section.split('._\n\n')[1];
        assert.ok(body.startsWith('## entry '), `cut at a heading: ${body.slice(0, 40)}`);
        assert.ok(body.length <= 500);
        assert.ok(section.includes(URL), 'with a pointer to the file');
    });
});
