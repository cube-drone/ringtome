//! The crush trilogy: every uploaded byte-blob becomes canonical, bounded, crushed media here.
//!
//! Three siblings with one grammar - [`image::crush`], [`video::crush`], [`audio::crush`] - each
//! a pure, CPU-bound function (callers use `spawn_blocking`) taking hostile bytes to a `Crushed`
//! output or a `CrushError`. The module name qualifies; the verb stays the same.
//!
//!   - [`image`]: stills -> AVIF (+ thumbnail). Decodes with the pure-rust `image` crate + rav1d.
//!   - [`video`]: the closed intermediary set (AV1-WebM, APNG frames, animated images) -> AV1-WebM
//!     or crushed APNG per the transparency/audio routing rule.
//!   - [`audio`]: the wild formats (mp3/aac/flac/wav/vorbis) -> fit-to-cap Ogg Opus.
//!
//! [`crush`] is the one door the ingest worker calls: it sniffs an upload and routes it to the
//! right lane, returning a uniform [`Ingested`]. This is where an animated image (GIF/APNG/WebP)
//! stops being the "we don't do animation" tombstone and becomes a silent video instead.

pub mod audio;
pub mod image;
pub mod video;

use crate::record::documents::Format;

/// EBML magic - a WebM (the video lane's compact intermediary).
const EBML_MAGIC: [u8; 4] = [0x1A, 0x45, 0xDF, 0xA3];

/// Uniform crushed-media result for the ingest worker: the canonical body bytes, the [`Format`]
/// they are stored and served under, an optional thumbnail (its own sibling blob), and the
/// measured metadata. Every metadata field is optional because the kinds carry different facts:
/// audio has no dimensions, stills have no duration, and video has no thumbnail yet.
pub struct Ingested {
    pub body: Vec<u8>,
    pub format: Format,
    /// A small AVIF thumbnail: the image's own thumb, an audio waveform, a video's poster frame, or
    /// `None` (passthrough audio has none).
    pub thumb_avif: Option<Vec<u8>>,
    /// A silent AV1-in-WebM hover-preview clip - video's WebM output only; `None` for stills, audio,
    /// and the self-animating APNG output.
    pub preview_webm: Option<Vec<u8>>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
}

/// Why an upload could not be crushed - the union of the three lanes' failures. The ingest worker
/// turns this into the user-visible tombstone.
#[derive(Debug)]
pub enum CrushError {
    /// Not any media we accept (wrong container/codec), or garbage.
    Unsupported(String),
    /// Malformed / corrupt / decompression-bomb / decode-or-encode failure.
    Decode(String),
    /// Time-based media longer than the crush budget can fit - a misbehaving client.
    TooLong(String),
}

impl std::fmt::Display for CrushError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CrushError::Unsupported(s) => write!(f, "unsupported media: {s}"),
            CrushError::Decode(s) => write!(f, "could not decode: {s}"),
            CrushError::TooLong(s) => write!(f, "too long to crush: {s}"),
        }
    }
}

impl std::error::Error for CrushError {}

/// The one door. Sniff an upload and route it to the still-image, video, or audio lane, returning a
/// uniform [`Ingested`]. Animated images route to the VIDEO lane (transparency there decides APNG
/// vs AV1-WebM). A non-image that is not a WebM is handed to the audio lane, which sniffs it itself
/// and errors cleanly on garbage. Every lane re-decodes and re-encodes - laundering - so nothing
/// here trusts the incoming bytes.
pub fn crush(bytes: &[u8]) -> Result<Ingested, CrushError> {
    match image::detect(bytes) {
        image::Detected::Still => image::crush(bytes)
            .map(Ingested::from_image)
            .map_err(CrushError::from_image),
        image::Detected::Animated => crush_as_video(bytes),
        image::Detected::NotImage if bytes.starts_with(&EBML_MAGIC) => crush_as_video(bytes),
        image::Detected::NotImage => audio::crush(bytes, audio::CrushOpts { max_bytes: None })
            .map(Ingested::from_audio)
            .map_err(CrushError::from_audio),
    }
}

/// The one door, sidecar edition: `audio` is the browser pre-encoder's fallback-lane Ogg Opus,
/// shipped separately because the frames lane's APNG can't carry sound. Only APNG frames accept
/// it; a WebM's audio rides inside the container (the sidecar is ignored there), and anything
/// else with a sidecar is a client speaking a protocol we don't - refused plainly.
pub fn crush_with_sidecar(bytes: &[u8], audio: Option<&[u8]>) -> Result<Ingested, CrushError> {
    let Some(audio) = audio else {
        return crush(bytes);
    };
    match image::detect(bytes) {
        image::Detected::Animated => {
            video::crush(bytes, Some(audio), video::CrushOpts { max_frames: None })
                .map(Ingested::from_video)
                .map_err(CrushError::from_video)
        }
        image::Detected::NotImage if bytes.starts_with(&EBML_MAGIC) => crush_as_video(bytes),
        _ => Err(CrushError::Unsupported(
            "an audio sidecar only rides with video frames".into(),
        )),
    }
}

/// The video lane, for an animated image or a WebM. A bare upload carries no side-channel audio:
/// an animated image is silent, and a WebM's audio rides inside the container.
fn crush_as_video(bytes: &[u8]) -> Result<Ingested, CrushError> {
    video::crush(bytes, None, video::CrushOpts { max_frames: None })
        .map(Ingested::from_video)
        .map_err(CrushError::from_video)
}

