/*
    The feed-selectivity slider's brain (PROJECT_PLAN: one slider, two budgets): six stops,
    and per row one EFFECTIVE interest with a defined provenance precedence - the reader's
    explicit dial on the AUTHOR; else their rebroadcast dial on the SHARER; else the derived
    path score; else the floor pool that admitted it. The precedence doubles as "why am I
    seeing this?", which unasked-for content owes at every stop.
*/
const assert = require("node:assert");

let SELECTIVITY_STOPS, DEFAULT_STOP, effectiveInterest, visibleAt;
before(async () => {
    ({ SELECTIVITY_STOPS, DEFAULT_STOP, effectiveInterest, visibleAt } = await import(
        "../../../js/pure/selectivity.js"
    ));
});

describe("feed selectivity", () => {
    const real = { author: "a".repeat(64) };
    const shared = { author: "a".repeat(64), via: "b".repeat(64) };
    const suggested = { author: "a".repeat(64), suggested_via: "c".repeat(64), suggested_level: "high" };
    const suggestedWeak = { author: "a".repeat(64), suggested_via: "c".repeat(64), suggested_level: "low" };
    const facts = (root, f) => ({ [root]: f });

    it("carries the six stops, widest first, Explorer the default", () => {
        assert.deepEqual(
            SELECTIVITY_STOPS.map((s) => s.key),
            ["explorer", "highly-speculative", "speculative", "interest", "medium", "high"]
        );
        assert.equal(DEFAULT_STOP, "explorer");
    });

    it("precedence: the author dial leads, the sharer dial follows, the path score trails", () => {
        const authorDial = effectiveInterest(shared, facts(shared.author, { interest: "medium" }));
        assert.deepEqual(authorDial, { kind: "author-dial", band: "medium" });
        const sharerDial = effectiveInterest(shared, facts(shared.via, { interest_rebroadcasts: "high" }));
        assert.deepEqual(sharerDial, { kind: "sharer-dial", band: "high" });
        const path = effectiveInterest(suggested, {});
        assert.deepEqual(path, { kind: "path", band: "high" });
        assert.deepEqual(effectiveInterest(real, {}), { kind: "floor", band: null });
    });

    it("an unset dial is no opinion, never a low one", () => {
        // Silence and 'none' stay distinct (the 2026-08-08 lesson, pure/feed.js): a sharer
        // dial of undefined falls through to the path/floor, a 'none' is an opinion.
        const eff = effectiveInterest(shared, facts(shared.author, {}));
        assert.equal(eff.kind, "floor");
    });

    it("the strict stops want explicit dials at height", () => {
        const high = facts(real.author, { interest: "high" });
        const medium = facts(real.author, { interest: "medium" });
        assert.ok(visibleAt("high", real, high));
        assert.ok(!visibleAt("high", real, medium));
        assert.ok(visibleAt("medium", real, medium));
        assert.ok(!visibleAt("medium", real, {}));
        // The sharer dial counts as explicit at the strict stops too.
        assert.ok(visibleAt("high", shared, facts(shared.via, { interest_rebroadcasts: "high" })));
    });

    it("'interest only' is every real row and no suggested one", () => {
        assert.ok(visibleAt("interest", real, {}));
        assert.ok(visibleAt("interest", shared, {}));
        assert.ok(!visibleAt("interest", suggested, {}));
    });

    it("the speculative stops admit by path strength, Explorer admits everything", () => {
        assert.ok(visibleAt("speculative", suggested, {}), "a strong path clears 'speculative'");
        assert.ok(!visibleAt("speculative", suggestedWeak, {}), "a weak path waits");
        assert.ok(visibleAt("highly-speculative", suggestedWeak, {}));
        assert.ok(visibleAt("explorer", suggestedWeak, {}));
        assert.ok(visibleAt("speculative", real, {}), "wider stops keep every narrower row");
    });

    it("a real dial on a suggested row's author outranks its path everywhere", () => {
        // Promotion, seen from the read side: the dial converts the row's standing at
        // every stop the moment it exists, however the row was journaled.
        const dialed = facts(suggested.author, { interest: "high" });
        assert.deepEqual(effectiveInterest(suggested, dialed), { kind: "author-dial", band: "high" });
        assert.ok(visibleAt("high", suggested, dialed));
    });
});
