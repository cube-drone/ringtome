//! Media ingest transcoder: turn an arbitrary bitmap upload into canonical AVIF.
//!
//! This is a hostile-input path. Uploads arrive as opaque bytes claiming to be some image; we
//! decode them with the pure-rust `image` crate (no C libraries such as libjpeg-turbo or libwebp),
//! behind a hard decompression-bomb guard, then re-encode the result to a size-bounded AVIF main
//! image plus a small AVIF thumbnail via `ravif`.
//!
//! Everything here is a pure function - no I/O, no shared state. It is CPU-bound; callers run
//! [`transcode`] under `tokio::task::spawn_blocking`.
//!
//! Scope for now is *stills only*. Animated inputs (multi-frame GIF, animated WebP, APNG) are
//! rejected with [`TranscodeError::Animated`] rather than silently flattened to their first frame.
//! Aesthetic "crunch" (palette reduction, colour quantisation, filtering) is deliberately out of
//! scope: we bound dimensions and re-encode, nothing more.

// The public interface below is consumed by the ingest wiring, which lands separately; within this
// binary crate on its own the items read as unused. Keep the lint quiet without hiding real dead
// code elsewhere.
#![allow(dead_code)]

use std::io::Cursor;

use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use image::imageops::FilterType;
use image::{
    AnimationDecoder, DynamicImage, ImageDecoder, ImageError, ImageFormat, ImageReader, Limits,
};
use imgref::Img;
use rgb::FromSlice;

// ---------------------------------------------------------------------------
// Tunables. Kept together and clearly named so the resize/encode policy is
// trivially adjustable later without spelunking through the logic below.
// ---------------------------------------------------------------------------

/// Decompression-bomb guard: reject any input declaring a dimension larger than this, before
/// allocating pixels for it. 16384 is comfortably above any legitimate photo yet far below the
/// sizes a malicious header uses to trigger an OOM.
const MAX_DECODE_DIMENSION: u32 = 16_384;

/// Decompression-bomb guard: cap on total decode-time allocation. A tiny file can declare
/// dimensions within the per-axis cap yet still multiply out to a huge buffer; this bounds that.
const MAX_DECODE_ALLOC_BYTES: u64 = 512 * 1024 * 1024;

/// The main (bounded) image is resized to *fit inside* this square, preserving aspect ratio.
const MAIN_BOUND: u32 = 800;

/// The thumbnail is resized to fit inside this square, preserving aspect ratio. Small on purpose:
/// thumbnails are for list/grid views and ride eagerly when browsing, so they stay tiny.
const THUMB_BOUND: u32 = 128;

/// AVIF quality (1-100). Deliberately low: 18 is the chosen crush sweet spot - dense text stays
/// legible but on the edge, with crispy visible artifacting, and typical images land at 5-20 KB.
/// This is the aesthetic *and* the size lever working together, not a fidelity setting.
const AVIF_QUALITY: f32 = 18.0;

/// AVIF alpha-channel quality (1-100). Matched to the main quality so transparency crushes with
/// the same character.
const AVIF_ALPHA_QUALITY: f32 = 18.0;

/// AVIF encoder speed (0 = slowest/best, 10 = fastest). A middle setting: quality-preserving
/// without pathological encode times on the blocking pool.
const AVIF_SPEED: u8 = 6;

/// Resampling filter for downscaling. Lanczos3 is quality-preserving (no crunch).
const RESIZE_FILTER: FilterType = FilterType::Lanczos3;

/// A successfully ingested still image: canonical AVIF plus thumbnail and final dimensions.
#[derive(Debug)]
pub struct Ingested {
    /// The transcoded main image, AVIF, bounded to fit 800x800.
    pub avif: Vec<u8>,
    /// A small AVIF thumbnail, bounded to fit 128x128.
    pub thumb_avif: Vec<u8>,
    /// Final (post-bound) width of the MAIN image.
    pub width: u32,
    /// Final (post-bound) height of the MAIN image.
    pub height: u32,
    /// Playback duration; always `None` for now (stills only).
    pub duration_ms: Option<u64>,
}

/// Why an upload could not be turned into canonical media.
#[derive(Debug)]
pub enum TranscodeError {
    /// Input has more than one frame; the "we don't support animated images yet" tombstone.
    Animated,
    /// A format we cannot decode.
    Unsupported(String),
    /// Malformed / corrupt / decompression-bomb / decode failure.
    Decode(String),
}

