//! The bench behind `pow::BASELINE_BITS` - kept so the constant's comment can be re-checked
//! rather than believed. Not a gate: timing on a shared runner is noise, so every test here is
//! `#[ignore]`d and the real cop is `pow::tests::the_baseline_is_a_moment_not_a_minute`, which
//! bounds the work instead of the clock.
//!
//! ```sh
//! cargo test -p ringtome-proto --release --test pow_calibration -- --ignored --nocapture
//! ```
//!
//! Run it in BOTH profiles when re-calibrating. The debug number is the one dev and integration
//! actually pay, and if the two ever diverge sharply (they were within 20% on 2026-08-10,
//! because blake3's hot loop is SIMD in a dependency) then one constant no longer serves both
//! and that is a finding, not a rounding error.

use ringtome_proto::pow;
use std::time::Instant;

#[test]
#[ignore = "a benchmark, not a gate - see the module note"]
fn what_each_price_costs_to_pay_and_to_check() {
    let runs = 12;
    for bits in [14u32, 15, 16, 17, 18, 19, 20] {
        let mut total = 0u128;
        for i in 0..runs {
            // A fresh challenge each run: one envelope's solution says nothing about the next,
            // and averaging over a single challenge would measure that challenge's luck.
            let c = pow::challenge(format!("envelope body number {i}").as_bytes());
            let started = Instant::now();
            let stamp = pow::solve(&c, bits);
            total += started.elapsed().as_micros();
            assert!(pow::verify(&c, &stamp, bits).is_ok(), "a solve must verify");
        }
        println!(
            "solve bits={bits}: mean {:.1} ms over {runs} solves",
            total as f64 / runs as f64 / 1000.0
        );
    }

    // The asymmetry, measured rather than asserted: this is the number that decides whether
    // raising the dial hurts the attacker or the defender.
    let c = pow::challenge(b"a representative envelope body");
    let stamp = pow::solve(&c, 16);
    let started = Instant::now();
    let checks = 100_000;
    for _ in 0..checks {
        let _ = pow::verify(&c, &stamp, 16);
    }
    println!(
        "verify: {:.2} us each",
        started.elapsed().as_micros() as f64 / f64::from(checks)
    );
}
