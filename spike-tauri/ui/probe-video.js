// The video probe: can this webview do the browser-side ingest that video-ingest proved in
// Chromium?
//
// The premise being tested is video-ingest's whole security argument: the hostile decode happens
// in the browser's hardened decoder, and the browser re-emits something a memory-safe Rust server
// can read. That premise has two failure modes in a platform webview, and they are NOT equally
// bad, so this probe is built to tell them apart:
//
//   DEGRADED - no AV1 *encode*, so the compact `av1` lane is unavailable and we fall to the
//              universal `frames` lane. Costly (video-ingest measured ~1.6MB vs ~58MB for 20s of
//              source) but the design already anticipates it.
//   BLOCKING - the webview cannot DECODE the user's input at all, or lacks AudioEncoder. Then
//              nothing can be laundered and video upload is simply unavailable here. On Linux
//              this is a live risk, because WebKitGTK's media stack is GStreamer and H.264
//              support is whatever the distro installed.
//
// So the capability matrix reports decode and encode separately, and the end-to-end run tries
// every lane the engine claims rather than only the one pickLane() routes to.

import { ingestVideo, pickLane, _resetLaneCache } from './vendor/video-ingest/index.js';
import { mediaRecorderCanAv1, av1RecorderMimeType } from './vendor/video-ingest/feature-detect.js';

const VIDEO_ENCODER_CODECS = [
    ['AV1', 'av01.0.04M.08'],
    ['VP9', 'vp09.00.10.08'],
    ['VP8', 'vp8'],
    ['H.264', 'avc1.42001E'],
];

const RECORDER_TYPES = [
    ['WebM AV1+Opus', 'video/webm;codecs=av01,opus'],
    ['WebM AV1', 'video/webm;codecs=av01'],
    ['WebM VP9+Opus', 'video/webm;codecs=vp9,opus'],
    ['WebM VP8+Opus', 'video/webm;codecs=vp8,opus'],
    ['MP4 H.264', 'video/mp4;codecs=avc1.42001E'],
];

const PLAYBACK_TYPES = [
    ['H.264 in MP4', 'video/mp4; codecs="avc1.42E01E"'],
    ['HEVC in MP4', 'video/mp4; codecs="hvc1"'],
    ['AAC in MP4', 'audio/mp4; codecs="mp4a.40.2"'],
    ['VP9 in WebM', 'video/webm; codecs="vp9"'],
    ['AV1 in WebM', 'video/webm; codecs="av01.0.04M.08"'],
    ['Opus in WebM', 'audio/webm; codecs="opus"'],
    ['Opus in Ogg', 'audio/ogg; codecs="opus"'],
];

function present(name, value) {
    return { name, ok: Boolean(value), detail: value ? 'present' : 'absent' };
}

async function encoderSupport(kind, codec) {
    if (typeof VideoEncoder === 'undefined') return { name: `VideoEncoder ${kind}`, ok: false, detail: 'no VideoEncoder' };
    try {
        const { supported } = await VideoEncoder.isConfigSupported({
            codec,
            width: 320,
            height: 240,
            bitrate: 300_000,
            framerate: 20,
        });
        return { name: `VideoEncoder ${kind}`, ok: Boolean(supported), detail: supported ? codec : `${codec} unsupported` };
    } catch (err) {
        // Some engines throw on an unsupported config instead of answering false.
        return { name: `VideoEncoder ${kind}`, ok: false, detail: `threw: ${err?.message ?? err}` };
    }
}

async function decoderSupport(kind, codec) {
    if (typeof VideoDecoder === 'undefined') return { name: `VideoDecoder ${kind}`, ok: false, detail: 'no VideoDecoder' };
    try {
        const { supported } = await VideoDecoder.isConfigSupported({ codec, codedWidth: 320, codedHeight: 240 });
        return { name: `VideoDecoder ${kind}`, ok: Boolean(supported), detail: supported ? codec : `${codec} unsupported` };
    } catch (err) {
        return { name: `VideoDecoder ${kind}`, ok: false, detail: `threw: ${err?.message ?? err}` };
    }
}

async function audioEncoderSupport() {
    if (typeof AudioEncoder === 'undefined') {
        return { name: 'AudioEncoder Opus', ok: false, detail: 'no AudioEncoder — BLOCKING for both lanes' };
    }
    try {
        const { supported } = await AudioEncoder.isConfigSupported({
            codec: 'opus',
            sampleRate: 48_000,
            numberOfChannels: 1,
            bitrate: 24_000,
        });
        return { name: 'AudioEncoder Opus', ok: Boolean(supported), detail: supported ? 'opus' : 'opus unsupported' };
    } catch (err) {
        return { name: 'AudioEncoder Opus', ok: false, detail: `threw: ${err?.message ?? err}` };
    }
}

