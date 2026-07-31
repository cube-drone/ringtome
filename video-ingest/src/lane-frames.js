// lane-frames.js
//
// The universal fallback lane. Decode the source with a <video> element, sample
// downscaled frames onto a canvas, PNG-encode each, and stitch them into a
// single APNG. Audio is re-encoded to Ogg Opus separately. Nothing here needs
// AV1 encode or even WebCodecs *encode* of video.

import { loadVideoElement, extractFrames, MAX_SIDE, TARGET_FPS } from './downscale.js';
import { encodeApng } from './apng-encoder.js';
import { encodeAudioToOpus } from './audio-opus.js';

export async function ingestFramesLane(fileOrBlob, opts = {}) {
  const maxSide = opts.maxSide ?? MAX_SIDE;
  const fps = opts.fps ?? TARGET_FPS;
  // Loosely-accurate meter: frame extraction (seek-per-frame) dominates, so it owns 0-75;
  // the APNG stitch and audio re-encode get coarse stage marks. 99 is the ceiling - "done"
  // is the caller's word.
  const report = opts.onProgress || (() => {});

  const { video, revoke } = await loadVideoElement(fileOrBlob);
  try {
    const extracted = await extractFrames(video, {
      maxSide,
      fps,
      onProgress: (done, total) => report(Math.min(75, Math.round((done * 75) / (total || 1)))),
    });

    report(80);
    const apng = await encodeApng(extracted.frames, {
      width: extracted.width,
      height: extracted.height,
      delayMs: Math.round(1000 / fps),
      numPlays: 0, // loop forever
    });

    // Audio is independent of the visual pipeline.
    report(92);
    const audio = await encodeAudioToOpus(fileOrBlob);
    report(99);

    return {
      lane: 'frames',
      width: extracted.width,
      height: extracted.height,
      durationMs: extracted.durationMs,
      frameCount: extracted.frameCount,
      fps,
      video: apng, // image/apng
      audio, // audio/ogg (Opus) or null
    };
  } finally {
    revoke();
  }
}
