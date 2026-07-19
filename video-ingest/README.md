# video-ingest (spike)

Browser-side JS that normalizes an **arbitrary user video** into one of two
**intermediary formats** that a memory-safe Rust server can safely re-decode.

This is a **proof of concept** (a library, not a UI) built to answer one
question — *can the client do the hostile video work so the server never has
to?* — and the answer is **yes, proven end-to-end in real Chromium**, with the
sad-path output cross-checked against the actual Rust `image` decoder. Keep this
directory: it's the reference implementation for the eventual upload UI, and its
findings define the Rust video pipeline's input contract.

---

## Why an intermediary format at all

Two independent reasons, both pointing the same way:

1. **Rust can't decode the codec zoo.** There is no production-grade *pure-Rust*
   decoder for H.264 or HEVC — the codecs every phone on earth records — and none
   for VP9. Rust can decode **AV1** (`rav1d`) and still-image frames
   (PNG/WebP/APNG via the `image` crate), and that's about it. So a Rust server
   simply cannot read most real-world video.
2. **Patents + memory-safety.** The universal decoder for that zoo is FFmpeg — a
   huge C/C++ library with a long hostile-input CVE history (see CVE-2023-4863,
   the libwebp zero-click), plus patent-licensing baggage for H.264/HEVC *decode*
   distribution. Bundling and sandboxing it is exactly the mess we're avoiding.

So we **never let the server decode the user's arbitrary input.** Instead:

1. The **hostile decode** happens in the **browser's hardened, already-licensed,
   hardware-accelerated decoder** (the `<video>` element / WebCodecs).
2. The browser **re-emits** the content in a format the server can re-decode in
   **memory-safe Rust**. This *launders* the input — the server (and every peer
   that later replicates it) only ever sees our-encoder bytes, never the
   attacker's crafted bitstream. The viewer's browser is then the last line, but
   we're no longer relying on it as the *only* line.

This is the video analog of the AVIF image path (browser can't be trusted; decode
in memory-safe Rust). The discipline is the same: **every byte from the network
is hostile, and we only decode what we can decode safely.**

---

## Why *two* intermediary formats

Because of a codec asymmetry that turns out to be the whole ballgame:

> **AV1 *decode* is universal** (every modern browser plays it), but
> **AV1 *encode* is not** — Chromium does it; Safari and older/some Firefox don't.

So:

- Browsers that **can encode AV1** get the **happy path**: a compact
  **AV1-in-WebM** intermediary the server re-decodes with `rav1d`.
- Every other browser gets the **universal fallback**: a **320p APNG** (frames) +
  a separate **Ogg Opus** audio blob — built from only `<video>` + `<canvas>` +
  `AudioEncoder`, none of which require AV1 encode. The server decodes the APNG
  frames with the `image` crate.

The fallback is the floor nobody falls through. It is bandwidth-heavy (no
inter-frame compression — see findings) but it *always works*.

| Lane | Emitted | Server decodes with | When |
|------|---------|---------------------|------|
| `av1` (happy path) | **AV1-in-WebM** (AV1 + Opus, muxed) | `rav1d` (video) + Opus | browser can *encode* AV1 |
| `frames` (fallback) | **320p APNG** + separate **Ogg Opus** | `image` crate (frames) + Opus | any browser |

Both lanes downscale so the **longest side ≤ 320px**, cap frame rate to **~20fps**,
and target short-form clips.

---

## What the Rust video pipeline can assume (the payoff)

This is why the spike mattered. After ingest, the Rust server only ever has to
accept **two input shapes** — everything else is rejected at the door, because
the browser already normalized it:

1. **AV1-in-WebM.** Demux WebM (pure-Rust EBML) → AV1 video stream (`rav1d`) +
   Opus audio (remux/passthrough, or decode with a memory-safe Opus decoder).
2. **APNG + Ogg Opus.** Decode APNG frames (`image` crate) → re-encode video with
   `rav1e`; Opus audio as above.

