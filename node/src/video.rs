//! Video ingest crusher: turn the browser's intermediary video upload into canonical crushed media.
//!
//! This is a hostile-input path, like `media.rs` before it, but for motion. The browser client
//! (see `video-ingest/README.md`) has already laundered the arbitrary codec zoo down to a CLOSED
//! set of shapes a memory-safe Rust server can re-decode:
//!
//!   1. **AV1-in-WebM** (+ muxed Opus audio) - the happy path, from browsers that encode AV1.
//!   2. **APNG frames + a separate Ogg Opus blob** - the universal fallback.
//!   3. **Animated images** (GIF / APNG / animated WebP) - the formats `media.rs` tombstones.
//!
//! Everything else is rejected. And because a *modified* client can upload anything, every decode
//! path here is bomb-guarded and the server re-encodes everything - we never redistribute an
//! attacker-authored bitstream, only our-encoder bytes ("laundering").
//!
//! Output routing:
//!   - transparent + silent  -> crushed **APNG** (alpha preserved; `<img>` renders it everywhere)
//!   - opaque (± audio)      -> crushed **AV1-in-WebM** (+ Opus passthrough)
//!   - transparent + audio   -> **AV1-in-WebM with alpha flattened** onto black
//!     (audio wins; there is no universally-playable alpha video format)
//!
//! Audio is NEVER decoded: Opus packets are demuxed (WebM) or unwrapped (Ogg) and passed through
//! into the output mux byte-for-byte. Only pixel data is decoded, and only with pure-rust
//! decoders (`rav1d`, the `image` crate) behind hard limits.
//!
//! Everything here is a pure function - no I/O, no shared state. CPU-bound; callers run
//! [`crush`] under `tokio::task::spawn_blocking`.

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
use image::{AnimationDecoder, ImageDecoder, Limits, RgbaImage};

// rav1e is the AV1 *encoder* (same crate ravif drives for stills, same no-asm pure-rust build).
use rav1e::prelude::{
    ChromaSampling, ColorDescription, ColorPrimaries, Config, EncoderConfig, EncoderStatus,
    FrameType, MatrixCoefficients, PixelRange, Rational, TransferCharacteristics,
};

// rav1d's public surface is the raw `dav1d_*` C ABI plus the `Dav1d*` FFI structs, exactly as in
// media.rs. We keep our own minimal unsafe glue here (media.rs's is private, and video needs the
// multi-frame send/drain flow, not the single-still one).
use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::{Dav1dContext, Dav1dSettings};
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::{
    dav1d_close, dav1d_data_create, dav1d_data_unref, dav1d_default_settings, dav1d_get_picture,
    dav1d_open, dav1d_picture_unref, dav1d_send_data,
};

use webm_iterable::matroska_spec::{Block, Master, MatroskaSpec, SimpleBlock};
use webm_iterable::WebmIterator;

// ---------------------------------------------------------------------------
// Tunables. Kept together and clearly named so the crush policy is trivially
// adjustable later without spelunking through the logic below.
// ---------------------------------------------------------------------------

/// Decompression-bomb guard: reject any input declaring a dimension larger than this, before
/// allocating pixels for it. Same figure as media.rs.
const MAX_DECODE_DIMENSION: u32 = 16_384;

/// Decompression-bomb guard: cap on decode-time allocation (per frame for video). A tiny file can
/// declare dimensions within the per-axis cap yet still multiply out to a huge buffer.
const MAX_DECODE_ALLOC_BYTES: u64 = 512 * 1024 * 1024;

/// The crush geometry: every frame is resized so its longest side fits this. 320p is the whole
/// aesthetic - the client already emits 320p, so for honest clients this is a no-op.
const MAX_SIDE: u32 = 320;

/// Effective output frame-rate ceiling, expressed as a minimum spacing between kept frames.
/// 50 ms = ~20 fps; sources faster than this get frames dropped (cumulative timing stays honest).
const MIN_FRAME_SPACING_MS: u64 = 50;

/// Frame-count cap (~2 minutes at 20 fps). The cap TRUNCATES rather than errors: decoding stops
/// once this many source frames have been read and the clip is clipped. Chosen over a hard error
/// because it doubles as the CI window into the big fixtures (tests pass a small
/// `CrushOpts::max_frames`) and clipping is the crush ethos; an over-long upload from a
/// misbehaving client loses its tail rather than DoSing the decode loop. The one *error* path on
/// the time axis is [`MAX_DURATION_MS`] below.
const MAX_FRAMES: u32 = 2_400;

/// A WebM whose Segment Info *declares* a duration longer than this is rejected with
/// [`VideoError::TooLong`] before any block is decoded - the client is supposed to bound duration,
/// so a self-declared over-long upload is a misbehaving client, refused cheaply and early.
/// 150 s = the MAX_FRAMES budget (2 min at 20 fps) plus slack.
const MAX_DURATION_MS: f64 = 150_000.0;

/// rav1e speed preset (0 = slowest/best, 10 = fastest). Fast on purpose: the quantizer below does
/// the aesthetic work and encode time rides the upload path. Tunable later.
const AV1_SPEED: u8 = 10;

/// rav1e quantizer (0-255, higher = harsher). Deliberately brutal: 140 is the video sibling of
/// media.rs's AVIF q18 - motion stays legible with crispy visible artifacting, and 320p clips
/// land small. This is the aesthetic *and* the size lever working together. Tunable later.
const AV1_QUANTIZER: usize = 140;

/// Maximum keyframe interval in frames (~2 s at the 20 fps target): seek granularity vs size.
const KEYFRAME_INTERVAL_FRAMES: u64 = 40;

/// rav1e tile request. Tiles are the only real parallelism lever in the no-asm pure-rust build
/// (rayon splits work per tile), and the difference is stark: a measured 6.6x wall-clock speedup
/// together with `low_latency` below (2.2 s/frame -> 0.2 s/frame at 320p). At our frame size the
/// encoder can satisfy at most 4x2 tiles, so 8 is the effective ceiling; the tile-boundary
/// quality cost is noise at the crush quantizer.
const AV1_TILES: usize = 8;

/// Background colour that transparent pixels are flattened onto when audio forces the WebM route
/// (alpha cannot survive there). Black, by ruling.
const FLATTEN_BACKGROUND: [u8; 3] = [0, 0, 0];

/// Resampling filter for downscaling. Lanczos3, matching media.rs (no resize crunch).
const RESIZE_FILTER: FilterType = FilterType::Lanczos3;

/// Opus always runs at 48 kHz on the decode side; granules and TOC durations are in these units.
const OPUS_SAMPLE_RATE: u64 = 48_000;

/// A GIF/APNG frame delay of 0 means "unspecified"; browsers render those at ~100 ms. Match them.
const ZERO_DELAY_MS: u64 = 100;

/// Start a new output cluster whenever the relative timestamp would exceed this (SimpleBlock
/// offsets are i16 ms; 30 s keeps comfortably clear of the 32.7 s ceiling).
const CLUSTER_MAX_SPAN_MS: u64 = 30_000;

// ---------------------------------------------------------------------------
// Public API (consumed by the ingest wiring, which lands separately).
// ---------------------------------------------------------------------------

/// A successfully crushed video: canonical bytes plus the facts the ingest wiring stores.
#[derive(Debug)]
pub struct Crushed {
    /// Which canonical container the routing picked.
    pub format: CrushedFormat,
    /// The crushed output (a complete APNG or WebM file).
    pub bytes: Vec<u8>,
    /// Final (post-bound) frame width.
    pub width: u32,
    /// Final (post-bound) frame height.
    pub height: u32,
    /// Playback duration of the crushed clip.
    pub duration_ms: u64,
    /// Number of frames in the crushed clip (post frame-rate cap, post truncation).
    pub frame_count: u32,
    /// Whether the output carries an Opus audio track.
    pub has_audio: bool,
    /// True when the source had transparency that was flattened onto [`FLATTEN_BACKGROUND`]
    /// because audio forced the WebM route.
    pub alpha_flattened: bool,
}

/// The two canonical output containers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrushedFormat {
    /// Crushed APNG (transparent + silent inputs; alpha preserved).
    Apng,
    /// Crushed AV1-in-WebM (everything else; + Opus when audio is present).
    WebmAv1,
}

/// Why an upload could not be turned into canonical video.
#[derive(Debug)]
pub enum VideoError {
    /// Not one of the closed set of intermediary shapes (wrong container, wrong codec).
    Unsupported(String),
    /// Malformed / corrupt / decompression-bomb / decode or encode failure.
    Decode(String),
    /// The input *declares* a duration beyond the crush budget - a misbehaving client.
    TooLong(String),
}

impl std::fmt::Display for VideoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VideoError::Unsupported(detail) => write!(f, "unsupported video input: {detail}"),
            VideoError::Decode(detail) => write!(f, "could not process video: {detail}"),
            VideoError::TooLong(detail) => write!(f, "video too long: {detail}"),
        }
    }
}

impl std::error::Error for VideoError {}

/// Knobs for [`crush`]. `max_frames: None` means the [`MAX_FRAMES`] const; tests pass a small
/// `Some(n)` to window the big fixtures at CI speed (the cap truncates - see [`MAX_FRAMES`]).
#[derive(Debug, Default, Clone, Copy)]
pub struct CrushOpts {
    pub max_frames: Option<u32>,
}

/// Crush an intermediary video upload to canonical output.
///
/// `audio_ogg_opus` is the fallback lane's separate Ogg Opus blob; it is only meaningful for
/// non-WebM inputs (a WebM carries its own audio track, and any extra blob riding beside one is
/// ignored). Pure function, no I/O. CPU-bound (callers run it under `spawn_blocking`).
pub fn crush(
    video: &[u8],
    audio_ogg_opus: Option<&[u8]>,
    opts: CrushOpts,
) -> Result<Crushed, VideoError> {
    let cap = opts.max_frames.unwrap_or(MAX_FRAMES).max(1) as usize;

    // Sniff the container from magic bytes and take the matching decode lane. Each lane yields
    // bounded (resized, frame-rate-capped, truncated) RGBA frames plus any passthrough audio.
    let (frames, transparent, audio) = match sniff(video)? {
        InputKind::Webm => {
            let demuxed = demux_webm(video)?;
            let frames = decode_webm_frames(&demuxed, cap)?;
            // A WebM's audio rides inside it; a stray side-blob is ignored per the API contract.
            (frames, false, demuxed.audio)
        }
        kind => {
            let (frames, transparent) = decode_animation(video, kind, cap)?;
            let audio = audio_ogg_opus.map(parse_ogg_opus).transpose()?;
            (frames, transparent, audio)
        }
    };

    if frames.is_empty() {
        return Err(VideoError::Decode("input contained no frames".into()));
    }
    let width = frames[0].image.width();
    let height = frames[0].image.height();
    let duration_ms = frames.last().map(|f| f.ms + f.dur_ms).unwrap_or(0).max(1);
    let frame_count = frames.len() as u32;

    // Truncate audio to the (possibly clipped) video window so the two tracks agree; if nothing
    // survives the window the track is dropped entirely.
    let audio = audio.and_then(|mut a| {
        a.packets.retain(|(ms, _)| *ms < duration_ms);
        if a.packets.is_empty() {
            None
        } else {
            Some(a)
        }
    });
    let has_audio = audio.is_some();

    // The routing ruling: transparency only survives when there is no audio (APNG); audio always
    // wins the container fight, flattening any alpha onto the background const.
    if transparent && !has_audio {
        let bytes = encode_apng(&frames, width, height)?;
        return Ok(Crushed {
            format: CrushedFormat::Apng,
            bytes,
            width,
            height,
            duration_ms,
            frame_count,
            has_audio: false,
            alpha_flattened: false,
        });
    }

    let alpha_flattened = transparent;
    let encoded = encode_av1(&frames, width, height, alpha_flattened)?;
    let bytes = mux_webm(&encoded, audio.as_ref(), duration_ms, width, height)?;
    Ok(Crushed {
        format: CrushedFormat::WebmAv1,
        bytes,
        width,
        height,
        duration_ms,
        frame_count,
        has_audio,
        alpha_flattened,
    })
}