export async function runCapabilityProbe() {
    const probe = document.createElement('video');
    const rows = [];

    rows.push({
        name: 'secure context',
        ok: Boolean(globalThis.isSecureContext),
        // WebCodecs requires a secure context: video-ingest found that file:// and data: do not
        // qualify, which is why this is checked before anything else is believed.
        detail: `isSecureContext=${globalThis.isSecureContext}, origin=${location.origin}, crossOriginIsolated=${globalThis.crossOriginIsolated}`,
    });

    rows.push(present('MediaRecorder', typeof MediaRecorder !== 'undefined'));
    rows.push(present('WebCodecs VideoEncoder', typeof VideoEncoder !== 'undefined'));
    rows.push(present('WebCodecs VideoDecoder', typeof VideoDecoder !== 'undefined'));
    rows.push(present('WebCodecs AudioDecoder', typeof AudioDecoder !== 'undefined'));
    rows.push(present('OffscreenCanvas', typeof OffscreenCanvas !== 'undefined'));
    rows.push(present('HTMLMediaElement.captureStream (av1 lane audio tap)', typeof probe.captureStream === 'function'));
    rows.push(present('canvas.toBlob (frames lane)', typeof document.createElement('canvas').toBlob === 'function'));
    rows.push(present('AudioContext.decodeAudioData (frames lane audio)',
        typeof (globalThis.AudioContext ?? globalThis.webkitAudioContext) !== 'undefined'));

    // Informational only: ImageDecoder is Chromium-only and video-ingest uses it in its TEST,
    // never in the library. Its absence is not a finding about the lanes.
    rows.push({
        name: 'ImageDecoder (informational — test-only in video-ingest)',
        ok: typeof globalThis.ImageDecoder !== 'undefined',
        detail: typeof globalThis.ImageDecoder !== 'undefined' ? 'present' : 'absent (Chromium-only; harmless)',
    });

    // Informational: gates any ffmpeg.wasm-shaped workaround, which needs threads.
    rows.push({
        name: 'SharedArrayBuffer (informational — gates a wasm-codec workaround)',
        ok: typeof SharedArrayBuffer !== 'undefined',
        detail:
            typeof SharedArrayBuffer !== 'undefined'
                ? `present, crossOriginIsolated=${globalThis.crossOriginIsolated}`
                : 'absent — a wasm encoder fallback would need COOP/COEP',
    });

    for (const [label, type] of PLAYBACK_TYPES) {
        const answer = probe.canPlayType(type);
        rows.push({
            name: `<video> can play ${label}`,
            ok: answer === 'probably' || answer === 'maybe',
            detail: answer === '' ? 'no' : answer,
        });
    }

    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
        for (const [label, type] of RECORDER_TYPES) {
            const ok = MediaRecorder.isTypeSupported(type);
            rows.push({ name: `MediaRecorder ${label}`, ok, detail: ok ? type : 'unsupported' });
        }
    }

    for (const [kind, codec] of VIDEO_ENCODER_CODECS) rows.push(await encoderSupport(kind, codec));
    for (const [kind, codec] of VIDEO_ENCODER_CODECS) rows.push(await decoderSupport(kind, codec));
    rows.push(await audioEncoderSupport());

    _resetLaneCache();
    const lane = await pickLane();
    rows.push({
        name: "video-ingest pickLane() — the library's own routing",
        ok: true,
        detail: `${lane}${lane === 'frames' ? ' (fallback: no MediaRecorder AV1)' : ' (happy path)'}`,
    });
    rows.push({
        name: 'av1RecorderMimeType()',
        ok: mediaRecorderCanAv1(),
        detail: av1RecorderMimeType() ?? 'none',
    });

    return { rows, lane };
}

