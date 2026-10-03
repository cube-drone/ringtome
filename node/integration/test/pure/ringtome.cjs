/*
    Ringtome addresses (node/js/pure/ringtome.js; PROJECT_PLAN's "`/ringtome/` replaces `/home`,
    `/in` and `/id`", 2026-09-28): one grammar under a prefix that can only be us, so an address is
    recognized at any origin, and every renderer rehomes it to its own node.
*/
const assert = require('node:assert');

let r;
before(async () => {
    r = await import('../../../js/pure/ringtome.js');
});

const SEG = '7Wv3kX9hQ2mN5pR8sT1uV4wY6zA3bC5dE7fG9hJ2kL4m';
const DOC = '0123456789abcdef0123456789abcdef';
const PAGE = 'fedcba9876543210fedcba9876543210';

describe('a ringtome address', () => {
    it('is minted in one grammar for every kind of thing', () => {
        assert.equal(r.ringtomePath({ seg: SEG }), `/ringtome/user/${SEG}`);
        assert.equal(
            r.ringtomePath({ seg: SEG, kind: 'post', doc: DOC }),
            `/ringtome/user/${SEG}/post/${DOC}`,
        );
        assert.equal(
            r.ringtomePath({ seg: SEG, kind: 'post', doc: DOC, page: PAGE }),
            `/ringtome/user/${SEG}/post/${DOC}/page/${PAGE}`,
        );
        assert.equal(
            r.parseRingtome(`/ringtome/user/${SEG}/post/${DOC}/page/${PAGE}`).page,
            PAGE,
            "a book page is the page's own post id",
        );
        assert.equal(
            r.ringtomePath({ seg: SEG, kind: 'doc', doc: DOC }),
            `/ringtome/user/${SEG}/doc/${DOC}`,
        );
        assert.equal(
            r.ringtomePath({ seg: SEG, kind: 'room', doc: DOC, line: 'abcdef0123' }),
            `/ringtome/user/${SEG}/room/${DOC}/line/abcdef0123`,
        );
    });

    it('is read at any origin - the origin is a lens, never part of the answer', () => {
        for (const origin of [
            'http://localhost:8374',
            'https://propersite.with.tld',
            'https://evil.example',
            '',
        ]) {
            const p = r.parseRingtome(`${origin}/ringtome/user/${SEG}/post/${DOC}`);
            assert.ok(p, origin || 'a bare path');
            assert.equal(p.seg, SEG);
            assert.equal(p.kind, 'post');
            assert.equal(p.doc, DOC);
            assert.equal(p.path, `/ringtome/user/${SEG}/post/${DOC}`);
        }
    });

    it('keeps the hints, and rehomes to the path', () => {
        const p = r.parseRingtome(`https://a.example/ringtome/user/${SEG}?via=k1,k2#top`);
        assert.equal(p.kind, null, 'a person');
        assert.deepEqual(p.via, ['k1', 'k2']);
        assert.equal(
            r.rehome(`https://a.example/ringtome/user/${SEG}?via=k1,k2`),
            `/ringtome/user/${SEG}?via=k1,k2`,
        );
        assert.equal(
            r.rehome(`http://localhost:9/ringtome/user/${SEG}/room/${DOC}/line/abcdef0123`),
            `/ringtome/user/${SEG}/room/${DOC}/line/abcdef0123`,
        );
    });

    it('carries the notebook a document was opened in, beside the hints - and nothing but a slug (2026-09-28)', () => {
        const p = r.parseRingtome(
            `https://x.example/ringtome/user/${SEG}/doc/${DOC}?via=k1&bucket=family-recipes`,
        );
        assert.equal(p.bucket, 'family-recipes');
        assert.equal(p.path, `/ringtome/user/${SEG}/doc/${DOC}?via=k1&bucket=family-recipes`);
        assert.equal(
            r.parseRingtome(`/ringtome/user/${SEG}/doc/${DOC}?bucket=Not%20A%20Slug`).bucket,
            null,
        );
        assert.equal(r.parseRingtome(`/ringtome/user/${SEG}/doc/${DOC}`).bucket, null);
        assert.equal(r.withHints('/p', { bucket: 'b' }), '/p?bucket=b');
        assert.equal(r.withHints('/p', {}), '/p');
    });

    it('is nothing else: other sites, other paths and malformed ones stay as written', () => {
        for (const not of [
            'https://example.com/some/page',
            `https://example.com/id/${SEG}/post/${DOC}`,
            `/ringtome/user/${SEG}/post/nothex`,
            `/ringtome/user/${SEG}/shoe/${DOC}`,
            `/ringtome/user/${SEG}/post/${DOC}/page/3`,
            `/ringtome/user/${SEG}/doc/${DOC}/line/abcdef0123`,
            `/ringtome/user/${SEG}/post/${DOC}/extra/bits/here`,
            '/ringtome/notes',
            'ringtome/user/x',
            '',
        ]) {
            assert.equal(r.parseRingtome(not), null, not);
            assert.equal(r.rehome(not), null, not);
        }
    });

    it('takes the old /id/ spelling, as a path only, to the new', () => {
        assert.equal(r.fromLegacyId(`/id/${SEG}`), `/ringtome/user/${SEG}`);
        assert.equal(r.fromLegacyId(`/id/${SEG}/post/${DOC}`), `/ringtome/user/${SEG}/post/${DOC}`);
        assert.equal(
            r.fromLegacyId(`/id/${SEG}/post/${DOC}/${PAGE}`),
            `/ringtome/user/${SEG}/post/${DOC}/page/${PAGE}`,
        );
        assert.equal(r.fromLegacyId(`/id/${SEG}?via=k1`), `/ringtome/user/${SEG}?via=k1`);
        assert.equal(
            r.fromLegacyId(`/id/${SEG}/docs/${DOC}/body`),
            null,
            'picture bytes are not a page',
        );
        assert.equal(r.fromLegacyId(`https://x.example/id/${SEG}`), null, 'never at an origin');
    });
});

