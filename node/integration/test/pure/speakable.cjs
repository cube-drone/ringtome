// The speakable identicon - goldens shared with the Rust twin (src/speakable.rs): these
// exact strings pin the wordlist, the hash windows, and the base58 alphabet as one wire
// format across both languages. If either side drifts, these fail before an address does.
const assert = require('node:assert');

let speakable, parseSpeakable, wordsFor, toBase58, fromBase58, WORDS;
before(async () => {
    ({ speakable, parseSpeakable, wordsFor, toBase58, fromBase58 } = await import(
        '../../../js/speakable.js'
    ));
    ({ WORDS } = await import('../../../js/pure/words.js'));
});

// The cross-language goldens. Do not regenerate casually - minted addresses depend on them.
const GOLDENS = [
    [
        '93ad0ddd9dd2022bf2ac21664b386965e0eeffecaff6e49b71039db5f1cf53f3',
        'sway-broke-AwTyvw9SPjfiJ4xvMfwDKZeHQH6N1mw3LQtoYtJNPfqU',
    ],
    [
        'aa'.repeat(32),
        'tulip-brick-CVDFLCAjXhVWiPXH9nTCTpCgVzmDVoiPzNJYuccr1dqB',
    ],
    [
        '00'.repeat(31) + '01',
        'goal-sneak-11111111111111111111111111111112',
    ],
];

describe('the speakable identicon', () => {
    it('pins the wordlist as a wire format', () => {
        assert.equal(WORDS.length, 1296);
        assert.equal(new Set(WORDS).size, 1296, 'no duplicates');
        assert.ok(WORDS.every((w) => /^[a-z]+$/.test(w)), 'lowercase ascii, no hyphens');
        assert.equal(WORDS[1285], 'yonder', "the yo-yo slot's amendment, pinned");
    });

    it('mints the goldens exactly (drift here breaks minted addresses)', () => {
        for (const [root, addr] of GOLDENS) {
            assert.equal(speakable(root), addr);
        }
    });

    it('round-trips every accepted form', () => {
        for (const [root, addr] of GOLDENS) {
            assert.deepEqual(parseSpeakable(addr), { ok: true, root }, 'worded');
            assert.deepEqual(parseSpeakable(addr.split('-')[2]), { ok: true, root }, 'bare base58');
            assert.deepEqual(parseSpeakable(root), { ok: true, root }, 'the hex escape hatch');
        }
    });

    it('REFUSES a checksum mismatch, loudly, with the true words in hand', () => {
        const [root] = GOLDENS[0];
        const key = toBase58(root);
        const lied = parseSpeakable(`pagoda-dimension-${key}`);
        assert.equal(lied.ok, false, 'wrong words never pass');
        assert.equal(lied.root, root, 'the claimed root rides along for the warning');
        assert.equal(lied.expected, 'sway-broke', '"did you mean" has its material');
    });

    it('rejects what is not an address at all', () => {
        assert.equal(parseSpeakable('pagoda-dimension'), null, 'words with no key');
        assert.equal(parseSpeakable('not/base58/0OIl'), null, 'confusables are not in the alphabet');
        assert.equal(parseSpeakable('a-b-c-d'), null, 'too many parts');
        assert.equal(parseSpeakable(''), null);
        assert.equal(parseSpeakable(null), null);
        assert.equal(parseSpeakable('sway-broke-' + 'z'.repeat(60)), null, 'overlong key');
    });

    it('base58 handles leading zeros the conventional way', () => {
        const root = '00'.repeat(31) + '01';
        assert.equal(toBase58(root), '1'.repeat(31) + '2');
        assert.equal(fromBase58('1'.repeat(31) + '2'), root);
    });

    it('derives words deterministically from the hash, not the mood', () => {
        const [root] = GOLDENS[0];
        assert.deepEqual(wordsFor(root), ['sway', 'broke']);
        assert.deepEqual(wordsFor(root), wordsFor(root));
    });
});

describe('the strict key rule', () => {
    let parseSpeakable, toBase58;
    before(async () => {
        ({ parseSpeakable, toBase58 } = await import('../../../js/speakable.js'));
    });

    it('a partial base58 string is typing, not an address', () => {
        // fromBase58 left-pads, so "y" used to decode as the near-zero root and the People
        // lookup teleported a filter keystroke to apple-fifth-1111…1y (2026-08-24). A key
        // must round-trip through toBase58 - only canonical mints qualify.
        assert.equal(parseSpeakable('y'), null);
        assert.equal(parseSpeakable('yy'), null);
        assert.equal(parseSpeakable('apple-fifth-y'), null, 'a short key never earns "did you mean"');
    });

    it('a canonical key still parses, and lying words still get the truth', () => {
        const root = 'ab'.repeat(32);
        const key = toBase58(root);
        assert.deepEqual(parseSpeakable(key), { ok: true, root });
        const lied = parseSpeakable(`wrong-words-${key}`);
        assert.equal(lied.ok, false);
        assert.equal(lied.root, root);
        assert.ok(lied.expected.includes('-'), 'the true words ride the refusal');
    });
});
