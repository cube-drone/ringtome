// The display register: whose labels render (ANNOTATIONS.md ruling 5).
const assert = require('node:assert');

let visibleAnnotations, DEFAULT_ANNOTATION_STOP;
before(async () => {
    ({ visibleAnnotations, DEFAULT_ANNOTATION_STOP } = await import('../../../js/pure/annotations.js'));
});

describe('the annotations display register', () => {
    const author = 'ada';
    const labels = [
        { annotator: 'ada', key: 'tag', value: 'saucy' },
        { annotator: 'bea', key: 'tag', value: 'goopy' },
        { annotator: 'cal', key: 'tag', value: 'rude' },
        { annotator: 'dan', key: 'tag', value: 'meh' },
    ];
    const facts = { bea: { interest: 'high' }, cal: { blocked: 'yes' }, dan: {} };

    it("defaults to the author's plus people I follow", () => {
        assert.equal(DEFAULT_ANNOTATION_STOP, 'followed');
        const seen = visibleAnnotations(labels, { author, stop: 'followed', factsByRoot: facts });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'bea']);
    });

    it("'author' shows the author's alone", () => {
        const seen = visibleAnnotations(labels, { author, stop: 'author', factsByRoot: facts });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada']);
    });

    it("'everyone' shows all - except a blocked annotator, whatever the stop", () => {
        const seen = visibleAnnotations(labels, { author, stop: 'everyone', factsByRoot: facts });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'bea', 'dan']);
    });

    it("the reader's own labels always show - nobody follows themselves", () => {
        // 2026-08-31: three tags said from the UI vanished on refresh, filtered out by the
        // reader's own register at the default stop.
        const mine = [...labels, { annotator: 'me', key: 'tag', value: 'said-by-me' }];
        const seen = visibleAnnotations(mine, { author, stop: 'author', factsByRoot: facts, me: 'me' });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'me']);
    });

    it("with no ledger at all (nobody signed in) it is the author's only", () => {
        const seen = visibleAnnotations(labels, { author, stop: 'everyone', factsByRoot: null });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada']);
    });
});
