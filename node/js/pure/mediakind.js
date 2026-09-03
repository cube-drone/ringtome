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

/// A profile `media()` that knows ringtome's spellings before deferring to the base
/// profile's table. `base` supplies `linkAllowed` (the scheme policy stays the base's) and
/// the fallback `media`.
export function mediaResolver(base) {
    return function media(target) {
        const kind = ownMediaKind(target);
        if (kind && base.linkAllowed(target)) return { kind, url: target };
        return base.media.call(base, target);
    };
}
