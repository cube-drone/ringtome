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

pub mod audio;
pub mod image;
pub mod video;
