// The lock-out blast radius: active proper descendants by rank-path prefix. The arithmetic is
// three lines; the cases that matter are the boundaries - self is not a descendant, siblings
// share a prefix-of-the-parent but not of each other, and the already-revoked don't re-die.
const assert = require('node:assert');

let blastRadius, isDeparted;
before(async () => {
    ({ blastRadius, isDeparted } = await import('../../../js/pure/removal.js'));
});

const key = (pubkey, rank_path, status = 'active') => ({ pubkey, rank_path, status });

// root [], spare [0], laptop [1], laptop's phone [1,0], phone's watch [1,0,0],
// desktop [2] (laptop's sibling), and a already-locked-out stray under laptop [1,1].
const keys = [
    key('root', []),
    key('spare', [0]),
    key('laptop', [1]),
    key('phone', [1, 0]),
    key('watch', [1, 0, 0]),
    key('desktop', [2]),
    key('stray', [1, 1], 'repudiated'),
];

describe('removal blast radius', () => {
    it('collects the active subtree, not the key itself', () => {
        assert.deepEqual(
            blastRadius(keys, [1]).map((k) => k.pubkey),
            ['phone', 'watch'],
            'laptop takes phone and watch down; laptop itself is the target, not radius'
        );
    });

    it('spares siblings and the senior line', () => {
        assert.deepEqual(blastRadius(keys, [2]), [], 'desktop has no descendants');
        assert.ok(
            !blastRadius(keys, [1]).some((k) => k.pubkey === 'desktop' || k.pubkey === 'spare'),
            'a sibling branch and the spare are untouched'
        );
    });

    it('does not re-kill the already-revoked', () => {
        assert.ok(
            !blastRadius(keys, [1]).some((k) => k.pubkey === 'stray'),
            'the repudiated stray was down before the ship was'
        );
    });

    it('the root takes everything active with it', () => {
        assert.deepEqual(
            blastRadius(keys, []).map((k) => k.pubkey),
            ['spare', 'laptop', 'phone', 'watch', 'desktop']
        );
    });
});

describe('the farewell gate', () => {
    it('fires only on affirmative removal - never on can\'t-tell', () => {
        assert.equal(isDeparted('retired'), true);
        assert.equal(isDeparted('repudiated'), true);
        assert.equal(isDeparted('invalid'), true);
        assert.equal(isDeparted('unknown'), false, 'an empty tree asserts nothing');
        assert.equal(isDeparted('active'), false);
        assert.equal(isDeparted(undefined), false);
    });
});
