//! Audio ingest crusher: turn a wild variety of audio uploads into canonical Ogg Opus.
//!
//! This is a hostile-input path, sibling to `media.rs` (stills) and `video.rs` (motion), but for
//! sound. Unlike the video lane there is no client-side laundering step: uploads arrive as opaque
//! bytes claiming to be some audio file, and the server does all the work with pure-rust decoders
//! (symphonia) behind hard bomb guards. The accepted zoo:
//!
//!   1. **MP3, AAC-in-M4A, FLAC, WAV/PCM, Vorbis-in-Ogg** - decoded with symphonia, resampled to
//!      48 kHz (rubato) when needed, and re-encoded to Opus. Because everything on this lane is
//!      decode -> PCM -> re-encode, source metadata (ID3, Vorbis comments, M4A atoms) never
//!      survives into the output: metadata stripping falls out for free.
//!   2. **Ogg Opus** - NOT decoded (there is no production pure-rust Opus *decoder*); an in-spec
//!      Ogg Opus upload passes its packets through untouched (zero generational loss, the AVIF
//!      passthrough precedent) but is re-muxed with a minimal OpusTags so user metadata is
//!      stripped. Out-of-spec Ogg Opus is refused honestly - see [`passthrough_ogg_opus`].
//!
//! Everything else is rejected. Formats are identified from the BYTES (symphonia's probe / our
//! own magic sniff) - the client's extension or content-type label is never trusted.
//!
//! **Fit-to-cap bitrate** is the signature move: the network's per-document cap is ~10 MB, so the
//! encode bitrate is `clamp(cap_bits / duration, FLOOR, HOUSE)`. Short clips get the house
//! quality; long podcasts automatically get crunchier instead of being rejected (an hour lands
//! around 18 kbps and fits); only past the point where even the floor bitrate cannot fit does the
//! upload become [`CrushError::TooLong`].
//!
//! **Memory is bounded** regardless of input length: ~110 minutes of 48 kHz stereo f32 PCM is
//! ~2.5 GB, so the decoded stream is never buffered whole. Decode, resample, and Opus encode all
//! run incrementally with small fixed buffers; the only thing that accumulates is the encoded
//! output (≤ the cap by construction) and a 256-bucket waveform envelope. A RUNNING sample count
//! enforces the duration cap mid-decode, so a lying container header cannot make us do unbounded
//! work.
//!
//! Everything here is a pure function - no I/O, no shared state. CPU-bound; callers run
//! [`crush`] under `tokio::task::spawn_blocking`.

// The public interface below is consumed by the ingest wiring, which lands separately; within this
// binary crate on its own the items read as unused. Keep the lint quiet without hiding real dead
// code elsewhere.
#![allow(dead_code)]

use std::io::Cursor;

use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use ogg::PacketReader;

// The reference libopus, c2rust-transpiled. Raw C-shaped API; all unsafe stays inside the
// LibopusEncoder/tests glue below (the rav1d precedent).
use unsafe_libopus::{
    opus_encode_float, opus_encoder_create, opus_encoder_ctl_impl, opus_encoder_destroy, varargs,
    OpusEncoder, OPUS_APPLICATION_AUDIO, OPUS_GET_LOOKAHEAD_REQUEST, OPUS_SET_BITRATE_REQUEST,
    OPUS_SET_COMPLEXITY_REQUEST,
};

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::audioadapter_buffers::owned::InterleavedOwned;
use rubato::{Fft, FixedSync, Indexing, Resampler};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

// ---------------------------------------------------------------------------
// Tunables. Kept together and clearly named so the crush policy is trivially
// adjustable later without spelunking through the logic below.
// ---------------------------------------------------------------------------

/// Opus's decode rate, and our canonical output rate. Opus only accepts 8/12/16/24/48 kHz input;
/// we resample everything to 48 kHz rather than juggling per-rate frame sizes (see [`Resampled`]).
const OPUS_SAMPLE_RATE: u32 = 48_000;

/// Samples per channel per Opus frame: 20 ms at 48 kHz, the codec's sweet-spot frame size.
const OPUS_FRAME_SAMPLES: usize = 960;

/// The house bitrate: what a short clip gets. 48 kbps stereo Opus is comfortably transparent-ish
/// for speech and respectable for music - the audio sibling of the q18 AVIF crush: good enough,
/// small on purpose.
const HOUSE_BITRATE_BPS: u32 = 48_000;

/// The floor bitrate: fit-to-cap never goes below this. 12 kbps Opus is crunchy but intelligible
/// speech; below it there is no point shipping the audio at all.
const FLOOR_BITRATE_BPS: u32 = 12_000;

/// The default output byte cap, matching the network's ~10 MB per-document ceiling. Callers with
/// a different budget pass [`CrushOpts::max_bytes`]; tests use tiny caps to force fit-to-cap.
const DEFAULT_CAP_BYTES: u64 = 10 * 1024 * 1024;

/// The duration ceiling: where the floor bitrate meets the default cap (~116 minutes). Past this,
/// even maximum crunch cannot fit the cap, so the upload is [`CrushError::TooLong`]. A smaller
/// `max_bytes` tightens the effective ceiling proportionally (see [`effective_max_duration_ms`]).
const MAX_DURATION_MS: u64 = DEFAULT_CAP_BYTES * 8_000 / FLOOR_BITRATE_BPS as u64;

/// Bomb guard: reject inputs declaring more channels than this before decoding anything. Real
/// uploads are mono/stereo/5.1/7.1; a header declaring hundreds of channels is an allocation bomb.
const MAX_INPUT_CHANNELS: usize = 8;

/// Bomb guard: declared sample-rate sanity window. Below 8 kHz nothing intelligible survives our
/// pipeline; above 384 kHz (the highest "hi-res" rate in the wild) the header is lying.
const MIN_INPUT_SAMPLE_RATE: u32 = 8_000;
const MAX_INPUT_SAMPLE_RATE: u32 = 384_000;

/// Slack allowed between the demux-measured duration and what the decode actually produces before
/// we call the container a liar and abort. Codec priming/padding differences are milliseconds;
/// two seconds is generous for honest files and nothing for an attacker.
const DURATION_LIE_SLACK_MS: u64 = 2_000;

/// Opus encoder complexity (0-10, higher = better/slower). libopus's own default; encode speed
/// is far above realtime even at the top setting, so there is nothing to trade away.
const OPUS_COMPLEXITY: i32 = 9;

/// Resampler input chunk, in frames. Small enough to keep buffers tiny, large enough that the
/// FFT resampler runs at a sensible granularity.
const RESAMPLER_CHUNK_FRAMES: usize = 1024;

/// Audio packets per Ogg page in our own mux (~1 s of audio): keeps pages well under the format's
/// limits and seek granularity reasonable.
const OGG_PAGE_PACKETS: usize = 50;

/// The vendor string in our minimal OpusTags. Content-neutral, same spirit as media.rs's marker:
/// no identity, no timestamps - provenance lives in the chain, never in the container.
const OPUS_VENDOR: &str = "ringtome";

/// A fixed serial for our own Ogg stream. Ogg serials only disambiguate multiplexed streams
/// within one file, and we always write exactly one stream, so a constant keeps output
/// deterministic (same input, same bytes).
const OGG_STREAM_SERIAL: u32 = 0x524E_4754; // "RNGT"

/// Waveform envelope resolution: peak buckets across the whole clip, fixed regardless of length
/// (so a hostile duration claim cannot inflate the allocation).
const WAVEFORM_BUCKETS: usize = 256;

/// Waveform thumbnail geometry: one pixel column per bucket.
const WAVEFORM_WIDTH: u32 = 256;
const WAVEFORM_HEIGHT: u32 = 64;

/// Waveform colours: dark background, light trace.
const WAVEFORM_BACKGROUND: [u8; 3] = [24, 24, 28];
const WAVEFORM_FOREGROUND: [u8; 3] = [220, 220, 230];

/// AVIF quality for the waveform thumbnail. Higher than media.rs's q18 crush on purpose: this is
/// synthetic two-tone line art, which q18 smears into mush, and at 256x64 the file is tiny anyway.
const WAVEFORM_AVIF_QUALITY: f32 = 40.0;

/// AVIF encoder speed for the waveform (0 = slowest/best, 10 = fastest). Matches media.rs.
const WAVEFORM_AVIF_SPEED: u8 = 6;

// ---------------------------------------------------------------------------
// Public API (consumed by the ingest wiring, which lands separately).
// ---------------------------------------------------------------------------

/// A successfully crushed audio upload: canonical Ogg Opus plus the facts the ingest wiring
/// stores.
#[derive(Debug)]
pub struct Crushed {
    /// The crushed output: a complete Ogg Opus file.
    pub bytes: Vec<u8>,
    /// Playback duration of the crushed audio.
    pub duration_ms: u64,
    /// Output channel count (1 or 2; >2-channel sources are downmixed).
    pub channels: u8,
    /// The bitrate actually used: the fit-to-cap target on the encode lane, the source-derived
    /// average on the passthrough lane.
    pub bitrate_bps: u32,
    /// True when the input was in-spec Ogg Opus passed through without re-encoding.
    pub passthrough: bool,
    /// A small AVIF waveform thumbnail (peak envelope). `None` on the passthrough lane - we never
    /// decode Opus, so there is no PCM to draw.
    pub waveform_avif: Option<Vec<u8>>,
}

