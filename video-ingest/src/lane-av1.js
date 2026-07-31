// lane-av1.js
//
// The happy path: emit AV1-in-WebM. We use MediaRecorder over a
// canvas.captureStream() (plus the source's audio, if any) because it is far
// simpler than driving WebCodecs VideoEncoder + a hand-rolled WebM muxer, and
// the Rust server only needs a valid AV1 WebM to re-decode with rav1d.
//
// TRADE-OFF (spike): MediaRecorder records in REAL TIME at playback speed, so
// ingesting a 2 s clip takes ~2 s. A production path would use WebCodecs
// VideoEncoder to transcode faster-than-realtime. Noted in the README.

import { fitWithin, MAX_SIDE, TARGET_FPS } from './downscale.js';
import { av1RecorderMimeType } from './feature-detect.js';

// Draw the playing <video> onto the downscaled canvas until it ends, recording
// the canvas' captured stream (with audio) to a WebM.
export async function ingestAv1Lane(fileOrBlob, opts = {}) {
  const maxSide = opts.maxSide ?? MAX_SIDE;
  const fps = opts.fps ?? TARGET_FPS;

  const mimeType = av1RecorderMimeType();
  if (!mimeType) {
    throw new Error('av1 lane requested but MediaRecorder cannot encode av01 here');
  }

  const url = URL.createObjectURL(fileOrBlob);
  const video = document.createElement('video');
  video.src = url;
  video.playsInline = true;
  // We route audio through Web Audio (not the speakers), so the element can stay
  // unmuted for the tap without making noise.
  video.muted = true;

  // Wait for metadata so we know the real dimensions/duration.
  await new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('video load failed')), {
      once: true,
    });
  });

  const { width, height } = fitWithin(video.videoWidth, video.videoHeight, maxSide);
  const durationMs = Math.round((video.duration || 0) * 1000);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Video track from the canvas, sampled at our capped fps.
  const canvasStream = canvas.captureStream(fps);
  const tracks = [...canvasStream.getVideoTracks()];

  // Audio track: capture the element's DECODED audio directly via captureStream
  // (mozCaptureStream in Firefox). Its audio track carries real sound regardless
  // of `element.muted` — which only gates the speakers. This replaces a previous
  // createMediaElementSource tap that captured silence, because Chrome zeroes the
  // Web Audio graph signal for a muted element. A source with no decodable audio
  // simply yields no audio track (silent WebM, harmless).
  let hasAudio = false;
  try {
    const cap = video.captureStream?.() ?? video.mozCaptureStream?.();
    const aTracks = cap ? cap.getAudioTracks() : [];
    if (aTracks.length) {
      tracks.push(aTracks[0]);
      hasAudio = true;
    }
  } catch (_) {
    // No audio available; carry on with video only.
  }

  const recordStream = new MediaStream(tracks);
  const recorder = new MediaRecorder(recordStream, {
    mimeType,
    videoBitsPerSecond: 1_200_000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  const finished = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  // Count drawn frames as a coarse frameCount for metadata.
  let drawn = 0;
  let rafId = null;
  const drawLoop = () => {
    if (video.ended || video.paused) return;
    ctx.drawImage(video, 0, 0, width, height);
    drawn++;
    rafId = requestAnimationFrame(drawLoop);
  };

  // The tap plays in real time, so playback position IS the encode meter (99-capped:
  // "done" is the caller's word).
  const report = opts.onProgress || (() => {});
  video.addEventListener('timeupdate', () => {
    if (video.duration > 0) {
      report(Math.min(99, Math.round((video.currentTime / video.duration) * 100)));
    }
  });

  recorder.start();
  await video.play();
  drawLoop();

  await new Promise((resolve, reject) => {
    video.addEventListener('ended', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('playback error')), {
      once: true,
    });
  });

  if (rafId) cancelAnimationFrame(rafId);
  // Draw one final frame so the last moment is captured, then stop.
  try {
    ctx.drawImage(video, 0, 0, width, height);
  } catch (_) {
    /* ignore */
  }
  recorder.stop();
  await finished;

  URL.revokeObjectURL(url);

  const blob = new Blob(chunks, { type: 'video/webm' });

  // canvas.captureStream(fps) samples the canvas at (at most) our capped fps,
  // regardless of how many times the rAF loop actually redrew it (`drawn` runs
  // at display refresh, ~60Hz, so it overcounts). Report the cap and derive the
  // frame count from the real duration.
  const seconds = (video.duration || durationMs / 1000) || 1;
  const frameCount = Math.max(1, Math.round(seconds * fps));

  return {
    lane: 'av1',
    width,
    height,
    durationMs,
    frameCount,
    fps,
    video: blob, // WebM (AV1 [+ Opus])
    // Audio is muxed into the WebM on this lane; expose null at the top level
    // to match the frames-lane shape (where audio is a separate blob).
    audio: null,
    _hasAudio: hasAudio,
  };
}
