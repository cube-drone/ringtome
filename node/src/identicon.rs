//! The root-derived identicon, Rust half - twin of `js/pure/identicon.js`, held to the same
//! goldens. The anonymous face draws this for a persona with no picture of their own; the
//! console draws the identical SVG from the identical bytes, because an identicon that
//! differs between two views of one persona cannot do the job canon gives it (PROJECT_PLAN,
//! Naming: "the name may collide; the image will not").
//!
//! No hash and no image crate: a root pubkey is already 32 uniformly-random bytes, and a
//! crate's PNG could never be reproduced bit-for-bit in a browser.

/// The persona's hue - the same number `pure/person.js` derives, and the same one the
/// hexagon's ring wears.
pub fn hue(root: &[u8; 32]) -> u32 {
    (u32::from(root[0]) * 65536 + u32::from(root[1]) * 256 + u32::from(root[2])) % 360
}

/// The identicon as an SVG string: a 5x5 grid mirrored left-to-right, three tones from the
/// persona's own hue. `viewBox`-scaled, so one string serves every size.
pub fn identicon_svg(root: &[u8; 32]) -> String {
    let h = hue(root);
    let ink = format!("hsl({h}, 62%, 42%)");
    let accent = format!("hsl({}, 68%, 58%)", (h + 42) % 360);
    let ground = format!("hsl({h}, 34%, 92%)");

    let mut cells = String::new();
    // The first fifteen bytes are the fifteen drawn cells (3 columns x 5 rows); the other
    // two columns mirror them.
    for (i, &b) in root.iter().take(15).enumerate() {
        // A different bit per cell (see the JS twin): a patterned key must not draw the same
        // answer fifteen times.
        if (b >> (i % 7)) & 1 == 0 {
            continue;
        }
        let col = i / 5;
        let row = i % 5;
        let fill = if (b >> ((i + 3) % 7)) & 1 == 1 { &accent } else { &ink };
        cells.push_str(&format!(
            r#"<rect x="{col}" y="{row}" width="1" height="1" fill="{fill}"/>"#
        ));
        if col < 2 {
            cells.push_str(&format!(
                r#"<rect x="{}" y="{row}" width="1" height="1" fill="{fill}"/>"#,
                4 - col
            ));
        }
    }
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges"><rect width="5" height="5" fill="{ground}"/>{cells}</svg>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cross-language goldens - identical strings pinned in
    /// integration/test/pure/identicon.cjs. Drift on either side fails before a persona
    /// shows two different faces.
    const GOLDENS: [(&str, &str); 2] = [
        (
            "93ad0ddd9dd2022bf2ac21664b386965e0eeffecaff6e49b71039db5f1cf53f3",
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges"><rect width="5" height="5" fill="hsl(213, 34%, 92%)"/><rect x="0" y="0" width="1" height="1" fill="hsl(213, 62%, 42%)"/><rect x="4" y="0" width="1" height="1" fill="hsl(213, 62%, 42%)"/><rect x="0" y="2" width="1" height="1" fill="hsl(213, 62%, 42%)"/><rect x="4" y="2" width="1" height="1" fill="hsl(213, 62%, 42%)"/><rect x="0" y="3" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="4" y="3" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="0" y="4" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="4" y="4" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="1" y="2" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="3" y="2" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="1" y="3" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="3" y="3" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="1" y="4" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="3" y="4" width="1" height="1" fill="hsl(255, 68%, 58%)"/><rect x="2" y="4" width="1" height="1" fill="hsl(255, 68%, 58%)"/></svg>"##,
        ),
        (
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges"><rect width="5" height="5" fill="hsl(330, 34%, 92%)"/><rect x="0" y="1" width="1" height="1" fill="hsl(330, 62%, 42%)"/><rect x="4" y="1" width="1" height="1" fill="hsl(330, 62%, 42%)"/><rect x="0" y="3" width="1" height="1" fill="hsl(330, 62%, 42%)"/><rect x="4" y="3" width="1" height="1" fill="hsl(330, 62%, 42%)"/><rect x="1" y="0" width="1" height="1" fill="hsl(12, 68%, 58%)"/><rect x="3" y="0" width="1" height="1" fill="hsl(12, 68%, 58%)"/><rect x="1" y="3" width="1" height="1" fill="hsl(330, 62%, 42%)"/><rect x="3" y="3" width="1" height="1" fill="hsl(330, 62%, 42%)"/><rect x="2" y="0" width="1" height="1" fill="hsl(330, 62%, 42%)"/><rect x="2" y="2" width="1" height="1" fill="hsl(12, 68%, 58%)"/></svg>"##,
        )
    ];

    fn root(hex: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn draws_the_goldens_exactly() {
        for (hex, svg) in GOLDENS {
            assert_eq!(identicon_svg(&root(hex)), svg, "identicon for {hex}");
        }
    }

    #[test]
    fn different_keys_draw_different_pictures() {
        assert_ne!(
            identicon_svg(&root(GOLDENS[0].0)),
            identicon_svg(&root(GOLDENS[1].0))
        );
    }
}
