const assert = require('node:assert');

let maskMedia, sameWords, lineDiff;
before(async () => {
    ({ maskMedia, sameWords, lineDiff } = await import('../../../js/pure/wordsdiff.js'));
});

describe('the private words against the public ones (PUBLISH.md slice 3)', () => {
    it('masks embed targets and keeps the caption, so a published picture post reads as unchanged', () => {
        const priv = 'hello\n\n![cat](/api/identity/r/docs/d/body/cat.avif)';
        const pub = 'hello\n\n![cat](/id/r/docs/t/body/media.avif)';
        assert.equal(maskMedia(priv), 'hello\n\n![cat](…)');
        assert.equal(sameWords(priv, pub), true);
        assert.equal(sameWords(priv + ' and more', pub), false);
        assert.equal(sameWords('![cat](x)', '![dog](y)'), false, 'a re-captioned picture is a change');
        assert.equal(sameWords('a\n', 'a'), true, 'trailing whitespace is not a change');
    });

    it('line-diffs by longest common subsequence', () => {
        const d = lineDiff('a\nb\nc', 'a\nc\nd');
        assert.deepEqual(d, [
            { kind: ' ', text: 'a' },
            { kind: '-', text: 'b' },
            { kind: ' ', text: 'c' },
            { kind: '+', text: 'd' },
        ]);
        assert.deepEqual(lineDiff('', ''), [{ kind: ' ', text: '' }]);
        assert.deepEqual(lineDiff('x', ''), [{ kind: '-', text: 'x' }, { kind: '+', text: '' }]);
    });
});