// ---------------------------------------------------------------------------
// Container sniffing.
// ---------------------------------------------------------------------------

/// The closed set of input containers, identified by magic bytes only (never by trusting the
/// client's labelling).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputKind {
    Webm,
    Apng,
    Gif,
    Webp,
}

/// Identify the container from magic bytes. Anything unrecognised - mp4, random bytes, whatever -
/// is `Unsupported`, not corrupt: the closed set is the contract.
fn sniff(input: &[u8]) -> Result<InputKind, VideoError> {
    if input.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Ok(InputKind::Webm);
    }
    if input.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Ok(InputKind::Apng);
    }
    if input.starts_with(b"GIF87a") || input.starts_with(b"GIF89a") {
        return Ok(InputKind::Gif);
    }
    if input.len() >= 12 && &input[0..4] == b"RIFF" && &input[8..12] == b"WEBP" {
        return Ok(InputKind::Webp);
    }
    Err(VideoError::Unsupported(
        "not a WebM, APNG, GIF, or WebP".into(),
    ))
}

// ---------------------------------------------------------------------------
// Bounded frames: the common currency between the decode lanes and the
// encoders. Frames are resized (and frame-rate-capped) as they are decoded so
// only ~320p RGBA ever accumulates in memory.
// ---------------------------------------------------------------------------

/// One kept frame of the crushed clip: bounded RGBA pixels plus honest timing.
struct BoundedFrame {
    image: RgbaImage,
    /// Presentation start, ms from clip start.
    ms: u64,
    /// Display duration, ms (the gap to the next kept frame; the source's own tail for the last).
    dur_ms: u64,
}

/// Streaming frame collector: applies the frame-rate cap (drop, keep timing honest), the resize
/// bound, and the dimension guards as raw frames arrive, so dropped frames are never resized and
/// raw frames are never stored. Timing is normalised to start at the first frame.
struct FrameSink {
    kept: Vec<BoundedFrame>,
    /// Bounded output dimensions, fixed by the first frame (all frames must match the source dims).
    source_dims: Option<(u32, u32)>,
    target_dims: (u32, u32),
    first_ms: u64,
    /// End of the clip so far (start + duration of the latest raw frame), for the last kept
    /// frame's honest duration.
    end_ms: u64,
    /// Raw frames seen; decoding stops (truncates) when this reaches the cap.
    raw_count: usize,
    cap: usize,
}

impl FrameSink {
    fn new(cap: usize) -> Self {
        FrameSink {
            kept: Vec::new(),
            source_dims: None,
            target_dims: (0, 0),
            first_ms: 0,
            end_ms: 0,
            raw_count: 0,
            cap,
        }
    }

    /// True while the sink wants more frames; decode loops stop when this goes false (truncation).
    fn wants_more(&self) -> bool {
        self.raw_count < self.cap
    }

    /// Offer one raw decoded frame (source resolution) with its source timing.
    fn push(&mut self, image: &RgbaImage, ms: u64, dur_ms: u64) -> Result<(), VideoError> {
        let (w, h) = (image.width(), image.height());
        match self.source_dims {
            None => {
                self.source_dims = Some((w, h));
                self.target_dims = bounded_dims(w, h);
                self.first_ms = ms;
            }
            // A mid-stream resolution switch is not something any honest client emits.
            Some(dims) if dims != (w, h) => {
                return Err(VideoError::Decode(
                    "frame dimensions changed mid-stream".into(),
                ));
            }
            Some(_) => {}
        }
        self.raw_count += 1;
        let ms = ms.saturating_sub(self.first_ms);
        self.end_ms = self.end_ms.max(ms + dur_ms.max(1));

        // The frame-rate cap: drop any frame closer than the minimum spacing to the last kept one.
        if let Some(last) = self.kept.last() {
            if ms < last.ms + MIN_FRAME_SPACING_MS {
                return Ok(());
            }
        }

        let (tw, th) = self.target_dims;
        let image = if (w, h) == (tw, th) {
            image.clone()
        } else {
            image::imageops::resize(image, tw, th, RESIZE_FILTER)
        };
        self.kept.push(BoundedFrame {
            image,
            ms,
            dur_ms: 0, // recomputed in finish()
        });
        Ok(())
    }

    /// Recompute kept-frame durations from the gaps between kept frames (dropping frames must not
    /// shorten the clip) and hand the frames over.
    fn finish(mut self) -> Vec<BoundedFrame> {
        let n = self.kept.len();
        for i in 0..n {
            let next_start = if i + 1 < n {
                self.kept[i + 1].ms
            } else {
                self.end_ms
            };
            self.kept[i].dur_ms = next_start.saturating_sub(self.kept[i].ms).max(1);
        }
        self.kept
    }
}

/// The crush geometry: fit inside [`MAX_SIDE`] (never upscale), then force both dimensions even
/// (the AV1 route encodes 4:2:0, and one policy for both routes keeps output dims predictable).
fn bounded_dims(w: u32, h: u32) -> (u32, u32) {
    let (w, h) = (w.max(1), h.max(1));
    let longest = w.max(h);
    let (bw, bh) = if longest <= MAX_SIDE {
        (w, h)
    } else {
        let scale = f64::from(MAX_SIDE) / f64::from(longest);
        (
            ((f64::from(w) * scale).round() as u32).max(1),
            ((f64::from(h) * scale).round() as u32).max(1),
        )
    };
    ((bw & !1).max(2), (bh & !1).max(2))
}

// ---------------------------------------------------------------------------
// Lane 1: WebM demux (webm-iterable) + AV1 decode (rav1d).
// ---------------------------------------------------------------------------

/// Opus audio for passthrough: the OpusHead (which becomes the WebM CodecPrivate) plus the raw
/// packets with millisecond timestamps. Packets are never decoded.
struct AudioTrack {
    /// The OpusHead bytes, verbatim.
    codec_private: Vec<u8>,
    channels: u8,
    /// Opus pre-skip in 48 kHz samples (from the OpusHead), signalled as WebM CodecDelay.
    pre_skip: u16,
    packets: Vec<(u64, Vec<u8>)>,
}

/// A demuxed AV1-in-WebM intermediary: the raw AV1 packets (with ms timestamps) still undecoded,
/// plus any Opus track. Also the round-trip surface for our own muxed output in tests.
struct DemuxedWebm {
    /// Track-declared dimensions (bomb-guarded before any pixel decode).
    width: u32,
    height: u32,
    video_packets: Vec<(u64, Vec<u8>)>,
    audio: Option<AudioTrack>,
}

/// Demux a WebM: strict against the closed set. Exactly one video track and it must be V_AV1;
/// at most one audio track and it must be A_OPUS with an OpusHead CodecPrivate; any other track
/// is `Unsupported`. A declared over-budget duration is refused before any block is read.
fn demux_webm(input: &[u8]) -> Result<DemuxedWebm, VideoError> {
    let mut src = Cursor::new(input);
    // Buffer TrackEntry masters whole so each track's children can be inspected in one piece.
    let iter = WebmIterator::new(&mut src, &[MatroskaSpec::TrackEntry(Master::Start)]);

    let mut timestamp_scale: u64 = 1_000_000; // Matroska default: ticks are ns, 1e6 => ms.
    let mut cluster_ticks: u64 = 0;
    let mut video_track: Option<u64> = None;
    let mut audio_track: Option<u64> = None;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut audio: Option<AudioTrack> = None;
    let mut video_packets: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut audio_packets: Vec<(u64, Vec<u8>)> = Vec::new();

    let ticks_to_ms = |ticks: u64, scale: u64| -> u64 { ticks.saturating_mul(scale) / 1_000_000 };

    for tag in iter {
        let tag = tag.map_err(|e| VideoError::Decode(format!("webm parse failed: {e}")))?;
        match tag {
            MatroskaSpec::TimestampScale(v) => timestamp_scale = v.max(1),
            // The duration bound, checked the moment the file declares it: refuse an over-long
            // upload before decoding a single block.
            MatroskaSpec::Duration(d) => {
                let declared_ms = d * (timestamp_scale as f64) / 1_000_000.0;
                if !declared_ms.is_finite() || declared_ms > MAX_DURATION_MS {
                    return Err(VideoError::TooLong(format!(
                        "webm declares {declared_ms:.0} ms, over the {MAX_DURATION_MS:.0} ms bound"
                    )));
                }
            }
            MatroskaSpec::TrackEntry(master) => {
                let children = match master {
                    Master::Full(children) => children,
                    // TrackEntry is in the buffered set, so it always arrives Full.
                    _ => continue,
                };
                let number = find_uint(&children, |t| matches!(t, MatroskaSpec::TrackNumber(_)))
                    .ok_or_else(|| VideoError::Decode("track without a number".into()))?;
                let track_type =
                    find_uint(&children, |t| matches!(t, MatroskaSpec::TrackType(_))).unwrap_or(0);
                let codec = children.iter().find_map(|t| match t {
                    MatroskaSpec::CodecID(id) => Some(id.clone()),
                    _ => None,
                });
                let codec = codec.as_deref().unwrap_or("");
                match track_type {
                    // Video: must be AV1, exactly once, with sane declared dimensions.
                    1 => {
                        if codec != "V_AV1" {
                            return Err(VideoError::Unsupported(format!(
                                "webm video codec {codec:?} (only V_AV1 is accepted)"
                            )));
                        }
                        if video_track.is_some() {
                            return Err(VideoError::Unsupported(
                                "webm has multiple video tracks".into(),
                            ));
                        }
                        let (w, h) = video_dimensions(&children).ok_or_else(|| {
                            VideoError::Decode("video track without dimensions".into())
                        })?;
                        // Bomb guard on the *declared* dimensions, before any pixel decode. Each
                        // decoded picture is re-checked against the same bounds in extract_picture.
                        if w > MAX_DECODE_DIMENSION || h > MAX_DECODE_DIMENSION {
                            return Err(VideoError::Decode(format!(
                                "webm declares {w}x{h}, over the {MAX_DECODE_DIMENSION}px bound"
                            )));
                        }
                        width = w;
                        height = h;
                        video_track = Some(number);
                    }
                    // Audio: must be Opus, exactly once, with the OpusHead riding as CodecPrivate.
                    2 => {
                        if codec != "A_OPUS" {
                            return Err(VideoError::Unsupported(format!(
                                "webm audio codec {codec:?} (only A_OPUS is accepted)"
                            )));
                        }
                        if audio_track.is_some() {
                            return Err(VideoError::Unsupported(
                                "webm has multiple audio tracks".into(),
                            ));
                        }
                        let head = children
                            .iter()
                            .find_map(|t| match t {
                                MatroskaSpec::CodecPrivate(data) => Some(data.clone()),
                                _ => None,
                            })
                            .ok_or_else(|| {
                                VideoError::Decode("opus track without an OpusHead".into())
                            })?;
                        let (channels, pre_skip) = parse_opus_head(&head)?;
                        audio_track = Some(number);
                        audio = Some(AudioTrack {
                            codec_private: head,
                            channels,
                            pre_skip,
                            packets: Vec::new(),
                        });
                    }
                    // Anything else (subtitles, whatever) is outside the closed set.
                    other => {
                        return Err(VideoError::Unsupported(format!(
                            "webm track type {other} (only one video + one audio track)"
                        )));
                    }
                }
            }
            MatroskaSpec::Timestamp(v) => cluster_ticks = v,
            MatroskaSpec::SimpleBlock(ref data) => {
                let block = SimpleBlock::try_from(data.as_slice())
                    .map_err(|e| VideoError::Decode(format!("bad webm block: {e}")))?;
                collect_block_frames(
                    block.track,
                    block.timestamp,
                    &block
                        .read_frame_data()
                        .map_err(|e| VideoError::Decode(format!("bad webm lacing: {e}")))?,
                    cluster_ticks,
                    |ticks| ticks_to_ms(ticks, timestamp_scale),
                    video_track,
                    audio_track,
                    &mut video_packets,
                    &mut audio_packets,
                );
            }
            // BlockGroup-style Blocks: same payload shape, no keyframe flag (we don't need one on
            // the way in - rav1d finds its own sync points).
            MatroskaSpec::Block(ref data) => {
                let block = Block::try_from(data.as_slice())
                    .map_err(|e| VideoError::Decode(format!("bad webm block: {e}")))?;
                collect_block_frames(
                    block.track,
                    block.timestamp,
                    &block
                        .read_frame_data()
                        .map_err(|e| VideoError::Decode(format!("bad webm lacing: {e}")))?,
                    cluster_ticks,
                    |ticks| ticks_to_ms(ticks, timestamp_scale),
                    video_track,
                    audio_track,
                    &mut video_packets,
                    &mut audio_packets,
                );
            }
            _ => {}
        }
    }

    if video_track.is_none() {
        return Err(VideoError::Unsupported("webm has no video track".into()));
    }
    if video_packets.is_empty() {
        return Err(VideoError::Decode("webm has no video data".into()));
    }
    if let Some(a) = audio.as_mut() {
        a.packets = std::mem::take(&mut audio_packets);
    }
    Ok(DemuxedWebm {
        width,
        height,
        video_packets,
        audio,
    })
}