/// Why an upload could not be turned into canonical audio.
#[derive(Debug)]
pub enum CrushError {
    /// Not a format we can decode (or Ogg Opus we cannot re-crush - see [`passthrough_ogg_opus`]).
    Unsupported(String),
    /// Malformed / corrupt / decompression-bomb / decode or encode failure.
    Decode(String),
    /// Longer than even the floor bitrate can fit under the byte cap.
    TooLong(String),
}

impl std::fmt::Display for CrushError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CrushError::Unsupported(detail) => write!(f, "unsupported audio input: {detail}"),
            CrushError::Decode(detail) => write!(f, "could not process audio: {detail}"),
            CrushError::TooLong(detail) => write!(f, "audio too long: {detail}"),
        }
    }
}

impl std::error::Error for CrushError {}

/// Knobs for [`crush`]. `max_bytes: None` means the [`DEFAULT_CAP_BYTES`] network cap;
/// tests pass small `Some(n)` values to force the fit-to-cap and too-long paths cheaply.
#[derive(Debug, Default, Clone, Copy)]
pub struct CrushOpts {
    pub max_bytes: Option<u64>,
}

/// Crush an audio upload to canonical Ogg Opus.
///
/// Pure function, no I/O. CPU-bound (callers run it under `spawn_blocking`).
pub fn crush(input: &[u8], opts: CrushOpts) -> Result<Crushed, CrushError> {
    let cap_bytes = opts.max_bytes.unwrap_or(DEFAULT_CAP_BYTES).max(1);
    let max_ms = effective_max_duration_ms(cap_bytes);

    // Ogg Opus is sniffed by magic before symphonia sees the bytes: symphonia would happily demux
    // the container but cannot decode Opus, and this lane must pass through, not decode.
    if is_ogg_opus(input) {
        return passthrough_ogg_opus(input, cap_bytes, max_ms);
    }
    crush_via_decode(input, cap_bytes, max_ms)
}

/// The duration ceiling for a given byte cap: the point where the floor bitrate exactly fills the
/// cap, bounded by the global [`MAX_DURATION_MS`].
fn effective_max_duration_ms(cap_bytes: u64) -> u64 {
    MAX_DURATION_MS.min(cap_bytes.saturating_mul(8_000) / u64::from(FLOOR_BITRATE_BPS))
}

/// The fit-to-cap bitrate: spend the whole byte budget over the whole duration, clamped into
/// [FLOOR, HOUSE]. Callers have already rejected durations past the floor-meets-cap point.
fn fit_bitrate_bps(cap_bytes: u64, duration_ms: u64) -> u32 {
    let fit = cap_bytes.saturating_mul(8_000) / duration_ms.max(1);
    (fit.min(u64::from(HOUSE_BITRATE_BPS)) as u32).max(FLOOR_BITRATE_BPS)
}

// ---------------------------------------------------------------------------
// Ogg Opus passthrough: re-mux, never re-encode.
// ---------------------------------------------------------------------------

/// Sniff Ogg Opus from the bytes: an "OggS" capture pattern whose first packet (which the first
/// page must contain whole, per RFC 7845) begins with the OpusHead magic.
fn is_ogg_opus(input: &[u8]) -> bool {
    if input.len() < 28 || &input[0..4] != b"OggS" {
        return false;
    }
    let nsegs = input[26] as usize;
    let start = 27 + nsegs;
    input.len() >= start + 8 && &input[start..start + 8] == b"OpusHead"
}

/// Pass an in-spec Ogg Opus upload through without re-encoding (zero generational loss, the AVIF
/// passthrough precedent), re-muxing the stream with a minimal OpusTags so user tags and metadata
/// are stripped. Audio packets and page granule positions are preserved faithfully.
///
/// Out-of-spec Opus (over the byte cap, or over-long) is `Unsupported` / `TooLong` rather than
/// re-crushed: there is no production-quality pure-rust Opus *decoder*, so we cannot decode it to
/// PCM and fit-to-cap it the way the other formats are. Documented honestly rather than papered
/// over; the day a pure-rust decoder lands, this branch becomes a decode lane.
fn passthrough_ogg_opus(input: &[u8], cap_bytes: u64, max_ms: u64) -> Result<Crushed, CrushError> {
    let mut reader = PacketReader::new(Cursor::new(input));
    let map_ogg = |e: ogg::OggReadError| CrushError::Decode(format!("ogg parse failed: {e}"));

    // First packet of the (first) logical stream is the OpusHead - the sniff saw its magic, this
    // parse validates its shape.
    let head = reader
        .read_packet()
        .map_err(map_ogg)?
        .ok_or_else(|| CrushError::Decode("ogg stream is empty".into()))?;
    let serial = head.stream_serial();
    let (channels, pre_skip) = parse_opus_head(&head.data)?;
    if channels > 2 {
        // The canonical form is ≤2 channels and downmixing requires a decode we don't have.
        return Err(CrushError::Unsupported(format!(
            "{channels}-channel Opus (cannot downmix without a pure-rust Opus decoder)"
        )));
    }

    /// One audio packet ready for the re-mux: bytes, plus where its source page ended (so the
    /// output reproduces the source's page boundaries and their granule positions exactly).
    struct AudioPacket {
        data: Vec<u8>,
        ends_page: bool,
        granule: u64,
    }

    let mut packets: Vec<AudioPacket> = Vec::new();
    let mut seen_tags = false;
    while let Some(packet) = reader.read_packet().map_err(map_ogg)? {
        // A hostile blob could interleave other logical streams; only the Opus stream survives.
        if packet.stream_serial() != serial {
            continue;
        }
        // Second packet is the OpusTags metadata block: required by RFC 7845, never redistributed.
        if !seen_tags {
            seen_tags = true;
            if !packet.data.starts_with(b"OpusTags") {
                return Err(CrushError::Decode(
                    "ogg opus stream missing OpusTags".into(),
                ));
            }
            continue;
        }
        packets.push(AudioPacket {
            ends_page: packet.last_in_page(),
            granule: packet.absgp_page(),
            data: packet.data,
        });
    }
    if packets.is_empty() {
        return Err(CrushError::Decode("ogg opus has no audio packets".into()));
    }

    // Duration from granule positions: the final page's granule counts 48 kHz samples including
    // pre-skip (RFC 7845 §4). This is the in-spec gate, not an allocation decision, so trusting
    // the granules is fine - the byte cap above is what bounds our memory.
    let final_granule = packets.last().map(|p| p.granule).unwrap_or(0);
    let duration_ms =
        final_granule.saturating_sub(u64::from(pre_skip)) * 1_000 / u64::from(OPUS_SAMPLE_RATE);
    if duration_ms > max_ms {
        return Err(CrushError::TooLong(format!(
            "ogg opus runs {duration_ms} ms, over the {max_ms} ms bound"
        )));
    }
    if input.len() as u64 > cap_bytes {
        return Err(CrushError::Unsupported(format!(
            "ogg opus is {} bytes, over the {cap_bytes}-byte cap, and cannot be re-crushed \
             (no pure-rust Opus decoder)",
            input.len()
        )));
    }

    // Re-mux: OpusHead verbatim, a minimal OpusTags of our own, then the audio packets with the
    // source's page boundaries and granule positions reproduced.
    let byte_len = |n: usize| n as u64; // for the bitrate arithmetic below
    let mut audio_bytes = 0u64;
    let mut out = Vec::with_capacity(input.len());
    {
        let mut writer = PacketWriter::new(Cursor::new(&mut out));
        let map_io = |e: std::io::Error| CrushError::Decode(format!("ogg write failed: {e}"));
        writer
            .write_packet(head.data, serial, PacketWriteEndInfo::EndPage, 0)
            .map_err(map_io)?;
        writer
            .write_packet(minimal_opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)
            .map_err(map_io)?;
        let last = packets.len() - 1;
        for (i, packet) in packets.into_iter().enumerate() {
            audio_bytes += byte_len(packet.data.len());
            let info = if i == last {
                PacketWriteEndInfo::EndStream
            } else if packet.ends_page {
                PacketWriteEndInfo::EndPage
            } else {
                PacketWriteEndInfo::NormalPacket
            };
            writer
                .write_packet(packet.data, serial, info, packet.granule)
                .map_err(map_io)?;
        }
    }

    // Source-derived average over the audio payload (the closest honest figure to "the rate the
    // encoder used" that a passthrough can report).
    let bitrate_bps =
        u32::try_from(audio_bytes.saturating_mul(8_000) / duration_ms.max(1)).unwrap_or(u32::MAX);

    Ok(Crushed {
        bytes: out,
        duration_ms,
        channels,
        bitrate_bps,
        passthrough: true,
        // No decode on this lane means no PCM to draw a waveform from.
        waveform_avif: None,
    })
}