/// Generate a small clip in-browser so the probe can run with no fixture on disk.
///
/// This uses MediaRecorder, which is exactly one of the things under test - so a failure HERE is
/// reported as "cannot generate a fixture", never as an ingest failure. On an engine where this
/// fails, supply a real file instead; that is the better test anyway, since a phone's H.264 is
/// the input that matters.
export async function generateFixture({ seconds = 4 } = {}) {
    if (typeof MediaRecorder === 'undefined') {
        throw new Error('no MediaRecorder in this webview — pick a file instead');
    }
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((t) => MediaRecorder.isTypeSupported?.(t));
    if (!type) throw new Error('MediaRecorder supports no WebM type here — pick a file instead');

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(25);

    // A 440Hz tone, so the audio paths carry real signal rather than silence (video-ingest's
    // test measured ~-17dB for exactly this reason).
    const AudioCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    let audioContext = null;
    if (AudioCtor) {
        audioContext = new AudioCtor();
        const oscillator = audioContext.createOscillator();
        oscillator.frequency.value = 440;
        const destination = audioContext.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    }

    const recorder = new MediaRecorder(stream, { mimeType: type });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = (e) => reject(e.error ?? new Error('MediaRecorder error'));
    });

    recorder.start();
    const startedAt = performance.now();
    let frame = 0;
    while (performance.now() - startedAt < seconds * 1000) {
        const t = (performance.now() - startedAt) / 1000;
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, `hsl(${(t * 90) % 360} 80% 55%)`);
        gradient.addColorStop(1, `hsl(${(t * 90 + 120) % 360} 80% 35%)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = '48px sans-serif';
        ctx.fillText(`frame ${frame}`, 40, 240);
        frame += 1;
        await new Promise((r) => setTimeout(r, 40));
    }
    recorder.stop();
    await done;
    audioContext?.close?.();

    const blob = new Blob(chunks, { type: type.split(';')[0] });
    return new File([blob], 'generated-fixture.webm', { type: blob.type });
}

async function canDecodeVideoBlob(blob) {
    const url = URL.createObjectURL(blob);
    try {
        const video = document.createElement('video');
        video.muted = true;
        video.src = url;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no loadedmetadata within 10s')), 10_000);
            video.onloadedmetadata = () => {
                clearTimeout(timer);
                resolve();
            };
            video.onerror = () => {
                clearTimeout(timer);
                reject(new Error(video.error ? `media error ${video.error.code}` : 'media error'));
            };
        });
        if (!video.videoWidth) throw new Error('metadata loaded but videoWidth is 0');
        return `re-decoded: ${video.videoWidth}x${video.videoHeight}`;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function canDecodeApng(blob) {
    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('image never loaded within 10s')), 10_000);
            image.onload = () => {
                clearTimeout(timer);
                resolve();
            };
            image.onerror = () => {
                clearTimeout(timer);
                reject(new Error('image failed to decode'));
            };
        });
        let frames = '';
        if (typeof globalThis.ImageDecoder !== 'undefined') {
            try {
                const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/png' });
                await decoder.tracks.ready;
                frames = `, ${decoder.tracks.selectedTrack?.frameCount ?? '?'} frames`;
            } catch {
                frames = ', frame count unavailable';
            }
        }
        return `re-decoded: ${image.naturalWidth}x${image.naturalHeight}${frames}`;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/// POST an artifact to the harness so it lands on disk for cross-checking against the Rust
/// decoders (rav1d for AV1, the `image` crate for APNG). Webview download support is uneven; the
/// save endpoint exists so capturing output never depends on it.
async function saveArtifact(port, name, blob) {
    const response = await fetch(`http://127.0.0.1:${port}/save/${name}`, {
        method: 'POST',
        body: blob,
    });
    if (!response.ok) throw new Error(`save failed: HTTP ${response.status}`);
    return response.text();
}

export async function runIngestLane({ file, lane, port, save }) {
    const started = performance.now();
    const out = await ingestVideo(file, { forceLane: lane });
    const elapsed = Math.round(performance.now() - started);

    const facts = [
        `lane=${out.lane}`,
        `${out.width}x${out.height}`,
        `${out.frameCount} frames @ ${out.fps}fps`,
        `${Math.round(out.durationMs)}ms source`,
        `video=${(out.video.size / 1024 / 1024).toFixed(2)}MB`,
        out.audio ? `audio=${(out.audio.size / 1024).toFixed(0)}KB` : 'audio=none (dropped or muxed in)',
        `encode took ${elapsed}ms`,
    ];

    // A lane that "succeeds" but emits something nothing can read is a failure we would otherwise
    // discover on the server. Check here.
    const decode = out.lane === 'av1'
        ? await canDecodeVideoBlob(out.video)
        : await canDecodeApng(out.video);

    const saved = [];
    if (save && port) {
        const suffix = out.lane === 'av1' ? 'webm' : 'apng';
        saved.push(await saveArtifact(port, `${out.lane}-video.${suffix}`, out.video));
        if (out.audio) saved.push(await saveArtifact(port, `${out.lane}-audio.opus`, out.audio));
    }

    return { lane: out.lane, ms: elapsed, facts, decode, saved, out };
}
