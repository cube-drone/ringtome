/*
    Versioned documents (the notes app): create, save, list, read over HTTP.

    The load-bearing behaviors: fast-forward saves keep one head; two saves sharing a parent are
    DETECTED divergence with both versions kept and readable (never-lose-words - a stale tab must
    not destroy an afternoon); and neither titles nor bodies ever appear as plaintext in the
    stored entry log (headers are epoch-encrypted; bodies live in the file layer, not the chain).
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");

const NOTES_SERVICE = 6;

async function createDoc(fetch, root, title, body) {
    const res = await fetch(`api/identity/${root}/docs`, {
        method: "POST",
        body: JSON.stringify({ title, body }),
    });
    assert.equal(res.status, 200);
    return res.json();
}

async function saveDoc(fetch, root, docId, title, body, parents) {
    const res = await fetch(`api/identity/${root}/docs/${docId}`, {
        method: "PUT",
        body: JSON.stringify({ title, body, parents }),
    });
    assert.equal(res.status, 200);
    return res.json();
}

async function listDocs(fetch, root) {
    return (await fetch(`api/identity/${root}/docs`)).json();
}

async function getDoc(fetch, root, docId) {
    return (await fetch(`api/identity/${root}/docs/${docId}`)).json();
}

describe("versioned documents (notes)", function () {
    this.timeout(30000);

    it("creates, fast-forwards, lists, and reads a note", async function () {
        const user = await makeUserFetch({ prefix: "docs" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const doc = await createDoc(user, root, "groceries", "eggs");
        const v2 = await saveDoc(user, root, doc.doc_id, "groceries", "eggs, milk", [doc.version]);

        const list = await listDocs(user, root);
        assert.equal(list.docs.length, 1);
        assert.equal(list.docs[0].title, "groceries");
        assert.equal(list.docs[0].head, v2.version, "the fast-forward is the single head");
        assert.equal(list.docs[0].diverged, false);
        assert.equal(list.undecryptable, 0);

        const detail = await getDoc(user, root, doc.doc_id);
        assert.equal(detail.diverged, false);
        assert.equal(detail.heads.length, 1);
        assert.equal(detail.heads[0].body, "eggs, milk");
    });

    it("detects the stale tab: divergence keeps both versions readable", async function () {
        const user = await makeUserFetch({ prefix: "docsfork" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const doc = await createDoc(user, root, "draft", "start");
        // The PC afternoon, then the stale phone tab - both edited from the same version.
        const pc = await saveDoc(
            user, root, doc.doc_id, "draft", "start, then a whole afternoon", [doc.version]
        );
        const phone = await saveDoc(user, root, doc.doc_id, "draft", "start!", [doc.version]);

        const list = await listDocs(user, root);
        assert.equal(list.docs[0].diverged, true, "two saves sharing a parent must be detected");
        assert.equal(list.docs[0].heads, 2);

        const detail = await getDoc(user, root, doc.doc_id);
        assert.equal(detail.heads.length, 2, "both siblings survive as heads");
        const bodies = detail.heads.map((h) => h.body).sort();
        assert.deepEqual(
            bodies,
            ["start!", "start, then a whole afternoon"],
            "never-lose: both bodies remain readable"
        );
        const versions = detail.heads.map((h) => h.version).sort();
        assert.deepEqual(versions, [pc.version, phone.version].sort());
    });

    it("stores neither titles nor bodies as plaintext in the entry log", async function () {
        const user = await makeUserFetch({ prefix: "docscipher" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const secretTitle = "the secret plan";
        const secretBody = "operation hat convention is GO";
        await createDoc(user, root, secretTitle, secretBody);

        const entries = await (await user(`api/identity/${root}/entries`)).json();
        const noteEntries = entries.filter((e) => e.service === NOTES_SERVICE);
        assert.ok(noteEntries.length >= 1, "the doc header landed on the notes chain");

        for (const secret of [secretTitle, secretBody]) {
            const hex = Buffer.from(secret, "utf8").toString("hex");
            for (const e of entries) {
                assert.ok(
                    !e.bytes_hex.includes(hex),
                    "plaintext must never appear in stored entry bytes"
                );
            }
        }
    });
});
