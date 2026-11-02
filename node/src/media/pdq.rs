//! PDQ, Meta's perceptual hash (plans/SCANNING.md, _Fingerprints: PDQ_): a 256-bit fingerprint of
//! a picture, where re-encodes, resizes and light crops of the same picture land a few bits apart
//! and different pictures land about half the bits apart.
//!
//! Ported from the `pdqhash` crate (Apache-2.0, Darwinium; github.com/darwinium-com/pdqhash), itself
//! a port of Meta's reference (github.com/facebook/ThreatExchange, `pdq/`), onto this tree's `image`
//! version: luminance, a two-pass Jarosz tent filter, decimation to 64x64, the 16x16 corner of a
//! DCT, and a bit per coefficient against their median. The DCT matrix is computed, by the reference's
//! own formula, rather than carried as a table.
//!
//! **Checked against Meta's reference outputs** (the tests below): for Meta's own regression
//! pictures, our hashes sit within a few bits of the C++ reference's - JPEG decoders differ in the
//! last bit of a pixel, and so does the hash - far inside the distance that counts as a match.

use image::DynamicImage;

/// Two hashes this many bits apart or fewer are the same picture, as Meta's own guidance sets it
/// for matching (of 256).
pub const MATCH_DISTANCE: u32 = 31;

/// Below this quality (0-100) a hash says little - a flat or tiny picture - and is never matched.
pub const MIN_QUALITY: u8 = 50;

/// The least side a picture can have and still be hashed.
const MIN_SIDE: u32 = 5;
/// Bigger pictures are first scaled down to this, which costs a few bits of agreement with the
/// reference and saves most of the work.
const DOWNSAMPLE: u32 = 512;
const BUFFER: usize = 64;
const DCT_SIDE: usize = 16;
const JAROSZ_PASSES: usize = 2;

/// A picture's fingerprint and how much it can be trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pdq {
    pub hash: [u8; 32],
    /// 0-100: how much structure the picture has to hash.
    pub quality: u8,
}

impl Pdq {
    pub fn distance(&self, other: &[u8; 32]) -> u32 {
        distance(&self.hash, other)
    }

    /// Worth matching against: enough structure that a near hash means a near picture.
    pub fn usable(&self) -> bool {
        self.quality >= MIN_QUALITY
    }
}

/// Bits apart.
pub fn distance(a: &[u8; 32], b: &[u8; 32]) -> u32 {
    a.iter().zip(b).map(|(x, y)| (x ^ y).count_ones()).sum()
}

/// The fingerprint of a decoded picture; `None` for one too small to hash.
pub fn of(image: &DynamicImage) -> Option<Pdq> {
    if image.width() < MIN_SIDE || image.height() < MIN_SIDE {
        return None;
    }
    let image = if image.width() > DOWNSAMPLE || image.height() > DOWNSAMPLE {
        std::borrow::Cow::Owned(image.resize_exact(
            DOWNSAMPLE.min(image.width()),
            DOWNSAMPLE.min(image.height()),
            image::imageops::FilterType::Triangle,
        ))
    } else {
        std::borrow::Cow::Borrowed(image)
    };
    Some(full_size(&image))
}

/// The fingerprint at the picture's own size, as the reference computes it.
pub fn full_size(image: &DynamicImage) -> Pdq {
    let rgb = image.to_rgb8();
    let (cols, rows) = (rgb.width() as usize, rgb.height() as usize);
    let mut luma: Vec<f32> = rgb
        .pixels()
        .map(|p| 0.299 * p.0[0] as f32 + 0.587 * p.0[1] as f32 + 0.114 * p.0[2] as f32)
        .collect();
    jarosz(&mut luma, rows, cols, window(cols, BUFFER), window(rows, BUFFER));
    let small = decimate(&luma, rows, cols);
    let dct = dct64_to_16(&small);
    Pdq { hash: bits(&dct), quality: (quality(&small) * 100.0).round() as u8 }
}

fn window(old: usize, new: usize) -> usize {
    old.div_ceil(2 * new)
}