/// Route one (possibly laced) block's frames to the right packet list with an absolute ms
/// timestamp. Blocks for unknown tracks are ignored (the track scan already rejected foreign
/// track *types*; a block with a bogus number is just noise).
#[allow(clippy::too_many_arguments)] // internal demux plumbing, not API surface
fn collect_block_frames(
    track: u64,
    rel_ticks: i16,
    frames: &[webm_iterable::matroska_spec::Frame<'_>],
    cluster_ticks: u64,
    ticks_to_ms: impl Fn(u64) -> u64,
    video_track: Option<u64>,
    audio_track: Option<u64>,
    video_packets: &mut Vec<(u64, Vec<u8>)>,
    audio_packets: &mut Vec<(u64, Vec<u8>)>,
) {
    let abs_ticks = cluster_ticks.saturating_add_signed(i64::from(rel_ticks));
    let ms = ticks_to_ms(abs_ticks);
    for frame in frames {
        if Some(track) == video_track {
            video_packets.push((ms, frame.data.to_vec()));
        } else if Some(track) == audio_track {
            audio_packets.push((ms, frame.data.to_vec()));
        }
    }
}

/// Pull an unsigned-int child out of a buffered master's children.
fn find_uint(children: &[MatroskaSpec], pred: impl Fn(&MatroskaSpec) -> bool) -> Option<u64> {
    use webm_iterable::matroska_spec::EbmlTag;
    children
        .iter()
        .find(|t| pred(t))
        .and_then(|t| t.as_unsigned_int().copied())
}

/// Dig PixelWidth/PixelHeight out of a TrackEntry's nested Video master.
fn video_dimensions(children: &[MatroskaSpec]) -> Option<(u32, u32)> {
    let video = children.iter().find_map(|t| match t {
        MatroskaSpec::Video(Master::Full(v)) => Some(v),
        _ => None,
    })?;
    let w = find_uint(video, |t| matches!(t, MatroskaSpec::PixelWidth(_)))?;
    let h = find_uint(video, |t| matches!(t, MatroskaSpec::PixelHeight(_)))?;
    Some((u32::try_from(w).ok()?, u32::try_from(h).ok()?))
}

/// Decode a demuxed WebM's AV1 packets into bounded frames. Pictures come out of rav1d in
/// presentation order (an AV1-in-WebM block is one temporal unit = one shown frame), so picture N
/// takes block N's timestamp; durations are the gaps between blocks.
fn decode_webm_frames(demuxed: &DemuxedWebm, cap: usize) -> Result<Vec<BoundedFrame>, VideoError> {
    // Per-block durations from the timestamp deltas; the last block reuses the previous duration
    // (the mux has no "end" marker), defaulting to the 20 fps spacing for a single block.
    let ts: Vec<u64> = demuxed.video_packets.iter().map(|(ms, _)| *ms).collect();
    let dur_of = |i: usize| -> u64 {
        if i + 1 < ts.len() {
            ts[i + 1].saturating_sub(ts[i]).max(1)
        } else if i > 0 {
            ts[i].saturating_sub(ts[i - 1]).max(1)
        } else {
            MIN_FRAME_SPACING_MS
        }
    };

    let mut sink = FrameSink::new(cap);
    let mut decoder = Av1Decoder::open()?;
    let mut picture_index = 0usize;
    let mut on_picture = |pic: DecodedPicture, sink: &mut FrameSink| -> Result<(), VideoError> {
        let i = picture_index.min(ts.len().saturating_sub(1));
        picture_index += 1;
        let rgba = decoded_to_rgba(&pic);
        sink.push(&rgba, ts[i], dur_of(i))
    };

    for (_, packet) in &demuxed.video_packets {
        if !sink.wants_more() {
            break; // truncation: the cap clips the clip
        }
        for pic in decoder.send_packet(packet)? {
            on_picture(pic, &mut sink)?;
        }
    }
    if sink.wants_more() {
        for pic in decoder.drain()? {
            if !sink.wants_more() {
                break;
            }
            on_picture(pic, &mut sink)?;
        }
    }
    Ok(sink.finish())
}

// ---------------------------------------------------------------------------
// rav1d glue: the only unsafe in this module. A long-lived decoder context fed
// packet by packet (unlike media.rs's one-shot still decode), with every plane
// copied out into owned Vecs before anything rav1d-owned goes away.
// ---------------------------------------------------------------------------

/// A decoded AV1 frame, copied out of rav1d into owned buffers (stride padding removed) so all
/// downstream work is safe. Field meanings match media.rs's struct of the same name: `layout` is
/// the dav1d pixel layout (0=I400, 1=I420, 2=I422, 3=I444); `matrix`/`full_range` come from the
/// AV1 sequence header.
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

/// A live rav1d decoder context. All unsafe stays inside this impl; the context is closed on drop
/// on every path.
struct Av1Decoder {
    ctx: Option<Dav1dContext>,
}

impl Av1Decoder {
    /// Open a single-threaded, minimal-delay decoder (same settings as media.rs).
    fn open() -> Result<Self, VideoError> {
        // SAFETY: `settings` is a live local fully initialised by `dav1d_default_settings` (via
        // `ptr::write`) before any field is read; `dav1d_open` writes `ctx` before we use it.
        unsafe {
            let mut settings = MaybeUninit::<Dav1dSettings>::uninit();
            dav1d_default_settings(NonNull::new(settings.as_mut_ptr()).unwrap());
            let mut settings = settings.assume_init();
            settings.n_threads = 1;
            settings.max_frame_delay = 1;

            let mut ctx: Option<Dav1dContext> = None;
            if dav1d_open(NonNull::new(&mut ctx), NonNull::new(&mut settings)).0 != 0
                || ctx.is_none()
            {
                return Err(VideoError::Decode("dav1d_open failed".into()));
            }
            Ok(Av1Decoder { ctx })
        }
    }

    /// Feed one WebM block's AV1 data (a temporal unit) and collect every picture that becomes
    /// ready. rav1d may hold pictures back (frame delay); they surface on a later send or in
    /// [`Self::drain`].
    fn send_packet(&mut self, packet: &[u8]) -> Result<Vec<DecodedPicture>, VideoError> {
        if packet.is_empty() {
            return Err(VideoError::Decode("empty AV1 packet".into()));
        }
        let ctx = self.ctx;
        let mut out = Vec::new();

        // SAFETY: `data` is created and fully initialised by `dav1d_data_create` (checked for
        // null) before use; every pointer handed to rav1d points at a live local; `data` is
        // unref'd on every exit path, and pictures are extracted (copied) then unref'd
        // immediately, so no rav1d-owned memory escapes.
        unsafe {
            let mut data = MaybeUninit::<Dav1dData>::uninit();
            let dst = dav1d_data_create(NonNull::new(data.as_mut_ptr()), packet.len());
            if dst.is_null() {
                return Err(VideoError::Decode("dav1d_data_create failed".into()));
            }
            let mut data = data.assume_init();
            std::ptr::copy_nonoverlapping(packet.as_ptr(), dst, packet.len());

            // Send/drain loop: `dav1d_send_data` may consume the data only partially (EAGAIN-style
            // nonzero return), in which case pictures must be pulled before re-sending. The
            // iteration bound guarantees termination even if a hostile bitstream makes rav1d
            // refuse both progress directions.
            let mut result = Ok(());
            for _ in 0..64 {
                if data.sz == 0 {
                    break;
                }
                let _ = dav1d_send_data(ctx, NonNull::new(&mut data));
                loop {
                    match Self::next_picture(ctx) {
                        Ok(Some(pic)) => out.push(pic),
                        Ok(None) => break,
                        Err(e) => {
                            result = Err(e);
                            break;
                        }
                    }
                }
                if result.is_err() {
                    break;
                }
            }
            dav1d_data_unref(NonNull::new(&mut data));
            result?;
        }
        Ok(out)
    }

    /// End of stream: pull whatever the delay pipeline still holds.
    fn drain(&mut self) -> Result<Vec<DecodedPicture>, VideoError> {
        let ctx = self.ctx;
        let mut out = Vec::new();
        // Bounded for the same reason as the send loop; the frame delay is 1, so this is plenty.
        for _ in 0..64 {
            // SAFETY: see `next_picture`; `ctx` stays live for the whole loop.
            match unsafe { Self::next_picture(ctx) } {
                Ok(Some(pic)) => out.push(pic),
                Ok(None) => break,
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    /// Try to pull one picture. `Ok(None)` means rav1d wants more data (EAGAIN-style nonzero
    /// return from `dav1d_get_picture`).
    ///
    /// # Safety
    /// `ctx` must be a live context from `dav1d_open` that has not been closed.
    unsafe fn next_picture(
        ctx: Option<Dav1dContext>,
    ) -> Result<Option<DecodedPicture>, VideoError> {
        // SAFETY: a zeroed picture is a valid "empty" picture (all refs None), safe to unref even
        // if never filled; `dav1d_get_picture` overwrites it wholesale via `ptr::write` on
        // success. The picture is unref'd on every path after `extract_picture` copies it out.
        unsafe {
            let mut pic = MaybeUninit::<Dav1dPicture>::zeroed().assume_init();
            if dav1d_get_picture(ctx, NonNull::new(&mut pic)).0 != 0 {
                return Ok(None);
            }
            let extracted = extract_picture(&pic);
            dav1d_picture_unref(NonNull::new(&mut pic));
            extracted.map(Some)
        }
    }
}

impl Drop for Av1Decoder {
    fn drop(&mut self) {
        // SAFETY: `ctx` came from `dav1d_open` and is only closed here, exactly once.
        unsafe {
            dav1d_close(NonNull::new(&mut self.ctx));
        }
    }
}

/// Copy a decoded rav1d picture's planes into an owned [`DecodedPicture`], re-checking the bomb
/// bounds against what the bitstream *actually* decoded (the track header was only a claim).
///
/// # Safety
/// `pic` must be a picture successfully filled by `dav1d_get_picture` (valid plane pointers /
/// strides and a live sequence header) and still alive (not yet unref'd).
unsafe fn extract_picture(pic: &Dav1dPicture) -> Result<DecodedPicture, VideoError> {
    let w = pic.p.w as usize;
    let h = pic.p.h as usize;
    let layout = pic.p.layout;
    // rav1d is built with bitdepth_8 + bitdepth_16; 10/12-bit input is down-shifted to 8-bit in
    // the plane copy (our own client emits 8-bit, but the closed set is enforced by codec, not
    // depth, so handle what rav1d can hand us).
    let bpc = pic.p.bpc;
    if !(8..=12).contains(&bpc) {
        return Err(VideoError::Unsupported(format!("AV1 with {bpc}-bit depth")));
    }
    let bpc = bpc as u8;
    if w == 0 || h == 0 {
        return Err(VideoError::Decode(
            "AV1 decoded to a zero-size frame".into(),
        ));
    }
    if w > MAX_DECODE_DIMENSION as usize
        || h > MAX_DECODE_DIMENSION as usize
        || (w as u64) * (h as u64) * 4 > MAX_DECODE_ALLOC_BYTES
    {
        return Err(VideoError::Decode(format!(
            "AV1 frame {w}x{h} is over the decode bounds"
        )));
    }

    // SAFETY: rav1d guarantees data[0]/stride[0] describe `h` rows of at least `w` luma samples.
    let y_ptr = pic.data[0]
        .ok_or_else(|| VideoError::Decode("AV1 frame missing luma plane".into()))?
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
            .ok_or_else(|| VideoError::Decode("AV1 frame missing U plane".into()))?
            .as_ptr() as *const u8;
        let v_ptr = pic.data[2]
            .ok_or_else(|| VideoError::Decode("AV1 frame missing V plane".into()))?
            .as_ptr() as *const u8;
        // SAFETY: chroma planes share stride[1]; each holds `uv_height` rows of >= `uv_width`
        // samples.
        (
            unsafe { copy_plane_any(u_ptr, pic.stride[1], uv_width, uv_height, bpc) },
            unsafe { copy_plane_any(v_ptr, pic.stride[1], uv_width, uv_height, bpc) },
        )
    };

    // Colour matrix + range come from the AV1 sequence header; default to BT.601 limited-range
    // (what web encoders emit for video) if, implausibly, no header is attached.
    let (matrix, full_range) = match pic.seq_hdr {
        // SAFETY: `pic` is alive, so its `seq_hdr` (if set) points at a live sequence header.
        Some(seq) => {
            let seq = unsafe { seq.as_ref() };
            (seq.mtrx, seq.color_range != 0)
        }
        None => (6 /* BT601 */, false),
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
/// `base` must point at `height` rows spaced `stride` bytes apart, each with at least `width`
/// readable bytes.
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

/// Copy one plane to a tight 8-bit `Vec`, dispatching on bit depth: 8-bit samples verbatim,
/// 9..=12-bit read as little-endian `u16` and down-shifted to 8-bit (same trick as media.rs).
///
/// # Safety
/// Same contract as [`copy_plane`]: `base` must point at `height` rows spaced `stride` bytes
/// apart, each holding at least `width` samples (bytes for 8-bit, `u16`s for higher depths).
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
        let shift = u32::from(bpc - 8);
        let mut out = vec![0u8; width * height];
        for row in 0..height {
            // SAFETY: caller guarantees the row holds at least `width` u16 samples; stride stays
            // in BYTES in the bitdepth_16 build, and reads are unaligned-tolerant.
            let row_ptr = unsafe { base.offset(row as isize * stride) } as *const u16;
            for col in 0..width {
                // SAFETY: `col < width`, so `row_ptr + col` is within the row.
                let sample = unsafe { row_ptr.add(col).read_unaligned() };
                out[row * width + col] = (sample >> shift).min(255) as u8;
            }
        }
        out
    }
}

/// A colour matrix for YUV->RGB. `Identity` is CICP MC 0 (planes carry G/B/R directly).
enum ColorMatrix {
    Identity,
    YCbCr { kr: f32, kb: f32 },
}

/// Pick luma weights from the AV1 matrix-coefficients code (CICP / ITU-T H.273). Anything not
/// special-cased (including "unspecified") falls back to BT.601 - the web-video default and what
/// our own encoder signals.
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
        (f32::from(y), f32::from(cb) - 128.0, f32::from(cr) - 128.0)
    } else {
        // Studio-swing 8-bit: Y in [16,235], C in [16,240]. Expand before matrixing.
        (
            (f32::from(y) - 16.0) * (255.0 / 219.0),
            (f32::from(cb) - 128.0) * (255.0 / 224.0),
            (f32::from(cr) - 128.0) * (255.0 / 224.0),
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

/// Convert a decoded YUV picture to an opaque RGBA8 image, upsampling chroma by nearest-neighbour.
/// (AV1-in-WebM alpha would ride in BlockAdditions, which our client never emits; the WebM lane
/// is opaque by construction.)
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
                    // Identity/GBR: plane 0 = G, plane 1 = B, plane 2 = R.
                    ColorMatrix::Identity => [cr, luma, cb],
                    ColorMatrix::YCbCr { kr, kb } => {
                        ycbcr_to_rgb(luma, cb, cr, kr, kb, pic.full_range)
                    }
                }
            };
            img.put_pixel(
                x as u32,
                y as u32,
                image::Rgba([rgb[0], rgb[1], rgb[2], 255]),
            );
        }
    }
    img
}

