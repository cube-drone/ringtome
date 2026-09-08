const assert = require('node:assert');

let warningFor, parseTagList, serializeTagList, DEFAULT_BLUR;
before(async () => {
    ({ warningFor, parseTagList, serializeTagList, DEFAULT_BLUR } = await import('../../../js/pure/warnings.js'));
});

describe('content warnings by tag (2026-09-07)', () => {
    const facts = { trusted: { trust: 'high' }, stranger: {}, none: { trust: 'none' } };
    // Built per claim: the module (and its default list) loads in `before`.
    const ctxOf = () => ({ author: 'ada', me: 'me', factsByRoot: facts, blur: DEFAULT_BLUR, hide: ['spoilers'] });
    const tag = (annotator, value) => ({ annotator, key: 'tag', value });

    it("the author's, the reader's and a trusted person's tags count; a stranger's does not", () => {
        const ctx = ctxOf();
        assert.equal(warningFor([tag('ada', 'gore')], ctx).kind, 'blur');
        assert.equal(warningFor([tag('me', 'NSFW')], ctx).kind, 'blur', 'case-blind');
        assert.equal(warningFor([tag('trusted', 'sexual  assault')], ctx).kind, 'blur', 'spacing-blind');
        assert.equal(warningFor([tag('stranger', 'gore')], ctx).kind, null);
        assert.equal(warningFor([tag('none', 'gore')], ctx).kind, null, "a 'none' band is no trust");
    });
    it('hide outranks blur, and the verdict names the tags that decided it', () => {
        const ctx = ctxOf();
        const v = warningFor([tag('ada', 'gore'), tag('trusted', 'spoilers')], ctx);
        assert.equal(v.kind, 'hide');
        assert.deepEqual(v.tags, ['spoilers']);
        assert.deepEqual(warningFor([tag('ada', 'gore'), tag('ada', '18+')], ctx).tags, ['gore', '18+']);
    });
    it('a stored list round-trips; absent or broken means the default stands; an emptied list is empty', () => {
        assert.deepEqual(parseTagList(undefined, DEFAULT_BLUR), DEFAULT_BLUR);
        assert.deepEqual(parseTagList('not json', DEFAULT_BLUR), DEFAULT_BLUR);
        assert.deepEqual(parseTagList(serializeTagList([' Gore ', 'gore', 'x']), DEFAULT_BLUR), ['gore', 'x']);
        assert.deepEqual(parseTagList('[]', DEFAULT_BLUR), [], 'the user may clear the defaults');
    });
});