fn jarosz(buf: &mut [f32], rows: usize, cols: usize, along_rows: usize, along_cols: usize) {
    let mut temp = vec![0.0f32; buf.len()];
    for _ in 0..JAROSZ_PASSES {
        for i in 0..rows {
            box_1d(buf, i * cols, &mut temp, cols, 1, along_rows);
        }
        for j in 0..cols {
            box_1d(&temp, j, buf, rows, cols, along_cols);
        }
    }
}

/// One box blur along a strided line, its window shrinking at both ends.
fn box_1d(input: &[f32], start: usize, out: &mut [f32], len: usize, stride: usize, full: usize) {
    let half = (full + 2) / 2;
    let phase1 = half - 1;
    let phase2 = full - half + 1;
    let oi_off = phase1 * stride;
    let li_off = phase2 * stride;
    let mut sum = 0.0f32;
    let mut size = 0.0f32;
    let p1_end = oi_off + start;
    for ri in (start..p1_end).step_by(stride) {
        sum += input[ri];
        size += 1.0;
    }
    let p2_end = full * stride + start;
    for ri in (p1_end..p2_end).step_by(stride) {
        sum += input[ri];
        size += 1.0;
        out[ri - oi_off] = sum / size;
    }
    let p3_end = len * stride + start;
    for ri in (p2_end..p3_end).step_by(stride) {
        let oi = ri - oi_off;
        sum += input[ri];
        sum -= input[oi - li_off];
        out[oi] = sum / size;
    }
    for oi in ((len - half + 1) * stride + start..p3_end).step_by(stride) {
        sum -= input[oi - li_off];
        size -= 1.0;
        out[oi] = sum / size;
    }
}

fn decimate(input: &[f32], rows: usize, cols: usize) -> [[f32; BUFFER]; BUFFER] {
    let mut out = [[0.0; BUFFER]; BUFFER];
    for (oi, row) in out.iter_mut().enumerate() {
        let ii = ((oi * 2 + 1) * rows) / (BUFFER * 2);
        for (oj, cell) in row.iter_mut().enumerate() {
            let ij = ((oj * 2 + 1) * cols) / (BUFFER * 2);
            *cell = input[ii * cols + ij];
        }
    }
    out
}

/// How much significant gradient the 64x64 holds, 0-1 (the reference's heuristic).
fn quality(b: &[[f32; BUFFER]; BUFFER]) -> f32 {
    let mut sum = 0.0f32;
    for pair in b.windows(2) {
        for (u, v) in pair[0].iter().zip(&pair[1]) {
            sum += ((u - v) / 255.0).abs();
        }
    }
    for row in b.iter() {
        for j in 0..BUFFER - 1 {
            sum += ((row[j] - row[j + 1]) / 255.0).abs();
        }
    }
    (sum / 90.0).min(1.0)
}

/// The reference's DCT matrix: the 16 lowest frequencies past the DC term, over 64 samples.
fn dct_matrix() -> &'static [[f32; BUFFER]; DCT_SIDE] {
    static M: std::sync::LazyLock<[[f32; BUFFER]; DCT_SIDE]> = std::sync::LazyLock::new(|| {
        let mut m = [[0.0f32; BUFFER]; DCT_SIDE];
        let scale = (2.0f64 / BUFFER as f64).sqrt();
        for (i, row) in m.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                let angle = std::f64::consts::PI / 2.0 / BUFFER as f64
                    * (i as f64 + 1.0)
                    * (2.0 * j as f64 + 1.0);
                *cell = (scale * angle.cos()) as f32;
            }
        }
        m
    });
    &M
}

fn dct64_to_16(input: &[[f32; BUFFER]; BUFFER]) -> [f32; DCT_SIDE * DCT_SIDE] {
    let d = dct_matrix();
    let mut mid = [[0.0f32; BUFFER]; DCT_SIDE];
    for i in 0..DCT_SIDE {
        for j in 0..BUFFER {
            mid[i][j] = (0..BUFFER).map(|k| d[i][k] * input[k][j]).sum();
        }
    }
    let mut out = [0.0f32; DCT_SIDE * DCT_SIDE];
    for i in 0..DCT_SIDE {
        for j in 0..DCT_SIDE {
            out[i * DCT_SIDE + j] = (0..BUFFER).map(|k| mid[i][k] * d[j][k]).sum();
        }
    }
    out
}

