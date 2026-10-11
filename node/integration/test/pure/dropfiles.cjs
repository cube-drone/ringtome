// Many files at once (2026-10-11): a dropped folder keeps its media and passes over the rest, reads
// in its listing's order with numbers as numbers, and goes up a few at a time.
const assert = require('node:assert');

let folderKeeps, byPath, pooled;
before(async () => {
    ({ folderKeeps, byPath, pooled } = await import('../../../js/pure/dropfiles.js'));
});

describe('a dropped folder (2026-10-11)', () => {
    it('keeps media by type, by extension where there is no type, and nothing hidden', () => {
        assert.ok(folderKeeps('01 Buck.mp3', 'audio/mpeg'));
        assert.ok(folderKeeps('cover.jpg', 'image/jpeg'));
        assert.ok(folderKeeps('02 Doe.opus', ''), 'no type, but a sound by its name');
        assert.ok(!folderKeeps('album.cue', ''));
        assert.ok(!folderKeeps('rip.log', 'text/plain'));
        assert.ok(!folderKeeps('notes.pdf', 'application/pdf'));
        assert.ok(!folderKeeps('.DS_Store', ''));
        assert.ok(!folderKeeps('._01 Buck.mp3', 'audio/mpeg'), "a macOS shadow file isn't a track");
    });

    it('reads in listing order, numbers as numbers', () => {
        const names = ['10 - Doe.mp3', '2 - Buck.mp3', '1 - Fawn.mp3', 'disc 2/1 - Elk.mp3'];
        assert.deepEqual(names.sort(byPath), [
            '1 - Fawn.mp3',
            '2 - Buck.mp3',
            '10 - Doe.mp3',
            'disc 2/1 - Elk.mp3',
        ]);
    });

    it('goes up a few at a time, each in turn, and a failure stops nothing', async () => {
        let running = 0;
        let most = 0;
        const started = [];
        const done = [];
        await pooled(
            [1, 2, 3, 4, 5, 6, 7],
            3,
            async (n, i) => {
                running++;
                most = Math.max(most, running);
                await new Promise((r) => setTimeout(r, 5 * (8 - n)));
                running--;
                if (n === 2) throw new Error('this one failed');
                done.push(i);
            },
            (i) => started.push(i),
        );
        assert.equal(most, 3, 'never more than three at once');
        assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6], 'each starts in its turn');
        assert.deepEqual(done.sort(), [0, 2, 3, 4, 5, 6], 'all but the failure finished');
    });
});