/// Validate an OpusHead and pull out (channels, pre_skip). Layout per RFC 7845 §5.1:
/// magic(8) version(1) channels(1) pre_skip(u16 LE) input_rate(u32 LE) gain(i16) mapping(1).
fn parse_opus_head(head: &[u8]) -> Result<(u8, u16), CrushError> {
    if head.len() < 19 || &head[0..8] != b"OpusHead" {
        return Err(CrushError::Decode("missing or malformed OpusHead".into()));
    }
    let channels = head[9];
    if channels == 0 {
        return Err(CrushError::Decode("OpusHead declares zero channels".into()));
    }
    let pre_skip = u16::from_le_bytes([head[10], head[11]]);
    Ok((channels, pre_skip))
}

/// The minimal OpusTags packet (RFC 7845 §5.2): magic, our vendor string, zero user comments.
/// This is the whole metadata story for our output - nothing else survives the crush.
fn minimal_opus_tags() -> Vec<u8> {
    let vendor = OPUS_VENDOR.as_bytes();
    let mut tags = Vec::with_capacity(8 + 4 + vendor.len() + 4);
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes()); // user comment count
    tags
}

// ---------------------------------------------------------------------------
// The decode lane: symphonia demux+decode -> downmix -> resample -> Opus.
// ---------------------------------------------------------------------------

/// A probed input: the demuxer plus the facts (bomb-guard-checked) about its best audio track.
struct ProbedTrack {
    format: Box<dyn FormatReader>,
    track_id: u32,
    sample_rate: u32,
    /// Declared channel count, when the container states one (AAC only reveals it at decode time).
    channels: Option<usize>,
    /// Declared frame count, when the container states one. A *claim*, used only as a duration
    /// fallback - never for allocation.
    declared_frames: Option<u64>,
}

/// The channel bomb guard, applied to the declared count at probe time and to the real count at
/// first decode.
fn check_channel_bound(channels: usize) -> Result<(), CrushError> {
    if channels == 0 {
        return Err(CrushError::Decode("track has no channels".into()));
    }
    if channels > MAX_INPUT_CHANNELS {
        return Err(CrushError::Unsupported(format!(
            "{channels} channels (over the {MAX_INPUT_CHANNELS}-channel bound)"
        )));
    }
    Ok(())
}

/// Probe the bytes with symphonia and select the first decodable audio track, enforcing the
/// declared-parameter bomb guards before any decode work. An unrecognised container is
/// `Unsupported`, not corrupt: the format zoo is the contract.
fn probe_track(input: &[u8]) -> Result<ProbedTrack, CrushError> {
    let source = MediaSourceStream::new(Box::new(Cursor::new(input.to_vec())), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &Hint::new(),
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| CrushError::Unsupported(format!("not a recognised audio format: {e}")))?;
    let format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.sample_rate.is_some())
        .ok_or_else(|| CrushError::Unsupported("no decodable audio track".into()))?;

    let sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    if !(MIN_INPUT_SAMPLE_RATE..=MAX_INPUT_SAMPLE_RATE).contains(&sample_rate) {
        return Err(CrushError::Decode(format!(
            "declared sample rate {sample_rate} Hz is outside the \
             {MIN_INPUT_SAMPLE_RATE}-{MAX_INPUT_SAMPLE_RATE} Hz sanity window"
        )));
    }
    // Channel count may be absent at probe time (AAC keeps it in the codec-specific config the
    // decoder parses); when declared, bomb-guard it here, and either way the first decoded buffer
    // re-checks the real count before any pipeline allocation.
    let channels = track.codec_params.channels.map(|c| c.count());
    if let Some(channels) = channels {
        check_channel_bound(channels)?;
    }

    Ok(ProbedTrack {
        track_id: track.id,
        sample_rate,
        channels,
        declared_frames: track.codec_params.n_frames,
        format,
    })
}

/// Measure the track's duration by demuxing it (no decode): sum every packet's own duration.
/// This is what the fit-to-cap bitrate is computed from - measured from the actual packets, not
/// read off a header field the uploader controls. Aborts with `TooLong` the moment the running
/// total crosses the bound, so an absurdly long stream costs only a demux prefix.
///
/// Falls back to the declared frame count if the demuxer reports no per-packet durations (rare;
/// the decode pass re-verifies the total either way).
fn measure_duration_ms(input: &[u8], max_ms: u64) -> Result<u64, CrushError> {
    let mut probed = probe_track(input)?;
    let mut frames: u64 = 0; // in source-rate sample frames
    loop {
        let packet = match probed.format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            // A chained/reset stream: only the first stream is measured (and later decoded).
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(CrushError::Decode(format!("demux failed: {e}"))),
        };
        if packet.track_id() != probed.track_id {
            continue;
        }
        // Audio track timebases are 1/sample_rate, so packet durations are sample frames.
        frames = frames.saturating_add(packet.dur());
        let ms = frames.saturating_mul(1_000) / u64::from(probed.sample_rate);
        if ms > max_ms {
            return Err(CrushError::TooLong(format!(
                "measured over {ms} ms of audio, past the {max_ms} ms bound"
            )));
        }
    }
    let mut ms = frames.saturating_mul(1_000) / u64::from(probed.sample_rate);
    if ms == 0 {
        // Demuxer gave no durations; fall back to the container's claim (still re-checked against
        // reality during decode - see DURATION_LIE_SLACK_MS).
        ms = probed
            .declared_frames
            .map(|f| f.saturating_mul(1_000) / u64::from(probed.sample_rate))
            .unwrap_or(0);
    }
    if ms == 0 {
        return Err(CrushError::Decode(
            "could not determine audio duration".into(),
        ));
    }
    if ms > max_ms {
        return Err(CrushError::TooLong(format!(
            "audio runs {ms} ms, over the {max_ms} ms bound"
        )));
    }
    Ok(ms)
}

/// One run of downmixed, source-rate PCM handed to a decode sink, with the facts needed to
/// interpret it (fixed from the first chunk onward).
struct PcmChunk<'a> {
    /// Interleaved f32 samples, already downmixed to `channels`.
    samples: &'a [f32],
    /// Post-downmix channel count (1 or 2).
    channels: usize,
    /// The source sample rate (pre-resample).
    rate: u32,
}

/// The shared decode glue: probe, decode, guard, downmix, and hand every PCM chunk to `sink` in
/// stream order. Both the crusher ([`crush_via_decode`]) and the loudness regression test ride
/// this exact path, so a signal-fidelity bug here cannot hide behind the Opus encoder.
///
/// `measured_ms` is the demux-measured duration (for the container-lie guard); `max_ms` is the
/// hard duration bound (running-count enforced - a lying header must not matter).
fn decode_downmixed(
    input: &[u8],
    max_ms: u64,
    measured_ms: u64,
    sink: &mut dyn FnMut(PcmChunk<'_>) -> Result<(), CrushError>,
) -> Result<(), CrushError> {
    let mut probed = probe_track(input)?;
    let source_rate = probed.sample_rate;

    let decoder_track = probed
        .format
        .tracks()
        .iter()
        .find(|t| t.id == probed.track_id)
        .expect("probed track exists");
    let mut decoder = symphonia::default::get_codecs()
        .make(&decoder_track.codec_params, &DecoderOptions::default())
        .map_err(|e| CrushError::Unsupported(format!("no decoder for this codec: {e}")))?;

    // The running-count guards: the real decoded length must stay under the duration bound (a
    // lying header must not matter) and close to the measured length (or the caller's bitrate
    // choice was made on false pretences).
    let max_source_frames = max_ms.saturating_mul(u64::from(source_rate)) / 1_000;
    let lie_bound_frames =
        (measured_ms + DURATION_LIE_SLACK_MS).saturating_mul(u64::from(source_rate)) / 1_000;
    let mut source_frames: u64 = 0;

    // The real channel count is only certain once the decoder has seen the stream (AAC keeps it
    // in the codec-specific config); fixed and guarded at the first decoded buffer.
    let mut source_channels: Option<usize> = None;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match probed.format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphoniaError::ResetRequired) => break, // chained stream: first stream only
            Err(e) => return Err(CrushError::Decode(format!("demux failed: {e}"))),
        };
        if packet.track_id() != probed.track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|e| CrushError::Decode(format!("audio decode failed: {e}")))?;

        let spec = *decoded.spec();
        let channels = match source_channels {
            Some(known) => {
                // A mid-stream format switch is not something any honest encoder emits.
                if spec.channels.count() != known || spec.rate != source_rate {
                    return Err(CrushError::Decode("audio format changed mid-stream".into()));
                }
                known
            }
            None => {
                // First decoded buffer: guard the now-known channel count before any allocation.
                // The rate must match the probe - duration (and so bitrate) was computed on it.
                let known = spec.channels.count();
                check_channel_bound(known)?;
                if spec.rate != source_rate {
                    return Err(CrushError::Decode(
                        "decoded sample rate contradicts the container".into(),
                    ));
                }
                source_channels = Some(known);
                known
            }
        };

        // (Re)size the interleave buffer to this packet's frame capacity, reusing it when it fits.
        let needed = decoded.capacity() as u64;
        if sample_buf
            .as_ref()
            .map(|b| b.capacity() < needed as usize * channels)
            != Some(false)
        {
            sample_buf = Some(SampleBuffer::new(needed, spec));
        }
        let buf = sample_buf.as_mut().expect("buffer was just ensured");
        buf.copy_interleaved_ref(decoded);
        let interleaved = buf.samples();
        if interleaved.is_empty() {
            continue;
        }

        source_frames += (interleaved.len() / channels) as u64;
        if source_frames > max_source_frames {
            return Err(CrushError::TooLong(format!(
                "decoded past the {max_ms} ms bound (container under-declared its length)"
            )));
        }
        if source_frames > lie_bound_frames {
            return Err(CrushError::Decode(
                "stream is substantially longer than its container declares".into(),
            ));
        }

        let mixed = downmix(interleaved, channels);
        sink(PcmChunk {
            samples: &mixed,
            channels: channels.min(2),
            rate: source_rate,
        })?;
    }
    Ok(())
}

