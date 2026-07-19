// feature-detect.js
//
// Decides which "intermediary" lane we can produce in this browser.
//
//   'av1'    -> the browser can ENCODE AV1, so we emit AV1-in-WebM (the happy
//               path). The Rust server re-decodes it with rav1d.
//   'frames' -> fallback that only needs universally-available APIs. We emit a
//               320p APNG for the frames plus a separate Opus audio blob. The
//               server decodes the APNG frames with the `image` crate.
//
// The check is intentionally conservative: we only claim 'av1' when we have a
// concrete, testable AV1 encode path (WebCodecs VideoEncoder OR MediaRecorder).

// These calls are async, so we memoize the answer after the first probe.
let cachedLane = null;

// Whether we can produce the av1 lane's output HERE.
//
// Detection MUST match the encoder the av1 lane actually uses. The lane encodes
// via MediaRecorder (av1RecorderMimeType), so we probe *exactly that* — not
// WebCodecs. Firefox is the reason: it reports WebCodecs `VideoEncoder` av01
// support while its MediaRecorder cannot mux av01, so a WebCodecs probe would
// route Firefox to a lane that then throws. Probe the capability we'll actually
// invoke. (When the av1 lane is rewritten onto WebCodecs, this probe moves with it.)
function canEncodeAv1() {
  return mediaRecorderCanAv1();
}

// pickLane() -> Promise<'av1' | 'frames'>
//
// NOTE: the spec asks for a sync-looking `pickLane()`, but the only reliable
// AV1 encode probe (WebCodecs) is async. We expose an async function and the
// library awaits it. The demo/test still call it directly.
export async function pickLane() {
  if (cachedLane) return cachedLane;
  cachedLane = (await canEncodeAv1()) ? 'av1' : 'frames';
  return cachedLane;
}

// Reset the memoized answer. Only used by tests.
export function _resetLaneCache() {
  cachedLane = null;
}

// Whether MediaRecorder can produce an AV1 WebM directly (preferred happy-path
// encoder here because it is far simpler than hand-muxing WebCodecs output).
export function mediaRecorderCanAv1() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return false;
  return (
    MediaRecorder.isTypeSupported('video/webm;codecs=av01,opus') ||
    MediaRecorder.isTypeSupported('video/webm;codecs=av01')
  );
}

// Best MediaRecorder mimeType for the av1 lane, preferring audio inclusion.
export function av1RecorderMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  if (MediaRecorder.isTypeSupported('video/webm;codecs=av01,opus')) {
    return 'video/webm;codecs=av01,opus';
  }
  if (MediaRecorder.isTypeSupported('video/webm;codecs=av01')) {
    return 'video/webm;codecs=av01';
  }
  return null;
}
