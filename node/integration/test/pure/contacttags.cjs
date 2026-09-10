const assert = require("node:assert");

let m;
before(async () => {
    m = await import("../../../js/pure/contacttags.js");
});

describe("contact tags: private labels on the people you know (2026-09-10)", () => {
    it("a tag is a key: lowercased, collapsed, capped, once", () => {
        assert.equal(m.normaliseTag("  Trade   Show "), "trade show");
        assert.equal(m.normaliseTag("x".repeat(40)).length, m.TAG_MAX);
        assert.equal(m.normaliseTag("   "), "");
        let tags = [];
        tags = m.withTag(tags, "Family");
        tags = m.withTag(tags, "family ");
        tags = m.withTag(tags, "");
        tags = m.withTag(tags, "trade-show");
        assert.deepEqual(tags, ["family", "trade-show"]);
        assert.deepEqual(m.withoutTag(tags, "FAMILY"), ["trade-show"]);
        assert.equal(m.serialiseTags(tags), '["family","trade-show"]');
        assert.equal(m.serialiseTags([]), "", "clearing writes the empty string");
    });
    it("reads the register back, tolerating junk", () => {
        assert.deepEqual(m.contactTags({ tags: '["Family","family","", 7, "trade-show"]' }), ["family", "trade-show"]);
        assert.deepEqual(m.contactTags({ tags: "not json" }), []);
        assert.deepEqual(m.contactTags({ tags: '{"a":1}' }), []);
        assert.deepEqual(m.contactTags({}), []);
        assert.deepEqual(m.contactTags(null), []);
    });
    it("counts across the roster and filters by every picked tag", () => {
        const rows = [
            { root: "a", facts: { tags: '["family","bikes"]' } },
            { root: "b", facts: { tags: '["family"]' } },
            { root: "c", facts: { tags: '["bikes","trade-show"]' } },
            { root: "d", facts: {} },
        ];
        assert.deepEqual(m.tagCounts(rows), [
            { value: "bikes", count: 2 },
            { value: "family", count: 2 },
            { value: "trade-show", count: 1 },
        ]);
        assert.deepEqual(m.rowsTagged(rows, []).map((r) => r.root), ["a", "b", "c", "d"]);
        assert.deepEqual(m.rowsTagged(rows, ["family"]).map((r) => r.root), ["a", "b"]);
        assert.deepEqual(m.rowsTagged(rows, ["family", "bikes"]).map((r) => r.root), ["a"]);
        assert.deepEqual(m.rowsTagged(rows, ["nobody"]), []);
    });
});
