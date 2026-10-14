// The cassette bounces to the music (Curtis, 2026-10-13: "if it's terrible we can take it out").
// Not a live analyser on the playing audio - that would route the player through Web Audio, which
// the player keeps out of so the lock screen can't stop the music, and the phone's player makes
// its sound where the page can't hear it - but the song read a second time, quietly: decoded at a
// low rate, its bass kept (a low-pass, so the kick drum leads), and boiled down here to how hard it
// kicks in each step of 50ms. The cassette looks up the step it's at as it plays.
//
// A kick is the step's loudness above the last second's: a sudden rise bounces, a loud stretch
// settles. Pure; the vectors are in integration/test/pure/amp.cjs.

/// One step's length, in milliseconds.
export const STEP_MS = 50;

/// How hard the music kicks in each step, from 0 to 1, out of `samples` (mono) at `sampleRate`.
/// Scaled by the song's own strong kicks (all but the top 2%), so a quiet song bounces too.
export function kicks(samples, sampleRate, stepMs = STEP_MS) {
    const step = Math.max(1, Math.round((sampleRate * stepMs) / 1000));
    const n = Math.floor(samples.length / step);
    const energy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = i * step; j < (i + 1) * step; j++) sum += samples[j] * samples[j];
        energy[i] = Math.sqrt(sum / step);
    }
    // Above the last second's mean.
    const span = Math.max(1, Math.round(1000 / stepMs));
    const out = new Float32Array(n);
    let run = 0;
    for (let i = 0; i < n; i++) {
        const seen = Math.min(i, span);
        const mean = seen ? run / seen : energy[i];
        out[i] = Math.max(0, energy[i] - mean);
        run += energy[i];
        if (i >= span) run -= energy[i - span];
    }
    const rises = [...out].filter((v) => v > 0).sort((a, b) => a - b);
    const top = rises.length ? rises[Math.floor((rises.length - 1) * 0.98)] : 0;
    if (!top) return new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / top);
    return out;
}

/// The kick at `seconds` into the song.
export const kickAt = (k, seconds, stepMs = STEP_MS) =>
    (k && seconds >= 0 && k[Math.floor((seconds * 1000) / stepMs)]) || 0;