// ---------------------------------------------------------------------------
// Lane 2/3: animated images via the `image` crate, behind the same bomb guard
// as media.rs.
// ---------------------------------------------------------------------------

/// The decode-time limits enforcing the decompression-bomb guard - same construction (and same
/// reasoning) as media.rs's `decode_limits`.
fn decode_limits() -> Limits {
    let mut limits = Limits::no_limits();
    limits.max_image_width = Some(MAX_DECODE_DIMENSION);
    limits.max_image_height = Some(MAX_DECODE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    limits
}

/// Decode an animated image (APNG / GIF / animated WebP) into bounded frames, reporting whether
/// any decoded pixel was transparent (alpha < 255, checked *before* the resize so detection sees
/// the source's own pixels). Frames are pulled lazily and decoding stops at the cap, so a 57 MB
/// fallback-lane APNG costs only the frames actually kept.
fn decode_animation(
    input: &[u8],
    kind: InputKind,
    cap: usize,
) -> Result<(Vec<BoundedFrame>, bool), VideoError> {
    let frames: Box<dyn Iterator<Item = image::ImageResult<image::Frame>>> = match kind {
        InputKind::Apng => {
            let mut decoder = PngDecoder::new(Cursor::new(input)).map_err(map_image_err)?;
            decoder.set_limits(decode_limits()).map_err(map_image_err)?;
            // A plain (non-APNG) PNG still decodes: one frame, which crushes to a 1-frame clip.
            Box::new(decoder.apng().map_err(map_image_err)?.into_frames())
        }
        InputKind::Gif => {
            let mut decoder = GifDecoder::new(Cursor::new(input)).map_err(map_image_err)?;
            decoder.set_limits(decode_limits()).map_err(map_image_err)?;
            Box::new(decoder.into_frames())
        }
        InputKind::Webp => {
            let mut decoder = WebPDecoder::new(Cursor::new(input)).map_err(map_image_err)?;
            decoder.set_limits(decode_limits()).map_err(map_image_err)?;
            Box::new(decoder.into_frames())
        }
        InputKind::Webm => unreachable!("webm takes the demux lane"),
    };

    let mut sink = FrameSink::new(cap);
    let mut transparent = false;
    let mut clock_ms = 0u64;
    for frame in frames {
        if !sink.wants_more() {
            break; // truncation: the cap clips the clip
        }
        let frame = frame.map_err(map_image_err)?;
        let (num, den) = frame.delay().numer_denom_ms();
        let mut dur_ms = u64::from(num) / u64::from(den.max(1));
        if dur_ms == 0 {
            dur_ms = ZERO_DELAY_MS;
        }
        let image = frame.into_buffer();
        transparent = transparent || image.pixels().any(|p| p[3] < 255);
        sink.push(&image, clock_ms, dur_ms)?;
        clock_ms += dur_ms;
    }
    Ok((sink.finish(), transparent))
}

/// Map an `image` decode error onto our taxonomy (same shape as media.rs).
fn map_image_err(error: image::ImageError) -> VideoError {
    let detail = error.to_string();
    match error {
        image::ImageError::Unsupported(_) => VideoError::Unsupported(detail),
        _ => VideoError::Decode(detail),
    }
}

// ---------------------------------------------------------------------------
// Ogg Opus: unwrap the fallback lane's audio blob. Packets are NEVER decoded -
// the OpusHead and the raw packets pass through into the WebM mux.
// ---------------------------------------------------------------------------

/// Parse an Ogg Opus blob into a passthrough [`AudioTrack`]. Packet timestamps are derived from
/// each packet's own self-describing TOC duration (accumulated from zero), not from granule
/// positions - the TOC is what the mux timing needs and it cannot be spoofed independently of
/// the audio the viewer will hear.
fn parse_ogg_opus(input: &[u8]) -> Result<AudioTrack, VideoError> {
    let mut reader = ogg::PacketReader::new(Cursor::new(input));
    let map_ogg = |e: ogg::OggReadError| VideoError::Decode(format!("ogg parse failed: {e}"));

    // First packet of the (first) logical stream must be the OpusHead.
    let head = reader
        .read_packet()
        .map_err(map_ogg)?
        .ok_or_else(|| VideoError::Decode("ogg stream is empty".into()))?;
    let serial = head.stream_serial();
    let (channels, pre_skip) = parse_opus_head(&head.data)?;
    let codec_private = head.data;

    let mut packets: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut samples = 0u64; // running position in 48 kHz samples
    let mut seen_tags = false;
    while let Some(packet) = reader.read_packet().map_err(map_ogg)? {
        // A hostile blob could interleave other logical streams; only the Opus stream counts.
        if packet.stream_serial() != serial {
            continue;
        }
        // Second packet is the OpusTags metadata; skipped, never redistributed.
        if !seen_tags {
            seen_tags = true;
            continue;
        }
        let ms = samples * 1000 / OPUS_SAMPLE_RATE;
        samples += opus_packet_samples(&packet.data)?;
        packets.push((ms, packet.data));
    }
    if packets.is_empty() {
        return Err(VideoError::Decode("ogg has no opus audio packets".into()));
    }
    Ok(AudioTrack {
        codec_private,
        channels,
        pre_skip,
        packets,
    })
}

/// Validate an OpusHead and pull out (channels, pre_skip). Layout per RFC 7845 §5.1:
/// magic(8) version(1) channels(1) pre_skip(u16 LE) input_rate(u32 LE) gain(i16) mapping(1).
fn parse_opus_head(head: &[u8]) -> Result<(u8, u16), VideoError> {
    if head.len() < 19 || &head[0..8] != b"OpusHead" {
        return Err(VideoError::Decode("missing or malformed OpusHead".into()));
    }
    let channels = head[9];
    if channels == 0 {
        return Err(VideoError::Decode("OpusHead declares zero channels".into()));
    }
    let pre_skip = u16::from_le_bytes([head[10], head[11]]);
    Ok((channels, pre_skip))
}

/// An Opus packet's duration in 48 kHz samples, from its self-describing TOC byte (RFC 6716 §3.1):
/// the config picks the per-frame duration, the count code the number of frames.
fn opus_packet_samples(packet: &[u8]) -> Result<u64, VideoError> {
    let toc = *packet
        .first()
        .ok_or_else(|| VideoError::Decode("empty opus packet".into()))?;
    let config = toc >> 3;
    let frame_samples: u64 = match config {
        0..=11 => [480, 960, 1920, 2880][(config & 3) as usize], // SILK 10/20/40/60 ms
        12..=15 => [480, 960][(config & 1) as usize],            // Hybrid 10/20 ms
        _ => [120, 240, 480, 960][(config & 3) as usize],        // CELT 2.5/5/10/20 ms
    };
    let frames: u64 = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => {
            let count = packet
                .get(1)
                .map(|b| u64::from(b & 0x3F))
                .filter(|c| *c > 0)
                .ok_or_else(|| VideoError::Decode("malformed opus packet".into()))?;
            count
        }
    };
    Ok(frames * frame_samples)
}

