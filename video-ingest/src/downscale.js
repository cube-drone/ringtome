// downscale.js
//
// Shared geometry + a <video>-element decoder that both lanes use to pull
// frames. We deliberately decode by drawing a <video> to a <canvas>: that is
// the one path available in every browser and it does NOT require WebCodecs
// decode. The browser's hardened decoder handles the hostile input; we only
// ever touch already-decoded RGBA pixels.

export const MAX_SIDE = 320; // longest side, px
export const TARGET_FPS = 20; // frame-rate cap

// Compute a downscaled size whose longest side is <= MAX_SIDE, preserving
// aspect ratio. Never upscales. Dimensions are rounded to even numbers because
// many video encoders require even width/height.
export function fitWithin(srcW, srcH, maxSide = MAX_SIDE) {
  if (srcW <= 0 || srcH <= 0) return { width: 2, height: 2 };
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxSide ? maxSide / longest : 1;
  let w = Math.round(srcW * scale);
  let h = Math.round(srcH * scale);
  // Force even and >= 2.
  w = Math.max(2, w - (w % 2));
  h = Math.max(2, h - (h % 2));
  return { width: w, height: h };
}

// Load a File/Blob into a fully-decoded, seekable <video> element.
export async function loadVideoElement(fileOrBlob) {
  const url = URL.createObjectURL(fileOrBlob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  await new Promise((resolve, reject) => {
    const onError = () =>
      reject(new Error('video decode/load failed (unsupported codec?)'));
    video.addEventListener('error', onError, { once: true });
    // loadedmetadata gives us dimensions; we also wait for enough data to draw.
    video.addEventListener(
      'loadeddata',
      () => {
        video.removeEventListener('error', onError);
        resolve();
      },
      { once: true }
    );
  });

  return { video, revoke: () => URL.revokeObjectURL(url) };
}

// Seek a <video> to a given time and resolve once that frame is presentable.
export function seekTo(video, timeSec) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      reject(new Error('seek failed'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    // Clamp into a valid range.
    video.currentTime = Math.max(0, Math.min(timeSec, video.duration || timeSec));
  });
}

// Extract downscaled frames by seeking through the video at the capped fps.
// Returns { width, height, fps, durationMs, frames: [{ blob, canvas }] } where
// each frame is rendered on its own canvas. The caller decides what to do with
// them (PNG-encode for APNG, or draw onto a capture-stream canvas).
//
// `onFrame(canvas, index, timeSec)` is called per frame so callers can stream
// frames out without holding them all in memory when possible.
export async function extractFrames(video, opts = {}) {
  const maxSide = opts.maxSide ?? MAX_SIDE;
  const fps = opts.fps ?? TARGET_FPS;
  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) {
    throw new Error('video has no finite duration');
  }

  const { width, height } = fitWithin(video.videoWidth, video.videoHeight, maxSide);
  const frameInterval = 1 / fps;
  // Number of frames we intend to sample.
  const frameCount = Math.max(1, Math.floor(duration * fps));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const t = i * frameInterval;
    await seekTo(video, t);
    ctx.drawImage(video, 0, 0, width, height);
    if (opts.onFrame) {
      await opts.onFrame(canvas, i, t);
    } else {
      // Snapshot pixels so a shared canvas can be reused.
      const snap = document.createElement('canvas');
      snap.width = width;
      snap.height = height;
      snap.getContext('2d').drawImage(canvas, 0, 0);
      frames.push({ canvas: snap, timeSec: t });
    }
  }

  return {
    width,
    height,
    fps,
    durationMs: Math.round(duration * 1000),
    frameCount,
    frames,
  };
}