impl std::fmt::Display for TranscodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscodeError::Animated => {
                write!(f, "animated images are not supported yet")
            }
            TranscodeError::Unsupported(detail) => {
                write!(f, "unsupported image format: {detail}")
            }
            TranscodeError::Decode(detail) => {
                write!(f, "could not decode image: {detail}")
            }
        }
    }
}

impl std::error::Error for TranscodeError {}

/// Decode an arbitrary bitmap upload and re-encode to canonical AVIF + thumbnail.
///
/// Pure function, no I/O. CPU-bound (callers run it under `spawn_blocking`).
pub fn transcode(input: &[u8]) -> Result<Ingested, TranscodeError> {
    // Identify the format from magic bytes. An unrecognised blob is unsupported, not corrupt.
    let format = image::guess_format(input)
        .map_err(|e| TranscodeError::Unsupported(e.to_string()))?;

    // Reject animation before we commit to decoding a single frame.
    if is_animated(input, format)? {
        return Err(TranscodeError::Animated);
    }

    // Decode the (single) frame behind the decompression-bomb guard.
    let mut reader = ImageReader::new(Cursor::new(input));
    reader.set_format(format);
    reader.limits(decode_limits());
    let decoded = reader.decode().map_err(map_image_err)?;

    // Bound the main image, then derive the thumbnail from the already-bounded main.
    let main = fit_within(decoded, MAIN_BOUND);
    let width = main.width();
    let height = main.height();
    let avif = encode_avif(&main)?;

    let thumb = fit_within(main, THUMB_BOUND);
    let thumb_avif = encode_avif(&thumb)?;

    Ok(Ingested {
        avif,
        thumb_avif,
        width,
        height,
        duration_ms: None,
    })
}

/// The decode-time limits enforcing the decompression-bomb guard. Built from `no_limits()` (rather
/// than `Default`, which sets its own soft caps) so the guard is exactly and only what we declare.
fn decode_limits() -> Limits {
    let mut limits = Limits::no_limits();
    limits.max_image_width = Some(MAX_DECODE_DIMENSION);
    limits.max_image_height = Some(MAX_DECODE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    limits
}

/// Is this input animated? Only formats that *can* animate are inspected; jpeg/bmp/tiff/qoi are
/// single-frame by construction and skip the check. Detection uses each format's own frame/anim
/// API, all under the same bomb guard so a hostile "animated" header cannot allocate freely.
fn is_animated(input: &[u8], format: ImageFormat) -> Result<bool, TranscodeError> {
    match format {
        ImageFormat::Gif => {
            let mut decoder = GifDecoder::new(Cursor::new(input)).map_err(map_image_err)?;
            decoder.set_limits(decode_limits()).map_err(map_image_err)?;
            // A GIF exposes no frame count without walking it; a second frame is enough to decide.
            Ok(decoder.into_frames().take(2).count() > 1)
        }
        ImageFormat::WebP => {
            let mut decoder = WebPDecoder::new(Cursor::new(input)).map_err(map_image_err)?;
            decoder.set_limits(decode_limits()).map_err(map_image_err)?;
            Ok(decoder.has_animation())
        }
        ImageFormat::Png => {
            let mut decoder = PngDecoder::new(Cursor::new(input)).map_err(map_image_err)?;
            decoder.set_limits(decode_limits()).map_err(map_image_err)?;
            // An acTL chunk marks the PNG as an APNG (animated).
            decoder.is_apng().map_err(map_image_err)
        }
        _ => Ok(false),
    }
}

/// Resize `img` to fit inside a `bound` x `bound` square, preserving aspect ratio. Never upscales:
/// an image already within the bound is returned untouched.
fn fit_within(img: DynamicImage, bound: u32) -> DynamicImage {
    if img.width() <= bound && img.height() <= bound {
        img
    } else {
        img.resize(bound, bound, RESIZE_FILTER)
    }
}

/// Encode an RGBA view of `img` to AVIF at the configured quality/speed.
fn encode_avif(img: &DynamicImage) -> Result<Vec<u8>, TranscodeError> {
    let rgba = img.to_rgba8();
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);
    let pixels = rgba.as_raw().as_rgba();

    let encoder = ravif::Encoder::new()
        .with_quality(AVIF_QUALITY)
        .with_alpha_quality(AVIF_ALPHA_QUALITY)
        .with_speed(AVIF_SPEED);

    let encoded = encoder
        .encode_rgba(Img::new(pixels, width, height))
        .map_err(|e| TranscodeError::Decode(format!("avif encode failed: {e}")))?;

    Ok(encoded.avif_file)
}

