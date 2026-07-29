//! Media ingest transcoder: turn an arbitrary bitmap upload into canonical AVIF.
//!
//! This is a hostile-input path. Uploads arrive as opaque bytes claiming to be some image; we
//! decode them with the pure-rust `image` crate (no C libraries such as libjpeg-turbo or libwebp),
//! behind a hard decompression-bomb guard, then re-encode the result to a size-bounded AVIF main
//! image plus a small AVIF thumbnail via `ravif`.
//!
//! Everything here is a pure function - no I/O, no shared state. It is CPU-bound; callers run
//! [`crush`] under `tokio::task::spawn_blocking`.
//!
//! Scope for now is *stills only*. Animated inputs (multi-frame GIF, animated WebP, APNG) are
//! rejected with [`CrushError::Animated`] rather than silently flattened to their first frame.
//! Aesthetic "crunch" (palette reduction, colour quantisation, filtering) is deliberately out of
//! scope: we bound dimensions and re-encode, nothing more.

// The public interface below is consumed by the ingest wiring, which lands separately; within this
// binary crate on its own the items read as unused. Keep the lint quiet without hiding real dead
// code elsewhere.
#![allow(dead_code)]

use std::io::Cursor;
use std::mem::MaybeUninit;
use std::ptr::NonNull;

use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use image::imageops::FilterType;
use image::{
    AnimationDecoder, DynamicImage, ImageDecoder, ImageError, ImageFormat, ImageReader, Limits,
    Rgba, RgbaImage,
};
use imgref::Img;
use rgb::FromSlice;

// rav1d's public surface is the raw `dav1d_*` C ABI plus the `Dav1d*` FFI structs. We drive it
// directly (there is no safe wrapper crate for the no-asm, pure-rust build) and keep every unsafe
// touch inside `decode_av1` below.
use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_data_unref, dav1d_default_settings, dav1d_get_picture,
    dav1d_open, dav1d_picture_unref, dav1d_send_data,
};

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

/// AVIF quality (1-100). Was 18 for a while - the "crush" aesthetic, crispy artifacts as a
/// design nod - which turned out less fun in practice than in theory (field-tested 2026-07-28).
/// 90 is a proper fidelity setting: photos look like photos; AVIF still keeps files reasonable.
const AVIF_QUALITY: f32 = 90.0;

/// AVIF alpha-channel quality (1-100). Matched to the main quality so transparency keeps the
/// same fidelity.
const AVIF_ALPHA_QUALITY: f32 = 90.0;

/// AVIF encoder speed (0 = slowest/best, 10 = fastest). A middle setting: quality-preserving
/// without pathological encode times on the blocking pool.
const AVIF_SPEED: u8 = 6;

/// Resampling filter for downscaling. Lanczos3 is quality-preserving (no crunch).
const RESIZE_FILTER: FilterType = FilterType::Lanczos3;

/// A successfully ingested still image: canonical AVIF plus thumbnail and final dimensions.
#[derive(Debug)]
pub struct Crushed {
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
pub enum CrushError {
    /// Input has more than one frame; the "we don't support animated images yet" tombstone.
    Animated,
    /// A format we cannot decode.
    Unsupported(String),
    /// Malformed / corrupt / decompression-bomb / decode failure.
    Decode(String),
}

impl std::fmt::Display for CrushError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CrushError::Animated => {
                write!(f, "animated images are not supported yet")
            }
            CrushError::Unsupported(detail) => {
                write!(f, "unsupported image format: {detail}")
            }
            CrushError::Decode(detail) => {
                write!(f, "could not decode image: {detail}")
            }
        }
    }
}

impl std::error::Error for CrushError {}

