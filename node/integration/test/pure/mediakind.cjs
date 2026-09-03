/*
    Ringtome's media spellings reach the screen (2026-09-03): the renderer decides an embed's
    kind from its extension through the profile, and `.apng` / `.opus` twins rendered as
    bracketed links until the profile learned them. This claim renders through the REAL
    html renderer, so a spelling can never fall out silently again.
*/
const assert = require('node:assert');
const path = require('node:path');
const { createRequire } = require('node:module');

const jsRequire = createRequire(path.join(__dirname, '../../../js/package.json'));
let ownMediaKind, mediaResolver, OWN_MEDIA_KINDS, parse, render, bareWebProfile;
before(async () => {
    ({ ownMediaKind, mediaResolver, OWN_MEDIA_KINDS } = await import('../../../js/pure/mediakind.js'));
    ({ parse } = await import(jsRequire.resolve('@cube-drone/marquee-parser')));
    ({ render, bareWebProfile } = await import(jsRequire.resolve('@cube-drone/marquee-html-renderer')));
});

describe('media kinds: ringtome spellings', () => {
    it('names its four formats and nothing else - the base table keeps .ogg', () => {
        assert.equal(ownMediaKind('/id/r/docs/d/body/media.apng'), 'image');
        assert.equal(ownMediaKind('/id/r/docs/d/body/media.avif?x=1#y'), 'image');
        assert.equal(ownMediaKind('/id/r/docs/d/body/media.webm'), 'video');
        assert.equal(ownMediaKind('/id/r/docs/d/body/media.opus'), 'audio');
        assert.equal(ownMediaKind('/api/identity/r/docs/d/body/song.ogg'), null, 'not ours to spell');
        assert.equal(ownMediaKind('https://e.x/page.html'), null);
        assert.equal(ownMediaKind('no-extension'), null);
        assert.equal(ownMediaKind(null), null);
        assert.deepEqual(Object.keys(OWN_MEDIA_KINDS).sort(), ['apng', 'avif', 'opus', 'webm']);
        // The private audio reference still renders - through the base table, as before.
        const media = mediaResolver(bareWebProfile);
        assert.deepEqual(media('/api/identity/r/docs/d/body/song.ogg'), { kind: 'audio', url: '/api/identity/r/docs/d/body/song.ogg' });
    });

    it('renders every ringtome spelling inline through the real renderer', () => {
        const profile = { ...bareWebProfile, media: mediaResolver(bareWebProfile) };
        const src = [
            '![a](/id/r/docs/d/body/media.apng)',
            '![b](/id/r/docs/d/body/media.opus)',
            '![c](/id/r/docs/d/body/media.avif)',
            '![d](/id/r/docs/d/body/media.webm)',
            '![e](https://e.x/photo.jpg)',
        ].join('\n\n');
        const html = render(parse(src), profile);
        assert.match(html, /<img class="mq-embed" src="\/id\/r\/docs\/d\/body\/media\.apng"/, 'apng is a picture');
        assert.match(html, /<audio class="mq-embed" controls src="\/id\/r\/docs\/d\/body\/media\.opus"/, 'opus is audio');
        assert.match(html, /<img class="mq-embed" src="\/id\/r\/docs\/d\/body\/media\.avif"/);
        assert.match(html, /<video class="mq-embed" controls src="\/id\/r\/docs\/d\/body\/media\.webm"/);
        assert.match(html, /<img class="mq-embed" src="https:\/\/e\.x\/photo\.jpg"/, 'the base table still answers for the web');
        assert.ok(!html.includes('mq-embed-fallback'), 'nothing fell to the placeholder');
    });

    it('keeps the base scheme policy: a javascript: target is inert whatever its spelling', () => {
        const media = mediaResolver(bareWebProfile);
        assert.equal(media('javascript:alert(1)/x.apng'), null);
    });
});