// ---------------------------------------------------------------------------
// AV1 encode (rav1e) + RGBA->YUV.
// ---------------------------------------------------------------------------

/// One encoded AV1 temporal unit, ready to become a WebM SimpleBlock.
struct Av1Packet {
    ms: u64,
    keyframe: bool,
    data: Vec<u8>,
}

/// The crushed AV1 stream plus the bits the mux needs.
struct EncodedVideo {
    packets: Vec<Av1Packet>,
    /// AV1CodecConfigurationRecord for the track's CodecPrivate, when the sequence header could
    /// be located in the first packet (see [`build_av1c`]).
    av1c: Option<Vec<u8>>,
}

/// Encode bounded RGBA frames to AV1 with rav1e at the crush settings - in parallel, one
/// independent encoder per keyframe interval. AV1 references never cross a keyframe, so cutting
/// the clip into [`KEYFRAME_INTERVAL_FRAMES`]-sized chunks and encoding each in its own context
/// produces the same stream shape a single long encode would (every chunk opens with the
/// keyframe the interval demanded anyway) while letting a multi-core box chew all chunks at
/// once. This matters because the no-asm pure-rust rav1e is slow serially (~0.2 s/frame at 320p
/// even at speed 10 with tiles); chunking turns a ~2-minute full-length encode into seconds of
/// wall clock. Packets are stitched back in chunk order, so timestamps stay monotonic.
fn encode_av1(
    frames: &[BoundedFrame],
    width: u32,
    height: u32,
    flatten: bool,
) -> Result<EncodedVideo, VideoError> {
    let chunk_len = KEYFRAME_INTERVAL_FRAMES as usize;
    // Scoped threads (chunks borrow `frames`); each chunk's rav1e context shares the global
    // rayon pool for its tile work, so the box is saturated without oversubscription drama.
    let chunk_results: Vec<Result<Vec<Av1Packet>, VideoError>> = std::thread::scope(|scope| {
        let handles: Vec<_> = frames
            .chunks(chunk_len)
            .map(|chunk| scope.spawn(move || encode_av1_chunk(chunk, width, height, flatten)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| VideoError::Decode("av1 encoder thread panicked".into()))
                    .and_then(|result| result)
            })
            .collect()
    });

    let mut packets: Vec<Av1Packet> = Vec::with_capacity(frames.len());
    for result in chunk_results {
        packets.extend(result?);
    }
    let av1c = packets
        .first()
        .and_then(|p| extract_sequence_header_obu(&p.data))
        .and_then(build_av1c);
    Ok(EncodedVideo { packets, av1c })
}

/// Encode one keyframe-aligned chunk of frames in its own rav1e context. Frames are converted to
/// 4:2:0 limited-range BT.601 (matching the colour description signalled in the bitstream, and
/// the default our decode side assumes for unspecified web video). rav1e emits one packet per
/// shown frame with `input_frameno` increasing sequentially, so packet N carries chunk frame N's
/// timestamp.
fn encode_av1_chunk(
    frames: &[BoundedFrame],
    width: u32,
    height: u32,
    flatten: bool,
) -> Result<Vec<Av1Packet>, VideoError> {
    let mut enc = EncoderConfig::with_speed_preset(AV1_SPEED);
    enc.width = width as usize;
    enc.height = height as usize;
    enc.bit_depth = 8;
    enc.chroma_sampling = ChromaSampling::Cs420;
    enc.pixel_range = PixelRange::Limited;
    // sRGB primaries/transfer (canvas-land pixels) with the BT.601 matrix used below.
    enc.color_description = Some(ColorDescription {
        color_primaries: ColorPrimaries::BT709,
        transfer_characteristics: TransferCharacteristics::SRGB,
        matrix_coefficients: MatrixCoefficients::BT601,
    });
    enc.quantizer = AV1_QUANTIZER;
    enc.min_key_frame_interval = KEYFRAME_INTERVAL_FRAMES.min(12);
    enc.max_key_frame_interval = KEYFRAME_INTERVAL_FRAMES;
    // Forward-only references. This trades a little compression (no alt-ref frames) for roughly
    // half the encode time - and the no-asm pure-rust rav1e needs every halving it can get: with
    // bidirectional refs a full-length 320p clip blows through the ingest time budget even with
    // tiles. Revisit if rav1e ever grows fast pure-rust motion search.
    enc.low_latency = true;
    enc.tiles = AV1_TILES;
    // Nominal only: real presentation times ride in the WebM mux, per kept frame.
    enc.time_base = Rational {
        num: 1,
        den: 1000 / MIN_FRAME_SPACING_MS,
    };

    let cfg = Config::new().with_encoder_config(enc);
    let mut ctx = cfg
        .new_context::<u8>()
        .map_err(|e| VideoError::Decode(format!("rav1e config rejected: {e:?}")))?;

    let mut packets: Vec<(u64, bool, Vec<u8>)> = Vec::new();
    let receive = |ctx: &mut rav1e::Context<u8>,
                   packets: &mut Vec<(u64, bool, Vec<u8>)>|
     -> Result<bool, VideoError> {
        // Returns false once the encoder is fully drained (LimitReached).
        loop {
            match ctx.receive_packet() {
                Ok(pkt) => {
                    packets.push((
                        pkt.input_frameno,
                        pkt.frame_type == FrameType::KEY,
                        pkt.data,
                    ));
                }
                Err(EncoderStatus::Encoded) => continue,
                Err(EncoderStatus::NeedMoreData) => return Ok(true),
                Err(EncoderStatus::LimitReached) => return Ok(false),
                Err(e) => return Err(VideoError::Decode(format!("rav1e encode failed: {e:?}"))),
            }
        }
    };

    for bounded in frames {
        let (y, u, v) = rgba_to_yuv420(&bounded.image, flatten);
        let mut frame = ctx.new_frame();
        frame.planes[0].copy_from_raw_u8(&y, width as usize, 1);
        frame.planes[1].copy_from_raw_u8(&u, (width / 2) as usize, 1);
        frame.planes[2].copy_from_raw_u8(&v, (width / 2) as usize, 1);
        ctx.send_frame(frame)
            .map_err(|e| VideoError::Decode(format!("rav1e rejected a frame: {e:?}")))?;
        // Drain opportunistically so the encoder's queue never balloons.
        receive(&mut ctx, &mut packets)?;
    }
    ctx.flush();
    while receive(&mut ctx, &mut packets)? {}

    // Packets arrive with sequentially-increasing input_frameno; sort defensively and map each
    // back to its kept frame's honest (absolute) timestamp.
    packets.sort_by_key(|(frameno, _, _)| *frameno);
    Ok(packets
        .into_iter()
        .map(|(frameno, keyframe, data)| {
            let i = (frameno as usize).min(frames.len() - 1);
            Av1Packet {
                ms: frames[i].ms,
                keyframe,
                data,
            }
        })
        .collect())
}

/// Convert an RGBA frame to planar 4:2:0 limited-range BT.601 (the matrix signalled in the
/// bitstream). Chroma is box-averaged over each 2x2 block (dims are forced even). When `flatten`
/// is set, alpha is composited onto [`FLATTEN_BACKGROUND`] first - the transparent-with-audio
/// ruling.
fn rgba_to_yuv420(img: &RgbaImage, flatten: bool) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let w = img.width() as usize;
    let h = img.height() as usize;
    let mut y_plane = vec![0u8; w * h];
    let mut cb_full = vec![0f32; w * h];
    let mut cr_full = vec![0f32; w * h];

    for (i, px) in img.pixels().enumerate() {
        let [mut r, mut g, mut b] = [f32::from(px[0]), f32::from(px[1]), f32::from(px[2])];
        if flatten {
            let a = f32::from(px[3]) / 255.0;
            r = r * a + f32::from(FLATTEN_BACKGROUND[0]) * (1.0 - a);
            g = g * a + f32::from(FLATTEN_BACKGROUND[1]) * (1.0 - a);
            b = b * a + f32::from(FLATTEN_BACKGROUND[2]) * (1.0 - a);
        }
        // BT.601 luma, then studio-swing quantisation (Y 16..235, C 16..240).
        let luma = 0.299 * r + 0.587 * g + 0.114 * b;
        y_plane[i] = clamp_u8(16.0 + luma * (219.0 / 255.0));
        cb_full[i] = (b - luma) / 1.772;
        cr_full[i] = (r - luma) / 1.402;
    }

    let (cw, ch) = (w / 2, h / 2);
    let mut u_plane = vec![0u8; cw * ch];
    let mut v_plane = vec![0u8; cw * ch];
    for cy in 0..ch {
        for cx in 0..cw {
            let (x, y) = (cx * 2, cy * 2);
            let idx = [
                y * w + x,
                y * w + x + 1,
                (y + 1) * w + x,
                (y + 1) * w + x + 1,
            ];
            let cb: f32 = idx.iter().map(|&i| cb_full[i]).sum::<f32>() / 4.0;
            let cr: f32 = idx.iter().map(|&i| cr_full[i]).sum::<f32>() / 4.0;
            u_plane[cy * cw + cx] = clamp_u8(128.0 + cb * (224.0 / 255.0));
            v_plane[cy * cw + cx] = clamp_u8(128.0 + cr * (224.0 / 255.0));
        }
    }
    (y_plane, u_plane, v_plane)
}

