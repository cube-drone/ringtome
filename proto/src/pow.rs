//! The delivery stamp: hashcash for the door strangers knock on.
//!
//! The sender searches for a nonce; the recipient checks it with **one hash**. That asymmetry
//! is the entire mechanism, and it is why this is hashcash rather than one of the memory-hard
//! functions (Argon2, scrypt, balloon) that a reader might expect from a "make it cost
//! something" brief. Those are built for password storage, where the defender verifies once per
//! login and wants the attacker's advantage narrowed. Here the defender verifies once per
//! *arriving envelope* - which under a flood is the attacker's chosen rate. A symmetric
//! function would hand a flood a CPU amplifier aimed at the node it is flooding, and would make
//! raising the dial hurt the defender as much as the attacker. Cheap verification is what lets
//! the price go up at all.
//!
//! The cost of that choice, named rather than hidden: hashcash favours whoever has the widest
//! silicon, so a *high* price is regressive - it prices out phones before datacenters
//! (PROJECT_PLAN, The proof-of-work dial). At the baseline this is irrelevant, because the
//! baseline is not a defence. If the dial ever needs to sit high enough to deter, the honest
//! answer is the friend-token bypass for the people it would price out, not a symmetric
//! function that taxes the defender too.
//!
//! ## What the baseline is for
//!
//! It is not deterrence, and claiming otherwise would be dishonest arithmetic: at
//! [`DEFAULT_BITS`] a flood of 512 fresh identities pays a few seconds *in total*. What it buys
//! is that the machinery is real - solved, carried, verified, and re-priced on every delivery
//! this system makes, in production and not only in tests - so that turning the dial up is a
//! change of one number rather than a change of plan. A dial nobody has ever turned is a
//! document, not a dial.
//!
//! ## What the stamp binds
//!
//! The challenge is the envelope's own body with the stamp field absent, so a solved stamp is
//! good for exactly one envelope: it cannot be carried to another recipient, re-pointed at
//! another kind, or lifted onto different evidence. There is no clock in it (No Clocks!), which
//! means a stamp does not expire - re-delivering the *same* envelope is free, which is correct,
//! because transcription is idempotent and a re-delivery costs the recipient nothing new.

use crate::ProtoError;

/// Domain separation for the challenge digest and for the search itself. Two contexts, not one:
/// the challenge is a value that gets carried around, and it must never be usable as a search
/// result for some other purpose in the system.
const CHALLENGE_DOMAIN: &str = "ringtome-v0/deliver-stamp-challenge";
const SEARCH_DOMAIN: &str = "ringtome-v0/deliver-stamp-search";

/// A stamp is exactly one big-endian u64 nonce. Fixed width on purpose: a variable-length stamp
/// would be a second thing to disagree about, and the search space of a u64 is not the binding
/// constraint on anything here.
pub const STAMP_LEN: usize = 8;

/// The default price, in leading zero bits of the search hash. Operators override it
/// (`RINGTOME_POW_REQUESTED_BITS` / `RINGTOME_POW_WILLING_BITS`); this is only the number a
/// node ships with, and it is a *default* rather than a floor or a ceiling.
///
/// **Calibrated, not guessed** (2026-08-10, M1 MacBook, `tests/pow_calibration.rs`): 19 bits
/// solves in **32ms release, 40ms debug**, mean of twelve, at roughly 16M candidate hashes per
/// second. Verification of the same stamp costs **0.28us** - about a hundred thousand to one,
/// which is the number that makes the dial safe to raise.
///
/// The two profiles landing within 20% of each other is not luck: blake3's hot loop is SIMD in
/// a dependency, so a debug build of this crate does not slow the search much. That is what
/// lets one constant serve dev, integration and release without a per-profile fudge.
///
/// Expressed in bits rather than milliseconds because bits are what both sides can agree on
/// without a shared clock or a shared benchmark. Faster silicon pays less; that asymmetry is
/// inherent to every proof-of-work and is why this number is not a defence (see the module
/// note).
///
/// `the_baseline_is_a_moment_not_a_minute` pins the work in the range this comment claims, so a
/// careless edit fails a test rather than quietly making every sender in the system pay a
/// minute.
pub const DEFAULT_BITS: u32 = 19;

// There is deliberately no protocol ceiling here (removed 2026-08-10, when the dial was cut).
// A ceiling was only ever needed to bound how far a *dynamic* price could climb, and there is
// no dynamic price: both numbers are operator config, fixed at boot. The sender's own
// `pow_willing_bits` is the entire answer to "how much will I pay", and it needs no help from
// the protocol to enforce it. A node demanding more than anyone will pay has not found a
// loophole - it has obliquely closed its own inbox, which an operator is allowed to do.

/// The challenge for one envelope: its body, stamped field removed.
///
/// Callers pass `Envelope::encode_body()` with `stamp: None` - see `deliver::Envelope::challenge`,
/// which is the only correct way to build this and exists so no caller has to remember.
pub fn challenge(body_without_stamp: &[u8]) -> [u8; 32] {
    blake3::derive_key(CHALLENGE_DOMAIN, body_without_stamp)
}

/// Count leading zero bits of a digest - the difficulty measure.
fn leading_zero_bits(digest: &[u8; 32]) -> u32 {
    let mut bits = 0;
    for byte in digest {
        bits += byte.leading_zeros();
        if *byte != 0 {
            break;
        }
    }
    bits
}

