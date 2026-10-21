//! Randomness, from one place (2026-10-21, the RustCrypto upgrade). rand 0.10 made the operating
//! system's generator fallible (`SysRng`, a `TryRng`) and every key and nonce we make wants an
//! infallible `CryptoRng`. `OsRng` here is the bridge, under the name the call sites always used:
//! the OS generator, and a node that can't read the OS's entropy stops rather than make a key
//! from nothing.

use rand::rand_core::{Infallible, TryCryptoRng, TryRng};
use rand::rngs::SysRng;

/// The operating system's cryptographic generator, infallible: an entropy failure panics.
#[derive(Clone, Copy, Debug, Default)]
pub struct OsRng;

impl TryRng for OsRng {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        Ok(SysRng.try_next_u32().expect("the operating system's entropy"))
    }

    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        Ok(SysRng.try_next_u64().expect("the operating system's entropy"))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        SysRng.try_fill_bytes(dst).expect("the operating system's entropy");
        Ok(())
    }
}

impl TryCryptoRng for OsRng {}