// ---------------------------------------------------------------------------
// av1C (AV1CodecConfigurationRecord) for the WebM CodecPrivate.
// ---------------------------------------------------------------------------

/// Walk the OBUs in an AV1 temporal unit and return the sequence-header OBU (type 1) verbatim
/// (header + size field + payload), or None if there isn't one.
fn extract_sequence_header_obu(data: &[u8]) -> Option<Vec<u8>> {
    let mut pos = 0usize;
    while pos < data.len() {
        let header = data[pos];
        if header & 0x80 != 0 {
            return None; // forbidden bit: not a valid OBU stream
        }
        let obu_type = (header >> 3) & 0x0F;
        let has_extension = header & 0x04 != 0;
        let has_size = header & 0x02 != 0;
        let mut off = pos + 1 + usize::from(has_extension);
        let payload_end = if has_size {
            let (size, n) = read_leb128(data, off)?;
            off += n;
            off.checked_add(usize::try_from(size).ok()?)?
        } else {
            data.len() // a size-less OBU extends to the end of the temporal unit
        };
        if payload_end > data.len() {
            return None;
        }
        if obu_type == 1 {
            return Some(data[pos..payload_end].to_vec());
        }
        pos = payload_end;
    }
    None
}

/// Read an unsigned LEB128 at `pos`; returns (value, bytes consumed).
fn read_leb128(data: &[u8], pos: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for i in 0..8 {
        let byte = *data.get(pos + i)?;
        value |= u64::from(byte & 0x7F) << (7 * i);
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
    }
    None
}

/// Build the 4-byte av1C prefix + configOBUs from our own sequence-header OBU. Profile and level
/// are parsed out of the header's leading bits; the remaining flag bits are constants of our
/// encoder config (8-bit, 4:2:0, non-monochrome). Returns None when the header takes a shape we
/// don't parse (timing info present - rav1e doesn't emit it, so in practice never), in which
/// case the CodecPrivate is simply omitted: players tolerate its absence and our own demux
/// round-trip never needs it.
fn build_av1c(seq_obu: Vec<u8>) -> Option<Vec<u8>> {
    // Locate the sequence-header payload past the OBU header + size field.
    let header = *seq_obu.first()?;
    let has_extension = header & 0x04 != 0;
    let has_size = header & 0x02 != 0;
    let mut off = 1 + usize::from(has_extension);
    if has_size {
        let (_, n) = read_leb128(&seq_obu, off)?;
        off += n;
    }
    let payload = seq_obu.get(off..)?;

    let mut bits = BitReader::new(payload);
    let seq_profile = bits.read(3)?;
    let _still_picture = bits.read(1)?;
    let reduced = bits.read(1)? == 1;
    let (seq_level_idx, seq_tier) = if reduced {
        (bits.read(5)?, 0)
    } else {
        if bits.read(1)? == 1 {
            return None; // timing_info_present: variable-length fields we don't parse
        }
        let _initial_display_delay_present = bits.read(1)?;
        let _operating_points_cnt_minus_1 = bits.read(5)?;
        let _operating_point_idc = bits.read(12)?;
        let level = bits.read(5)?;
        let tier = if level > 7 { bits.read(1)? } else { 0 };
        (level, tier)
    };

    let mut av1c = Vec::with_capacity(4 + seq_obu.len());
    av1c.push(0x81); // marker=1, version=1
    av1c.push(((seq_profile as u8) << 5) | (seq_level_idx as u8));
    // tier | high_bitdepth=0 | twelve_bit=0 | monochrome=0 | subsampling x=1 y=1 | position=0:
    // constants of our encoder config (8-bit 4:2:0), not parsed.
    av1c.push(((seq_tier as u8) << 7) | (1 << 3) | (1 << 2));
    av1c.push(0x00); // no initial_presentation_delay
    av1c.extend_from_slice(&seq_obu);
    Some(av1c)
}

/// A big-endian bit reader for the few fixed-width sequence-header fields av1C needs.
struct BitReader<'a> {
    data: &'a [u8],
    pos: usize, // in bits
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader { data, pos: 0 }
    }

    fn read(&mut self, n: usize) -> Option<u32> {
        let mut value = 0u32;
        for _ in 0..n {
            let byte = *self.data.get(self.pos / 8)?;
            let bit = (byte >> (7 - self.pos % 8)) & 1;
            value = (value << 1) | u32::from(bit);
            self.pos += 1;
        }
        Some(value)
    }
}

// ---------------------------------------------------------------------------
// WebM mux: a hand-rolled EBML writer.
//
// webm-iterable stays our *demuxer*, but its writer has a corrupting edge: it
// encodes an element size of 127 as the one-byte vint 0xFF, which is the
// RESERVED all-ones "unknown size" pattern (likewise 16383 -> 0x7FFF, and so
// on at every width). Any SimpleBlock whose payload landed on such a boundary
// - e.g. a 123-byte Opus packet - produced a file even its own reader rejects.
// The fix is this small writer: EBML emission is bounded and well understood
// (the JS spike hand-rolled APNG and Ogg the same way), and encoding sizes
// correctly is a dozen lines.
// ---------------------------------------------------------------------------

/// Track numbers in our own output. Fixed: we always write video as 1, audio (if any) as 2.
const VIDEO_TRACK: u64 = 1;
const AUDIO_TRACK: u64 = 2;

// The Matroska/WebM element ids we emit. An EBML id's leading byte carries its own length
// marker, so ids are written verbatim (minimal big-endian bytes of these constants).
const ID_EBML: u32 = 0x1A45_DFA3;
const ID_EBML_VERSION: u32 = 0x4286;
const ID_EBML_READ_VERSION: u32 = 0x42F7;
const ID_EBML_MAX_ID_LENGTH: u32 = 0x42F2;
const ID_EBML_MAX_SIZE_LENGTH: u32 = 0x42F3;
const ID_DOC_TYPE: u32 = 0x4282;
const ID_DOC_TYPE_VERSION: u32 = 0x4287;
const ID_DOC_TYPE_READ_VERSION: u32 = 0x4285;
const ID_SEGMENT: u32 = 0x1853_8067;
const ID_INFO: u32 = 0x1549_A966;
const ID_TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const ID_DURATION: u32 = 0x4489;
const ID_MUXING_APP: u32 = 0x4D80;
const ID_WRITING_APP: u32 = 0x5741;
const ID_TRACKS: u32 = 0x1654_AE6B;
const ID_TRACK_ENTRY: u32 = 0xAE;
const ID_TRACK_NUMBER: u32 = 0xD7;
const ID_TRACK_UID: u32 = 0x73C5;
const ID_TRACK_TYPE: u32 = 0x83;
const ID_FLAG_LACING: u32 = 0x9C;
const ID_CODEC_ID: u32 = 0x86;
const ID_CODEC_PRIVATE: u32 = 0x63A2;
const ID_CODEC_DELAY: u32 = 0x56AA;
const ID_SEEK_PRE_ROLL: u32 = 0x56BB;
const ID_VIDEO: u32 = 0xE0;
const ID_PIXEL_WIDTH: u32 = 0xB0;
const ID_PIXEL_HEIGHT: u32 = 0xBA;
const ID_AUDIO: u32 = 0xE1;
const ID_SAMPLING_FREQUENCY: u32 = 0xB5;
const ID_CHANNELS: u32 = 0x9F;
const ID_CLUSTER: u32 = 0x1F43_B675;
const ID_TIMESTAMP: u32 = 0xE7;
const ID_SIMPLE_BLOCK: u32 = 0xA3;

/// Encode a *known* element size as an EBML vint, always avoiding the all-ones pattern (which
/// means "unknown size") at every width - the exact corner the off-the-shelf writer got wrong.
fn ebml_size(size: usize) -> Vec<u8> {
    let size = size as u64;
    for len in 1..=8usize {
        // All-ones at this width is reserved for "unknown"; sizes at or past it take more bytes.
        if size < (1u64 << (7 * len)) - 1 {
            let mut bytes = vec![0u8; len];
            for (i, byte) in bytes.iter_mut().rev().enumerate() {
                *byte = (size >> (8 * i)) as u8;
            }
            bytes[0] |= 0x80u8 >> (len - 1);
            return bytes;
        }
    }
    unreachable!("element sizes are bounded far below the 56-bit vint ceiling");
}

/// One complete EBML element: id (verbatim), size vint, payload.
fn el(id: u32, payload: &[u8]) -> Vec<u8> {
    let id_bytes = id.to_be_bytes();
    let skip = id_bytes.iter().take_while(|b| **b == 0).count();
    let size = ebml_size(payload.len());
    let mut out = Vec::with_capacity(4 + size.len() + payload.len());
    out.extend_from_slice(&id_bytes[skip..]);
    out.extend_from_slice(&size);
    out.extend_from_slice(payload);
    out
}

/// An unsigned-integer element (minimal big-endian payload, at least one byte).
fn el_uint(id: u32, value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count().min(7);
    el(id, &bytes[skip..])
}

/// A float element (8-byte big-endian IEEE 754).
fn el_float(id: u32, value: f64) -> Vec<u8> {
    el(id, &value.to_be_bytes())
}

/// A UTF-8 string element.
fn el_str(id: u32, value: &str) -> Vec<u8> {
    el(id, value.as_bytes())
}

/// A master element from already-encoded children.
fn el_master(id: u32, children: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = children.iter().flatten().copied().collect();
    el(id, &payload)
}

/// A SimpleBlock: 1-byte track vint (our track numbers are 1 and 2), i16 relative timestamp,
/// flags (keyframe bit), then the codec data verbatim.
fn el_simple_block(track: u64, rel_ts: i16, keyframe: bool, data: &[u8]) -> Vec<u8> {
    debug_assert!(track < 0x80, "our track numbers fit a 1-byte vint");
    let mut payload = Vec::with_capacity(4 + data.len());
    payload.push(0x80 | track as u8);
    payload.extend_from_slice(&rel_ts.to_be_bytes());
    payload.push(if keyframe { 0x80 } else { 0x00 });
    payload.extend_from_slice(data);
    el(ID_SIMPLE_BLOCK, &payload)
}