/// Map an `image` decode error onto our taxonomy: a format the crate recognises but cannot handle
/// is `Unsupported`; everything else (corruption, truncation, tripped limits) is `Decode`.
fn map_image_err(error: ImageError) -> TranscodeError {
    let detail = error.to_string();
    match error {
        ImageError::Unsupported(_) => TranscodeError::Unsupported(detail),
        _ => TranscodeError::Decode(detail),
    }
}

/// Tests against the real fixture corpus in `sample_media/` (public-domain / CC, so distributable
/// and committed). Real-shaped data catches what synthetic PNGs can't - actual JPEG/WebP/GIF
/// decoders, transparency, animation detection, and formats we *can't* ingest. Transcoded output
/// is dumped to a gitignored `scratch/` so it can be eyeballed after a run.
#[cfg(test)]
mod corpus {
    use super::*;
    use std::path::PathBuf;

    fn corpus(name: &str) -> Vec<u8> {
        let path = format!("{}/../sample_media/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(&path).unwrap_or_else(|e| panic!("corpus fixture {name}: {e}"))
    }

    fn scratch() -> PathBuf {
        let dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../scratch/transcoded"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dump(name: &str, out: &Ingested) {
        let dir = scratch();
        std::fs::write(dir.join(format!("{name}.avif")), &out.avif).unwrap();
        std::fs::write(dir.join(format!("{name}.thumb.avif")), &out.thumb_avif).unwrap();
    }

    fn is_avif(bytes: &[u8]) -> bool {
        bytes.len() > 12 && &bytes[4..8] == b"ftyp"
    }

    #[test]
    #[ignore = "diagnostic: prints how each corpus fixture transcodes"]
    fn classify_corpus() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../sample_media");
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        names.sort();
        for name in names {
            match transcode(&std::fs::read(format!("{dir}/{name}")).unwrap()) {
                Ok(i) => println!(
                    "OK       {name}: {}x{}  avif={}KB thumb={}KB",
                    i.width,
                    i.height,
                    i.avif.len() / 1024,
                    i.thumb_avif.len() / 1024
                ),
                Err(e) => println!("REJECT   {name}: {e:?}"),
            }
        }
    }

    /// The real stills - JPEG, static WebP, static GIF, opaque and transparent PNG - all decode and
    /// re-encode to a bounded AVIF plus thumbnail, and get dumped to `scratch/` for inspection.
    /// Ignored by default: it runs a real AV1 encode per still (seconds each), which would bloat CI
    /// as the corpus grows. Run the full verify-and-dump sweep on demand with:
    ///   cargo test -p ringtome-node stills_transcode_to_bounded_avif -- --ignored --nocapture
    #[test]
    #[ignore = "slow (one AV1 encode per still); on-demand verify + dump to scratch/"]
    fn stills_transcode_to_bounded_avif() {
        for name in [
            "polaroid.jpg",
            "its_webp.webp",
            "non_animated.gif",
            "floppy.png",
            "ready_or_not_transparent.png",
        ] {
            let out = transcode(&corpus(name))
                .unwrap_or_else(|e| panic!("{name} should transcode, got {e:?}"));
            assert!(out.width > 0 && out.height > 0, "{name} has real dimensions");
            assert!(
                out.width <= 800 && out.height <= 800,
                "{name} is bounded to 800x800 (got {}x{})",
                out.width,
                out.height
            );
            assert!(is_avif(&out.avif), "{name} body is a real AVIF");
            assert!(is_avif(&out.thumb_avif), "{name} thumb is a real AVIF");
            assert_eq!(out.duration_ms, None, "{name} is a still");
            dump(name, &out);
        }
    }

