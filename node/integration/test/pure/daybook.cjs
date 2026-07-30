// The day book's shape. The subtle one is the PHANTOM rule - whether to offer today's blank page -
// which took six lines of comment to explain in place and has exactly the shape of a thing that
// breaks when someone backdates an entry.
const assert = require('node:assert');

let entryMs, dayKey, isOpen, journalStack;
before(async () => {
    ({ entryMs, dayKey, isOpen, journalStack } = await import('../../../js/pure/daybook.js'));
});

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 15, 12);
const id = (n) => String(n).padStart(2, '0').repeat(16);
const entry = (n, over = {}) => ({
    doc_id: id(n), buckets: ['journal'], format: 'marquee', created_ms: NOW - n * DAY, ...over,
});
const ids = (list) => list.map((e) => (e.phantom ? 'phantom' : e.doc_id.slice(0, 2)));
const opts = (over = {}) => ({ bucket: 'journal', seals: new Map(), now: NOW, hits: null, ...over });

describe('entryMs', () => {
    it('files an entry under its CREATION, not its last edit', () => {
        assert.equal(entryMs(entry(1, { updated_ms: NOW })), NOW - DAY);
    });

    it('lets a claimed date move it into the past', () => {
        const backdated = entry(1, { fields: { display_date: '2015-07-31' } });
        assert.ok(entryMs(backdated) < Date.UTC(2016, 0, 1));
    });

    it('is safe on a entry with no dates at all', () => {
        assert.equal(entryMs({}), 0);
        assert.equal(entryMs(null), 0);
    });
});

describe('isOpen', () => {
    // A function, not a const: describe bodies run before before(), so the import is not in yet.
    const todayKey = () => dayKey(NOW);

    it('follows the day when there is no override', () => {
        assert.equal(isOpen(entry(0), new Map(), todayKey()), true); // created today
        assert.equal(isOpen(entry(3), new Map(), todayKey()), false); // three days ago
    });

    it('lets a local override win either way', () => {
        assert.equal(isOpen(entry(3), new Map([[id(3), 'open']]), todayKey()), true);
        assert.equal(isOpen(entry(0), new Map([[id(0), 'locked']]), todayKey()), false);
    });

    it('is safe with no seals map', () => {
        assert.equal(isOpen(entry(0), undefined, todayKey()), true);
    });
});

describe('journalStack', () => {
    it('streams the bucket s entries newest first', () => {
        const { stack } = journalStack([entry(2), entry(1), entry(3)], opts());
        assert.deepEqual(ids(stack), ['phantom', '01', '02', '03']);
    });

    it('keeps loose MEDIA records out of the day book', () => {
        // An embedded image's record can land in this bucket; it is not an entry.
        const media = entry(1, { format: 'avif' });
        const { stack } = journalStack([media, entry(2)], opts());
        assert.deepEqual(ids(stack), ['phantom', '02']);
    });

    it('ignores entries filed in another journal', () => {
        const { stack } = journalStack([entry(1, { buckets: ['other'] })], opts());
        assert.deepEqual(ids(stack), ['phantom']);
    });

    describe('the phantom', () => {
        it('is offered when the newest entry is sealed', () => {
            const { stack } = journalStack([entry(3)], opts());
            assert.equal(ids(stack)[0], 'phantom');
        });

        it('is NOT offered when the top of the stream is already open', () => {
            const { stack } = journalStack([entry(0)], opts()); // today's, unsealed
            assert.deepEqual(ids(stack), ['00']);
        });

        it('IS offered when an unsealed entry is buried in the past', () => {
            // Unlocked for repairs, or backdated away: the book's open spot is at the top or
            // nowhere, so a mid-stream open entry must not suppress today's blank page.
            const seals = new Map([[id(3), 'open']]);
            const { stack } = journalStack([entry(1), entry(3)], opts({ seals }));
            assert.deepEqual(ids(stack), ['phantom', '01', '03']);
        });

        it('is never offered while searching', () => {
            const { stack } = journalStack([entry(3)], opts({ hits: new Set([id(3)]) }));
            assert.deepEqual(ids(stack), ['03']);
        });

        it('is offered against an empty journal', () => {
            assert.deepEqual(ids(journalStack([], opts()).stack), ['phantom']);
        });
    });

    it('filters to the hits while searching, and says that it is', () => {
        const docs = [entry(1), entry(2), entry(3)];
        const found = journalStack(docs, opts({ hits: new Set([id(2)]) }));
        assert.equal(found.searching, true);
        assert.deepEqual(ids(found.stack), ['02']);
        assert.equal(journalStack(docs, opts()).searching, false);
    });

    it('hands back the unfiltered entries too - two effects watch that list', () => {
        const docs = [entry(1), entry(2)];
        const { entries, stack } = journalStack(docs, opts({ hits: new Set([id(1)]) }));
        assert.deepEqual(ids(entries), ['01', '02']);
        assert.deepEqual(ids(stack), ['01']);
    });
});
