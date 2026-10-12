//! How loud a sound is, as one number (plans/AUDIO.md, section 9, ruling 20: loudness levelling):
//! its integrated loudness in LUFS, measured the EBU R128 / ITU-R BS.1770 way, at 48 kHz - the rate
//! every sound is stored at, so the standard filter coefficients serve as they are.
//!
//! The measure: each channel through the K-weighting filter (a high shelf, then a high pass); the
//! mean square of each 400 ms block, blocks stepping 100 ms; a block's loudness from the channels'
//! summed power; then the gates - blocks quieter than -70 LUFS left out, and then any quieter than
//! 10 LU under the mean of the rest - and the mean of what remains, as loudness. A whisper of a
//! recording doesn't come out silent for its pauses, and a song doesn't come out quiet for its
//! fade.
//!
//! Pure and allocation-light: a meter is fed interleaved samples in whatever chunks the decoder
//! gives, and keeps one number per 100 ms.

/// The field a sound's loudness is kept in, as its document's other facts are (media/audio.rs
/// `SOUND_FIELDS`): "-9.4", in LUFS.
pub const FIELD: &str = "loudness";

/// The sample rate the coefficients are for: every sound is measured where it's stored.
pub const RATE: u32 = 48_000;

/// 100 ms at 48 kHz: a block is four of these, and they step one at a time.
const STEP: usize = (RATE / 10) as usize;

/// One second-order section: `y = b0 x + b1 x1 + b2 x2 - a1 y1 - a2 y2`.
#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    const fn new(b: [f64; 3], a: [f64; 2]) -> Self {
        Biquad { b, a, x: [0.0; 2], y: [0.0; 2] }
    }

    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// The K-weighting filter at 48 kHz (ITU-R BS.1770-4, table 1 and table 2): the head's high shelf,
/// then the RLB high pass.
fn k_weighting() -> [Biquad; 2] {
    [
        Biquad::new(
            [1.535_124_859_586_97, -2.691_696_189_406_38, 1.198_392_810_852_85],
            [-1.690_659_293_182_41, 0.732_480_774_215_85],
        ),
        Biquad::new([1.0, -2.0, 1.0], [-1.990_047_454_833_98, 0.990_072_250_366_21]),
    ]
}

/// A loudness meter for one sound, of one or two channels at 48 kHz.
pub struct Meter {
    channels: usize,
    filters: Vec<[Biquad; 2]>,
    /// The current 100 ms step's sum of squares, per channel, and how many frames are in it.
    sums: Vec<f64>,
    filled: usize,
    /// Each finished 100 ms step's mean square, summed over the channels.
    steps: Vec<f64>,
}

impl Meter {
    pub fn new(channels: usize) -> Self {
        let channels = channels.clamp(1, 2);
        Meter {
            channels,
            filters: vec![k_weighting(); channels],
            sums: vec![0.0; channels],
            filled: 0,
            steps: Vec::new(),
        }
    }

    /// Interleaved samples, `channels` to a frame.
    pub fn push(&mut self, interleaved: &[f32]) {
        for frame in interleaved.chunks_exact(self.channels) {
            for (c, &x) in frame.iter().enumerate() {
                let [shelf, pass] = &mut self.filters[c];
                let y = pass.run(shelf.run(f64::from(x)));
                self.sums[c] += y * y;
            }
            self.filled += 1;
            if self.filled == STEP {
                let power: f64 = self.sums.iter().map(|s| s / STEP as f64).sum();
                self.steps.push(power);
                self.sums.iter_mut().for_each(|s| *s = 0.0);
                self.filled = 0;
            }
        }
    }

    /// The sound's integrated loudness in LUFS, or None for something under one block long or
    /// silent all through.
    pub fn integrated(&self) -> Option<f64> {
        // A block is four steps; blocks step one at a time (75% overlap).
        let blocks: Vec<f64> = self.steps.windows(4).map(|w| w.iter().sum::<f64>() / 4.0).collect();
        let loudness = |power: f64| -0.691 + 10.0 * power.log10();
        let mean = |powers: &[f64]| powers.iter().sum::<f64>() / powers.len() as f64;
        let absolute: Vec<f64> =
            blocks.into_iter().filter(|&p| p > 0.0 && loudness(p) > -70.0).collect();
        if absolute.is_empty() {
            return None;
        }
        let relative = loudness(mean(&absolute)) - 10.0;
        let gated: Vec<f64> = absolute.into_iter().filter(|&p| loudness(p) > relative).collect();
        if gated.is_empty() {
            return None;
        }
        Some(loudness(mean(&gated)))
    }
}

/// A loudness as a sound's field keeps it: one decimal place, as "-9.4".
pub fn field_value(lufs: f64) -> String {
    format!("{lufs:.1}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sine at `freq` Hz and `amp` peak, `secs` long, in `channels` identical channels.
    fn sine(freq: f64, amp: f64, secs: f64, channels: usize) -> Vec<f32> {
        let n = (secs * f64::from(RATE)) as usize;
        let mut out = Vec::with_capacity(n * channels);
        for i in 0..n {
            let x = amp * (2.0 * std::f64::consts::PI * freq * i as f64 / f64::from(RATE)).sin();
            for _ in 0..channels {
                out.push(x as f32);
            }
        }
        out
    }

    fn measure(samples: &[f32], channels: usize) -> Option<f64> {
        let mut m = Meter::new(channels);
        // In uneven chunks, as a decoder gives them.
        for chunk in samples.chunks(7_331 * channels) {
            m.push(chunk);
        }
        m.integrated()
    }

    #[test]
    fn a_full_scale_1k_sine_in_one_channel_reads_about_minus_three() {
        // BS.1770's own check: a 0 dBFS 997 Hz sine, mono, is -3.01 LUFS give or take the
        // filter's small gain at 1 kHz.
        let lufs = measure(&sine(997.0, 1.0, 5.0, 1), 1).unwrap();
        assert!((lufs - -3.01).abs() < 0.1, "{lufs}");
    }

    #[test]
    fn the_same_sine_in_both_channels_reads_three_db_louder() {
        let mono = measure(&sine(997.0, 0.5, 5.0, 1), 1).unwrap();
        let stereo = measure(&sine(997.0, 0.5, 5.0, 2), 2).unwrap();
        assert!((stereo - mono - 3.01).abs() < 0.05, "{mono} {stereo}");
    }

    #[test]
    fn half_the_amplitude_is_six_db_quieter() {
        let full = measure(&sine(997.0, 1.0, 5.0, 1), 1).unwrap();
        let half = measure(&sine(997.0, 0.5, 5.0, 1), 1).unwrap();
        assert!((full - half - 6.02).abs() < 0.05, "{full} {half}");
    }

    #[test]
    fn silence_between_the_notes_doesnt_make_a_song_quiet() {
        // Three seconds of tone, then three of near-silence: the gates leave the silence out.
        let mut song = sine(997.0, 0.5, 3.0, 1);
        song.extend(sine(997.0, 0.0001, 3.0, 1));
        let tone = measure(&sine(997.0, 0.5, 3.0, 1), 1).unwrap();
        let with_quiet = measure(&song, 1).unwrap();
        assert!((tone - with_quiet).abs() < 0.3, "{tone} {with_quiet}");
    }

    #[test]
    fn nothing_to_measure_is_none() {
        assert_eq!(measure(&sine(997.0, 1.0, 0.2, 1), 1), None, "under one block");
        assert_eq!(measure(&vec![0.0; 48_000 * 2], 1), None, "silent");
        assert_eq!(field_value(-9.4449), "-9.4");
    }
}
