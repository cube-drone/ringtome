// audio-opus.js
//
// Extract the source audio, re-encode it to Opus with WebCodecs' AudioEncoder,
// and mux the packets into an Ogg Opus blob. Both APIs (Web Audio
// decodeAudioData + AudioEncoder) are broadly available and do NOT require any
// AV1 support, which is why this lane is the universal fallback for audio.

import { muxOggOpus } from './ogg-opus.js';

// Opus always runs on a 48 kHz internal clock; the Ogg granule position is
// measured in 48 kHz samples.
const OPUS_RATE = 48000;

// Decode the container's audio track to raw PCM. Returns null if the source has
// no audio at all (decodeAudioData throws / yields zero channels).
async function decodePcm(fileOrBlob) {
  const buf = await fileOrBlob.arrayBuffer();
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  // A short-lived context just to run decodeAudioData.
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
    return audioBuffer;
  } catch (_) {
    return null; // no audio / undecodable audio track
  } finally {
    ctx.close();
  }
}

// encodeAudioToOpus(fileOrBlob) -> Promise<Blob | null>
export async function encodeAudioToOpus(fileOrBlob) {
  if (typeof AudioEncoder === 'undefined') {
    console.warn('[video-ingest] AudioEncoder unavailable — this browser needs a non-WebCodecs audio fallback');
    return null;
  }

  const audioBuffer = await decodePcm(fileOrBlob);
  if (!audioBuffer || audioBuffer.length === 0) {
    console.warn('[video-ingest] no decodable audio track (silent source, or an audio codec this browser can\'t decode)');
    return null;
  }

  const srcRate = audioBuffer.sampleRate;
  // Cap to stereo; downmix beyond 2 channels is out of scope for the spike.
  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const frameCount = audioBuffer.length;

  const packets = [];
  let encoderError = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // chunk.duration is microseconds; convert to 48 kHz sample count.
      const samples = Math.round(((chunk.duration ?? 0) / 1e6) * OPUS_RATE);
      packets.push({ data, samples });
    },
    error: (e) => {
      encoderError = e;
    },
  });

  encoder.configure({
    codec: 'opus',
    sampleRate: srcRate, // encoder resamples to 48k internally
    numberOfChannels: channels,
    bitrate: 96_000,
  });

  // Feed the PCM in ~1s chunks rather than one giant multi-second AudioData.
  // Some encoders (notably Firefox) choke on a single huge AudioData; small
  // chunks are the portable path, each carrying its own advancing timestamp.
  const chunkFrames = Math.max(1, Math.min(frameCount, srcRate));
  for (let start = 0; start < frameCount; start += chunkFrames) {
    const n = Math.min(chunkFrames, frameCount - start);
    // f32-planar layout: [ch0 samples..., ch1 samples...] for this chunk only.
    const chunk = new Float32Array(n * channels);
    for (let ch = 0; ch < channels; ch++) {
      chunk.set(audioBuffer.getChannelData(ch).subarray(start, start + n), ch * n);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: srcRate,
      numberOfFrames: n,
      numberOfChannels: channels,
      timestamp: Math.round((start / srcRate) * 1e6), // microseconds
      data: chunk,
    });
    encoder.encode(audioData);
    audioData.close();
  }

  await encoder.flush();
  encoder.close();

  if (encoderError) throw encoderError;
  if (packets.length === 0) {
    console.warn('[video-ingest] AudioEncoder produced no Opus packets');
    return null;
  }

  // pre-skip left at 0 for the spike; libopus inserts a small encoder delay we
  // don't read back from WebCodecs, so playback starts a few ms early. Harmless
  // for short-form and easy to correct later if we thread the real value.
  return muxOggOpus(packets, {
    channels,
    inputSampleRate: srcRate,
    preSkip: 0,
  });
}
