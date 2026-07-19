// index.js — public entry point for the video-ingest spike.
//
// ingestVideo() normalizes an arbitrary user video into one of two "intermediary"
// formats that a memory-safe Rust server can re-decode:
//
//   lane 'av1'    -> AV1-in-WebM (happy path, server uses rav1d)
//   lane 'frames' -> 320p APNG + separate Ogg Opus audio (universal fallback,
//                    server uses the `image` crate for frames)
//
// The security idea: the hostile decode of untrusted input happens in the
// browser's hardened decoder; we only ever emit formats the server can decode
// in safe code, laundering the input.
//
// See README.md for the design rationale and honest spike limitations.

import { pickLane as detectLane, _resetLaneCache } from './feature-detect.js';
import { ingestAv1Lane } from './lane-av1.js';
import { ingestFramesLane } from './lane-frames.js';
import { MAX_SIDE, TARGET_FPS } from './downscale.js';

export { MAX_SIDE, TARGET_FPS };

// pickLane() -> Promise<'av1' | 'frames'>
// Exported for feature-detection tests. Async because the only reliable AV1
// encode probe (WebCodecs) is async.
export async function pickLane() {
  return detectLane();
}

// ingestVideo(fileOrBlob, opts) -> Promise<Intermediary>
//
// Intermediary = {
//   lane: 'av1' | 'frames',
//   width, height, durationMs, frameCount, fps,
//   video: Blob,          // 'av1': WebM(AV1[+Opus]); 'frames': APNG (image/apng)
//   audio?: Blob | null,  // 'frames': Ogg Opus (or null if source had no audio)
// }
//
// opts:
//   forceLane: 'av1' | 'frames'  — override feature detection (for testing)
//   maxSide:   number            — longest-side cap in px (default 320)
//   fps:       number            — frame-rate cap (default 20)
export async function ingestVideo(fileOrBlob, opts = {}) {
  if (!(fileOrBlob instanceof Blob)) {
    throw new TypeError('ingestVideo expects a File or Blob');
  }

  const forced = opts.forceLane;
  const lane = forced ?? (await pickLane());
  if (lane !== 'av1' && lane !== 'frames') {
    throw new Error(`unknown lane: ${lane}`);
  }

  if (lane === 'av1') {
    try {
      return await ingestAv1Lane(fileOrBlob, opts);
    } catch (err) {
      // An explicit forceLane:'av1' surfaces the failure (the caller asked for it).
      // In auto mode we degrade to the universal frames lane rather than hard-fail on
      // a browser that turned out not to encode av1 after all.
      if (forced === 'av1') throw err;
      return ingestFramesLane(fileOrBlob, opts);
    }
  }
  return ingestFramesLane(fileOrBlob, opts);
}

// Testing hook.
export { _resetLaneCache };
