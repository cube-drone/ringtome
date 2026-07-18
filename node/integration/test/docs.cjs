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

const { HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const DOCUMENTS_PRIVATE_SERVICE = 6;

async function createDoc(fetch, root, title, body, format) {
    const res = await fetch(`api/identity/${root}/docs`, {
        method: "POST",
        body: JSON.stringify({ title, body, format }),
    });
    assert.equal(res.status, 200);
    return res.json();
}

async function saveDoc(fetch, root, docId, title, body, parents, format) {
    const res = await fetch(`api/identity/${root}/docs/${docId}`, {
        method: "PUT",
        body: JSON.stringify({ title, body, parents, format }),
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
        assert.equal(detail.resolution, "single");
        assert.equal(detail.body, "eggs, milk");
        assert.equal(detail.title, "groceries");
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

        // The healing contract: the next save lists every DAG head as a parent.
        assert.deepEqual(detail.save_parents.sort(), [pc.version, phone.version].sort());

        // The conflict is presented IN the document: both sides' words inline, marked and
        // labeled - the editor is the merge tool, there is no merge UI.
        assert.equal(detail.resolution, "conflict");
        assert.ok(detail.body.includes("start!"), "phone words inline");
        assert.ok(detail.body.includes("whole afternoon"), "PC words inline");
        assert.ok(detail.body.includes("<<<<<<<"), "markers present");
    });

    it("dispatches conflict format on the document's type", async function () {
        const user = await makeUserFetch({ prefix: "docsfmt" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const doc = await createDoc(user, root, "page", "the hat is *red*", "marquee");
        await saveDoc(user, root, doc.doc_id, "page", "the hat is *blue*", [doc.version], "marquee");
        await saveDoc(user, root, doc.doc_id, "page", "the hat is *green*", [doc.version], "marquee");

        const list = await listDocs(user, root);
        assert.equal(list.docs[0].format, "marquee");

        const detail = await getDoc(user, root, doc.doc_id);
        assert.equal(detail.format, "marquee");
        assert.equal(detail.resolution, "conflict");
        assert.ok(detail.body.includes(":::conflict"), "marquee vocabulary, not markers");
        assert.ok(!detail.body.includes("<<<<<<<"), "no git markers");
        assert.ok(detail.body.includes("*blue*") && detail.body.includes("*green*"));
    });

    it("stores neither titles nor bodies as plaintext in the entry log", async function () {
        const user = await makeUserFetch({ prefix: "docscipher" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const secretTitle = "the secret plan";
        const secretBody = "operation hat convention is GO";
        await createDoc(user, root, secretTitle, secretBody);

        const entries = await (await user(`api/identity/${root}/entries`)).json();
        const noteEntries = entries.filter((e) => e.service === DOCUMENTS_PRIVATE_SERVICE);
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

// The loop the whole design exists for: write on the laptop, read on the Pi. Headers ride
// entry sync; bodies ride iroh-blobs, fetched by the initiator after each exchange.
(HOST_B ? describe : describe.skip)("documents across two nodes", function () {
    this.timeout(30000);

    it("writes on A, adopts B, and reads the actual words on B", async function () {
        // --- Act 1: identity on A, one note written before B exists.
        const alice = await makeUserFetch({ prefix: "docstwo" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        const doc = await createDoc(alice, root, "travel", "pack the good hat");

        // --- Act 2: adopt node B. Adoption's member-proven sync pulls the notes chain, and
        // the post-sync body fetch pulls the file bytes.
        const aliceOnB = await makeUserFetch({ prefix: "docstwob", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const grant = await (
            await alice(`api/identity/${root}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        await aliceOnB("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });

        const listOnB = await listDocs(aliceOnB, root);
        assert.equal(listOnB.docs.length, 1, "B sees the note");
        assert.equal(listOnB.docs[0].title, "travel");
        const detailOnB = await getDoc(aliceOnB, root, doc.doc_id);
        assert.equal(
            detailOnB.heads[0].body,
            "pack the good hat",
            "B reads the actual words - the body crossed as bytes, not just the header"
        );

        // --- Act 3: a fast-forward save on A reaches B when B initiates the next sync
        // (body fetch runs on the initiator's side).
        await saveDoc(alice, root, doc.doc_id, "travel", "pack the good hat, and the spare", [
            detailOnB.heads[0].version,
        ]);
        const syncResults = await (
            await aliceOnB(`api/identity/${root}/sync`, { method: "POST" })
        ).json();
        assert.ok(syncResults.some((r) => r.ok), "B reached A");

        const after = await getDoc(aliceOnB, root, doc.doc_id);
        assert.equal(after.diverged, false, "the save was a fast-forward");
        assert.equal(after.heads[0].body, "pack the good hat, and the spare");
    });
});
