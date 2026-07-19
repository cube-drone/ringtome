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

  const { video, revoke } = await loadVideoElement(fileOrBlob);
  try {
    const extracted = await extractFrames(video, { maxSide, fps });

    const apng = await encodeApng(extracted.frames, {
      width: extracted.width,
      height: extracted.height,
      delayMs: Math.round(1000 / fps),
      numPlays: 0, // loop forever
    });

    // Audio is independent of the visual pipeline.
    const audio = await encodeAudioToOpus(fileOrBlob);

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