/// Mux crushed AV1 packets (+ passthrough Opus) into a WebM: EBML header (webm doctype),
/// Info (ms timestamps), Tracks, then clusters split on video keyframes (and the i16-relative-
/// timestamp ceiling), blocks interleaved in presentation order.
fn mux_webm(
    video: &EncodedVideo,
    audio: Option<&AudioTrack>,
    duration_ms: u64,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, VideoError> {
    let header = el_master(
        ID_EBML,
        &[
            el_uint(ID_EBML_VERSION, 1),
            el_uint(ID_EBML_READ_VERSION, 1),
            el_uint(ID_EBML_MAX_ID_LENGTH, 4),
            el_uint(ID_EBML_MAX_SIZE_LENGTH, 8),
            el_str(ID_DOC_TYPE, "webm"),
            el_uint(ID_DOC_TYPE_VERSION, 4),
            el_uint(ID_DOC_TYPE_READ_VERSION, 2),
        ],
    );

    let info = el_master(
        ID_INFO,
        &[
            // 1 tick = 1_000_000 ns = 1 ms: every timestamp in this file is in milliseconds.
            el_uint(ID_TIMESTAMP_SCALE, 1_000_000),
            el_float(ID_DURATION, duration_ms as f64),
            el_str(ID_MUXING_APP, "ringtome"),
            el_str(ID_WRITING_APP, "ringtome"),
        ],
    );

    let mut video_entry = vec![
        el_uint(ID_TRACK_NUMBER, VIDEO_TRACK),
        el_uint(ID_TRACK_UID, VIDEO_TRACK),
        el_uint(ID_TRACK_TYPE, 1),
        el_uint(ID_FLAG_LACING, 0),
        el_str(ID_CODEC_ID, "V_AV1"),
        el_master(
            ID_VIDEO,
            &[
                el_uint(ID_PIXEL_WIDTH, u64::from(width)),
                el_uint(ID_PIXEL_HEIGHT, u64::from(height)),
            ],
        ),
    ];
    if let Some(av1c) = &video.av1c {
        video_entry.push(el(ID_CODEC_PRIVATE, av1c));
    }
    let mut track_entries = vec![el_master(ID_TRACK_ENTRY, &video_entry)];
    if let Some(a) = audio {
        track_entries.push(el_master(
            ID_TRACK_ENTRY,
            &[
                el_uint(ID_TRACK_NUMBER, AUDIO_TRACK),
                el_uint(ID_TRACK_UID, AUDIO_TRACK),
                el_uint(ID_TRACK_TYPE, 2),
                el_uint(ID_FLAG_LACING, 0),
                el_str(ID_CODEC_ID, "A_OPUS"),
                // Opus decoder warm-up: pre-skip in ns, plus the RFC 7845 standard 80 ms pre-roll.
                el_uint(
                    ID_CODEC_DELAY,
                    u64::from(a.pre_skip) * 1_000_000_000 / OPUS_SAMPLE_RATE,
                ),
                el_uint(ID_SEEK_PRE_ROLL, 80_000_000),
                el(ID_CODEC_PRIVATE, &a.codec_private),
                el_master(
                    ID_AUDIO,
                    &[
                        // Opus decode always runs at 48 kHz regardless of the input's rate.
                        el_float(ID_SAMPLING_FREQUENCY, 48_000.0),
                        el_uint(ID_CHANNELS, u64::from(a.channels)),
                    ],
                ),
            ],
        ));
    }
    let tracks = el_master(ID_TRACKS, &track_entries);

    // Interleave video + audio blocks in presentation order (video first at equal timestamps, so
    // a keyframe opens its own cluster before the audio that shares its instant).
    struct MuxBlock<'a> {
        ms: u64,
        track: u64,
        keyframe: bool,
        data: &'a [u8],
    }
    let mut blocks: Vec<MuxBlock> = video
        .packets
        .iter()
        .map(|p| MuxBlock {
            ms: p.ms,
            track: VIDEO_TRACK,
            keyframe: p.keyframe,
            data: &p.data,
        })
        .collect();
    if let Some(a) = audio {
        blocks.extend(a.packets.iter().map(|(ms, data)| MuxBlock {
            ms: *ms,
            track: AUDIO_TRACK,
            keyframe: true, // every Opus packet is independently decodable
            data,
        }));
    }
    blocks.sort_by_key(|b| (b.ms, b.track));

    // Cut clusters at video keyframes and at the relative-timestamp ceiling (blocks are sorted,
    // so the split-before-add keeps every relative timestamp in 0..=CLUSTER_MAX_SPAN_MS, well
    // inside i16).
    let mut clusters: Vec<Vec<u8>> = Vec::new();
    let mut cluster: Vec<Vec<u8>> = Vec::new();
    let mut cluster_start_ms = 0u64;
    for block in &blocks {
        let starts_new = !cluster.is_empty()
            && ((block.track == VIDEO_TRACK && block.keyframe)
                || block.ms.saturating_sub(cluster_start_ms) > CLUSTER_MAX_SPAN_MS);
        if starts_new {
            clusters.push(el_master(ID_CLUSTER, &std::mem::take(&mut cluster)));
        }
        if cluster.is_empty() {
            cluster_start_ms = block.ms;
            cluster.push(el_uint(ID_TIMESTAMP, cluster_start_ms));
        }
        let rel = i16::try_from(block.ms - cluster_start_ms)
            .map_err(|_| VideoError::Decode("cluster overflow in webm mux".into()))?;
        cluster.push(el_simple_block(
            block.track,
            rel,
            block.keyframe,
            block.data,
        ));
    }
    if !cluster.is_empty() {
        clusters.push(el_master(ID_CLUSTER, &cluster));
    }

    let mut segment_children = vec![info, tracks];
    segment_children.append(&mut clusters);
    let segment = el_master(ID_SEGMENT, &segment_children);

    let mut out = Vec::with_capacity(header.len() + segment.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&segment);
    Ok(out)
}

// ---------------------------------------------------------------------------
// APNG encode (the `png` crate - the same backend the `image` crate wraps).
// ---------------------------------------------------------------------------