/// One candidate: does `nonce` clear `bits` against this challenge?
fn attempt(search_key: &[u8; 32], nonce: u64) -> [u8; 32] {
    *blake3::keyed_hash(search_key, &nonce.to_be_bytes()).as_bytes()
}

/// Search for a nonce clearing `bits`. Returns the stamp bytes to put on the envelope.
///
/// **Synchronous and CPU-bound by construction** - that is what it is for. Callers on an async
/// runtime must hand this to a blocking pool; `node::outbox` does, and a caller that forgets
/// will stall the reactor for the whole price.
///
/// Whether a price is worth paying is the caller's judgment, not this function's: `node::outbox`
/// checks its configured willingness before it ever gets here. The search itself has no opinion.
pub fn solve(challenge: &[u8; 32], bits: u32) -> Vec<u8> {
    let search_key = blake3::derive_key(SEARCH_DOMAIN, challenge);
    // Exhaustive from zero rather than random: the search is memoryless, every nonce is as good
    // as any other, and starting at zero makes `solve` a pure function of its inputs - which is
    // what lets the tests below assert on real solutions instead of mocking a solver.
    for nonce in 0u64..=u64::MAX {
        if leading_zero_bits(&attempt(&search_key, nonce)) >= bits {
            return nonce.to_be_bytes().to_vec();
        }
    }
    unreachable!("a 64-bit search space does not run out before a 32-bit difficulty is met")
}

/// Check a stamp. One hash, no allocation, no search - the defender's whole cost.
///
pub fn verify(challenge: &[u8; 32], stamp: &[u8], bits: u32) -> Result<(), ProtoError> {
    if bits == 0 {
        return Ok(()); // an operator who configures zero has turned the price off
    }
    let nonce: [u8; STAMP_LEN] = stamp
        .try_into()
        .map_err(|_| ProtoError::BadEntry("stamp is not one u64 nonce"))?;
    let search_key = blake3::derive_key(SEARCH_DOMAIN, challenge);
    if leading_zero_bits(&attempt(&search_key, u64::from_be_bytes(nonce))) < bits {
        return Err(ProtoError::BadEntry("stamp does not clear the required work"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_solved_stamp_verifies_and_a_neighbouring_one_does_not() {
        let c = challenge(b"an envelope body");
        let stamp = solve(&c, 12);
        assert!(verify(&c, &stamp, 12).is_ok());

        // The nonce next door is not a solution (with overwhelming probability at 12 bits).
        let mut wrong = u64::from_be_bytes(stamp.clone().try_into().unwrap());
        wrong = wrong.wrapping_add(1);
        assert!(verify(&c, &wrong.to_be_bytes(), 12).is_err());
    }

    /// The property the binding exists for: work done for one envelope is worthless for any
    /// other. If this ever passes, a flood solves once and stamps every envelope it sends.
    #[test]
    fn a_stamp_does_not_transfer_to_another_envelope() {
        let mine = challenge(b"body addressed to alice");
        let theirs = challenge(b"body addressed to bob");
        let stamp = solve(&mine, 12);
        assert!(verify(&mine, &stamp, 12).is_ok());
        assert!(
            verify(&theirs, &stamp, 12).is_err(),
            "a stamp must be worthless on any envelope but its own"
        );
    }

    #[test]
    fn zero_is_free_for_everyone() {
        let c = challenge(b"body");
        assert!(verify(&c, &[], 0).is_ok(), "an operator may turn the price off");
    }

    #[test]
    fn a_stamp_of_the_wrong_shape_is_rejected_not_padded() {
        let c = challenge(b"body");
        assert!(verify(&c, &[0u8; 4], 8).is_err());
        assert!(verify(&c, &[0u8; 16], 8).is_err());
    }

    /// The calibration cop. Not a timing assertion - those flake on shared runners - but a
    /// bound on the *work*, which is what the milliseconds in `DEFAULT_BITS`' comment are
    /// derived from. If someone edits the constant to 30, this fails immediately instead of
    /// every sender in the system quietly starting to pay minutes.
    #[test]
    fn the_default_is_a_moment_not_a_minute() {
        assert!(
            (16..=20).contains(&DEFAULT_BITS),
            "the default is meant to be a perceptible blink, not a wait: 2^{DEFAULT_BITS} \
             expected hashes is outside the 10-50ms band this constant was calibrated for \
             (19 bits = 32ms release / 40ms debug on an M1; each bit doubles it)"
        );
    }

    /// Difficulty has to actually mean something monotone, or a dial is decoration: a stamp
    /// solved for a low price must not satisfy a high one.
    #[test]
    fn a_cheaper_stamp_does_not_satisfy_a_dearer_price() {
        let c = challenge(b"body");
        let cheap = solve(&c, 4);
        // 4 bits is one in sixteen, so this occasionally clears 8 by luck; walk up until it
        // genuinely does not, which is the assertion we mean.
        let mut price = 8;
        while verify(&c, &cheap, price).is_ok() && price < 24 {
            price += 4;
        }
        assert!(
            verify(&c, &cheap, price).is_err(),
            "work is monotone: a cheap solution cannot buy an expensive price"
        );
    }
}
