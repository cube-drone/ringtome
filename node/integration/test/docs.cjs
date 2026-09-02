/*
    Versioned documents (the notes app): create, save, list, read over HTTP.

    The load-bearing behaviors: fast-forward saves keep one head; two saves sharing a parent are
    DETECTED divergence with both versions kept and readable (never-lose-words - a stale tab must
    not destroy an afternoon); and neither titles nor bodies ever appear as plaintext in the
    stored entry log (headers are epoch-encrypted; bodies live in the file layer, not the chain).
*/
const assert = require("node:assert");
const zlib = require("node:zlib");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { makePng, assertIsAvif } = require("./helpers.cjs");

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

// --- media ingest test helpers --------------------------------------------------------------

// A real, decodable PNG built in-language (no image deps): a truecolor gradient. The ingest
// pipeline actually decodes this, so it can't be fake magic bytes like the old tests used.
async function waitForJob(fetch, root, jobId) {
    for (let i = 0; i < 200; i++) {
        const jobs = await (await fetch(`api/identity/${root}/ingest`)).json();
        const job = jobs.find((j) => j.job_id === jobId);
        if (job && job.status === "done") return job;
        if (job && job.status === "failed") throw new Error("ingest failed: " + job.error);
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("ingest did not finish in time");
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

    it("saves a document larger than the keepalive cap (the server was never the limit)", async function () {
        // The '600KB never saved' bug was fetch's client-side keepalive cap (64 KiB), not the
        // server. This proves the server-side path takes a body well past that cap and reads
        // it back verbatim - here ~128KB, over the keepalive limit and under this node's
        // 256KB document cap (a real node's default is ~10MB).
        const user = await makeUserFetch({ prefix: "docsbig" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const big = "Sherlock ".repeat(14_000); // ~126KB, ~2x the 64 KiB keepalive cap
        assert.ok(big.length > 64 * 1024, "the body exceeds the keepalive cap");
        const doc = await createDoc(user, root, "big", big, "marquee");
        const detail = await getDoc(user, root, doc.doc_id);
        assert.equal(detail.body.length, big.length, "the whole body round-trips");
        assert.equal(detail.body, big);
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

    it("queues an image upload, transcodes it to AVIF, and serves body + thumbnail", async function () {
        const user = await makeUserFetch({ prefix: "docsimg" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const png = makePng(120, 90); // a real image the pipeline actually decodes

        // Upload returns 202 immediately: a doc_id (version-less = pending) and a job to poll.
        const queuedRes = await user("api/identity/" + root + "/docs/binary?title=sunset", {
            method: "POST",
            body: png,
            file: true,
        });
        assert.equal(queuedRes.status, 202, "upload is accepted, not synchronously stored");
        const queued = await queuedRes.json();
        assert.ok(queued.doc_id, "got a doc_id back right away");
        assert.ok(queued.job_id, "and a job handle to poll");
        assert.equal(queued.status, "pending");

        // Wait for the transcode to land the first version.
        const job = await waitForJob(user, root, queued.job_id);
        assert.equal(job.status, "done");

        // The document now exists, reported as an avif.
        const list = await listDocs(user, root);
        assert.equal(list.docs.length, 1);
        assert.equal(list.docs[0].format, "avif");

        // Body: a real AVIF - transcoded, NOT the PNG stored verbatim - with isolation headers
        // (even a private body may be a hostile polyglot from a compromised member).
        const res = await user(`api/identity/${root}/docs/${queued.doc_id}/body`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "image/avif");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.equal(res.headers.get("content-security-policy"), "sandbox");
        const back = Buffer.from(await res.arrayBuffer());
        assertIsAvif(back, "served body");
        assert.ok(!back.equals(png), "the upload was transcoded, not stored byte-for-byte");

        // Thumbnail: its own sibling blob, also a real AVIF.
        const thumb = await user(`api/identity/${root}/docs/${queued.doc_id}/thumb`);
        assert.equal(thumb.status, 200);
        assert.equal(thumb.headers.get("content-type"), "image/avif");
        assertIsAvif(Buffer.from(await thumb.arrayBuffer()), "served thumbnail");
    });

    it("surfaces a failed transcode in the queue, never as a ghost document", async function () {
        const user = await makeUserFetch({ prefix: "docsbad" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // Not an image at all: the transcode rejects it as a terminal failure.
        const junk = Buffer.from("this is definitely not an image file");
        const queued = await (
            await user("api/identity/" + root + "/docs/binary?title=broken", {
                method: "POST",
                body: junk,
                file: true,
            })
        ).json();

        // The job reaches `failed` with a human tombstone (waitForJob throws on failure, so we
        // poll for the terminal state directly here).
        let job;
        for (let i = 0; i < 200; i++) {
            const jobs = await (await user(`api/identity/${root}/ingest`)).json();
            job = jobs.find((j) => j.job_id === queued.job_id);
            if (job && (job.status === "failed" || job.status === "done")) break;
            await new Promise((r) => setTimeout(r, 150));
        }
        assert.equal(job.status, "failed", "unreadable bytes fail the job");
        assert.ok(job.error && job.error.length > 0, "carries a tombstone message");

        // The doc_id never became a document: no ghost entry in the list...
        const list = await listDocs(user, root);
        assert.equal(list.docs.length, 0, "a failed upload leaves no document behind");

        // ...but the body endpoint is self-describing: 422 with the tombstone, not a bare 404.
        const body = await user(`api/identity/${root}/docs/${queued.doc_id}/body`);
        assert.equal(body.status, 422, "a failed upload's body is Unprocessable, not a silent 404");
        const explained = await body.json();
        assert.ok(
            explained.message && explained.message.length > 0,
            "the body carries the failure reason"
        );
        assert.equal(explained.message, job.error, "and it matches the queue's tombstone");
    });

    it("deletes a document: it leaves every list surface but stays whole on the chain", async function () {
        const user = await makeUserFetch({ prefix: "docsdelete" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const keep = await createDoc(user, root, "keeper", "the good hat");
        const gone = await createDoc(user, root, "regret", "a braised blunder");
        // Tag the doomed doc so we can also prove the inverse read (docs-by-tag, which goes
        // through summaries_for) drops it.
        await user(`api/identity/${root}/docs/${gone.doc_id}/annotations/tags/braise`, {
            method: "PUT",
        });

        // Both present, both findable up front.
        let list = await listDocs(user, root);
        assert.equal(list.docs.length, 2);
        let tagged = await (await user(`api/identity/${root}/docs/tagged/braise`)).json();
        assert.equal(tagged.docs.length, 1, "the tag finds it before deletion");

        // DELETE the unwanted one. It drops out of the list immediately (the tombstone filters
        // the same doc_heads spine every read shares).
        const res = await user(`api/identity/${root}/docs/${gone.doc_id}`, { method: "DELETE" });
        assert.equal(res.status, 200);
        list = await listDocs(user, root);
        assert.deepEqual(
            list.docs.map((d) => d.doc_id),
            [keep.doc_id],
            "only the keeper remains"
        );

        // The inverse read filters it too - a deleted doc is gone from every list surface, not
        // just the main one.
        tagged = await (await user(`api/identity/${root}/docs/tagged/braise`)).json();
        assert.equal(tagged.docs.length, 0, "the tag no longer surfaces the deleted doc");

        // The version chain was never touched: the header is still fetchable by id. Delete hides,
        // it does not erase (Immutable Chains != Immutable Content).
        const detail = await getDoc(user, root, gone.doc_id);
        assert.equal(detail.title, "regret", "the document itself is still on the chain");

        // Deleting again is idempotent (a no-op re-add), not an error.
        const again = await user(`api/identity/${root}/docs/${gone.doc_id}`, { method: "DELETE" });
        assert.equal(again.status, 200);
    });

    it("pins a document: the list row carries the flag, and unpin clears it", async function () {
        const user = await makeUserFetch({ prefix: "docspin" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const plain = await createDoc(user, root, "ordinary", "just a note");
        const star = await createDoc(user, root, "important", "read me first");

        // Nothing pinned to start.
        let list = await listDocs(user, root);
        assert.ok(list.docs.every((d) => d.pinned === false), "no doc starts pinned");

        // Pin one: its list row (and only its row) reports pinned.
        const res = await user(`api/identity/${root}/docs/${star.doc_id}/pin`, { method: "PUT" });
        assert.equal(res.status, 200);
        list = await listDocs(user, root);
        assert.equal(list.docs.find((d) => d.doc_id === star.doc_id).pinned, true);
        assert.equal(list.docs.find((d) => d.doc_id === plain.doc_id).pinned, false);

        // Unpin: the flag clears.
        await user(`api/identity/${root}/docs/${star.doc_id}/pin`, { method: "DELETE" });
        list = await listDocs(user, root);
        assert.ok(list.docs.every((d) => d.pinned === false), "unpin clears the flag");
    });

    it("rejects an oversized text document with 413", async function () {
        const user = await makeUserFetch({ prefix: "docsnovel" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // The test nodes boot with RINGTOME_MAX_DOCUMENT_BYTES=256KiB; a novel-stuffer exceeds it.
        const novel = "x".repeat(300 * 1024);
        const res = await user(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({ title: "war and peace", body: novel }),
        });
        assert.equal(res.status, 413, "a document past the distribution cap is refused");
    });

    it("rejects an upload past the pre-crunch cap with 413", async function () {
        const user = await makeUserFetch({ prefix: "docsbig" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // The test nodes boot with RINGTOME_MAX_UPLOAD_BYTES=1MiB; go just past it.
        const tooBig = Buffer.alloc(1024 * 1024 + 4096, 0x41);
        const res = await user("api/identity/" + root + "/docs/binary?title=huge", {
            method: "POST",
            body: tooBig,
            file: true,
        });
        assert.equal(res.status, 413, "an oversized upload is refused at the body limit");

        // It was rejected before quarantine, so nothing was queued.
        const jobs = await (await user(`api/identity/${root}/ingest`)).json();
        assert.equal(jobs.length, 0, "rejected before it could become a job");
    });

    it("stores neither titles nor bodies as plaintext in the entry log", async function () {
        const user = await makeUserFetch({ prefix: "docscipher" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const secretTitle = "the secret plan";
        const secretBody = "operation hat convention is GO";
        await createDoc(user, root, secretTitle, secretBody);

        const entries = (await (await user(`api/identity/${root}/entries?limit=500`)).json()).items;
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

    it("transcodes an image on A and syncs the AVIF to B", async function () {
        // --- Act 1: identity on A, one image uploaded and transcoded before B exists.
        const alice = await makeUserFetch({ prefix: "imgtwo" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const png = makePng(96, 72);
        const queued = await (
            await alice("api/identity/" + root + "/docs/binary?title=holiday", {
                method: "POST",
                body: png,
                file: true,
            })
        ).json();
        await waitForJob(alice, root, queued.job_id); // the AVIF version must exist before we sync

        // The canonical bytes B should end up with: A's stored AVIF body.
        const onA = Buffer.from(
            await (await alice(`api/identity/${root}/docs/${queued.doc_id}/body`)).arrayBuffer()
        );
        assertIsAvif(onA, "A's stored body");

        // --- Act 2: adopt node B. The doc-header crosses on the (member-proven) documents chain;
        // the encrypted AVIF body + thumbnail cross over iroh-blobs in the post-sync body fetch.
        const aliceOnB = await makeUserFetch({ prefix: "imgtwob", host: HOST_B });
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

        // --- B fetches the encrypted blob and decrypts it to the exact AVIF A produced.
        const listOnB = await listDocs(aliceOnB, root);
        assert.equal(listOnB.docs[0].format, "avif", "B sees it as an image document");
        const res = await aliceOnB(`api/identity/${root}/docs/${queued.doc_id}/body`);
        assert.equal(res.status, 200, "the blob crossed the wire to B");
        assert.equal(res.headers.get("content-type"), "image/avif");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        const onB = Buffer.from(await res.arrayBuffer());
        assert.ok(onB.equals(onA), "B decrypts to the exact AVIF bytes A stored");

        // The thumbnail rode along too (sync fetches both blobs).
        const thumbOnB = await aliceOnB(`api/identity/${root}/docs/${queued.doc_id}/thumb`);
        assert.equal(thumbOnB.status, 200, "the thumbnail blob also crossed to B");
        assertIsAvif(Buffer.from(await thumbOnB.arrayBuffer()), "B's thumbnail");
    });
});
