//! Semver parsing for versioned static-asset URLs.
//!
//! When serving JS and CSS we only serve versions ≤ the running app version. This prevents a
//! CDN from accidentally caching a *future* version's assets under a stale URL if, say, a
//! malicious request tries `/static/99.99.99/app.js`. Older versions are fine: a deploy bumps
//! the version in the HTML template, so stale clients will stop requesting them naturally.

use anyhow::Result;

/// Convert a `"major.minor.patch"` string into a single comparable integer.
pub fn semver_to_comparable_integer(version: &str) -> Result<u128> {
    let mut parts = version.split('.').map(|p| p.parse::<u128>());

    let major = parts.next();
    let minor = parts.next();
    let patch = parts.next();

    match (major, minor, patch) {
        (Some(Ok(major)), Some(Ok(minor)), Some(Ok(patch))) => {
            Ok(major << 64 | minor << 32 | patch)
        }
        _ => Err(anyhow::anyhow!("invalid version string")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordering() {
        assert!(
            semver_to_comparable_integer("1.3.2").unwrap()
                > semver_to_comparable_integer("1.2.100").unwrap()
        );
        assert!(
            semver_to_comparable_integer("2.0.0").unwrap()
                > semver_to_comparable_integer("1.1000.10000").unwrap()
        );
    }

    #[test]
    fn round_trips() {
        assert_eq!(semver_to_comparable_integer("0.0.1").unwrap(), 1);
    }
}