No H.264, no HEVC, no VP9, no MP4, no AC-3, no MKV — **the browser normalized all
of it away.** The server's entire video decode surface is `rav1d` + the `image`
crate + Opus handling: small, pure-Rust, memory-safe. That constrained-input
guarantee is the thing this spike buys.

(The server still *validates* — codec allowlist, dimension/duration/size bounds,
structural parse — because a modified client could upload anything. It just never
has to decode an untrusted *foreign* codec.)

---

## Interface

```js
import { ingestVideo, pickLane } from './src/index.js';

// pickLane() -> Promise<'av1' | 'frames'>   (async: the AV1 probe is async)
const lane = await pickLane();

// ingestVideo(fileOrBlob, opts) -> Promise<Intermediary>
const out = await ingestVideo(file, {
  forceLane: 'frames', // optional: 'av1' | 'frames' to override detection
  maxSide: 320,        // optional
  fps: 20,             // optional
});
// Intermediary = {
//   lane: 'av1' | 'frames',
//   width, height, durationMs, frameCount, fps,
//   video: Blob,         // 'av1': WebM(AV1[+Opus]); 'frames': APNG (image/apng)
//   audio?: Blob | null, // 'frames': Ogg Opus (or null if source audio couldn't
//                        //           be decoded — e.g. AC-3); 'av1': always null,
//                        //           audio is muxed INTO the WebM
// }
```

Auto mode never hard-fails on capability: if AV1 turns out unavailable it degrades
to `frames` (an explicit `forceLane:'av1'` still surfaces the error).

---

## How the APNG / Ogg Opus are assembled

No browser API emits animated PNG or Ogg Opus, so we hand-roll both from standard
building blocks (verified valid by `ffprobe`/`file` **and** by the Rust `image`
crate for the APNG):

- **APNG** (`src/apng-encoder.js`): PNG-encode each downscaled frame via
  `canvas.toBlob('image/png')`, parse out each PNG's `IHDR` + concatenated `IDAT`
  (**never re-compressing pixels**), then emit one stream — `IHDR`, `acTL`, then
  per frame an `fcTL` + pixel data (`IDAT` for frame 0, sequence-numbered `fdAT`
  after), then `IEND`, with a shared increasing sequence number and a PNG-CRC32
  per chunk.
- **Ogg Opus** (`src/ogg-opus.js`): wrap the WebCodecs `AudioEncoder` Opus packets
  in a standards-compliant Ogg stream (OpusHead BOS, OpusTags, one packet per
  page, EOS last, Ogg-CRC32 per page).

---

## Findings (verified in this spike)

- **Chromium encodes AV1** via both WebCodecs and MediaRecorder, and encodes
  Opus — the happy path is real.
- **The universal fallback is real**: `frames` needs only `<video>`+canvas+
  `AudioEncoder`, so it works where AV1 encode doesn't.
- **The server can ingest what the browser produces.** The hand-rolled APNG
  decoded cleanly in the Rust `image` crate (all frames, correct dims). AV1
  decode via `rav1d` is already established for images; the WebM-demux→`rav1d`
  video cross-check is left for the Rust pipeline.
- **Both audio paths carry real signal** (measured ~-17 dB in the headless test,
  not silence): the `frames` lane's `decodeAudioData`→`AudioEncoder`→Opus, and
  the `av1` lane's `captureStream` audio tap muxed into the WebM.
- **Size reality** (20 s of 4K source → 320p): the `av1` lane produces **~1.6 MB**;
  the `frames` lane produces **~58 MB** of APNG. The fallback is a safety net, not
  a peer — no inter-frame compression, every frame a full still. This bounds the
  *intermediary upload* (later crushed on the server) and reinforces short-form.
- **Some audio codecs can't be decoded by the browser at all** — notably **AC-3 /
  DTS** (Dolby, not web codecs). When the source audio is undecodable, the browser
  can't launder it, so the audio is **dropped** (video-only output) rather than
  failing the whole ingest. Real-world content (phones/web = AAC) decodes fine.
