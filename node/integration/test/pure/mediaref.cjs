// The in-document reference a landed upload leaves behind. It builds a URL and a markdown label
// out of a user-supplied FILENAME, which is the interesting part: the label is scrubbed of the
// characters that would break the markup it sits inside, and the slug is scrubbed harder because
// it lands in a path. Getting either wrong produces a document that renders as literal text.
const assert = require('node:assert');

let mediaReference;
before(async () => {
    ({ mediaReference } = await import('../../../js/doc/upload.js'));
});

const ROOT = 'aabb';
const BASE = `/api/identity/${ROOT}/docs/doc7/body`;
const ref = (over = {}) =>
    mediaReference({ root: ROOT, format: 'marquee', docId: 'doc7', name: 'holiday.jpg',
        mimeType: 'image/jpeg', ...over });

describe('media reference', () => {
    it('embeds an image with the extension the renderer sniffs for', () => {
        assert.equal(ref(), `![holiday.jpg](${BASE}/holiday.avif)`);
    });

    it('maps each input kind to what the crush actually emits', () => {
        assert.equal(ref({ mimeType: 'video/quicktime', name: 'clip.mov' }),
            `![clip.mov](${BASE}/clip.webm)`);
        assert.equal(ref({ mimeType: 'audio/wav', name: 'song.wav' }),
            `![song.wav](${BASE}/song.ogg)`);
    });

    it('degrades an unknown kind to a plain link rather than guessing an extension', () => {
        assert.equal(ref({ mimeType: 'application/pdf', name: 'thesis.pdf' }),
            `[thesis.pdf](${BASE})`);
        assert.equal(ref({ mimeType: '' }), `[holiday.jpg](${BASE})`);
        assert.equal(ref({ mimeType: undefined }), `[holiday.jpg](${BASE})`);
    });

    it('gives a plaintext document a bare URL - there is no markup to hang a label on', () => {
        assert.equal(ref({ format: 'plaintext' }), `${BASE}/holiday.avif`);
        assert.equal(ref({ format: 'plaintext', mimeType: 'application/pdf' }), BASE);
    });

    it('strips from the LABEL the characters that would break the markup around it', () => {
        assert.equal(ref({ name: 'my [best] (photo).jpg' }),
            `![my best photo.jpg](${BASE}/my_best_photo.avif)`);
    });

    it('collapses everything path-hostile in the slug and drops the original extension', () => {
        assert.equal(ref({ name: 'a b  c!@#d.jpeg' }),
            `![a b  c!@#d.jpeg](${BASE}/a_b_c_d.avif)`);
    });

    it('keeps dots and dashes in a slug, dropping only the trailing extension', () => {
        assert.equal(ref({ name: 'v1.2-final.png' }), `![v1.2-final.png](${BASE}/v1.2-final.avif)`);
    });

    it('falls back to "file" when there is no usable name', () => {
        assert.equal(ref({ name: '' }), `![file](${BASE}/file.avif)`);
        assert.equal(ref({ name: undefined }), `![file](${BASE}/file.avif)`);
    });

    it('falls the SLUG back to "file" when scrubbing leaves nothing, keeping the label empty', () => {
        // A name of only markup characters: the label legitimately empties, but a path segment
        // cannot, so the two fall back independently.
        assert.equal(ref({ name: '()' }), `![](${BASE}/file.avif)`);
    });
});
