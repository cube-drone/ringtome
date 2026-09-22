/*
    Release numbers and release names (Curtis, 2026-09-22). The numbering is the ordinary semver
    rule, spelled out because the alternative is a release nobody meant. The NAME is derived from
    the version rather than drawn at random, and that is the property worth pinning: a name lives in
    a tag forever, so it has to be the same name on every machine, this year and next.
*/
const assert = require('node:assert');

let parseVersion, bumpVersion, releaseName, releaseTag, WORDS;
before(async () => {
    ({ parseVersion, bumpVersion, releaseName, releaseTag } = await import('../../../js/pure/releasename.js'));
    ({ WORDS } = await import('../../../js/pure/words.js'));
});

describe('release numbers', () => {
    it('bumps each part and zeroes the ones beneath it', () => {
        assert.equal(bumpVersion('0.0.1', 'minor'), '0.1.0', 'the first real release');
        assert.equal(bumpVersion('0.1.0', 'micro'), '0.1.1');
        assert.equal(bumpVersion('0.1.9', 'minor'), '0.2.0', 'a minor bump zeroes the patch');
        assert.equal(bumpVersion('0.4.7', 'major'), '1.0.0', 'a major bump zeroes both');
        assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4', '"patch" is "micro" by another name');
    });

    it('reads a version, and refuses anything that is not one', () => {
        assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
        assert.equal(parseVersion('1.2'), null);
        assert.equal(parseVersion('1.2.3-lady-smirk'), null, 'a decorated version is not a version');
        assert.equal(parseVersion(''), null);
        assert.throws(() => bumpVersion('1.2', 'minor'));
        assert.throws(() => bumpVersion('1.2.3', 'sideways'));
    });
});

describe('release names', () => {
    it('is the same name for the same version, every time', () => {
        const once = releaseName('0.1.0');
        for (let i = 0; i < 50; i++) assert.equal(releaseName('0.1.0'), once, 'derived, never drawn');
        assert.equal(releaseTag('0.1.0'), `0.1.0-${once}`);
    });

    it('is two distinct words from the pinned list', () => {
        for (const v of ['0.1.0', '0.1.1', '0.2.0', '1.0.0', '2.17.43']) {
            const [a, b] = releaseName(v).split('-');
            assert.ok(WORDS.includes(a), `${a} is a word from the list`);
            assert.ok(WORDS.includes(b), `${b} is a word from the list`);
            assert.notEqual(a, b, 'never the same word twice');
        }
    });

    it('gives neighbouring versions unrelated names, which is the point of a name', () => {
        const names = ['0.1.0', '0.1.1', '0.1.2', '0.2.0', '1.0.0'].map(releaseName);
        assert.equal(new Set(names).size, names.length, 'no two releases in a row share a name');
    });
});