/// The decode lane end to end: measure duration (demux-only pass), pick the fit-to-cap bitrate,
/// then stream decode -> downmix -> resample -> Opus encode -> Ogg mux with bounded buffers.
fn crush_via_decode(input: &[u8], cap_bytes: u64, max_ms: u64) -> Result<Crushed, CrushError> {
    let duration_ms = measure_duration_ms(input, max_ms)?;
    let bitrate_bps = fit_bitrate_bps(cap_bytes, duration_ms);

    /// The streaming stages, built lazily at the first PCM chunk (when the channel count is
    /// finally known - see [`decode_downmixed`]).
    struct Pipeline {
        out_channels: usize,
        resampler: StreamResampler,
        opus: OpusSink,
        waveform: WaveformEnvelope,
    }
    let mut pipeline: Option<Pipeline> = None;

    decode_downmixed(input, max_ms, duration_ms, &mut |chunk| {
        let stages = match pipeline.as_mut() {
            Some(stages) => stages,
            None => pipeline.insert(Pipeline {
                out_channels: chunk.channels,
                resampler: StreamResampler::new(chunk.rate, chunk.channels)?,
                opus: OpusSink::new(chunk.channels, bitrate_bps)?,
                waveform: WaveformEnvelope::new(duration_ms, chunk.rate),
            }),
        };
        stages.waveform.update(chunk.samples, stages.out_channels);
        let resampled = stages.resampler.feed(chunk.samples)?;
        stages.opus.push(&resampled)
    })?;

    let Some(mut stages) = pipeline else {
        return Err(CrushError::Decode("input contained no audio".into()));
    };
    let tail = stages.resampler.finish()?;
    stages.opus.push(&tail)?;
    let encoded = stages.opus.finish()?;
    if encoded.total_samples == 0 {
        return Err(CrushError::Decode("input contained no audio".into()));
    }

    let out_duration_ms = encoded.total_samples.saturating_mul(1_000) / u64::from(OPUS_SAMPLE_RATE);
    let bytes = mux_ogg_opus(&encoded, stages.out_channels as u8)?;
    let waveform_avif = Some(stages.waveform.render()?);

    Ok(Crushed {
        bytes,
        duration_ms: out_duration_ms,
        channels: stages.out_channels as u8,
        bitrate_bps,
        passthrough: false,
        waveform_avif,
    })
}

/// Downmix interleaved source channels to at most two. Mono and stereo pass straight through.
/// More channels fold by parity - even-indexed channels average into the left, odd into the
/// right - which is crude next to a layout-aware matrix, but honest, bounded, and predictable
/// for any of the surround layouts we might see (the crush ethos: legible, not audiophile).
fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 2 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames * 2);
    let left_n = channels.div_ceil(2) as f32;
    let right_n = (channels / 2) as f32;
    for frame in interleaved.chunks_exact(channels) {
        let (mut left, mut right) = (0.0f32, 0.0f32);
        for (i, sample) in frame.iter().enumerate() {
            if i % 2 == 0 {
                left += sample;
            } else {
                right += sample;
            }
        }
        out.push(left / left_n);
        out.push(right / right_n);
    }
    out
}

// ---------------------------------------------------------------------------
// Streaming resampler: rubato in fixed-size chunks, delay-compensated.
// ---------------------------------------------------------------------------

/// A streaming source-rate -> 48 kHz resampler over interleaved f32. Inputs already at 48 kHz
/// bypass rubato entirely (the common case for our corpus; 44.1 kHz is the common real-world
/// other case). Non-48 kHz integer-divisor rates (24 k/16 k/...) also go through rubato: Opus
/// could ingest them directly, but one uniform path is simpler than per-rate frame-size logic,
/// and the FFT resampler is cheap next to the codec work.
///
/// Buffering is bounded: at most one input chunk plus rubato's internal state, regardless of
/// stream length. The resampler's startup delay is trimmed from the head of the output and the
/// equivalent tail is flushed out with silence at the end, so output length tracks
/// `input * 48000 / source_rate`.
struct StreamResampler {
    inner: Option<Fft<f32>>,
    channels: usize,
    /// Interleaved input awaiting a full chunk.
    pending: Vec<f32>,
    /// Frames of startup delay still to trim from the resampler's output.
    delay_to_trim: usize,
    /// Total input frames fed (for the exact expected output length).
    in_frames: u64,
    /// Total output frames emitted after delay trimming.
    out_frames: u64,
    source_rate: u32,
}

impl StreamResampler {
    fn new(source_rate: u32, channels: usize) -> Result<Self, CrushError> {
        let inner = if source_rate == OPUS_SAMPLE_RATE {
            None
        } else {
            let fft = Fft::<f32>::new(
                source_rate as usize,
                OPUS_SAMPLE_RATE as usize,
                RESAMPLER_CHUNK_FRAMES,
                channels,
                FixedSync::Input,
            )
            .map_err(|e| CrushError::Decode(format!("resampler rejected the rate: {e}")))?;
            Some(fft)
        };
        let delay_to_trim = inner.as_ref().map(|r| r.output_delay()).unwrap_or(0);
        Ok(StreamResampler {
            inner,
            channels,
            pending: Vec::new(),
            delay_to_trim,
            in_frames: 0,
            out_frames: 0,
            source_rate,
        })
    }

    /// Feed interleaved input; returns whatever interleaved 48 kHz output became ready.
    fn feed(&mut self, interleaved: &[f32]) -> Result<Vec<f32>, CrushError> {
        self.in_frames += (interleaved.len() / self.channels.max(1)) as u64;
        if self.inner.is_none() {
            return Ok(interleaved.to_vec());
        }
        self.pending.extend_from_slice(interleaved);
        let chunk_len = RESAMPLER_CHUNK_FRAMES * self.channels;
        let mut out = Vec::new();
        while self.pending.len() >= chunk_len {
            let rest = self.pending.split_off(chunk_len);
            let chunk = std::mem::replace(&mut self.pending, rest);
            self.run_chunk(&chunk, RESAMPLER_CHUNK_FRAMES, &mut out)?;
        }
        Ok(out)
    }

    /// End of input: resample the final partial chunk, then push silence until the delay-shifted
    /// tail is fully flushed, emitting exactly the expected number of output frames overall.
    fn finish(&mut self) -> Result<Vec<f32>, CrushError> {
        if self.inner.is_none() {
            return Ok(Vec::new());
        }
        let expected_out = self.in_frames.saturating_mul(u64::from(OPUS_SAMPLE_RATE))
            / u64::from(self.source_rate);
        let mut out = Vec::new();
        let partial = std::mem::take(&mut self.pending);
        let partial_frames = partial.len() / self.channels;
        self.run_chunk(&partial, partial_frames, &mut out)?;
        // Silence-flush the delay tail. Bounded: each iteration emits a chunk's worth of output,
        // and the shortfall is at most the resampler delay plus one chunk.
        let silence: Vec<f32> = Vec::new();
        for _ in 0..64 {
            if self.out_frames >= expected_out {
                break;
            }
            self.run_chunk(&silence, 0, &mut out)?;
        }
        // Trim any overshoot past the exact expected length (the last silence flush overshoots by
        // up to a chunk).
        let excess = self.out_frames.saturating_sub(expected_out) as usize;
        out.truncate(out.len().saturating_sub(excess * self.channels));
        self.out_frames = expected_out.min(self.out_frames);
        Ok(out)
    }