    /// Curiosity, not a permanent path: re-encode the stills at an arbitrary AVIF quality, chosen
    /// via the `CRONCH_Q` env var (default 18), into `scratch/q<n>/` - so dialing in a quality is
    /// an env change, not a recompile. Reuses the real decode + 800px bound, swapping only the
    /// encoder quality (clamped to ravif's valid 1..=100). Run with:
    ///   CRONCH_Q=18 cargo test -p ringtome-node dump_stills_at_quality -- --ignored --nocapture
    #[test]
    #[ignore = "curiosity: re-encode stills at CRONCH_Q (default 18) into scratch/q<n>/"]
    fn dump_stills_at_quality() {
        use image::ImageReader;
        use imgref::Img;
        use rgb::FromSlice;
        use std::io::Cursor;

        let q: f32 = std::env::var("CRONCH_Q")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(18.0)
            .clamp(1.0, 100.0);
        let src = concat!(env!("CARGO_MANIFEST_DIR"), "/../sample_media");
        let out = PathBuf::from(format!(
            "{}/../scratch/q{}",
            env!("CARGO_MANIFEST_DIR"),
            q as u32
        ));
        std::fs::create_dir_all(&out).unwrap();

        // Every corpus fixture the real pipeline would accept as a still - so new images (and these
        // text-dense ones) get picked up automatically; animated/video/undecodable are skipped.
        let mut names: Vec<_> = std::fs::read_dir(src)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        names.sort();

        for name in names {
            let input = std::fs::read(format!("{src}/{name}")).unwrap();
            let Ok(format) = image::guess_format(&input) else {
                println!("skip {name}: not an image");
                continue;
            };
            if is_animated(&input, format).unwrap_or(true) {
                println!("skip {name}: animated");
                continue;
            }
            let mut reader = ImageReader::new(Cursor::new(&input));
            reader.set_format(format);
            reader.limits(decode_limits());
            let decoded = match reader.decode() {
                Ok(d) => d,
                Err(e) => {
                    println!("skip {name}: {e}");
                    continue;
                }
            };
            let main = fit_within(decoded, MAIN_BOUND);

            let rgba = main.to_rgba8();
            let (w, h) = (rgba.width() as usize, rgba.height() as usize);
            let encoded = ravif::Encoder::new()
                .with_quality(q)
                .with_alpha_quality(q)
                .with_speed(AVIF_SPEED)
                .encode_rgba(Img::new(rgba.as_raw().as_rgba(), w, h))
                .unwrap();
            std::fs::write(out.join(format!("{name}.q{}.avif", q as u32)), &encoded.avif_file)
                .unwrap();
            println!("q{:<3} {name}: {w}x{h}  {} bytes", q as u32, encoded.avif_file.len());
        }
    }

    /// Animated GIF and animated WebP hit the "we don't do animation yet" tombstone rather than
    /// silently flattening to frame 0.
    #[test]
    fn animation_is_rejected() {
        for name in [
            "animated_color_squirrel.gif",
            "animated_logo_transparent_background.gif",
            "animated_logo_transparent_background.webp",
        ] {
            match transcode(&corpus(name)) {
                Err(TranscodeError::Animated) => {}
                other => panic!("{name} should be the animation tombstone, got {other:?}"),
            }
        }
    }

    /// A video isn't a decodable still, and - a real, slightly ironic limitation the corpus caught
    /// - neither is an AVIF *input*: our decoder is pure-Rust with no AV1 decode path, so we can
    /// emit AVIF but not ingest it. Both are rejected, never silently mis-handled.
    #[test]
    fn video_and_avif_input_are_rejected() {
        assert!(
            matches!(
                transcode(&corpus("buck-twenty.mp4")),
                Err(TranscodeError::Unsupported(_) | TranscodeError::Decode(_))
            ),
            "a video is not an ingestible image"
        );
        assert!(
            matches!(
                transcode(&corpus("retro.avif")),
                Err(TranscodeError::Unsupported(_))
            ),
            "AVIF input can't be decoded without an AV1 decoder (known gap)"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::gif::GifEncoder;
    use image::{DynamicImage, Frame, Rgb, RgbImage, Rgba, RgbaImage};

    /// Encode a `DynamicImage` to in-memory PNG bytes (test input generator).
    fn png_bytes(img: &DynamicImage) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).expect("encode png");
        buf.into_inner()
    }

