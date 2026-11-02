# PDQ reference pictures

Three of Meta's PDQ regression pictures, unchanged, from
[ThreatExchange](https://github.com/facebook/ThreatExchange) (BSD license),
`pdq/data/reg-test-input/dih/`. `src/media/pdq.rs` checks its hashes of them
against the C++ reference's (`pdq/cpp/reg_test/expected/out`).

`bridge-1-resized-900.jpg` is ours: `bridge-1-original.jpg` scaled to 900 pixels
on its long side and re-saved at JPEG quality 60 (macOS `sips`), for the claim
that a re-encoded copy is still refused.