/// Encode bounded RGBA frames as a crushed APNG (the transparent + silent route; alpha survives).
/// PNG is lossless, so the "crush" here is the 320p bound + the frame-rate cap doing the work.
fn encode_apng(frames: &[BoundedFrame], width: u32, height: u32) -> Result<Vec<u8>, VideoError> {
    let map_png = |e: png::EncodingError| VideoError::Decode(format!("apng encode failed: {e}"));
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .set_animated(frames.len() as u32, 0) // all frames animate; loop forever
        .map_err(map_png)?;
    let mut writer = encoder.write_header().map_err(map_png)?;
    for frame in frames {
        // Per-frame delay as a fraction of a second; ms denominators cap the numerator at ~65 s.
        let num = u16::try_from(frame.dur_ms).unwrap_or(u16::MAX);
        writer.set_frame_delay(num, 1000).map_err(map_png)?;
        writer
            .write_image_data(frame.image.as_raw())
            .map_err(map_png)?;
    }
    writer.finish().map_err(map_png)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests: real fixtures from sample_media/ (the actual browser-lane outputs)
// windowed to CI speed via CrushOpts::max_frames; full-length dumps are
// #[ignore]d, mirroring media.rs.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    // The off-the-shelf writer is still fine for synthesising small *foreign* WebMs to throw at
    // our demuxer (none of the test files land on its size-127 vint bug).
    use webm_iterable::WebmWriter;

    fn corpus(name: &str) -> Vec<u8> {
        let path = format!("{}/../sample_media/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(&path).unwrap_or_else(|e| panic!("corpus fixture {name}: {e}"))
    }

    fn scratch() -> PathBuf {
        let dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../scratch/video"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The CI window into the big fixtures: enough frames to exercise the whole pipeline
    /// (multiple output frames, audio interleaving, a real re-encode) inside the module's ~90 s
    /// test budget; the full-length path lives in the #[ignore]d dump test.
    const CI_FRAMES: u32 = 40;

    /// Structural round-trip: re-demux OUR OWN WebM with our own demuxer, check the track
    /// layout, and rav1d-decode the first video packet. No external tools.
    fn assert_webm_round_trips(crushed: &Crushed, expect_audio: bool) {
        let demuxed = demux_webm(&crushed.bytes).expect("our own webm re-demuxes");
        assert_eq!(
            (demuxed.width, demuxed.height),
            (crushed.width, crushed.height),
            "track dims match the report"
        );
        assert!(
            demuxed.video_packets.len() > 1,
            "more than one video block (got {})",
            demuxed.video_packets.len()
        );
        assert_eq!(
            demuxed.audio.is_some(),
            expect_audio,
            "audio track presence"
        );
        if let Some(audio) = &demuxed.audio {
            assert!(!audio.packets.is_empty(), "audio blocks present");
            assert!(
                audio.codec_private.starts_with(b"OpusHead"),
                "OpusHead rides along"
            );
        }

        // The first packet must decode in rav1d (it opens with our keyframe + sequence header).
        let mut decoder = Av1Decoder::open().expect("decoder opens");
        let mut pics = decoder
            .send_packet(&demuxed.video_packets[0].1)
            .expect("first packet decodes");
        pics.extend(decoder.drain().expect("drain"));
        assert!(!pics.is_empty(), "first packet yields a picture");
        assert_eq!(
            (pics[0].width, pics[0].height),
            (crushed.width, crushed.height),
            "decoded dims match"
        );
    }

    /// The happy path: real Chrome AV1-in-WebM (with muxed Opus), windowed to CI size, crushes
    /// to our own WebM and structurally round-trips.
    #[test]
    fn chrome_webm_crushes_and_round_trips() {
        let out = crush(
            &corpus("chrome_intermediary.webm"),
            None,
            CrushOpts {
                max_frames: Some(CI_FRAMES),
            },
        )
        .expect("chrome intermediary crushes");

        assert_eq!(out.format, CrushedFormat::WebmAv1);
        assert!(out.has_audio, "opus survives as passthrough");
        assert!(!out.alpha_flattened);
        assert!(out.width <= MAX_SIDE && out.height <= MAX_SIDE, "bounded");
        assert!(
            out.width.is_multiple_of(2) && out.height.is_multiple_of(2),
            "even dims"
        );
        assert!(out.frame_count > 1, "a real clip (got {})", out.frame_count);
        assert!(out.duration_ms > 0);
        assert_webm_round_trips(&out, true);
    }

    /// The fallback lane: Firefox's APNG frames + separate Ogg Opus. Opaque + audio, so it
    /// crushes to WebM with the audio remuxed in.
    #[test]
    fn firefox_apng_plus_ogg_crushes_to_webm() {
        let out = crush(
            &corpus("firefox_frames.apng"),
            Some(&corpus("firefox_audio.ogx")),
            CrushOpts {
                max_frames: Some(CI_FRAMES),
            },
        )
        .expect("firefox fallback pair crushes");

        assert_eq!(out.format, CrushedFormat::WebmAv1);
        assert!(out.has_audio, "the side-blob opus is muxed in");
        assert!(!out.alpha_flattened, "opaque source");
        assert!(out.width <= MAX_SIDE && out.height <= MAX_SIDE);
        assert!(out.frame_count > 1);
        assert_webm_round_trips(&out, true);
    }

    /// Transparent + silent routes to APNG with alpha intact, verified by decoding our own
    /// output with the image crate.
    #[test]
    fn transparent_silent_gif_goes_apng() {
        let input = corpus("animated_logo_transparent_background.gif");
        let src_decoder = GifDecoder::new(Cursor::new(&input[..])).expect("fixture parses");
        let (src_w, src_h) = src_decoder.dimensions();

        let out = crush(&input, None, CrushOpts::default()).expect("transparent gif crushes");
        assert_eq!(out.format, CrushedFormat::Apng);
        assert!(!out.has_audio);
        assert!(!out.alpha_flattened, "alpha is preserved, not flattened");
        assert!(out.width <= src_w && out.height <= src_h, "never upscaled");

        let decoder = PngDecoder::new(Cursor::new(&out.bytes[..])).expect("output parses as png");
        assert!(decoder.is_apng().expect("apng check"), "output is animated");
        let frames: Vec<_> = decoder
            .apng()
            .expect("apng decoder")
            .into_frames()
            .collect::<Result<_, _>>()
            .expect("output frames decode");
        assert!(
            frames.len() > 1,
            "animation survived (got {} frames)",
            frames.len()
        );
        assert_eq!(
            frames.len(),
            out.frame_count as usize,
            "frame_count is honest"
        );
        let transparent_survived = frames
            .iter()
            .any(|f| f.buffer().pixels().any(|p| p[3] < 255));
        assert!(transparent_survived, "some pixel kept alpha < 255");
    }

    /// Transparent + audio: audio wins the container fight; alpha is flattened onto black and
    /// the result is a WebM. The input APNG is built in-test with the png crate.
    #[test]
    fn transparent_with_audio_flattens_to_webm() {
        // A 2-frame 64x64 APNG, fully transparent except an opaque square that moves.
        let (w, h) = (64u32, 64u32);
        let mut apng = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut apng, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_animated(2, 0).unwrap();
            let mut writer = encoder.write_header().unwrap();
            for frame_no in 0..2u32 {
                let mut pixels = vec![0u8; (w * h * 4) as usize];
                for y in 0..16u32 {
                    for x in 0..16u32 {
                        let px = ((y + 8) * w + x + 8 + frame_no * 16) as usize * 4;
                        pixels[px..px + 4].copy_from_slice(&[250, 40, 40, 255]);
                    }
                }
                writer.set_frame_delay(100, 1000).unwrap();
                writer.write_image_data(&pixels).unwrap();
            }
            writer.finish().unwrap();
        }

        let out = crush(
            &apng,
            Some(&corpus("firefox_audio.ogx")),
            CrushOpts::default(),
        )
        .expect("transparent apng + audio crushes");
        assert_eq!(
            out.format,
            CrushedFormat::WebmAv1,
            "audio forces the webm route"
        );
        assert!(out.has_audio);
        assert!(
            out.alpha_flattened,
            "alpha was flattened onto the background"
        );
        assert_eq!((out.width, out.height), (64, 64));
        assert_webm_round_trips(&out, true);
    }

    /// An opaque animated GIF (no audio) routes to WebM. Opacity is verified against the
    /// fixture first so the routing assertion means something.
    #[test]
    fn opaque_animated_gif_goes_webm() {
        let input = corpus("animated_color_squirrel.gif");
        let decoder = GifDecoder::new(Cursor::new(&input[..])).expect("fixture parses");
        let opaque = decoder
            .into_frames()
            .take(3)
            .all(|f| f.expect("frame").buffer().pixels().all(|p| p[3] == 255));
        assert!(
            opaque,
            "fixture must be opaque for this test to mean anything"
        );

        let out = crush(
            &input,
            None,
            CrushOpts {
                max_frames: Some(12),
            },
        )
        .expect("opaque gif crushes");
        assert_eq!(out.format, CrushedFormat::WebmAv1);
        assert!(!out.has_audio);
        assert!(!out.alpha_flattened);
        assert!(out.frame_count > 1);
        assert_webm_round_trips(&out, false);
    }

    /// Everything outside the closed set errors cleanly: random bytes, a real mp4, and a WebM
    /// whose video codec is not AV1 (synthesised with our own muxer's writer).
    #[test]
    fn garbage_and_wrong_codecs_error() {
        assert!(
            matches!(
                crush(b"definitely not a video", None, CrushOpts::default()),
                Err(VideoError::Unsupported(_))
            ),
            "random bytes are unsupported"
        );

        // A real mp4 from the corpus: recognisable container, firmly outside the closed set.
        assert!(
            matches!(
                crush(&corpus("buck-twenty.mp4"), None, CrushOpts::default()),
                Err(VideoError::Unsupported(_))
            ),
            "mp4 is not an intermediary format"
        );

        // A structurally-valid WebM carrying VP9: right container, wrong codec.
        let mut vp9 = Vec::new();
        {
            let mut writer = WebmWriter::new(&mut vp9);
            writer
                .write(&MatroskaSpec::Ebml(Master::Full(vec![
                    MatroskaSpec::DocType("webm".into()),
                ])))
                .unwrap();
            writer.write(&MatroskaSpec::Segment(Master::Start)).unwrap();
            writer
                .write(&MatroskaSpec::Tracks(Master::Full(vec![
                    MatroskaSpec::TrackEntry(Master::Full(vec![
                        MatroskaSpec::TrackNumber(1),
                        MatroskaSpec::TrackType(1),
                        MatroskaSpec::CodecID("V_VP9".into()),
                        MatroskaSpec::Video(Master::Full(vec![
                            MatroskaSpec::PixelWidth(64),
                            MatroskaSpec::PixelHeight(64),
                        ])),
                    ])),
                ])))
                .unwrap();
            writer.write(&MatroskaSpec::Segment(Master::End)).unwrap();
        }
        assert!(
            matches!(
                crush(&vp9, None, CrushOpts::default()),
                Err(VideoError::Unsupported(_))
            ),
            "non-AV1 webm is unsupported"
        );
    }

    /// The time axis is bounded both ways: the frame cap TRUNCATES (the documented policy - the
    /// clip is clipped, not refused), and a WebM *declaring* an over-budget duration is refused
    /// with TooLong before any decode.
    #[test]
    fn frame_cap_enforced() {
        // Truncation: the squirrel has many frames; a cap of 3 clips the clip.
        let out = crush(
            &corpus("animated_color_squirrel.gif"),
            None,
            CrushOpts {
                max_frames: Some(3),
            },
        )
        .expect("capped crush still succeeds");
        assert!(
            out.frame_count >= 1 && out.frame_count <= 3,
            "cap truncates to at most 3 frames (got {})",
            out.frame_count
        );

        // Declared-duration refusal: a WebM claiming ~28 hours is a misbehaving client.
        let mut long = Vec::new();
        {
            let mut writer = WebmWriter::new(&mut long);
            writer
                .write(&MatroskaSpec::Ebml(Master::Full(vec![
                    MatroskaSpec::DocType("webm".into()),
                ])))
                .unwrap();
            writer.write(&MatroskaSpec::Segment(Master::Start)).unwrap();
            writer
                .write(&MatroskaSpec::Info(Master::Full(vec![
                    MatroskaSpec::TimestampScale(1_000_000),
                    MatroskaSpec::Duration(100_000_000.0),
                ])))
                .unwrap();
            writer.write(&MatroskaSpec::Segment(Master::End)).unwrap();
        }
        assert!(
            matches!(
                crush(&long, None, CrushOpts::default()),
                Err(VideoError::TooLong(_))
            ),
            "a declared over-budget duration is refused"
        );
    }

    /// Regression for a length-dependent mux corruption: the off-the-shelf EBML writer encoded a
    /// 127-byte element size as the one-byte all-ones vint `0xFF` - the RESERVED "unknown size"
    /// pattern - so any SimpleBlock whose payload happened to land on a vint boundary corrupted
    /// the file (probabilistic in clip length; the full-length dump caught it, the short windows
    /// never did). Two layers, neither needing a real full-length AV1 encode:
    /// (a) a deterministic payload-size sweep across the 1-byte vint boundary, and
    /// (b) a 320-frame tiny synthetic clip crushed end-to-end through multi-cluster mux.
    #[test]
    fn long_clip_mux_round_trips() {
        // (a) SimpleBlock payload = track vint (1) + timestamp (2) + flags (1) + data, so data
        // lengths 100..=150 sweep element sizes 104..=154 - straddling the 127 hazard.
        let packets: Vec<Av1Packet> = (100usize..=150)
            .map(|n| Av1Packet {
                ms: (n as u64 - 100) * 10,
                keyframe: n == 100,
                data: vec![0xAB; n],
            })
            .collect();
        let video = EncodedVideo {
            packets,
            av1c: None,
        };
        let muxed = mux_webm(&video, None, 600, 16, 16).expect("mux");
        let demuxed = demux_webm(&muxed).expect("every payload size re-demuxes");
        assert_eq!(demuxed.video_packets.len(), 51, "all blocks survive");
        for (i, (ms, data)) in demuxed.video_packets.iter().enumerate() {
            assert_eq!(*ms, i as u64 * 10, "timestamps survive");
            assert_eq!(data.len(), 100 + i, "payload sizes survive");
        }

        // (b) A 320-frame 16x16 gradient APNG (opaque + silent -> the WebM route) crushed with
        // default opts: exercises multi-cluster splitting, long timestamp ranges, and the encode
        // drain at full length, at tiny-frame speed.
        let (w, h) = (16u32, 16u32);
        let frame_count = 320u32;
        let mut apng = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut apng, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_animated(frame_count, 0).unwrap();
            let mut writer = encoder.write_header().unwrap();
            for frame_no in 0..frame_count {
                let mut pixels = Vec::with_capacity((w * h * 4) as usize);
                for y in 0..h {
                    for x in 0..w {
                        pixels.extend_from_slice(&[
                            (x * 16) as u8,
                            (y * 16) as u8,
                            (frame_no % 256) as u8,
                            255,
                        ]);
                    }
                }
                writer.set_frame_delay(50, 1000).unwrap();
                writer.write_image_data(&pixels).unwrap();
            }
            writer.finish().unwrap();
        }

        let out = crush(&apng, None, CrushOpts::default()).expect("synthetic long clip crushes");
        assert_eq!(
            out.format,
            CrushedFormat::WebmAv1,
            "opaque + silent routes to webm"
        );
        assert_eq!(
            out.frame_count, frame_count,
            "no frames dropped at exactly 20 fps"
        );
        assert_eq!(out.duration_ms, u64::from(frame_count) * 50);
        let demuxed = demux_webm(&out.bytes).expect("long clip re-demuxes");
        assert_eq!(
            demuxed.video_packets.len(),
            frame_count as usize,
            "every encoded frame survives the mux"
        );
        assert_webm_round_trips(&out, false);
    }

    /// Full-length crush of the real fixtures, dumped to a gitignored `scratch/video/` for human
    /// eyeballing. Ignored by default: minutes of real encode. Run on demand with:
    ///   cargo test -p ringtome-node full_length_dump_to_scratch -- --ignored --nocapture
    #[test]
    #[ignore = "slow (full-length AV1 encodes); on-demand verify + dump to scratch/video/"]
    fn full_length_dump_to_scratch() {
        let dir = scratch();

        let out = crush(
            &corpus("chrome_intermediary.webm"),
            None,
            CrushOpts::default(),
        )
        .expect("full chrome crush");
        println!(
            "chrome_intermediary: {}x{} {} frames {} ms audio={} -> {} KB webm",
            out.width,
            out.height,
            out.frame_count,
            out.duration_ms,
            out.has_audio,
            out.bytes.len() / 1024
        );
        std::fs::write(dir.join("chrome_intermediary.crushed.webm"), &out.bytes).unwrap();
        assert_webm_round_trips(&out, true);

        let out = crush(
            &corpus("animated_logo_transparent_background.gif"),
            None,
            CrushOpts::default(),
        )
        .expect("full transparent gif crush");
        println!(
            "transparent logo gif: {}x{} {} frames {} ms -> {} KB apng",
            out.width,
            out.height,
            out.frame_count,
            out.duration_ms,
            out.bytes.len() / 1024
        );
        std::fs::write(dir.join("transparent_logo.crushed.apng"), &out.bytes).unwrap();
        assert_eq!(out.format, CrushedFormat::Apng);
    }
}
