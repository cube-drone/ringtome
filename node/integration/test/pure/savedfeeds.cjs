// Saved feeds (2026-10-11): a pile of the feed's filters kept by name, read back off the persona's
// private registers, and known again when the feed on screen is one of them.
const assert = require('node:assert');

let feedSettings, sameFeed, readSaved, savedValue;
before(async () => {
    ({ feedSettings, sameFeed, readSaved, savedValue } =
        await import('../../../js/pure/savedfeeds.js'));
});

describe('saved feeds (2026-10-11)', () => {
    it('is the same feed however its picks were picked, and not with another curiosity or order', () => {
        const a = feedSettings({ tags: ['bread', 'art'], notKinds: ['reply'] }, 'medium', 'new');
        const b = feedSettings(
            { tags: ['art', 'bread'], notKinds: ['reply'], kinds: [] },
            'medium',
            'new',
        );
        assert.ok(sameFeed(a, b));
        assert.ok(!sameFeed(a, { ...b, stop: 'high' }));
        assert.ok(!sameFeed(a, { ...b, sort: 'hot' }));
        assert.ok(!sameFeed(a, feedSettings({ tags: ['art'] }, 'medium', 'new')));
        assert.ok(!sameFeed(feedSettings({ me: 'only' }), feedSettings({})), '"me" counts');
    });

    it('reads back by name, leaving out the deleted and the unreadable', () => {
        const settings = feedSettings({ authors: ['a'.repeat(64)] }, 'interest', 'hot');
        const saved = readSaved([
            { key: '2', value: savedValue('Zebras ', settings) },
            { key: '1', value: savedValue('art', settings) },
            { key: '3', value: '' },
            { key: '4', value: 'not json' },
            { key: '5', value: JSON.stringify({ picks: {} }) },
        ]);
        assert.deepEqual(
            saved.map((s) => [s.id, s.name]),
            [
                ['1', 'art'],
                ['2', 'Zebras'],
            ],
        );
        assert.ok(sameFeed(saved[0], settings));
    });

    it('keeps the search words too (Curtis, 2026-10-12), and a feed with other words is another feed', () => {
        const a = feedSettings({ tags: ['art'] }, 'medium', 'new', '  horses ');
        assert.equal(a.q, 'horses', 'trimmed');
        assert.equal(feedSettings({}, null, null, '   ').q, null, 'blank is none');
        assert.ok(sameFeed(a, feedSettings({ tags: ['art'] }, 'medium', 'new', 'horses')));
        assert.ok(!sameFeed(a, feedSettings({ tags: ['art'] }, 'medium', 'new')), 'no words');
        const [back] = readSaved([{ key: '1', value: savedValue('h', a) }]);
        assert.equal(back.q, 'horses');
    });
});