    /// Run one (possibly partial, possibly empty = silence) chunk through rubato, appending the
    /// delay-trimmed interleaved output to `out`.
    fn run_chunk(
        &mut self,
        interleaved: &[f32],
        frames: usize,
        out: &mut Vec<f32>,
    ) -> Result<(), CrushError> {
        let resampler = self.inner.as_mut().expect("only called when resampling");
        let map_rs = |e: rubato::ResampleError| CrushError::Decode(format!("resample failed: {e}"));
        let input = InterleavedSlice::new(interleaved, self.channels, frames)
            .map_err(|e| CrushError::Decode(format!("resample buffer shape: {e}")))?;
        let out_cap = resampler.output_frames_next();
        let mut output = InterleavedOwned::<f32>::new(0.0, self.channels, out_cap);
        let indexing = Indexing {
            input_offset: 0,
            output_offset: 0,
            partial_len: Some(frames),
            active_channels_mask: None,
        };
        let (_, produced) = resampler
            .process_into_buffer(&input, &mut output, Some(&indexing))
            .map_err(map_rs)?;
        let mut data = output.take_data();
        data.truncate(produced * self.channels);
        // Trim the startup delay off the front of the stream.
        let trim = self.delay_to_trim.min(produced);
        self.delay_to_trim -= trim;
        out.extend_from_slice(&data[trim * self.channels..]);
        self.out_frames += (produced - trim) as u64;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Opus encode sink: 20 ms frames in, packets out. Bounded buffers only.
//
// The encoder is the c2rust transpile of the REFERENCE libopus - the one C
// concession, made deliberately: encoders only consume PCM our memory-safe
// decoders produced, so they are not a hostile-input surface, and the
// transpile compiles as pure rust with no C toolchain. Its API is the raw C
// one, so [`LibopusEncoder`] below is this module's only unsafe: a minimal
// create/encode/destroy wrapper in the mould of video.rs's rav1d glue. (A
// from-scratch pure-rust port, opus-rs, was tried first and disqualified by
// measurement: it reads uninitialised memory on some encode paths - first
// packet, first transient, position varies with process history - and emits
// garbage packets that independent decoders play as full-scale transients.
// The loudness regression test below now stands guard over whichever encoder
// sits here.)
// ---------------------------------------------------------------------------

/// The encoded stream: packets plus the facts the mux needs for granule arithmetic.
struct EncodedOpus {
    packets: Vec<Vec<u8>>,
    /// Real 48 kHz sample frames encoded, before the final frame's zero-padding.
    total_samples: u64,
    /// The encoder's look-ahead (queried, not assumed), written to OpusHead as pre-skip.
    pre_skip: u16,
}

/// The contained unsafe glue over the transpiled libopus encoder. All unsafe stays inside this
/// impl; the encoder state is destroyed on drop on every path.
struct LibopusEncoder {
    st: *mut OpusEncoder,
}

impl LibopusEncoder {
    /// Create a 48 kHz encoder at the given channel count and VBR bitrate target (libopus
    /// defaults to VBR - fit-to-cap targets an average, and VBR spends it better than CBR).
    fn new(channels: usize, bitrate_bps: u32) -> Result<Self, CrushError> {
        let mut err = 0i32;
        // SAFETY: arguments satisfy opus_encoder_create's contract (48 kHz, 1-2 channels, a
        // valid application constant); the error out-pointer is a live local; the returned
        // state is null-checked before use and owned by Self (destroyed exactly once, in Drop).
        let st = unsafe {
            opus_encoder_create(
                OPUS_SAMPLE_RATE as i32,
                channels as i32,
                OPUS_APPLICATION_AUDIO,
                &mut err,
            )
        };
        if st.is_null() || err != 0 {
            return Err(CrushError::Decode(format!(
                "opus encoder init failed (code {err})"
            )));
        }
        let mut encoder = LibopusEncoder { st };
        encoder.set(OPUS_SET_BITRATE_REQUEST, bitrate_bps as i32)?;
        encoder.set(OPUS_SET_COMPLEXITY_REQUEST, OPUS_COMPLEXITY)?;
        Ok(encoder)
    }

    /// Set one i32 CTL value.
    fn set(&mut self, request: i32, value: i32) -> Result<(), CrushError> {
        // SAFETY: `st` is live (created in `new`, destroyed only in Drop); the varargs shape
        // (one i32 in) matches what each SET request consumes.
        let code = unsafe { opus_encoder_ctl_impl(self.st, request, varargs![value]) };
        if code != 0 {
            return Err(CrushError::Decode(format!(
                "opus encoder ctl {request} failed (code {code})"
            )));
        }
        Ok(())
    }

    /// The encoder's look-ahead in 48 kHz samples - the honest OpusHead pre-skip.
    fn lookahead(&mut self) -> Result<u16, CrushError> {
        let mut value = 0i32;
        // SAFETY: `st` is live; the varargs shape (one i32 out-reference) matches what the GET
        // request writes.
        let code = unsafe {
            opus_encoder_ctl_impl(self.st, OPUS_GET_LOOKAHEAD_REQUEST, varargs![&mut value])
        };
        if code != 0 || !(0..=i32::from(u16::MAX)).contains(&value) {
            return Err(CrushError::Decode(format!(
                "opus lookahead query failed (code {code}, value {value})"
            )));
        }
        Ok(value as u16)
    }

    /// Encode one full 20 ms frame into `out`; returns the packet length.
    fn encode(&mut self, frame: &[f32], out: &mut [u8]) -> Result<usize, CrushError> {
        // SAFETY: `st` is live; `frame` holds exactly OPUS_FRAME_SAMPLES interleaved frames for
        // the channel count the encoder was created with (asserted), so libopus reads no further;
        // `out` is a live buffer and libopus writes at most `out.len()` bytes.
        let n = unsafe {
            opus_encode_float(
                self.st,
                frame.as_ptr(),
                OPUS_FRAME_SAMPLES as i32,
                out.as_mut_ptr(),
                out.len() as i32,
            )
        };
        if n < 0 {
            return Err(CrushError::Decode(format!("opus encode failed (code {n})")));
        }
        Ok(n as usize)
    }
}

impl Drop for LibopusEncoder {
    fn drop(&mut self) {
        // SAFETY: `st` came from opus_encoder_create and is destroyed here, exactly once.
        unsafe { opus_encoder_destroy(self.st) };
    }
}

/// Streaming Opus encoder: accumulates interleaved 48 kHz f32 and encodes every full 20 ms frame
/// as it completes, so at most one frame of PCM is ever buffered. VBR at the fit-to-cap target.
struct OpusSink {
    encoder: LibopusEncoder,
    channels: usize,
    pre_skip: u16,
    pending: Vec<f32>,
    packets: Vec<Vec<u8>>,
    total_samples: u64,
    /// Scratch output buffer, reused across packets (4000 bytes > the largest legal packet).
    scratch: Vec<u8>,
}

impl OpusSink {
    fn new(channels: usize, bitrate_bps: u32) -> Result<Self, CrushError> {
        let mut encoder = LibopusEncoder::new(channels, bitrate_bps)?;
        let pre_skip = encoder.lookahead()?;
        Ok(OpusSink {
            encoder,
            channels,
            pre_skip,
            pending: Vec::new(),
            packets: Vec::new(),
            total_samples: 0,
            scratch: vec![0u8; 4000],
        })
    }

    /// Accept interleaved 48 kHz samples, encoding every completed 20 ms frame.
    fn push(&mut self, interleaved: &[f32]) -> Result<(), CrushError> {
        self.pending.extend_from_slice(interleaved);
        let frame_len = OPUS_FRAME_SAMPLES * self.channels;
        while self.pending.len() >= frame_len {
            let rest = self.pending.split_off(frame_len);
            let frame = std::mem::replace(&mut self.pending, rest);
            self.encode_frame(&frame, OPUS_FRAME_SAMPLES)?;
        }
        Ok(())
    }

    /// End of stream: zero-pad the final partial frame to a full 20 ms (the granule arithmetic in
    /// the mux trims the padding on playback) and hand over the packets. Also guarantees the
    /// stream decodes to at least pre-skip + real samples (extra silence if the padding fell
    /// short), so the final granule never claims more than the packets deliver.
    fn finish(mut self) -> Result<EncodedOpus, CrushError> {
        if !self.pending.is_empty() {
            let real = self.pending.len() / self.channels;
            let mut frame = std::mem::take(&mut self.pending);
            frame.resize(OPUS_FRAME_SAMPLES * self.channels, 0.0);
            self.encode_frame(&frame, real)?;
        }
        while ((self.packets.len() * OPUS_FRAME_SAMPLES) as u64)
            < u64::from(self.pre_skip) + self.total_samples
        {
            let silence = vec![0f32; OPUS_FRAME_SAMPLES * self.channels];
            self.encode_frame(&silence, 0)?;
        }
        Ok(EncodedOpus {
            packets: self.packets,
            total_samples: self.total_samples,
            pre_skip: self.pre_skip,
        })
    }

    /// Encode one full 20 ms frame; `real_samples` is how many of its frames are real audio
    /// rather than final-frame padding.
    fn encode_frame(&mut self, frame: &[f32], real_samples: usize) -> Result<(), CrushError> {
        debug_assert_eq!(frame.len(), OPUS_FRAME_SAMPLES * self.channels);
        let n = self.encoder.encode(frame, &mut self.scratch)?;
        self.packets.push(self.scratch[..n].to_vec());
        self.total_samples += real_samples as u64;
        Ok(())
    }
}

/// Mux encoded Opus packets into a canonical Ogg Opus file: OpusHead, our minimal OpusTags, then
/// the audio packets with granule positions counting 48 kHz samples (offset by pre-skip, RFC 7845
/// §4). The final granule uses the true unpadded sample count, so players trim the last frame's
/// zero-padding automatically.
fn mux_ogg_opus(encoded: &EncodedOpus, channels: u8) -> Result<Vec<u8>, CrushError> {
    let map_io = |e: std::io::Error| CrushError::Decode(format!("ogg write failed: {e}"));
    let mut out = Vec::new();
    {
        let mut writer = PacketWriter::new(Cursor::new(&mut out));
        writer
            .write_packet(
                build_opus_head(channels, encoded.pre_skip),
                OGG_STREAM_SERIAL,
                PacketWriteEndInfo::EndPage,
                0,
            )
            .map_err(map_io)?;
        writer
            .write_packet(
                minimal_opus_tags(),
                OGG_STREAM_SERIAL,
                PacketWriteEndInfo::EndPage,
                0,
            )
            .map_err(map_io)?;

        // A page's granule counts the samples decodable through it - INCLUDING the pre-skip
        // region, per RFC 7845 §4 - and the final granule stops at pre-skip + real samples so
        // players end-trim the final frame's padding ([`OpusSink::finish`] guarantees the
        // packets actually deliver that many).
        let end_granule = u64::from(encoded.pre_skip) + encoded.total_samples;
        let last = encoded.packets.len().saturating_sub(1);
        for (i, packet) in encoded.packets.iter().enumerate() {
            let decodable = ((i as u64) + 1) * OPUS_FRAME_SAMPLES as u64;
            let granule = decodable.min(end_granule);
            let info = if i == last {
                PacketWriteEndInfo::EndStream
            } else if (i + 1) % OGG_PAGE_PACKETS == 0 {
                PacketWriteEndInfo::EndPage
            } else {
                PacketWriteEndInfo::NormalPacket
            };
            writer
                .write_packet(packet.clone(), OGG_STREAM_SERIAL, info, granule)
                .map_err(map_io)?;
        }
    }
    Ok(out)
}

/// Build the OpusHead identification packet (RFC 7845 §5.1) for our own encode: version 1,
/// mapping family 0 (mono/stereo), the encoder's queried look-ahead as pre-skip, 48 kHz
/// original-rate field, zero gain.
fn build_opus_head(channels: u8, pre_skip: u16) -> Vec<u8> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(channels);
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&OPUS_SAMPLE_RATE.to_le_bytes());
    head.extend_from_slice(&0i16.to_le_bytes()); // output gain
    head.push(0); // channel mapping family 0: mono/stereo
    head
}