- **Feature-detection lesson (a bug we hit):** probe the *exact* encoder a lane
  uses. Firefox reports WebCodecs `VideoEncoder` av01 support but its
  `MediaRecorder` can't mux av01 — detecting via WebCodecs while encoding via
  MediaRecorder mis-routed Firefox into a lane that then threw. Detection now
  probes MediaRecorder (what the lane actually invokes).

---

## Improvements for the production version

- **Progress bars — mandatory.** Both lanes are slow, and `frames` is *much*
  slower. The UI must show progress (per-frame for `frames`, elapsed/real-time for
  `av1`) or it reads as hung.
- **A faster AV1 pipeline — the big one.** The `av1` lane uses `MediaRecorder`,
  which records at **playback speed** (a 3-minute clip takes 3 minutes). Rebuild
  it on **WebCodecs `VideoEncoder`** (decode → downscale → encode av01 → WebM mux).
  This fixes two things at once: (1) **faster-than-realtime** encode, and (2)
  **wider browser coverage** — Firefox *can* WebCodecs-encode av01 even though its
  MediaRecorder can't, so more browsers would get the compact lane instead of the
  58 MB fallback. Cost: a real WebM muxer (the one piece MediaRecorder gave us
  free).
- **Surface dropped audio.** When audio is undecodable (AC-3/DTS), tell the user
  ("audio track couldn't be processed") instead of a silent null. Optionally, an
  alternative audio fallback for browsers lacking `AudioEncoder`: upload raw PCM
  and Opus-encode server-side (encoders aren't a hostile-input surface, so even a
  C `libopus` is fine there).
- **Faster frame extraction.** `frames` seeks the `<video>` element per frame;
  WebCodecs `VideoDecoder` would be faster and more precise for long clips.
- **Streaming, not buffering.** Assemble/upload incrementally so long clips don't
  hold every frame in memory.
- **Thread the real Opus pre-skip** (currently 0; a few ms early start, harmless
  for short-form).
- **Hardware-accelerated encode** where the platform exposes it.

---

## Run it

Automated headless-Chromium test (the "it works" proof):

```
npm install    # puppeteer-core only
npm test
```

`test/run.js` serves the library over `http://127.0.0.1` (a **secure context**,
which WebCodecs requires — `about:blank`/`data:` do **not** work), launches
headless Chromium via `puppeteer-core`, **generates a test video in-browser**
(animated gradient + a 440 Hz tone → VP9/Opus WebM, no external fixture), runs
both lanes, **re-decodes each output in the browser**, and writes
`test/out/{av1.webm,frames.apng,frames.opus}` to disk for cross-checking against
the Rust decoders. Asserts and exits non-zero on failure.

Manual demo (try your own video, in any browser):

```
npm run demo
# open the printed http://127.0.0.1:<port>/demo/index.html
```

Must be served over http/loopback (not `file://`) so WebCodecs is enabled. Pick a
file, choose a lane (or auto), download the intermediary blob(s). The `av1` lane
shows a `<video controls>` preview — hit play to hear the muxed audio.

---

## Honest limitations (it's a spike)

- **`av1` lane records at playback speed** (MediaRecorder). See improvements.
- **`ImageDecoder`** (used only by the *test* to count APNG frames) is
  Chromium-only. The APNG itself is standard — Firefox/Safari render it, and the
  Rust `image` crate decodes it.
- **Only Chromium was auto-tested here.** The `frames` fallback uses standards-only
  APIs and *should* work in Firefox/Safari, but that wants real-browser
  confirmation (headless Firefox couldn't be driven from this box — snap
  confinement, not a code issue).
- **AAC decode** couldn't be confirmed on this box's Chromium build (open-source
  Chromium may ship without proprietary codecs); real Chrome/Firefox decode AAC
  fine, and the audio *machinery* is proven with real signal regardless.
</content>
