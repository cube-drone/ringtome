// The links the desktop app hands to the system's browser or mail app (pure/outward.js;
// 2026-10-22): the web and mail at another origin, never this node's own pages, never another
// scheme.
const assert = require('node:assert');

let outwardLink;
before(async () => {
    ({ outwardLink } = await import('../../../js/pure/outward.js'));
});

describe('links that leave the desktop app', () => {
    const here = 'http://127.0.0.1:6305';

    it('hands out the web and mail', () => {
        assert.equal(
            outwardLink('https://github.com/cube-drone/ringtome/releases/tag/0.5.2', here),
            'https://github.com/cube-drone/ringtome/releases/tag/0.5.2',
        );
        assert.equal(outwardLink('http://example.com/x', here), 'http://example.com/x');
        assert.equal(outwardLink('mailto:someone@example.com', here), 'mailto:someone@example.com');
    });

    it("keeps this node's own pages in the app, however they're written", () => {
        assert.equal(outwardLink('/ringtome/notes', here), null);
        assert.equal(outwardLink('http://127.0.0.1:6305/home', here), null);
        assert.equal(outwardLink('#top', here), null);
    });

    it('lets nothing else out', () => {
        for (const href of [
            'javascript:alert(1)',
            'file:///etc/passwd',
            'ssh://host',
            'x-apple.systempreferences:',
        ]) {
            assert.equal(outwardLink(href, here), null, href);
        }
        assert.equal(outwardLink('http://[bad', here), null, 'not an address');
    });
});