describe("a picture's address (2026-09-28)", () => {
    const ROOT = 'c39be6a02daaf7d357591b057f7b824da7f24a47c98cd594e3869abc1c5a70a3';
    const TWIN = '7256cefb182137730ceddd3cf1b01135';
    const O = 'http://localhost:6305';

    it('is read in either spelling, answered in the /ringtome/ one', () => {
        assert.equal(
            r.mediaPath(`${O}/id/${ROOT}/docs/${TWIN}/body/media.avif`, O),
            `/ringtome/user/${ROOT}/doc/${TWIN}/body/media.avif`,
            'the old spelling, from this node',
        );
        assert.equal(
            r.mediaPath(
                `https://elsewhere.example/ringtome/user/${SEG}/doc/${TWIN}/body/media.avif`,
                O,
            ),
            `/ringtome/user/${SEG}/doc/${TWIN}/body/media.avif`,
            'the new one, from anywhere',
        );
        assert.equal(
            r.mediaPath(`https://elsewhere.example/id/${ROOT}/docs/${TWIN}/body/media.avif`, O),
            null,
            "/id/ at a foreign site is anyone's",
        );
        assert.equal(
            r.mediaPath(`/api/identity/${ROOT}/docs/${TWIN}/body/p.avif`, O),
            `/api/identity/${ROOT}/docs/${TWIN}/body/p.avif`,
            'your own private picture',
        );
        assert.equal(
            r.mediaPath(`/ringtome/user/${SEG}/post/${TWIN}`, O),
            null,
            'a post is not bytes',
        );
    });

    it('pasted alone, becomes the picture; anything else pastes as it did', async () => {
        const p = await import('../../../js/pure/portable.js');
        assert.equal(
            p.pastedPicture(`${O}/id/${ROOT}/docs/${TWIN}/body/media.avif`, O),
            `![](/ringtome/user/${ROOT}/doc/${TWIN}/body/media.avif)`,
        );
        assert.equal(
            p.pastedPicture(`look ${O}/id/${ROOT}/docs/${TWIN}/body/media.avif`, O),
            null,
            'in a sentence: not an embed',
        );
        assert.equal(
            p.pastedPicture(`${O}/id/${ROOT}/docs/${TWIN}/body`, O),
            null,
            'no name, no kind: nothing to draw',
        );
        const m = await import('../../../js/pure/mediakind.js');
        const media = m.mediaResolver({ linkAllowed: () => true, media: () => null });
        assert.equal(
            media(`https://x.example/ringtome/user/${SEG}/doc/${TWIN}/body/media.avif`).url,
            `/ringtome/user/${SEG}/doc/${TWIN}/body/media.avif`,
            'drawn from this node',
        );
    });
});
