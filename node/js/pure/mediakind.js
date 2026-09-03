// Ringtome's own media spellings, and the renderer's door to them.
//
// The marquee renderer decides what an embed IS from the extension on its target, through
// the profile's `media()` - and the bare-web profile's table knew png/jpg/gif/webp/avif/svg,
// mp3/ogg/wav/flac/m4a, mp4/webm. Ringtome mints exactly four formats and spells two of them
// its own way: an APNG twin is `media.apng`, an audio twin `media.opus` (the private
// reference an upload writes says `.ogg`, which the base table knows - why private audio
// always rendered and a published one would not have). Both fell to the renderer's
// placeholder: a bracketed link where the picture should be (Curtis, 2026-09-03: "Is apng
// fully supported, currently?"). The table lives here, once, and the profile asks it FIRST -
// so ringtome's spellings render whatever the base table says, today and after marqueemarkup
// learns them too. Spellings the base already knows (`.ogg`) are left to it.

/// Extension -> media kind, for the formats ringtome stores and serves.
export const OWN_MEDIA_KINDS = { avif: 'image', apng: 'image', webm: 'video', opus: 'audio' };

/// The kind ringtome's own spelling says a target is, or null when it is not one of ours.
export function ownMediaKind(target) {
    const path = String(target || '').split(/[?#]/, 1)[0];
    const dot = path.lastIndexOf('.');
    if (dot < 0) return null;
    return OWN_MEDIA_KINDS[path.slice(dot + 1).toLowerCase()] || null;
}

/// A silent animation - a gif that became a video (header key 18) - is spelled `-loop`
/// before its extension by everything that writes a reference (the bake's `media-loop.webm`,
/// the picker's `name-loop.webm`), and the renderer draws it looping, muted, autoplaying,
/// with no controls (Curtis, 2026-09-03). The route ignores the name; the spelling is the
/// profile's signal, because a `media()` sees only the target.
const LOOP_SPELLING = /-loop\.[a-z0-9]+$/i;

/// The `-loop` suffix a reference to a silent animation carries before its extension.
export function loopSuffix(animation) {
    return animation ? '-loop' : '';
}

/// The extension a reference wears per stored format - the renderer's sniff (`opus` is
/// spelled `ogg`, the base table's word for it).
export const REFERENCE_EXT = { avif: 'avif', apng: 'apng', webm: 'webm', opus: 'ogg' };

/// The byte-URL a document's own reference uses: its stored format's extension and, for a
/// silent animation, the `-loop` spelling. The name is decorative (the route ignores it).
export function bodyUrlFor(root, docId, format, title, animation = false) {
    const base = `/api/identity/${root}/docs/${docId}/body`;
    const ext = REFERENCE_EXT[format];
    const slug = (title || 'file').replace(/[^\w.-]+/g, '_').replace(/\.[^.]*$/, '') || 'file';
    return ext ? `${base}/${slug}${loopSuffix(animation)}.${ext}` : base;
}

/// The reference the composer writes once the crush has spoken (2026-09-03, Curtis: a gif
/// "loads an .avif file but it doesn't seem to do anything with it"): at upload the MIME type
/// is the only guess - `image/gif` says picture - and an animated gif comes out of the crush
/// as a WebM or an APNG. This is the same reference respelled from the document's real
/// format and its animation fact; a marquee body gets the embed, plaintext the bare URL.
export function crushedReference({ root, docFormat, docId, title, animation, bodyFormat }) {
    const url = bodyUrlFor(root, docId, docFormat, title, animation);
    if (bodyFormat === 'plaintext') return url;
    const label = (title || 'file').replace(/[[\]()]/g, '');
    return `![${label}](${url})`;
}

/// Whether a target is spelled as a silent loop.
export function isLoopTarget(target) {
    const path = String(target || '').split(/[?#]/, 1)[0];
    return LOOP_SPELLING.test(path);
}

/// A profile `media()` that knows ringtome's spellings before deferring to the base
/// profile's table. `base` supplies `linkAllowed` (the scheme policy stays the base's) and
/// the fallback `media`. A video spelled `-loop` resolves with `loop: true`.
export function mediaResolver(base) {
    return function media(target) {
        const kind = ownMediaKind(target);
        if (kind && base.linkAllowed(target)) {
            return kind === 'video' && isLoopTarget(target) ? { kind, url: target, loop: true } : { kind, url: target };
        }
        return base.media.call(base, target);
    };
}
