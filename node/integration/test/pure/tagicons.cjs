// The icons on tags and kinds whose meaning is fixed (pure/tagicons.js; Curtis, 2026-10-06). The
// table names roles, so these pin it from both ends: every fixed value the node and the app use has
// a role, and every role is one icons.js draws - a renamed tag or a dropped role goes red here
// rather than quietly losing its icon.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let KIND_ICON, TAG_ICON, tagIconRole, SIZE_TAGS, MEDIA_TAGS, DEFAULT_BLUR;
before(async () => {
    ({ KIND_ICON, TAG_ICON, tagIconRole } = await import('../../../js/pure/tagicons.js'));
    ({ SIZE_TAGS, MEDIA_TAGS } = await import('../../../js/pure/facets.js'));
    ({ DEFAULT_BLUR } = await import('../../../js/pure/warnings.js'));
});

describe('tags and kinds whose meaning is fixed wear icons', () => {
    it('every kind, size, medium and default content warning has one', () => {
        // search.rs `KINDS`, the "show" row's values.
        for (const kind of ['post', 'reply', 'rebroadcast', 'book', 'room']) {
            assert.ok(KIND_ICON[kind], `kind ${kind}`);
        }
        for (const tag of [...SIZE_TAGS, ...MEDIA_TAGS, ...DEFAULT_BLUR, 'ai-agent', 'api-key']) {
            assert.ok(tagIconRole(tag), `tag ${tag}`);
        }
    });

    it('every role is one icons.js draws', () => {
        const icons = fs.readFileSync(path.join(__dirname, '../../../js/icons.js'), 'utf8');
        for (const role of new Set([...Object.values(KIND_ICON), ...Object.values(TAG_ICON)])) {
            assert.match(icons, new RegExp(`^    ${role}: [A-Z]`, 'm'), `Icons.${role}`);
        }
    });

    it('reads a tag however it is cased or spaced, and an ordinary tag wears nothing', () => {
        assert.equal(tagIconRole(' NSFW '), 'warnExplicit');
        assert.equal(tagIconRole('Sexual Assault'), 'warnHarm');
        assert.equal(tagIconRole('horses'), null);
        assert.equal(tagIconRole(''), null);
    });

    it("a made-with tag is provenance only in its author's mouth", () => {
        assert.equal(tagIconRole('ai-agent', { byAuthor: true }), 'aiAgent');
        assert.equal(tagIconRole('ai-agent', { byAuthor: false }), null);
        assert.equal(
            tagIconRole('nsfw', { byAuthor: false }),
            'warnExplicit',
            'a warning, from anyone',
        );
    });
});