    /// A simple RGB gradient of the given size, as a `DynamicImage`.
    fn gradient(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 100])
        }))
    }

    /// Parse an AVIF and return the dimensions declared by its AV1 sequence header. This both
    /// proves the produced bytes are a well-formed, parseable AVIF *and* recovers dimensions -
    /// done with the pure-rust `avif-parse` because `image` cannot decode AVIF without dav1d (C).
    fn avif_dims(bytes: &[u8]) -> (u32, u32) {
        let data =
            avif_parse::read_avif(&mut Cursor::new(bytes)).expect("output is a valid AVIF");
        let meta = data
            .primary_item_metadata()
            .expect("AVIF has a parseable AV1 sequence header");
        (
            u32::from(meta.max_frame_width),
            u32::from(meta.max_frame_height),
        )
    }

    #[test]
    fn transcode_png_produces_decodable_avif() {
        let input = png_bytes(&gradient(1200, 900));
        let out = transcode(&input).expect("transcode succeeds");

        assert_eq!(out.duration_ms, None);

        // Main image: decodes back, fits 800x800, aspect ratio preserved (1200x900 -> 800x600),
        // longest side pinned to the bound, and reported dimensions match the encoded bytes.
        let (w, h) = avif_dims(&out.avif);
        assert!(w <= MAIN_BOUND && h <= MAIN_BOUND, "main fits the bound");
        assert!(
            w == MAIN_BOUND || h == MAIN_BOUND,
            "longest side is pinned to the bound"
        );
        assert_eq!((w, h), (800, 600), "aspect ratio preserved");
        assert_eq!((w, h), (out.width, out.height), "reported dims match encoded");

        // Thumbnail: decodes back and fits the (128x128) thumbnail bound.
        let (tw, th) = avif_dims(&out.thumb_avif);
        assert!(tw <= THUMB_BOUND && th <= THUMB_BOUND, "thumb fits the bound");
    }

    #[test]
    fn small_image_is_not_upscaled() {
        let input = png_bytes(&gradient(100, 60));
        let out = transcode(&input).expect("transcode succeeds");

        assert_eq!((out.width, out.height), (100, 60), "main not upscaled");
        assert_eq!(avif_dims(&out.avif), (100, 60), "encoded dims unchanged");
    }

    #[test]
    fn animated_gif_is_rejected() {
        // Build a 2-frame GIF in memory.
        let mut bytes = Vec::new();
        {
            let mut encoder = GifEncoder::new(&mut bytes);
            for _ in 0..2 {
                let frame = Frame::new(RgbaImage::from_pixel(8, 8, Rgba([200, 100, 50, 255])));
                encoder.encode_frame(frame).expect("encode gif frame");
            }
        }

        assert!(matches!(
            transcode(&bytes),
            Err(TranscodeError::Animated)
        ));
    }

    #[test]
    fn garbage_bytes_are_a_decode_error_not_a_panic() {
        // Must return Err (Decode or Unsupported), never panic.
        assert!(transcode(b"definitely not an image").is_err());
    }

    /// Standard CRC-32 (IEEE) - PNG chunk checksums, so we can hand-craft a header. Tiny enough
    /// to inline rather than pull a dependency.
    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    /// Append a PNG chunk given its type-and-data (4-byte type followed by payload).
    fn push_chunk(out: &mut Vec<u8>, type_and_data: &[u8]) {
        let payload_len = (type_and_data.len() - 4) as u32;
        out.extend_from_slice(&payload_len.to_be_bytes());
        out.extend_from_slice(type_and_data);
        out.extend_from_slice(&crc32(type_and_data).to_be_bytes());
    }

    /// A minimal, valid-header PNG (signature + IHDR + IEND) whose IHDR *declares* the given
    /// dimensions. There are no actual pixels: the point is a tiny file claiming an enormous size.
    fn png_declaring_dimensions(width: u32, height: u32) -> Vec<u8> {
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

        let mut ihdr = Vec::from(*b"IHDR");
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.push(8); // bit depth
        ihdr.push(2); // colour type: RGB
        ihdr.push(0); // compression
        ihdr.push(0); // filter
        ihdr.push(0); // interlace
        push_chunk(&mut out, &ihdr);

        push_chunk(&mut out, b"IEND");
        out
    }

    /// The decompression-bomb guard. We craft a tiny PNG whose header *declares* 100000x100000 -
    /// no such buffer exists on disk. `transcode` must reject it as `Decode` (never OOM/panic),
    /// and we additionally assert the rejection is specifically the `Limits` guard firing on the
    /// declared dimensions, not merely the absence of pixel data.
    #[test]
    fn bomb_dimensions_are_limited() {
        let bomb = png_declaring_dimensions(100_000, 100_000);

        match transcode(&bomb) {
            Err(TranscodeError::Decode(_)) => {}
            other => panic!("expected Decode from the bomb guard, got {other:?}"),
        }

        // Prove it is the Limits guard, not just malformed/missing image data.
        let mut reader = ImageReader::new(Cursor::new(&bomb));
        reader.set_format(ImageFormat::Png);
        reader.limits(decode_limits());
        assert!(
            matches!(reader.decode(), Err(ImageError::Limits(_))),
            "over-limit dimensions must trip the Limits guard"
        );
    }
}
