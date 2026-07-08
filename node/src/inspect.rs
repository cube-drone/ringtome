//! `ringtome inspect <hex-or-file>` - pretty-print a decoded entry.
//!
//! The wire format is binary by design; this is the promised debug tool that recovers human
//! readability exactly where a human wants it. Accepts a hex string on the command line, or a
//! path to a file containing hex text or raw envelope bytes.

use anyhow::{bail, Context, Result};
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Authorize, Payload, ProfileSet, Revoke, SignedEntry};

pub fn run(arg: &str) -> Result<()> {
    let bytes = load_bytes(arg)?;
    let signed = SignedEntry::decode(&bytes)
        .map_err(|e| anyhow::anyhow!("not a valid ringtome entry: {e}"))?;
    let e = signed.entry();

    println!("ringtome entry (v{}, {} bytes)", e.v, signed.bytes().len());
    println!(
        "  type:      {} ({})",
        e.entry_type,
        entry_type::name(e.entry_type)
    );
    println!("  author:    {}", hex::encode(e.chain.author));
    println!(
        "  service:   {} ({})",
        e.chain.service,
        service::name(e.chain.service)
    );
    println!("  seq:       {}", e.seq);
    println!("  prev_hash: {}", hex::encode(e.prev_hash));
    println!(
        "  timestamp: {} (claimed ms since epoch; advisory)",
        e.timestamp_ms
    );
    match &e.payload {
        Payload::Inline(b) => {
            println!("  payload:   inline ({} bytes)", b.len());
            match e.entry_type {
                entry_type::PROFILE_SET => match ProfileSet::decode(b) {
                    Ok(ps) => println!("             profile-set {:?} = {:?}", ps.field, ps.value),
                    Err(err) => {
                        println!("             (profile-set payload fails to decode: {err})")
                    }
                },
                entry_type::AUTHORIZE => match Authorize::decode(b) {
                    Ok(authorization) => {
                        println!(
                            "             authorize child {}",
                            hex::encode(authorization.child)
                        );
                        for (i, u) in authorization.usurpers.iter().enumerate() {
                            println!("             usurper[{i}]  {}", hex::encode(u));
                        }
                    }
                    Err(err) => println!("             (authorize payload fails to decode: {err})"),
                },
                entry_type::REVOKE => match Revoke::decode(b) {
                    Ok(revocation) => {
                        println!(
                            "             revoke {} ({:?})",
                            hex::encode(revocation.target),
                            revocation.disposition
                        );
                        for a in &revocation.anchors {
                            println!(
                                "             anchor     {} seq {} head {}",
                                service::name(a.service),
                                a.seq,
                                hex::encode(a.head_hash)
                            );
                        }
                    }
                    Err(err) => println!("             (revoke payload fails to decode: {err})"),
                },
                _ => {}
            }
        }
        Payload::Blob(h) => println!("  payload:   blob {}", hex::encode(h)),
    }
    println!("  hash:      {}", hex::encode(signed.hash()));
    match signed.verify() {
        Ok(()) => println!("  signature: VALID"),
        Err(err) => println!("  signature: INVALID - {err}"),
    }
    Ok(())
}

/// Interpret the argument as hex, a file of hex text, or a file of raw bytes - in that order of
/// preference.
fn load_bytes(arg: &str) -> Result<Vec<u8>> {
    let raw: Vec<u8> = if std::path::Path::new(arg).exists() {
        std::fs::read(arg).with_context(|| format!("reading {arg}"))?
    } else {
        arg.as_bytes().to_vec()
    };

    let text = String::from_utf8_lossy(&raw);
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if !compact.is_empty()
        && compact.len().is_multiple_of(2)
        && compact.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Ok(hex::decode(&compact).expect("checked hex"));
    }

    if std::path::Path::new(arg).exists() {
        Ok(raw) // raw binary file
    } else {
        bail!("argument is neither valid hex nor an existing file");
    }
}