impl Ingested {
    fn from_image(c: image::Crushed) -> Self {
        Ingested {
            body: c.avif,
            format: Format::Avif,
            thumb_avif: Some(c.thumb_avif),
            preview_webm: None,
            width: Some(c.width),
            height: Some(c.height),
            duration_ms: c.duration_ms,
        }
    }

    fn from_video(c: video::Crushed) -> Self {
        let format = match c.format {
            video::CrushedFormat::Apng => Format::Apng,
            video::CrushedFormat::WebmAv1 => Format::WebmAv1,
        };
        Ingested {
            body: c.bytes,
            format,
            // The video lane's static poster fills the uniform thumbnail slot; its silent motion
            // preview (WebM output only) rides its own sibling field.
            thumb_avif: Some(c.poster_avif),
            preview_webm: c.preview_webm,
            width: Some(c.width),
            height: Some(c.height),
            duration_ms: Some(c.duration_ms),
        }
    }

    fn from_audio(c: audio::Crushed) -> Self {
        Ingested {
            body: c.bytes,
            format: Format::OggOpus,
            thumb_avif: c.waveform_avif,
            preview_webm: None,
            width: None,
            height: None,
            duration_ms: Some(c.duration_ms),
        }
    }
}

impl CrushError {
    fn from_image(e: image::CrushError) -> Self {
        match e {
            // Animated inputs route to the video lane before `image::crush` is called, so this
            // cannot arise from the dispatcher; map defensively rather than panic.
            image::CrushError::Animated => {
                CrushError::Unsupported("animated image reached the still lane".into())
            }
            image::CrushError::Unsupported(s) => CrushError::Unsupported(s),
            image::CrushError::Decode(s) => CrushError::Decode(s),
        }
    }

    fn from_video(e: video::CrushError) -> Self {
        match e {
            video::CrushError::Unsupported(s) => CrushError::Unsupported(s),
            video::CrushError::Decode(s) => CrushError::Decode(s),
            video::CrushError::TooLong(s) => CrushError::TooLong(s),
        }
    }

    fn from_audio(e: audio::CrushError) -> Self {
        match e {
            audio::CrushError::Unsupported(s) => CrushError::Unsupported(s),
            audio::CrushError::Decode(s) => CrushError::Decode(s),
            audio::CrushError::TooLong(s) => CrushError::TooLong(s),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        let path = format!("{}/../sample_media/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(&path).unwrap_or_else(|e| panic!("corpus fixture {name}: {e}"))
    }

    /// A still image routes to the AVIF lane: an image thumbnail, dimensions, no duration.
    #[test]
    fn still_image_routes_to_avif() {
        let out = crush(&corpus("polaroid.jpg")).expect("still crushes");
        assert_eq!(out.format, Format::Avif);
        assert!(out.thumb_avif.is_some(), "stills carry a thumbnail");
        assert!(out.width.is_some() && out.height.is_some());
        assert_eq!(out.duration_ms, None);
    }

    /// The animated-image -> video path: a TRANSPARENT animated image lands as a crushed APNG
    /// (alpha preserved, no AV1). This is the old "we don't do animation" tombstone, un-done.
    #[test]
    fn transparent_animation_routes_to_apng() {
        let out = crush(&corpus("animated_logo_transparent_background.gif")).expect("crushes");
        assert_eq!(out.format, Format::Apng, "transparent + silent -> APNG");
        assert!(out.width.is_some());
        assert!(out.duration_ms.is_some(), "animation has a duration");
    }

    /// Audio routes to Ogg Opus: a waveform thumbnail, a duration, and NO dimensions.
    #[test]
    fn audio_routes_to_ogg_opus() {
        let out = crush(&corpus("buck-audio.mp3")).expect("audio crushes");
        assert_eq!(out.format, Format::OggOpus);
        assert_eq!(out.width, None);
        assert_eq!(out.height, None);
        assert!(out.duration_ms.is_some());
        assert!(out.thumb_avif.is_some(), "the decode lane draws a waveform");
    }

    /// Garbage - not any media we accept - is a clean Unsupported, never a panic.
    #[test]
    fn garbage_is_unsupported() {
        assert!(matches!(
            crush(b"this is definitely not any kind of media file at all"),
            Err(CrushError::Unsupported(_))
        ));
    }

    /// The AV1-encode routes (WebM in, opaque animation) - proven end to end but slow, so on-demand.
    #[test]
    #[ignore = "slow: full AV1 re-encode through the video lane"]
    fn video_routes_to_webm() {
        let webm = crush(&corpus("chrome_intermediary.webm")).expect("webm crushes");
        assert_eq!(webm.format, Format::WebmAv1);
        assert!(webm.duration_ms.is_some());
        // Video now fills the thumbnail slot (a poster frame) AND carries a hover-preview clip.
        assert!(
            webm.thumb_avif.is_some(),
            "video carries a poster thumbnail"
        );
        assert!(webm.preview_webm.is_some(), "video carries a preview clip");
        let opaque =
            crush(&corpus("animated_color_squirrel.gif")).expect("opaque animation crushes");
        assert_eq!(opaque.format, Format::WebmAv1);
        assert!(
            opaque.preview_webm.is_some(),
            "opaque animation carries a preview"
        );
    }
}