/// Decode an arbitrary bitmap upload and re-encode to canonical AVIF + thumbnail.
///
/// Pure function, no I/O. CPU-bound (callers run it under `spawn_blocking`).
pub fn crush(input: &[u8]) -> Result<Crushed, CrushError> {
    // Identify the format from magic bytes. An unrecognised blob is unsupported, not corrupt.
    // (`guess_format` recognises the AVIF magic even though the `image` crate has no AVIF decoder
    // enabled - it inspects the ISOBMFF brand, not the feature set.)
    let format = image::guess_format(input).map_err(|e| CrushError::Unsupported(e.to_string()))?;

    // AVIF inputs take the pure-rust rav1d decode path (the `image` crate can't decode them).
    if format == ImageFormat::Avif {
        return transcode_avif(input);
    }

    // Reject animation before we commit to decoding a single frame.
    if is_animated(input, format)? {
        return Err(CrushError::Animated);
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
    // The canonical body carries the content-neutral "processed here" marker; the thumbnail does not.
    let avif = add_ringtome_marker(encode_avif(&main)?);

    let thumb = fit_within(main, THUMB_BOUND);
    let thumb_avif = encode_avif(&thumb)?;

    Ok(Crushed {
        avif,
        thumb_avif,
        width,
        height,
        duration_ms: None,
    })
}

/// Ingest an AVIF upload. Unlike the other formats we can *emit* AVIF verbatim, so an already-in-spec,
/// already-marked AVIF passes through untouched (zero re-encode, zero generational loss); anything
/// oversized, unmarked, or foreign is decoded and re-crushed like any other upload.
fn transcode_avif(input: &[u8]) -> Result<Crushed, CrushError> {
    // Decompression-bomb guard: reject on the container-declared dimensions before decoding pixels.
    let (w, h) = avif_dimensions(input)?;
    if w > MAX_DECODE_DIMENSION || h > MAX_DECODE_DIMENSION {
        return Err(CrushError::Decode(format!(
            "avif declares {w}x{h}, over the {MAX_DECODE_DIMENSION}px decode bound"
        )));
    }

    // We need the decoded pixels for the thumbnail regardless of whether the body passes through.
    let decoded = decode_avif(input)?;

    let in_spec = w <= MAIN_BOUND && h <= MAIN_BOUND;
    let (avif, width, height) = if in_spec && has_ringtome_marker(input) {
        // Already ours and already in spec: hand the exact bytes back, avoiding a generational loss.
        (input.to_vec(), w, h)
    } else {
        // Oversized, unmarked, or foreign: bound, re-encode, and mark.
        let main = fit_within(decoded.clone(), MAIN_BOUND);
        let (bw, bh) = (main.width(), main.height());
        (add_ringtome_marker(encode_avif(&main)?), bw, bh)
    };

    let thumb = fit_within(decoded, THUMB_BOUND);
    let thumb_avif = encode_avif(&thumb)?;

    Ok(Crushed {
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

/// The media dispatcher's routing verdict for these bytes: a still this lane crushes, an animated
/// image that belongs in the video lane, or not an image at all (a video/audio container, or
/// garbage). Magic-byte + frame-count inspection only - no full decode.
pub(super) enum Detected {
    Still,
    Animated,
    NotImage,
}

/// Classify an upload for [`crate::media::crush`]. `guess_format` recognises only image containers,
/// so a WebM/Ogg/WAV/MP3 (or garbage) lands as `NotImage` and routes elsewhere; a recognised image
/// splits still-vs-animated by frame count. A recognised-but-corrupt image stays `Still` so the
/// still lane surfaces the real decode error rather than silently rerouting it to audio.
pub(super) fn detect(input: &[u8]) -> Detected {
    let Ok(format) = image::guess_format(input) else {
        return Detected::NotImage;
    };
    match is_animated(input, format) {
        Ok(true) => Detected::Animated,
        Ok(false) => Detected::Still,
        Err(_) => Detected::Still,
    }
}

/// Is this input animated? Only formats that *can* animate are inspected; jpeg/bmp/tiff/qoi are
/// single-frame by construction and skip the check. Detection uses each format's own frame/anim
/// API, all under the same bomb guard so a hostile "animated" header cannot allocate freely.
fn is_animated(input: &[u8], format: ImageFormat) -> Result<bool, CrushError> {
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
fn encode_avif(img: &DynamicImage) -> Result<Vec<u8>, CrushError> {
    let rgba = img.to_rgba8();
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);
    let pixels = rgba.as_raw().as_rgba();

    // Force 8-bit output (ravif otherwise defaults to 10-bit via `BitDepth::Auto`). This is a
    // deliberate policy, not a decode limitation - our decoder now handles 10/12-bit foreign AVIFs
    // via rav1d's `bitdepth_16`. But 8-bit is the right *output*: visually equivalent at our
    // quality while smaller, and keeping our canonical body 8-bit keeps the in-spec
    // self-passthrough exact (the pass-through path decodes every AVIF for its thumbnail).
    let encoder = ravif::Encoder::new()
        .with_quality(AVIF_QUALITY)
        .with_alpha_quality(AVIF_ALPHA_QUALITY)
        .with_speed(AVIF_SPEED)
        .with_bit_depth(ravif::BitDepth::Eight);

    let encoded = encoder
        .encode_rgba(Img::new(pixels, width, height))
        .map_err(|e| CrushError::Decode(format!("avif encode failed: {e}")))?;

    Ok(encoded.avif_file)
}

// ---------------------------------------------------------------------------
// AVIF ingest: container parse (avif-parse) + AV1 decode (rav1d, no asm) + a
// content-neutral "processed here" marker. All pure-rust, no C/dav1d.
// ---------------------------------------------------------------------------

/// A fixed, content-neutral magic marking an AVIF as "processed by a Ringtome node". It carries NO
/// identity whatsoever - no document id, no pubkey, no timestamp. Provenance lives in the chain,
/// never in the pixels' container. Its only job is to let us recognise our own in-spec output and
/// pass it through unmodified instead of re-crushing it on every hop.
const RINGTOME_MARKER: &[u8] = b"RNGTMv1";

/// Append a top-level ISOBMFF `free` box whose payload begins with [`RINGTOME_MARKER`]. `free`/`skip`
/// boxes are defined as ignorable free space, so every conformant AVIF decoder (and every browser)
/// skips them: the marked file still renders and still round-trips through [`decode_avif`].
fn add_ringtome_marker(mut avif: Vec<u8>) -> Vec<u8> {
    // Box layout: [u32 be size][b"free"][payload]. size counts the whole box (header + payload).
    let box_size = (8 + RINGTOME_MARKER.len()) as u32;
    avif.extend_from_slice(&box_size.to_be_bytes());
    avif.extend_from_slice(b"free");
    avif.extend_from_slice(RINGTOME_MARKER);
    avif
}

/// Scan the top-level ISOBMFF box list for a `free` box whose payload starts with [`RINGTOME_MARKER`].
/// Handles the three size encodings: a following u64 `largesize` when size==1, and "extends to EOF"
/// when size==0. Malformed/overlong boxes stop the scan rather than reading out of bounds.
fn has_ringtome_marker(avif: &[u8]) -> bool {
    let len = avif.len();
    let mut pos = 0usize;
    while pos + 8 <= len {
        let size32 = u32::from_be_bytes([avif[pos], avif[pos + 1], avif[pos + 2], avif[pos + 3]]);
        let box_type = &avif[pos + 4..pos + 8];
        let (header_len, box_size) = match size32 {
            1 => {
                if pos + 16 > len {
                    break;
                }
                let large = u64::from_be_bytes(avif[pos + 8..pos + 16].try_into().unwrap());
                (16usize, large as usize)
            }
            0 => (8usize, len - pos), // to EOF
            n => (8usize, n as usize),
        };
        // A box smaller than its own header, or one claiming to run past EOF, is malformed: stop.
        if box_size < header_len || box_size > len - pos {
            break;
        }
        if box_type == b"free"
            && avif[pos + header_len..pos + box_size].starts_with(RINGTOME_MARKER)
        {
            return true;
        }
        pos += box_size;
    }
    false
}

/// The primary item's coded dimensions, read from the AVIF container's AV1 sequence header. Used by
/// the decompression-bomb guard (before any pixels are touched) and the in-spec pass-through check.
fn avif_dimensions(input: &[u8]) -> Result<(u32, u32), CrushError> {
    let data = avif_parse::read_avif(&mut Cursor::new(input)).map_err(map_avif_parse_err)?;
    let meta = data.primary_item_metadata().map_err(map_avif_parse_err)?;
    Ok((meta.max_frame_width.get(), meta.max_frame_height.get()))
}

/// Map an avif-parse container error onto our taxonomy. avif-parse rejects animated AVIF (the `avis`
/// brand) up front with a distinctive `Unsupported` message - that becomes our `Animated` tombstone,
/// so image-sequence detection here is real, not assumed.
fn map_avif_parse_err(error: avif_parse::Error) -> CrushError {
    use avif_parse::Error;
    match error {
        Error::Unsupported(msg) if msg.contains("Animated") => CrushError::Animated,
        Error::Unsupported(msg) => CrushError::Unsupported(msg.to_string()),
        other => CrushError::Decode(format!("avif container parse failed: {other}")),
    }
}

/// Decode an AVIF still to an RGBA8 `DynamicImage`, pure-rust: avif-parse extracts the primary (and
/// optional alpha) AV1 item; rav1d decodes the AV1 bitstream; we convert YUV->RGBA ourselves.
fn decode_avif(input: &[u8]) -> Result<DynamicImage, CrushError> {
    let data = avif_parse::read_avif(&mut Cursor::new(input)).map_err(map_avif_parse_err)?;

    // Bomb guard again, right at the decode boundary: reject before allocating/decoding pixels.
    let meta = data.primary_item_metadata().map_err(map_avif_parse_err)?;
    let (w, h) = (meta.max_frame_width.get(), meta.max_frame_height.get());
    if w > MAX_DECODE_DIMENSION || h > MAX_DECODE_DIMENSION {
        return Err(CrushError::Decode(format!(
            "avif declares {w}x{h}, over the {MAX_DECODE_DIMENSION}px decode bound"
        )));
    }

    // SAFETY: `decode_av1` is a safe wrapper - it owns the entire rav1d context lifecycle and copies
    // every plane out into owned Vecs before returning, so no rav1d-owned pointer escapes it.
    let color = decode_av1(&data.primary_item)?;
    let mut rgba = decoded_to_rgba(&color);

    if let Some(alpha_bitstream) = data.alpha_item.as_deref() {
        let alpha = decode_av1(alpha_bitstream)?;
        apply_alpha(&mut rgba, &alpha, data.premultiplied_alpha);
    }

    Ok(DynamicImage::ImageRgba8(rgba))
}

/// A decoded AV1 frame, copied out of rav1d into owned buffers (planes are packed tight, stride
/// padding removed) so all downstream work is safe. `layout` is the dav1d pixel layout (0=I400,
/// 1=I420, 2=I422, 3=I444); `matrix`/`full_range` come from the AV1 sequence header.
struct DecodedPicture {
    width: u32,
    height: u32,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
    uv_width: usize,
    layout: u32,
    matrix: u32,
    full_range: bool,
    monochrome: bool,
}

/// Drive rav1d's C ABI to decode a single-frame AV1 bitstream. This is the *only* unsafe in the AVIF
/// path; it opens a context, feeds the one OBU frame, pulls the picture, copies the planes out, and
/// tears everything down (picture + data + context) before returning owned, safe data.
fn decode_av1(bitstream: &[u8]) -> Result<DecodedPicture, CrushError> {
    if bitstream.is_empty() {
        return Err(CrushError::Decode("empty AV1 bitstream".into()));
    }

    // SAFETY: every pointer handed to rav1d below points at a live local (`settings`, `ctx`, `data`,
    // `pic`); `dav1d_default_settings`/`dav1d_data_create`/`dav1d_get_picture` fully initialise the
    // structs they write via `ptr::write` before we read them; and we unref the picture and data and
    // close the context on every exit path, so nothing leaks and no rav1d-owned memory escapes.
    unsafe {
        // Settings: single-threaded, minimal frame delay, so one send + one get yields the frame.
        let mut settings = MaybeUninit::<Dav1dSettings>::uninit();
        dav1d_default_settings(NonNull::new(settings.as_mut_ptr()).unwrap());
        let mut settings = settings.assume_init();
        settings.n_threads = 1;
        settings.max_frame_delay = 1;

        let mut ctx: Option<Dav1dContext> = None;
        if dav1d_open(NonNull::new(&mut ctx), NonNull::new(&mut settings)).0 != 0 || ctx.is_none() {
            return Err(CrushError::Decode("dav1d_open failed".into()));
        }

        // Copy the bitstream into a rav1d-allocated `Dav1dData`.
        let mut data = MaybeUninit::<Dav1dData>::uninit();
        let dst = dav1d_data_create(NonNull::new(data.as_mut_ptr()), bitstream.len());
        if dst.is_null() {
            dav1d_close(NonNull::new(&mut ctx));
            return Err(CrushError::Decode("dav1d_data_create failed".into()));
        }
        let mut data = data.assume_init();
        std::ptr::copy_nonoverlapping(bitstream.as_ptr(), dst, bitstream.len());

        // A zeroed picture is a valid "empty" picture (all refs None), safe to unref even if we never
        // fill it. `dav1d_get_picture` overwrites it wholesale via `ptr::write`.
        let mut pic = MaybeUninit::<Dav1dPicture>::zeroed().assume_init();

        // Feed the frame, then pull the picture. For a single still with max_frame_delay=1 this is one
        // send + one get; the bounded loop only re-feeds if rav1d asks and still has bytes queued.
        let mut got = false;
        let _ = dav1d_send_data(ctx, NonNull::new(&mut data));
        for _ in 0..64 {
            if dav1d_get_picture(ctx, NonNull::new(&mut pic)).0 == 0 {
                got = true;
                break;
            }
            if data.sz > 0 {
                let _ = dav1d_send_data(ctx, NonNull::new(&mut data));
            } else {
                break;
            }
        }

        let result = if got {
            extract_picture(&pic)
        } else {
            Err(CrushError::Decode("AV1 decode produced no frame".into()))
        };

        dav1d_picture_unref(NonNull::new(&mut pic));
        dav1d_data_unref(NonNull::new(&mut data));
        dav1d_close(NonNull::new(&mut ctx));
        result
    }
}

/// Copy a decoded rav1d picture's planes into an owned [`DecodedPicture`].
///
/// # Safety
/// `pic` must be a picture successfully filled by `dav1d_get_picture` (valid plane pointers/strides
/// and a live sequence header) and still alive (not yet unref'd).
unsafe fn extract_picture(pic: &Dav1dPicture) -> Result<DecodedPicture, CrushError> {
    let w = pic.p.w as usize;
    let h = pic.p.h as usize;
    let layout = pic.p.layout;
    // rav1d is built with bitdepth_8 + bitdepth_16, so it decodes 8-, 10-, and 12-bit AV1. We
    // normalise everything to 8-bit RGBA below; anything outside 8..=12 shouldn't occur, so guard it.
    let bpc = pic.p.bpc;
    if !(8..=12).contains(&bpc) {
        return Err(CrushError::Unsupported(format!(
            "AVIF with {bpc}-bit depth"
        )));
    }
    let bpc = bpc as u8;
    if w == 0 || h == 0 {
        return Err(CrushError::Decode(
            "AVIF decoded to a zero-size frame".into(),
        ));
    }

    // SAFETY: rav1d guarantees data[0]/stride[0] describe `h` rows of at least `w` luma samples.
    let y_ptr = pic.data[0]
        .ok_or_else(|| CrushError::Decode("AVIF frame missing luma plane".into()))?
        .as_ptr() as *const u8;
    let y = unsafe { copy_plane_any(y_ptr, pic.stride[0], w, h, bpc) };

    let monochrome = layout == 0; // DAV1D_PIXEL_LAYOUT_I400
    let (uv_width, uv_height) = match layout {
        1 => (w.div_ceil(2), h.div_ceil(2)), // I420
        2 => (w.div_ceil(2), h),             // I422
        3 => (w, h),                         // I444
        _ => (0, 0),                         // I400 (monochrome)
    };

    let (u, v) = if monochrome {
        (Vec::new(), Vec::new())
    } else {
        let u_ptr = pic.data[1]
            .ok_or_else(|| CrushError::Decode("AVIF frame missing U plane".into()))?
            .as_ptr() as *const u8;
        let v_ptr = pic.data[2]
            .ok_or_else(|| CrushError::Decode("AVIF frame missing V plane".into()))?
            .as_ptr() as *const u8;
        // SAFETY: chroma planes share stride[1]; each holds `uv_height` rows of >= `uv_width` samples.
        (
            unsafe { copy_plane_any(u_ptr, pic.stride[1], uv_width, uv_height, bpc) },
            unsafe { copy_plane_any(v_ptr, pic.stride[1], uv_width, uv_height, bpc) },
        )
    };

    // Colour matrix + range come from the AV1 sequence header; default to BT.601 full-range (what
    // ravif emits) if, implausibly, no header is attached.
    let (matrix, full_range) = match pic.seq_hdr {
        // SAFETY: `pic` is alive, so its `seq_hdr` (if set) points at a live sequence header.
        Some(seq) => {
            let seq = unsafe { seq.as_ref() };
            (seq.mtrx, seq.color_range != 0)
        }
        None => (6 /* BT601 */, true),
    };

    Ok(DecodedPicture {
        width: w as u32,
        height: h as u32,
        y,
        u,
        v,
        uv_width,
        layout,
        matrix,
        full_range,
        monochrome,
    })
}

/// Copy `height` rows of `width` bytes from a strided plane into a tightly-packed `Vec`.
///
/// # Safety
/// `base` must point at `height` rows spaced `stride` bytes apart, each with at least `width` readable
/// bytes.
unsafe fn copy_plane(base: *const u8, stride: isize, width: usize, height: usize) -> Vec<u8> {
    let mut out = vec![0u8; width * height];
    for row in 0..height {
        // SAFETY: caller guarantees `base + row*stride` starts a run of at least `width` bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(
                base.offset(row as isize * stride),
                out.as_mut_ptr().add(row * width),
                width,
            );
        }
    }
    out
}

/// Copy one plane to a tight 8-bit `Vec`, dispatching on bit depth: 8-bit samples are copied
/// verbatim; 9..=12-bit samples are read as little-endian `u16` and down-shifted to 8-bit.
///
/// # Safety
/// Same contract as [`copy_plane`]: `base` must point at `height` rows spaced `stride` bytes apart,
/// each holding at least `width` samples (bytes for 8-bit, `u16`s for higher bit depths).
unsafe fn copy_plane_any(
    base: *const u8,
    stride: isize,
    width: usize,
    height: usize,
    bpc: u8,
) -> Vec<u8> {
    if bpc == 8 {
        unsafe { copy_plane(base, stride, width, height) }
    } else {
        unsafe { copy_plane_16(base, stride, width, height, bpc) }
    }
}

/// Copy a >8-bit plane into a tight 8-bit `Vec`. In the `bitdepth_16` rav1d build, high-bit-depth
/// planes hold `u16` samples (native/little-endian) while `stride` stays in BYTES; each sample is
/// down-shifted from `bpc` bits to 8 (`sample >> (bpc - 8)`, clamped) before storing.
///
/// # Safety
/// `base` must point at `height` rows spaced `stride` bytes apart, each holding at least `width`
/// `u16` samples; `base` need not be `u16`-aligned (reads are unaligned).
unsafe fn copy_plane_16(
    base: *const u8,
    stride: isize,
    width: usize,
    height: usize,
    bpc: u8,
) -> Vec<u8> {
    let shift = u32::from(bpc - 8);
    let mut out = vec![0u8; width * height];
    for row in 0..height {
        // SAFETY: caller guarantees `base + row*stride` starts a run of at least `width` u16 samples.
        let row_ptr = unsafe { base.offset(row as isize * stride) } as *const u16;
        for col in 0..width {
            // SAFETY: `col < width`, so `row_ptr + col` is within the row; `read_unaligned` tolerates
            // the plane not being u16-aligned.
            let sample = unsafe { row_ptr.add(col).read_unaligned() };
            out[row * width + col] = (sample >> shift).min(255) as u8;
        }
    }
    out
}

/// A colour matrix for YUV->RGB. `Identity` is CICP MC 0 (the planes carry G/B/R directly, no matrix).
enum ColorMatrix {
    Identity,
    YCbCr { kr: f32, kb: f32 },
}

/// Pick luma weights from the AV1 matrix-coefficients code (CICP / ITU-T H.273). Anything we don't
/// special-case (including "unspecified") falls back to BT.601, which is what ravif encodes.
fn matrix_for(mtrx: u32) -> ColorMatrix {
    match mtrx {
        0 => ColorMatrix::Identity, // MC_IDENTITY (RGB / GBR planes)
        1 => ColorMatrix::YCbCr {
            kr: 0.2126,
            kb: 0.0722,
        }, // MC_BT709
        4 => ColorMatrix::YCbCr { kr: 0.30, kb: 0.11 }, // MC_FCC
        7 => ColorMatrix::YCbCr {
            kr: 0.212,
            kb: 0.087,
        }, // MC_SMPTE240
        _ => ColorMatrix::YCbCr {
            kr: 0.299,
            kb: 0.114,
        }, // MC_BT601/BT470BG/unspecified
    }
}

/// Convert one full-or-limited-range YCbCr triple to RGB8 using luma weights `kr`/`kb`.
fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8, kr: f32, kb: f32, full_range: bool) -> [u8; 3] {
    let (yf, cbf, crf) = if full_range {
        (y as f32, cb as f32 - 128.0, cr as f32 - 128.0)
    } else {
        // Studio-swing 8-bit: Y in [16,235], C in [16,240]. Expand to full range before matrixing.
        (
            (y as f32 - 16.0) * (255.0 / 219.0),
            (cb as f32 - 128.0) * (255.0 / 224.0),
            (cr as f32 - 128.0) * (255.0 / 224.0),
        )
    };
    let kg = 1.0 - kr - kb;
    let r = yf + 2.0 * (1.0 - kr) * crf;
    let b = yf + 2.0 * (1.0 - kb) * cbf;
    let g = yf - (2.0 * (1.0 - kr) * kr / kg) * crf - (2.0 * (1.0 - kb) * kb / kg) * cbf;
    [clamp_u8(r), clamp_u8(g), clamp_u8(b)]
}

fn clamp_u8(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

/// Convert a decoded YUV picture to an opaque RGBA8 image, upsampling chroma by nearest-neighbour to
/// match the requested subsampling.
fn decoded_to_rgba(pic: &DecodedPicture) -> RgbaImage {
    let w = pic.width as usize;
    let h = pic.height as usize;
    let (subx, suby) = match pic.layout {
        1 => (1u32, 1u32), // I420
        2 => (1, 0),       // I422
        _ => (0, 0),       // I444 (I400 handled via `monochrome`)
    };
    let matrix = matrix_for(pic.matrix);

    let mut img = RgbaImage::new(pic.width, pic.height);
    for y in 0..h {
        for x in 0..w {
            let luma = pic.y[y * w + x];
            let rgb = if pic.monochrome {
                [luma, luma, luma]
            } else {
                let cx = x >> subx;
                let cy = y >> suby;
                let cb = pic.u[cy * pic.uv_width + cx];
                let cr = pic.v[cy * pic.uv_width + cx];
                match matrix {
                    // Identity/GBR: plane 0 = G, plane 1 = B, plane 2 = R, sample values direct.
                    ColorMatrix::Identity => [cr, luma, cb],
                    ColorMatrix::YCbCr { kr, kb } => {
                        ycbcr_to_rgb(luma, cb, cr, kr, kb, pic.full_range)
                    }
                }
            };
            img.put_pixel(x as u32, y as u32, Rgba([rgb[0], rgb[1], rgb[2], 255]));
        }
    }
    img
}

/// Overlay a decoded alpha item (a monochrome AV1 image whose luma plane is the alpha channel) onto
/// an RGBA image, un-premultiplying the colour if the container flagged premultiplied alpha.
fn apply_alpha(img: &mut RgbaImage, alpha: &DecodedPicture, premultiplied: bool) {
    let aw = alpha.width as usize;
    let w = (img.width() as usize).min(aw);
    let h = (img.height() as usize).min(alpha.height as usize);
    for y in 0..h {
        for x in 0..w {
            let a = alpha.y[y * aw + x];
            let px = img.get_pixel_mut(x as u32, y as u32);
            if premultiplied && a > 0 {
                for c in 0..3 {
                    px[c] = ((px[c] as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
                }
            }
            px[3] = a;
        }
    }
}

/// Map an `image` decode error onto our taxonomy: a format the crate recognises but cannot handle
/// is `Unsupported`; everything else (corruption, truncation, tripped limits) is `Decode`.
fn map_image_err(error: ImageError) -> CrushError {
    let detail = error.to_string();
    match error {
        ImageError::Unsupported(_) => CrushError::Unsupported(detail),
        _ => CrushError::Decode(detail),
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
        let dir = PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scratch/transcoded"
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dump(name: &str, out: &Crushed) {
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
            match crush(&std::fs::read(format!("{dir}/{name}")).unwrap()) {
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
            let out = crush(&corpus(name))
                .unwrap_or_else(|e| panic!("{name} should transcode, got {e:?}"));
            assert!(
                out.width > 0 && out.height > 0,
                "{name} has real dimensions"
            );
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
            std::fs::write(
                out.join(format!("{name}.q{}.avif", q as u32)),
                &encoded.avif_file,
            )
            .unwrap();
            println!(
                "q{:<3} {name}: {w}x{h}  {} bytes",
                q as u32,
                encoded.avif_file.len()
            );
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
            match crush(&corpus(name)) {
                Err(CrushError::Animated) => {}
                other => panic!("{name} should be the animation tombstone, got {other:?}"),
            }
        }
    }

    /// A video isn't a decodable still: it's rejected, never silently mis-handled.
    #[test]
    fn video_is_rejected() {
        assert!(
            matches!(
                crush(&corpus("buck-twenty.mp4")),
                Err(CrushError::Unsupported(_) | CrushError::Decode(_))
            ),
            "a video is not an ingestible image"
        );
    }

    /// A real, foreign AVIF (encoded elsewhere, so unmarked) now ingests: we decode its AV1 bitstream
    /// with rav1d, bound + re-crush it, and stamp our content-neutral marker on the body. This is the
    /// path that used to be a known gap - AVIF in, AVIF out.
    #[test]
    fn foreign_avif_from_corpus_transcodes() {
        let out = crush(&corpus("retro.avif"))
            .unwrap_or_else(|e| panic!("retro.avif should transcode, got {e:?}"));
        assert!(
            out.width > 0 && out.height > 0,
            "retro.avif has real dimensions"
        );
        assert!(
            out.width <= 800 && out.height <= 800,
            "retro.avif is bounded to 800x800 (got {}x{})",
            out.width,
            out.height
        );
        assert!(is_avif(&out.avif), "retro.avif body is a real AVIF");
        assert!(is_avif(&out.thumb_avif), "retro.avif thumb is a real AVIF");
        assert!(
            has_ringtome_marker(&out.avif),
            "re-crushed foreign AVIF body is marked"
        );
        assert!(
            !has_ringtome_marker(&out.thumb_avif),
            "thumbnail is never marked"
        );
        dump("retro", &out);
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
        img.write_to(&mut buf, ImageFormat::Png)
            .expect("encode png");
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
        let data = avif_parse::read_avif(&mut Cursor::new(bytes)).expect("output is a valid AVIF");
        let meta = data
            .primary_item_metadata()
            .expect("AVIF has a parseable AV1 sequence header");
        (
            u32::from(meta.max_frame_width),
            u32::from(meta.max_frame_height),
        )
    }

    /// Encode a `DynamicImage` to AVIF with plain ravif at the given quality (an unmarked, foreign-
    /// shaped AVIF - the test analogue of a file encoded by some other tool).
    fn ravif_encode(img: &DynamicImage, quality: f32) -> Vec<u8> {
        use imgref::Img;
        use rgb::FromSlice;
        let rgba = img.to_rgba8();
        let (w, h) = (rgba.width() as usize, rgba.height() as usize);
        ravif::Encoder::new()
            .with_quality(quality)
            .with_speed(6)
            // 8-bit: our decoder is the bitdepth_8-only rav1d (ravif otherwise defaults to 10-bit).
            .with_bit_depth(ravif::BitDepth::Eight)
            .encode_rgba(Img::new(rgba.as_raw().as_rgba(), w, h))
            .expect("ravif encode")
            .avif_file
    }

    /// The correctness gate for YUV->RGB: encode a smooth gradient at high quality (so AV1's own loss
    /// is tiny) and decode it back. A wrong colour matrix or range shifts colours by tens of levels,
    /// which this small per-channel tolerance would catch.
    #[test]
    fn avif_decode_round_trips() {
        let src = DynamicImage::ImageRgb8(RgbImage::from_fn(200, 150, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 120])
        }));
        let avif = ravif_encode(&src, 90.0);

        let decoded = decode_avif(&avif).expect("decode_avif succeeds");
        assert_eq!(
            (decoded.width(), decoded.height()),
            (200, 150),
            "dimensions round-trip"
        );

        let (a, b) = (src.to_rgba8(), decoded.to_rgba8());
        let mut max_diff = 0u8;
        for (pa, pb) in a.pixels().zip(b.pixels()) {
            for c in 0..3 {
                max_diff = max_diff.max(pa[c].abs_diff(pb[c]));
            }
        }
        assert!(
            max_diff <= 12,
            "max per-channel diff {max_diff} too high - colour matrix/range bug?"
        );
    }

    /// The 10-bit decode path end to end: encode the gradient as a 10-bit AVIF (what many foreign
    /// uploads are) and decode it back through the `bitdepth_16` rav1d + the 10->8 down-shift. A
    /// slightly looser tolerance than the 8-bit test accounts for that down-shift's rounding.
    #[test]
    fn avif_10bit_decode_round_trips() {
        use imgref::Img;
        use rgb::FromSlice;

        let src = DynamicImage::ImageRgb8(RgbImage::from_fn(200, 150, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 120])
        }));
        let rgba = src.to_rgba8();
        let (w, h) = (rgba.width() as usize, rgba.height() as usize);
        let avif = ravif::Encoder::new()
            .with_quality(90.0)
            .with_speed(6)
            .with_bit_depth(ravif::BitDepth::Ten)
            .encode_rgba(Img::new(rgba.as_raw().as_rgba(), w, h))
            .expect("ravif 10-bit encode")
            .avif_file;

        let decoded = decode_avif(&avif).expect("decode_avif succeeds on 10-bit AVIF");
        assert_eq!(
            (decoded.width(), decoded.height()),
            (200, 150),
            "dimensions round-trip"
        );

        let (a, b) = (src.to_rgba8(), decoded.to_rgba8());
        let mut max_diff = 0u8;
        for (pa, pb) in a.pixels().zip(b.pixels()) {
            for c in 0..3 {
                max_diff = max_diff.max(pa[c].abs_diff(pb[c]));
            }
        }
        assert!(
            max_diff <= 16,
            "max per-channel diff {max_diff} too high - 10-bit decode/down-shift bug?"
        );
    }

    /// The marker survives a round-trip: added then detected; absent on a plain AVIF; and adding it
    /// (a `free` box) does not stop the AVIF from decoding.
    #[test]
    fn marker_round_trips() {
        let plain = ravif_encode(&gradient(64, 48), 80.0);
        assert!(!has_ringtome_marker(&plain), "plain AVIF has no marker");

        let marked = add_ringtome_marker(plain.clone());
        assert!(has_ringtome_marker(&marked), "marked AVIF is detected");

        let decoded = decode_avif(&marked).expect("marked AVIF still decodes");
        assert_eq!((decoded.width(), decoded.height()), (64, 48));
    }

    /// Our transcoded body carries the marker; the thumbnail never does.
    #[test]
    fn our_output_is_marked() {
        let out = crush(&png_bytes(&gradient(300, 200))).expect("transcode");
        assert!(has_ringtome_marker(&out.avif), "body is marked");
        assert!(
            !has_ringtome_marker(&out.thumb_avif),
            "thumbnail is not marked"
        );
    }

    /// The generational-loss fix: an in-spec marked AVIF (our own prior output) fed back in passes
    /// through byte-for-byte instead of being re-encoded.
    #[test]
    fn passthrough_preserves_bytes() {
        let first = crush(&png_bytes(&gradient(120, 90))).expect("first transcode");
        assert!(
            first.width <= MAIN_BOUND && first.height <= MAIN_BOUND,
            "in spec"
        );
        assert!(has_ringtome_marker(&first.avif), "first body is marked");

        let second = crush(&first.avif).expect("re-ingest the marked AVIF");
        assert_eq!(
            second.avif, first.avif,
            "in-spec marked AVIF passes through byte-identical"
        );
    }

    /// A foreign (unmarked) in-spec AVIF is not trusted: it's decoded and re-crushed, and the fresh
    /// body differs from the input, stays in spec, and gets marked.
    #[test]
    fn foreign_avif_is_recrushed() {
        let foreign = ravif_encode(&gradient(300, 220), 80.0);
        assert!(!has_ringtome_marker(&foreign), "input is unmarked");

        let out = crush(&foreign).expect("foreign AVIF transcodes");
        assert_ne!(
            out.avif, foreign,
            "foreign AVIF is re-encoded, not passed through"
        );
        assert!(
            out.width <= MAIN_BOUND && out.height <= MAIN_BOUND,
            "in spec"
        );
        assert!(has_ringtome_marker(&out.avif), "re-crushed body is marked");
    }

    #[test]
    fn transcode_png_produces_decodable_avif() {
        let input = png_bytes(&gradient(1200, 900));
        let out = crush(&input).expect("transcode succeeds");

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
        assert_eq!(
            (w, h),
            (out.width, out.height),
            "reported dims match encoded"
        );

        // Thumbnail: decodes back and fits the (128x128) thumbnail bound.
        let (tw, th) = avif_dims(&out.thumb_avif);
        assert!(
            tw <= THUMB_BOUND && th <= THUMB_BOUND,
            "thumb fits the bound"
        );
    }

    #[test]
    fn small_image_is_not_upscaled() {
        let input = png_bytes(&gradient(100, 60));
        let out = crush(&input).expect("transcode succeeds");

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

        assert!(matches!(crush(&bytes), Err(CrushError::Animated)));
    }

    #[test]
    fn garbage_bytes_are_a_decode_error_not_a_panic() {
        // Must return Err (Decode or Unsupported), never panic.
        assert!(crush(b"definitely not an image").is_err());
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
    /// no such buffer exists on disk. `crush` must reject it as `Decode` (never OOM/panic),
    /// and we additionally assert the rejection is specifically the `Limits` guard firing on the
    /// declared dimensions, not merely the absence of pixel data.
    #[test]
    fn bomb_dimensions_are_limited() {
        let bomb = png_declaring_dimensions(100_000, 100_000);

        match crush(&bomb) {
            Err(CrushError::Decode(_)) => {}
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
