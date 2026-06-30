use anyhow::Result;

/*
    When we're serving JS and CSS files, we want to serve only files that are less than or equal to the current app version.
    (Because files could be cached forever, it's fine to serve older versions: there might be a version in cache but since
     we bump the version on every deploy, we won't ask for them any more after an update anyways. On the other hand,
     if we were ever to forever-cache the current version as a future version (maybe a malicious user could trigger this?)
     then we wouldn't be able to update cached files until the cache expires, which could be a long time)

    Anyways, in order to _compare_ versions, we convert them to a comparable integer.
*/

pub fn semver_to_comparable_integer(version: &str) -> Result<u128> {
    let mut version_parts = version.split('.').map(|part| part.parse::<u128>());

    let major = version_parts.next();
    let minor = version_parts.next();
    let patch = version_parts.next();

    match (major, minor, patch) {
        (Some(Ok(major)), Some(Ok(minor)), Some(Ok(patch))) => {
            Ok(major << 64 | minor << 32 | patch)
        }
        _ => Err(anyhow::anyhow!("400 Invalid version")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_semver_to_comparable_integer() {
        assert_eq!(semver_to_comparable_integer("0.0.1").unwrap(), 1);
        assert_eq!(semver_to_comparable_integer("0.1.0").unwrap(), 4294967296);
        assert_eq!(semver_to_comparable_integer("1.0.0").unwrap(), 18446744073709551616);
        assert_eq!(semver_to_comparable_integer("1.2.100").unwrap(), 18446744082299486308);
        assert_eq!(semver_to_comparable_integer("1.2.3").unwrap(), 18446744082299486211);
        assert!(semver_to_comparable_integer("1.3.2").unwrap() > semver_to_comparable_integer("1.2.100").unwrap());
        assert!(semver_to_comparable_integer("2.2.3").unwrap() > semver_to_comparable_integer("1.1000.10000").unwrap());
    }
}