/// Torben's median: no sort, no copy.
fn median(m: &[f32]) -> f32 {
    let mut min = m.iter().copied().fold(f32::INFINITY, f32::min);
    let mut max = m.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let half = m.len().div_ceil(2);
    loop {
        let guess = (min + max) / 2.0;
        let (mut less, mut greater, mut equal) = (0, 0, 0);
        let (mut below, mut above) = (min, max);
        for &v in m {
            if v < guess {
                less += 1;
                below = below.max(v);
            } else if v > guess {
                greater += 1;
                above = above.min(v);
            } else {
                equal += 1;
            }
        }
        if less <= half && greater <= half {
            return if less >= half {
                below
            } else if less + equal >= half {
                guess
            } else {
                above
            };
        } else if less > greater {
            max = below;
        } else {
            min = above;
        }
    }
}

fn bits(dct: &[f32; DCT_SIDE * DCT_SIDE]) -> [u8; 32] {
    let m = median(dct);
    let mut hash = [0u8; 32];
    for i in 0..32 {
        let mut byte = 0u8;
        for j in 0..8 {
            if dct[i * 8 + j] > m {
                byte |= 1 << j;
            }
        }
        hash[31 - i] = byte;
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Meta's regression pictures and the C++ reference's hashes for them
    /// (ThreatExchange `pdq/cpp/reg_test/expected/out`), read 2026-11-02.
    const REFERENCE: &[(&str, &str)] = &[
        (
            "bridge-1-original.jpg",
            "d8f8f0cee0f4a84f0637022a078f67f0b36e2ed596621e1d33e6339c4e9c9b22",
        ),
        (
            "bridge-2-rotate-90.jpg",
            "30a10efdf1c83f429013d48d0ffffc52e34e0e35ada952a9d29605215aa9e5af",
        ),
        ("bridge-5-flipx.jpg", "d8f80f33e0f417b20e37f5cd028f980fb36ed02a9662c1e233e64c634e9c64dd"),
    ];

    fn hex32(s: &str) -> [u8; 32] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    fn picture(name: &str) -> DynamicImage {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/pdq").join(name);
        image::open(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    #[test]
    fn agrees_with_metas_reference_to_within_a_decoders_bits() {
        for (name, want) in REFERENCE {
            let img = picture(name);
            let full = full_size(&img);
            let small = of(&img).unwrap();
            let (d_full, d_small) = (full.distance(&hex32(want)), small.distance(&hex32(want)));
            assert!(d_full <= 10, "{name}: {d_full} bits from the reference at full size");
            assert!(d_small <= 16, "{name}: {d_small} bits from the reference, scaled down");
            assert!(full.usable(), "{name}: quality {}", full.quality);
        }
    }

    #[test]
    fn tells_different_pictures_apart_and_finds_a_re_encode() {
        let bridge = of(&picture("bridge-1-original.jpg")).unwrap();
        let rotated = of(&picture("bridge-2-rotate-90.jpg")).unwrap();
        assert!(bridge.distance(&rotated.hash) > 64, "a rotation is, to PDQ, another picture");
        // A re-encode at a low quality and a resize: the same picture.
        let img = picture("bridge-1-original.jpg").resize(
            640,
            640,
            image::imageops::FilterType::Lanczos3,
        );
        let mut jpeg = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg).unwrap();
        let again = of(&image::load_from_memory(&jpeg).unwrap()).unwrap();
        assert!(bridge.distance(&again.hash) <= MATCH_DISTANCE, "{}", bridge.distance(&again.hash));
        // And one scaled and re-saved by another program (tests/pdq/README.md).
        let resized = of(&picture("bridge-1-resized-900.jpg")).unwrap();
        assert!(
            bridge.distance(&resized.hash) <= MATCH_DISTANCE,
            "{}",
            bridge.distance(&resized.hash)
        );
    }

    #[test]
    fn a_flat_picture_is_too_plain_to_match() {
        let flat = DynamicImage::new_rgb8(64, 64);
        assert!(!of(&flat).unwrap().usable());
        assert!(of(&DynamicImage::new_rgb8(3, 3)).is_none());
    }
}
