/*
    The embed cap's client half: counting mirrors the server's classification, and the
    paste-rescue surgery turns an unsaveable body into a saveable one - or leaves it alone
    for the server to refuse, never mangles it.
*/
const assert = require("node:assert");

const ROOT = "a".repeat(64);
const doc = (n) => n.toString(16).padStart(32, "0");
const embed = (n, name = "pic") =>
    `![${name}](/api/identity/${ROOT}/docs/${doc(n)}/body/${name}.avif)`;

let embedcap, parse;
before(async () => {
    embedcap = await import("../../../js/pure/embedcap.js");
    // The REAL grammar, from the UI's own node_modules (this suite installs no copy of its
    // own, deliberately - a second parser version here could pass what the editor fails).
    ({ parse } = await import("../../../js/node_modules/@cube-drone/marquee-parser/dist/index.js"));
});

describe("counting what a body embeds", () => {
    it("counts distinct own documents - repetition is one, a URL is none", () => {
        const body = [
            embed(1),
            embed(1, "again"), // same doc, different alt: one obligation
            embed(2),
            "![web](https://example.com/pic.png)",
            `![theirs](/api/identity/${"b".repeat(64)}/docs/${doc(9)}/body/x.avif)`,
        ].join("\n\n");
        const { over, distinct } = embedcap.overCapTargets(parse(body), ROOT, 50);
        assert.equal(distinct, 2, "two own documents; the stranger's and the web's count zero");
        assert.equal(over.size, 0);
    });

    it("marks everything past the cap, keeping the FIRST arrivals", () => {
        const body = [embed(1), embed(2), embed(3)].join("\n\n");
        const { over, distinct } = embedcap.overCapTargets(parse(body), ROOT, 2);
        assert.equal(distinct, 3);
        assert.deepEqual(
            [...over],
            [`/api/identity/${ROOT}/docs/${doc(3)}/body/pic.avif`],
            "the third document is the one over a cap of two - order of appearance decides"
        );
    });
});

describe("the paste rescue", () => {
    const note = (alt) => `(“${alt}” removed - one page holds 50 embedded files)`;

    it("replaces every embed of an over-cap document, alt preserved, and the result parses clean", () => {
        const body = [embed(1), embed(2), embed(3, "sunset"), embed(3, "sunset-again")].join("\n\n");
        const { over } = embedcap.overCapTargets(parse(body), ROOT, 2);
        const { source, replaced } = embedcap.replaceTargets(body, over, note);
        assert.equal(replaced, 2, "both occurrences of the over-cap document");
        assert.ok(source.includes("(“sunset” removed"), "the refusal text carries the alt");
        assert.ok(!source.includes(doc(3)), "the over-cap target is gone");
        assert.ok(source.includes(doc(1)) && source.includes(doc(2)), "the first two stand");

        // The whole point: the rewritten body is under cap - saveable.
        const after = embedcap.overCapTargets(parse(source), ROOT, 2);
        assert.equal(after.over.size, 0);
        assert.equal(after.distinct, 2);
    });

    it("declines surgery it cannot do confidently, rather than mangling", () => {
        // The target appears with no `![` opener anywhere before it - nothing to cut.
        const target = `/api/identity/${ROOT}/docs/${doc(7)}/body/x.avif`;
        const body = `just a bare mention: ](${target}) with no opener`;
        const { source, replaced } = embedcap.replaceTargets(body, new Set([target]), note);
        assert.equal(replaced, 0);
        assert.equal(source, body, "untouched - the server's refusal is the backstop");
    });

    it("does not cut across paragraphs when an opener is far away", () => {
        const target = `/api/identity/${ROOT}/docs/${doc(8)}/body/x.avif`;
        const body = `![orphan opener\n\nsome words\n\nmore: ](${target})`;
        const { replaced } = embedcap.replaceTargets(body, new Set([target]), note);
        assert.equal(replaced, 0, "a candidate spanning a blank line is suspicious - skipped");
    });
});
