/*
    HorseBucks' ledger (bank.rs, HORSE_BASED_CURRENCIES.md, slice 1; Curtis 2026-09-29). Every
    earning is a line keyed by what earned it, in horsepennies (a hundredth of a HorseBuck), and
    what's paid is what's NEW: a note's second version pays only for the words it added, so a
    paragraph pasted again pays for its seam and nothing else. Asking twice pays nothing twice.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch, makePng } = require("./helpers.cjs");

const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

describe("HorseBucks: the ledger", function () {
    this.timeout(120000);

    let ada, root;
    const bank = async () => (await ada(`api/identity/${root}/bank`)).json();
    const paid = (b, kind) => b.lines.filter((l) => l.kind === kind).map((l) => Number(l.pennies));

    before(async () => {
        ada = await makeUserFetch({ prefix: "bankada" });
        root = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        for (let i = 0; i < 50; i++) {
            const fields = await (await ada(`api/identity/${root}/profile`)).json();
            if (fields.some((f) => f.field === "heartbeat")) break;
            await wait(100);
        }
    });

    it("pays for what's new, keyed by what earned it, in horsepennies - and never twice", async () => {
        // 150 distinct words: 148 three-word shingles, 25 horsepennies each.
        const words = Array.from({ length: 150 }, (_, i) => `w${i + 1}`);
        const first = words.join(" ");
        const made = await (await j(ada, `api/identity/${root}/docs`, { title: "a long note", body: first, format: "marquee" })).json();
        // The second version pastes the first fifty words again: only the seam is new.
        const got = await (await ada(`api/identity/${root}/docs/${made.doc_id}`)).json();
        const saved = await j(ada, `api/identity/${root}/docs/${made.doc_id}`, { title: "a long note", body: `${first} ${words.slice(0, 50).join(" ")}`, parents: got.heads.map((h) => h.version), format: "marquee" }, "PUT");
        assert.equal(saved.status, 200, await saved.text());
        // A picture, uploaded.
        const pic = await (await ada(`api/identity/${root}/docs/binary?title=a horse`, { method: "POST", body: makePng(16, 16), file: true })).json();
        for (let i = 0; i < 60; i++) {
            if ((await ada(`api/identity/${root}/docs/${pic.doc_id}/body`)).status === 200) break;
            await wait(250);
        }
        // Published: the words pay again (150 shingles in the published text), plus the size bonus.
        const pub = await j(ada, `api/identity/${root}/docs/${made.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.text());

        const b = await bank();
        assert.deepEqual(paid(b, "words").sort((x, y) => x - y), [50, 3700], "148 shingles, then only the paste's two-shingle seam");
        assert.deepEqual(paid(b, "image"), [1000], "10 H$ for the upload");
        assert.deepEqual(paid(b, "heartbeat"), [1000], "10 H$ for today");
        // 150 shingles x 25 = 3,750, plus a bonus of floor((150 - 100)^2 / 200) = 12 H$.
        assert.deepEqual(paid(b, "publication"), [3750 + 1200], "the words again, plus the size bonus");
        assert.equal(b.balance, String(3700 + 50 + 1000 + 1000 + 4950), "the balance is the lines' sum, exactly");
        const pubLine = b.lines.find((l) => l.kind === "publication");
        assert.equal(pubLine.detail.title, "a long note", "each line says what it was for");

        // By the month (2026-09-29): every month's total, which sum to the balance, and the newest
        // month's lines by default.
        assert.ok(b.months.length >= 1 && b.month === b.months[0].month, "the newest month is the one sent");
        assert.equal(b.months.reduce((sum, m) => sum + Number(m.pennies), 0), Number(b.balance), "the months sum to the balance");
        const same = await (await ada(`api/identity/${root}/bank?month=${b.month}`)).json();
        assert.equal(same.lines.length, b.lines.length, "a month asked for by name");

        const again = await bank();
        assert.equal(again.balance, b.balance, "asking again pays nothing twice");
    });
});
