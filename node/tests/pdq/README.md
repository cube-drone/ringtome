# PDQ reference pictures

Three of Meta's PDQ regression pictures, unchanged, from
[ThreatExchange](https://github.com/facebook/ThreatExchange) (BSD license),
`pdq/data/reg-test-input/dih/`. `src/media/pdq.rs` checks its hashes of them
against the C++ reference's (`pdq/cpp/reg_test/expected/out`).

`bridge-1-resized-900.jpg` is ours: `bridge-1-original.jpg` scaled to 900 pixels
on its long side and re-saved at JPEG quality 60 (macOS `sips`), for the claim
that a re-encoded copy is still refused.

`bridge-5-flipx-resized-900.jpg` is ours too: `bridge-1-resized-900.jpg` flipped
top to bottom (`sips -f vertical`; Meta's "flipx" is a flip about the x axis),
so a scaled, re-saved copy of `bridge-5-flipx.jpg` - for the picture entries'
claims, which can't use the original that the quarantine claims seal.