// ---------------------------------------------------------------------------
// Waveform thumbnail: a 256-bucket peak envelope drawn to a small AVIF.
// ---------------------------------------------------------------------------

/// Incrementally-built peak envelope. Bucket placement uses the measured duration (from the demux
/// pass, so honest); allocation is a fixed 256 floats regardless of what any header claims.
struct WaveformEnvelope {
    peaks: [f32; WAVEFORM_BUCKETS],
    /// Expected total source frames, from the measured duration - for bucket placement only.
    expected_frames: u64,
    position: u64,
}

impl WaveformEnvelope {
    fn new(duration_ms: u64, source_rate: u32) -> Self {
        WaveformEnvelope {
            peaks: [0.0; WAVEFORM_BUCKETS],
            expected_frames: duration_ms
                .saturating_mul(u64::from(source_rate))
                .max(1_000)
                / 1_000,
            position: 0,
        }
    }

    /// Fold a run of interleaved (already downmixed) samples into the envelope.
    fn update(&mut self, interleaved: &[f32], channels: usize) {
        let channels = channels.max(1);
        for frame in interleaved.chunks_exact(channels) {
            let peak = frame.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            let bucket = (self.position.saturating_mul(WAVEFORM_BUCKETS as u64)
                / self.expected_frames.max(1))
            .min(WAVEFORM_BUCKETS as u64 - 1) as usize;
            self.peaks[bucket] = self.peaks[bucket].max(peak.min(1.0));
            self.position += 1;
        }
    }

    /// Render the envelope to a small AVIF: dark field, light symmetric peak bars, one column per
    /// bucket. Same ravif recipe as media.rs's `encode_avif`, tuned for line art (see the
    /// [`WAVEFORM_AVIF_QUALITY`] note).
    fn render(&self) -> Result<Vec<u8>, CrushError> {
        let (w, h) = (WAVEFORM_WIDTH as usize, WAVEFORM_HEIGHT as usize);
        let bg = rgb::RGBA8::new(
            WAVEFORM_BACKGROUND[0],
            WAVEFORM_BACKGROUND[1],
            WAVEFORM_BACKGROUND[2],
            255,
        );
        let fg = rgb::RGBA8::new(
            WAVEFORM_FOREGROUND[0],
            WAVEFORM_FOREGROUND[1],
            WAVEFORM_FOREGROUND[2],
            255,
        );
        let mut pixels = vec![bg; w * h];
        let mid = h / 2;
        for (x, peak) in self.peaks.iter().enumerate() {
            // Bar half-height: at least one pixel (silence still draws a centreline).
            let half = ((peak * mid as f32).round() as usize).clamp(1, mid);
            for y in (mid - half)..(mid + half) {
                pixels[y * w + x] = fg;
            }
        }
        let encoder = ravif::Encoder::new()
            .with_quality(WAVEFORM_AVIF_QUALITY)
            .with_alpha_quality(WAVEFORM_AVIF_QUALITY)
            .with_speed(WAVEFORM_AVIF_SPEED)
            .with_bit_depth(ravif::BitDepth::Eight);
        let encoded = encoder
            .encode_rgba(imgref::Img::new(pixels.as_slice(), w, h))
            .map_err(|e| CrushError::Decode(format!("waveform avif encode failed: {e}")))?;
        Ok(encoded.avif_file)
    }
}

