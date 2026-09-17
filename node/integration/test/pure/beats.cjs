const assert = require("node:assert");

let m;
before(async () => {
    m = await import("../../../js/pure/beats.js");
});

describe("internet time: the day in a thousand beats (2026-09-17)", () => {
    it("counts from Biel midnight, the same everywhere", () => {
        // 2026-09-17T23:00:00Z is Biel midnight.
        const bielMidnight = Date.UTC(2026, 8, 17, 23, 0, 0);
        assert.equal(m.beats(bielMidnight), "@000");
        assert.equal(m.beats(bielMidnight + 86_400_000 / 2), "@500", "Biel noon");
        assert.equal(m.beats(bielMidnight - 1), "@999", "the last beat of the day before");
        assert.equal(m.beats(Date.UTC(2026, 8, 17, 12, 0, 0)), "@541", "noon UTC is 13:00 in Biel");
    });
    it("pads to three digits and survives the epoch's early days", () => {
        assert.equal(m.beats(0), "@041", "1970-01-01 00:00 UTC is 01:00 in Biel");
        assert.equal(m.beatOf(0), 41);
    });
});