// ---------------------------------------------------------------------------
// Tests. Fixture corpus lives in ../sample_media (public-domain / CC audio,
// committed); synthetic inputs cover what fixtures can't.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Vec<u8> {
        let path = format!("{}/../sample_media/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read(&path).unwrap_or_else(|e| panic!("corpus fixture {name}: {e}"))
    }

    /// ISOBMFF sniff, same as the video.rs corpus helper: any real AVIF opens with an ftyp box.
    fn is_avif(bytes: &[u8]) -> bool {
        bytes.len() > 12 && &bytes[4..8] == b"ftyp"
    }

    /// Parse an Ogg Opus file (ours or anyone's) into (head, tags, audio packets with their page
    /// granules). This is the structural round-trip check for everything the mux emits.
    struct ParsedOpus {
        head: Vec<u8>,
        tags: Vec<u8>,
        packets: Vec<(Vec<u8>, u64)>,
    }

    fn parse_ogg_opus(bytes: &[u8]) -> ParsedOpus {
        let mut reader = PacketReader::new(Cursor::new(bytes));
        let head = reader.read_packet().unwrap().expect("opus head");
        assert!(
            head.data.starts_with(b"OpusHead"),
            "first packet is OpusHead"
        );
        let serial = head.stream_serial();
        let tags = reader.read_packet().unwrap().expect("opus tags");
        assert!(
            tags.data.starts_with(b"OpusTags"),
            "second packet is OpusTags"
        );
        let mut packets = Vec::new();
        while let Some(p) = reader.read_packet().unwrap() {
            assert_eq!(p.stream_serial(), serial, "single logical stream");
            packets.push((p.data.clone(), p.absgp_page()));
        }
        ParsedOpus {
            head: head.data,
            tags: tags.data,
            packets,
        }
    }

    /// Duration in ms implied by the final page granule, per RFC 7845 (granule - pre-skip, 48 kHz).
    fn granule_duration_ms(parsed: &ParsedOpus) -> u64 {
        let (_, pre_skip) = parse_opus_head(&parsed.head).unwrap();
        let last = parsed.packets.last().map(|(_, g)| *g).unwrap_or(0);
        last.saturating_sub(u64::from(pre_skip)) * 1_000 / u64::from(OPUS_SAMPLE_RATE)
    }

    /// Overall RMS (as dBFS) of the decode lane's internal PCM for a fixture - the exact glue the
    /// crusher rides ([`decode_downmixed`]), tapped just before the resampler/encoder.
    fn lane_rms_db(name: &str) -> f64 {
        let input = corpus(name);
        let measured = measure_duration_ms(&input, MAX_DURATION_MS).expect("measurable duration");
        let (mut sum_sq, mut count) = (0f64, 0u64);
        decode_downmixed(&input, MAX_DURATION_MS, measured, &mut |chunk| {
            for s in chunk.samples {
                sum_sq += f64::from(*s) * f64::from(*s);
            }
            count += chunk.samples.len() as u64;
            Ok(())
        })
        .unwrap_or_else(|e| panic!("{name} should decode, got {e:?}"));
        10.0 * (sum_sq / count.max(1) as f64).log10()
    }

    /// Loudness/peak statistics of a fixture's CRUSHED OUTPUT, measured two ways: decoded
    /// packet-by-packet with the encoder crate's own decoder, and (when ffmpeg is installed)
    /// decoded again with ffmpeg as an INDEPENDENT referee. The second measurement matters:
    /// opus-rs's decoder shares code with its encoder and has been observed decoding cleanly a
    /// stream that independent decoders glitch on, so the in-crate numbers alone are a biased
    /// judge. Both are windowed to the real audio (pre-skip head and end-trim tail excluded).
    struct OutputStats {
        rms_db: f64,
        peak: f32,
        /// (rms_db, peak) per ffmpeg, when ffmpeg is on the PATH.
        referee: Option<(f64, f32)>,
    }

    fn rms_db_of(window: &[f32]) -> f64 {
        let sum_sq: f64 = window.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
        10.0 * (sum_sq / window.len().max(1) as f64).log10()
    }

    fn peak_of(window: &[f32]) -> f32 {
        window.iter().fold(0f32, |m, s| m.max(s.abs()))
    }

    /// Minimal test-only decoder glue over the transpiled libopus (same unsafe-containment rules
    /// as the encoder glue): decode one packet into interleaved f32.
    struct TestOpusDecoder {
        st: *mut unsafe_libopus::OpusDecoder,
        channels: usize,
    }

    impl TestOpusDecoder {
        fn new(channels: usize) -> Self {
            let mut err = 0i32;
            // SAFETY: valid create arguments; the state is null-checked and destroyed in Drop.
            let st =
                unsafe { unsafe_libopus::opus_decoder_create(48_000, channels as i32, &mut err) };
            assert!(
                !st.is_null() && err == 0,
                "opus decoder create failed ({err})"
            );
            TestOpusDecoder { st, channels }
        }

        /// Decode one packet; returns frames written (interleaved into `pcm`).
        fn decode(&mut self, packet: &[u8], pcm: &mut [f32]) -> usize {
            // SAFETY: `st` is live; the packet pointer/length pair is exact; `pcm` holds
            // `pcm.len()/channels` frames of writable space, which is what libopus is told.
            let frames = unsafe {
                unsafe_libopus::opus_decode_float(
                    self.st,
                    packet.as_ptr(),
                    packet.len() as i32,
                    pcm.as_mut_ptr(),
                    (pcm.len() / self.channels) as i32,
                    0,
                )
            };
            assert!(frames >= 0, "opus decode failed (code {frames})");
            frames as usize
        }
    }

    impl Drop for TestOpusDecoder {
        fn drop(&mut self) {
            // SAFETY: `st` came from opus_decoder_create and is destroyed here, exactly once.
            unsafe { unsafe_libopus::opus_decoder_destroy(self.st) };
        }
    }

    fn output_stats(name: &str) -> OutputStats {
        let out = crush(&corpus(name), CrushOpts::default())
            .unwrap_or_else(|e| panic!("{name} should crush, got {e:?}"));
        let parsed = parse_ogg_opus(&out.bytes);
        let (channels, pre_skip) = parse_opus_head(&parsed.head).unwrap();
        let end_granule = parsed.packets.last().map(|(_, g)| *g).unwrap_or(0);

        let mut decoder = TestOpusDecoder::new(channels as usize);
        let mut pcm = vec![0f32; OPUS_FRAME_SAMPLES * channels as usize];
        let mut decoded: Vec<f32> = Vec::new();
        for (data, _) in &parsed.packets {
            let frames = decoder.decode(data, &mut pcm);
            decoded.extend_from_slice(&pcm[..frames * channels as usize]);
        }
        let start = usize::from(pre_skip) * channels as usize;
        let end = (end_granule as usize * channels as usize).min(decoded.len());
        let window = &decoded[start.min(end)..end];

        OutputStats {
            rms_db: rms_db_of(window),
            peak: peak_of(window),
            referee: ffmpeg_stats(name, &out.bytes),
        }
    }

    /// Decode `bytes` with ffmpeg (which applies pre-skip and end trim itself) and measure.
    /// Returns `None` where ffmpeg isn't installed, so CI without it still runs everything else.
    fn ffmpeg_stats(name: &str, bytes: &[u8]) -> Option<(f64, f32)> {
        let path = std::env::temp_dir().join(format!(
            "ringtome-audio-loudness-{}-{name}.ogg",
            std::process::id()
        ));
        std::fs::write(&path, bytes).ok()?;
        let output = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(&path)
            .args(["-f", "f32le", "-"])
            .output();
        let _ = std::fs::remove_file(&path);
        let output = output.ok()?; // ffmpeg not installed: referee waived
        assert!(
            output.status.success(),
            "ffmpeg failed decoding {name}'s crushed output"
        );
        let samples: Vec<f32> = output
            .stdout
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        assert!(!samples.is_empty(), "{name}: ffmpeg decoded no samples");
        Some((rms_db_of(&samples), peak_of(&samples)))
    }

    /// The five fixtures are the same 20 s of audio in different containers, so every lane must
    /// come out at the same loudness - checked at BOTH ends of the pipeline, and with an
    /// independent decoder where available:
    ///
    ///   1. internal PCM RMS within 1 dB of the wav lane's (pins per-format decode-glue scaling
    ///      bugs: same content in, same loudness out);
    ///   2. decoded-output RMS within 1 dB of the wav lane's output, and output peaks far from
    ///      full scale (RMS dilutes a one-frame click into a pass; the peak does not) - this
    ///      pins everything downstream, including the opus-rs first-packet garbage documented
    ///      at [`OpusSink::new`];
    ///   3. the same bars again as measured by ffmpeg, the referee that does not share code
    ///      with the encoder.
    #[test]
    fn decoded_lanes_agree_on_loudness() {
        let pcm_reference = lane_rms_db("buck-audio.wav");
        let reference = output_stats("buck-audio.wav");
        assert!(
            (pcm_reference - reference.rms_db).abs() <= 1.0,
            "wav lane's output ({:.1} dBFS) tracks its PCM ({pcm_reference:.1} dBFS)",
            reference.rms_db
        );
        for name in [
            "buck-audio.wav",
            "buck-audio.flac",
            "buck-audio.mp3",
            "buck-audio.m4a",
            "buck-audio.ogg",
        ] {
            let pcm_db = lane_rms_db(name);
            assert!(
                (pcm_db - pcm_reference).abs() <= 1.0,
                "{name} lane decodes at {pcm_db:.1} dBFS RMS; the wav lane at {pcm_reference:.1} dBFS"
            );
            let stats = output_stats(name);
            assert!(
                (stats.rms_db - reference.rms_db).abs() <= 1.0,
                "{name} output plays at {:.1} dBFS RMS; the wav output at {:.1} dBFS",
                stats.rms_db,
                reference.rms_db
            );
            // The fixtures peak near 0.56; anything close to full scale is escaped garbage.
            assert!(
                stats.peak <= 0.9,
                "{name} output peaks at {:.3} - escaped encoder garbage",
                stats.peak
            );
            if let Some((ff_rms, ff_peak)) = stats.referee {
                assert!(
                    (ff_rms - pcm_reference).abs() <= 1.5,
                    "{name} per ffmpeg plays at {ff_rms:.1} dBFS vs source {pcm_reference:.1} dBFS"
                );
                assert!(
                    ff_peak <= 0.9,
                    "{name} per ffmpeg peaks at {ff_peak:.3} - escaped encoder garbage"
                );
            }
        }
    }

    /// Diagnostic: crush the corpus and dump the outputs (plus waveforms) into a gitignored
    /// `scratch/` for eyeball/ffmpeg verification. Run on demand with:
    ///   cargo test -p ringtome-node dump_crushed_corpus -- --ignored --nocapture
    #[test]
    #[ignore = "diagnostic: dump crushed audio + waveforms to scratch/ for inspection"]
    fn dump_crushed_corpus() {
        let dir = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scratch/crushed-audio"
        ));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "buck-audio.mp3",
            "buck-audio.flac",
            "buck-audio.wav",
            "buck-audio.m4a",
            "buck-audio.ogg",
            "firefox_audio.ogx",
        ] {
            let input = corpus(name);
            match crush(&input, CrushOpts::default()) {
                Ok(out) => {
                    println!(
                        "OK       {name}: {} -> {} bytes, {} ms, {} bps, passthrough={}",
                        input.len(),
                        out.bytes.len(),
                        out.duration_ms,
                        out.bitrate_bps,
                        out.passthrough
                    );
                    std::fs::write(dir.join(format!("{name}.opus.ogg")), &out.bytes).unwrap();
                    if let Some(wave) = &out.waveform_avif {
                        std::fs::write(dir.join(format!("{name}.wave.avif")), wave).unwrap();
                    }
                }
                Err(e) => println!("REJECT   {name}: {e:?}"),
            }
        }
    }

    /// Every decodable corpus format crushes to a structurally-valid canonical Ogg Opus: 48 kHz
    /// stereo OpusHead, real packet flow, ~20 s of granule time, house bitrate, and a waveform.
    /// Sizes shrink vs the source for the fat formats (wav/flac/mp3 at 128 kbps+).
    #[test]
    fn wild_formats_crush_to_ogg_opus() {
        for name in [
            "buck-audio.mp3",
            "buck-audio.flac",
            "buck-audio.wav",
            "buck-audio.m4a",
            "buck-audio.ogg",
        ] {
            let input = corpus(name);
            let out = crush(&input, CrushOpts::default())
                .unwrap_or_else(|e| panic!("{name} should crush, got {e:?}"));

            assert!(!out.passthrough, "{name} takes the decode lane");
            assert_eq!(out.channels, 2, "{name} is stereo");
            assert_eq!(
                out.bitrate_bps, HOUSE_BITRATE_BPS,
                "{name} gets house bitrate"
            );

            let parsed = parse_ogg_opus(&out.bytes);
            let (channels, _) = parse_opus_head(&parsed.head).unwrap();
            assert!(channels <= 2, "{name} output is ≤2 channels");
            assert!(
                parsed.packets.len() > 100,
                "{name} has a real packet flow ({} packets)",
                parsed.packets.len()
            );
            let dur = granule_duration_ms(&parsed);
            assert!(
                (19_000..=21_000).contains(&dur),
                "{name} granule duration ≈20 s (got {dur} ms)"
            );
            assert!(
                (19_000..=21_000).contains(&out.duration_ms),
                "{name} reported duration ≈20 s (got {} ms)",
                out.duration_ms
            );

            if matches!(
                name,
                "buck-audio.wav" | "buck-audio.flac" | "buck-audio.mp3"
            ) {
                assert!(
                    out.bytes.len() < input.len(),
                    "{name} shrinks ({} -> {})",
                    input.len(),
                    out.bytes.len()
                );
            }

            let waveform = out.waveform_avif.as_deref().expect("waveform present");
            assert!(is_avif(waveform), "{name} waveform is a real AVIF");

            if name == "buck-audio.mp3" {
                // Determinism pin: same input, same bytes - what makes crushed media
                // content-addressable. This regressed under the opus-rs port (uninitialised
                // memory made packet bytes vary with process history); the reference libopus
                // transpile is deterministic, and this assert keeps it that way.
                let again = crush(&input, CrushOpts::default()).expect("re-crush");
                assert_eq!(again.bytes, out.bytes, "{name} crushes deterministically");
            }
        }
    }

    /// In-spec Ogg Opus passes through: same audio packets, same granules, no re-encode - but the
    /// OpusTags is rebuilt minimal (vendor only), and there is no waveform (no decode, no PCM).
    #[test]
    fn opus_passthrough_preserves_packets() {
        let input = corpus("firefox_audio.ogx");
        let out = crush(&input, CrushOpts::default()).expect("in-spec opus passes through");
        assert!(out.passthrough);
        assert!(out.waveform_avif.is_none(), "no decode, no waveform");

        let src = parse_ogg_opus(&input);
        let ours = parse_ogg_opus(&out.bytes);
        assert_eq!(src.head, ours.head, "OpusHead preserved verbatim");
        assert_eq!(
            src.packets.len(),
            ours.packets.len(),
            "audio packet count preserved"
        );
        for (i, ((src_data, src_granule), (our_data, our_granule))) in
            src.packets.iter().zip(&ours.packets).enumerate()
        {
            assert_eq!(src_data, our_data, "packet {i} bytes preserved");
            assert_eq!(src_granule, our_granule, "packet {i} granule preserved");
        }

        // OpusTags stripped to the minimal shape: our vendor string, zero user comments.
        assert_eq!(
            ours.tags,
            minimal_opus_tags(),
            "OpusTags is ours and minimal"
        );
        let src_vendor_len = u32::from_le_bytes(src.tags[8..12].try_into().unwrap());
        let src_vendor = &src.tags[12..12 + src_vendor_len as usize];
        assert_ne!(
            src_vendor,
            OPUS_VENDOR.as_bytes(),
            "fixture has a foreign vendor"
        );
        assert!(
            (19_000..=21_000).contains(&out.duration_ms),
            "duration from granules ≈20 s (got {} ms)",
            out.duration_ms
        );
    }

    /// A cap between floor and house engages fit-to-cap: the bitrate lands on cap/duration, not
    /// the house rate, and the output actually fits (VBR averages to the target).
    #[test]
    fn fit_to_cap_engages() {
        let cap: u64 = 60_000; // 480 kbit over ~20 s => ~24 kbps: between FLOOR and HOUSE
        let out = crush(
            &corpus("buck-audio.wav"),
            CrushOpts {
                max_bytes: Some(cap),
            },
        )
        .expect("fit-to-cap crush succeeds");
        assert!(!out.passthrough);
        let expected = fit_bitrate_bps(cap, out.duration_ms);
        assert!(
            out.bitrate_bps < HOUSE_BITRATE_BPS && out.bitrate_bps > FLOOR_BITRATE_BPS,
            "bitrate {} sits strictly between floor and house",
            out.bitrate_bps
        );
        // Same formula, computed over the actual duration: allow a whisker for ms rounding.
        assert!(
            out.bitrate_bps.abs_diff(expected) <= 200,
            "bitrate {} ≈ fit value {expected}",
            out.bitrate_bps
        );
        assert!(
            (out.bytes.len() as u64) <= cap + cap / 10,
            "output {} fits ~cap {cap}",
            out.bytes.len()
        );
    }

    /// A cap so small that even the floor bitrate cannot fit 20 s is a TooLong, decided before
    /// any encode work.
    #[test]
    fn too_long_rejected() {
        // 20_000 bytes at the 12 kbps floor is ~13.3 s of budget; the fixture runs 20 s.
        let result = crush(
            &corpus("buck-audio.flac"),
            CrushOpts {
                max_bytes: Some(20_000),
            },
        );
        assert!(
            matches!(result, Err(CrushError::TooLong(_))),
            "expected TooLong, got {result:?}"
        );
    }

    /// Garbage in, clean Unsupported out - never a panic. Random bytes and a JPEG-shaped blob.
    #[test]
    fn garbage_is_unsupported() {
        // Deterministic pseudo-random bytes (xorshift), no rand dependency.
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let noise: Vec<u8> = (0..4096)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 32) as u8
            })
            .collect();
        let mut jpegish = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        jpegish.extend_from_slice(b"JFIF\0");
        jpegish.extend_from_slice(&noise);

        for (label, blob) in [("noise", &noise), ("jpeg", &jpegish)] {
            match crush(blob, CrushOpts::default()) {
                Err(CrushError::Unsupported(_)) => {}
                other => panic!("{label} should be Unsupported, got {other:?}"),
            }
        }
    }

    /// Metadata never survives the crush: the mp3's ID3 block and the vorbis fixture's encoder
    /// vendor string are absent from the output, whose only metadata is our own minimal OpusTags.
    #[test]
    fn id3_and_tags_do_not_survive() {
        let contains =
            |haystack: &[u8], needle: &[u8]| haystack.windows(needle.len()).any(|w| w == needle);

        let mp3 = corpus("buck-audio.mp3");
        assert!(contains(&mp3, b"ID3"), "mp3 fixture carries ID3");
        let out = crush(&mp3, CrushOpts::default()).expect("mp3 crushes");
        assert!(!contains(&out.bytes, b"ID3"), "ID3 does not survive");

        let ogg = corpus("buck-audio.ogg");
        assert!(
            contains(&ogg, b"Lavf"),
            "vorbis fixture carries an encoder vendor"
        );
        let out = crush(&ogg, CrushOpts::default()).expect("vorbis crushes");
        assert!(
            !contains(&out.bytes, b"Lavf"),
            "source vendor does not survive"
        );
        assert!(
            !contains(&out.bytes, b"libVorbis"),
            "no vorbis vendor either"
        );
        let parsed = parse_ogg_opus(&out.bytes);
        assert_eq!(
            parsed.tags,
            minimal_opus_tags(),
            "output metadata is ours, minimal"
        );
    }

    /// The resample path (absent from the 48 kHz corpus): a synthetic 44.1 kHz WAV comes out the
    /// right length at 48 kHz, exercising rubato's chunked feed, delay trim, and tail flush.
    #[test]
    fn non_48k_input_resamples() {
        // A 2 s 44.1 kHz stereo PCM16 WAV, built by hand (44-byte canonical header).
        let rate: u32 = 44_100;
        let seconds = 2u32;
        let frames = rate * seconds;
        let mut pcm = Vec::with_capacity((frames * 4) as usize);
        for i in 0..frames {
            let t = i as f32 / rate as f32;
            let s = ((t * 440.0 * std::f32::consts::TAU).sin() * 0.5 * 32767.0) as i16;
            pcm.extend_from_slice(&s.to_le_bytes());
            pcm.extend_from_slice(&s.to_le_bytes());
        }
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&2u16.to_le_bytes()); // stereo
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(&pcm);

        let out = crush(&wav, CrushOpts::default()).expect("44.1 kHz wav crushes");
        assert!(
            out.duration_ms.abs_diff(1_000 * u64::from(seconds)) <= 150,
            "resampled duration ≈2 s (got {} ms)",
            out.duration_ms
        );
        let parsed = parse_ogg_opus(&out.bytes);
        let dur = granule_duration_ms(&parsed);
        assert!(
            dur.abs_diff(1_000 * u64::from(seconds)) <= 150,
            "granule duration ≈2 s (got {dur} ms)"
        );
    }
}
