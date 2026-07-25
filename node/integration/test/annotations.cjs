/*
    Annotations: private facts about documents - per-doc fields (LWW registers) and tags (LWW
    set-elements) on the doc-meta chain - over HTTP, plus the docs-by-tag listing served off the
    memoized doc_heads rows.

    The load-bearing behaviors: fields round-trip and the later write wins; the tagged listing
    returns the SAME per-doc shape as the docs list (both read doc_heads); ordering is claimed
    stamps only (`modified` = display head, `created` = genesis - and never received_at); the
    value cap surfaces as a 4xx that names the alternative (write a document); untag removes a
    doc from the listing; nothing here is reachable without a session.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch, HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function getAnnotations(fetch, root, docId) {
    const res = await fetch(`api/identity/${root}/docs/${docId}/annotations`);
    assert.equal(res.status, 200);
    return res.json();
}

function putField(fetch, root, docId, field, value) {
    return fetch(`api/identity/${root}/docs/${docId}/annotations/fields/${field}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
    });
}

function deleteField(fetch, root, docId, field) {
    return fetch(`api/identity/${root}/docs/${docId}/annotations/fields/${field}`, {
        method: "DELETE",
    });
}

function putTag(fetch, root, docId, tag) {
    return fetch(`api/identity/${root}/docs/${docId}/annotations/tags/${tag}`, {
        method: "PUT",
    });
}

function deleteTag(fetch, root, docId, tag) {
    return fetch(`api/identity/${root}/docs/${docId}/annotations/tags/${tag}`, {
        method: "DELETE",
    });
}

async function docsTagged(fetch, root, tag, order) {
    const query = order ? `?order=${order}` : "";
    const res = await fetch(`api/identity/${root}/docs/tagged/${tag}${query}`);
    assert.equal(res.status, 200);
    return res.json();
}

// A fresh user with an identity and its root - every test here starts this way.
async function makeIdentity(prefix) {
    const user = await makeUserFetch({ prefix });
    const created = await (await user("api/identity", { method: "POST" })).json();
    return { user, root: created.root_pubkey };
}

describe("annotations: private facts about documents", function () {
    this.timeout(30000);

    it("sets fields, reads them back, and the later write wins", async function () {
        const { user, root } = await makeIdentity("annfields");
        const doc = await createDoc(user, root, "pier", "a sunset over the pier");

        const putRes = await putField(user, root, doc.doc_id, "description", "a sunset");
        assert.equal(putRes.status, 200);
        const written = await putRes.json();
        assert.ok(written.entry_hash, "the write names its entry");

        // Overwrite-wins: two writes to the same field, the later one stands.
        await putField(user, root, doc.doc_id, "artist", "someone");
        await putField(user, root, doc.doc_id, "artist", "Corff Burblepunk");

        const ann = await getAnnotations(user, root, doc.doc_id);
        assert.deepEqual(ann.fields, {
            description: "a sunset",
            artist: "Corff Burblepunk",
        });
        assert.deepEqual(ann.tags, [], "no tags yet");

        // Clearing is an LWW write of an absent value: the field disappears from reads.
        const del = await deleteField(user, root, doc.doc_id, "artist");
        assert.equal(del.status, 200);
        const after = await getAnnotations(user, root, doc.doc_id);
        assert.deepEqual(after.fields, { description: "a sunset" });
    });

    it("joins tags and fields onto the docs list row (the mirror's filter data)", async function () {
        // Annotations fold from a different chain than doc_heads; they're joined onto the list
        // row at the stream boundary so the mirror's docs row is filter-ready. Prove the join.
        const { user, root } = await makeIdentity("annjoin");
        const doc = await createDoc(user, root, "pier", "a sunset over the pier");
        await putField(user, root, doc.doc_id, "description", "a calm evening");
        // display_date is a conventional field (the user's claimed date); it rides the same
        // field path and arrives on the row for the client to sort/display by.
        await putField(user, root, doc.doc_id, "display_date", "2015-07-31");
        await putTag(user, root, doc.doc_id, "beach");
        await putTag(user, root, doc.doc_id, "sunset");

        const list = await listDocs(user, root);
        const row = list.docs.find((d) => d.doc_id === doc.doc_id);
        assert.ok(row, "the doc is listed");
        assert.deepEqual(row.tags, ["beach", "sunset"], "tags joined onto the row");
        assert.equal(row.fields.description, "a calm evening", "description joined onto the row");
        assert.equal(row.fields.display_date, "2015-07-31", "claimed date joined onto the row");

        // A doc with no annotations carries empty structures, never undefined.
        const bare = await createDoc(user, root, "bare", "nothing here");
        const bareRow = (await listDocs(user, root)).docs.find((d) => d.doc_id === bare.doc_id);
        assert.deepEqual(bareRow.tags, []);
        assert.deepEqual(bareRow.fields, {});
    });

    it("tags two docs and lists them by tag in the docs-list per-doc shape", async function () {
        const { user, root } = await makeIdentity("anntags");
        const pier = await createDoc(user, root, "pier", "the pier");
        const cat = await createDoc(user, root, "cat", "the cat");

        await putTag(user, root, pier.doc_id, "sunset");
        await putTag(user, root, cat.doc_id, "sunset");
        await putTag(user, root, pier.doc_id, "beach");

        // Both tag directions agree: per-doc tags...
        const ann = await getAnnotations(user, root, pier.doc_id);
        assert.deepEqual(ann.tags, ["beach", "sunset"]);

        // ...and the inverted listing, which must carry the SAME per-doc shape as the docs
        // list - both are reads of the memoized doc_heads rows.
        const tagged = await docsTagged(user, root, "sunset");
        assert.equal(tagged.docs.length, 2, "both tagged docs listed");
        const list = await listDocs(user, root);
        for (const entry of tagged.docs) {
            const inList = list.docs.find((d) => d.doc_id === entry.doc_id);
            assert.ok(inList, "every tagged doc is a listed doc");
            assert.deepEqual(entry, inList, "identical per-doc shape and values");
        }

        // The single-tag doc appears under its own tag only.
        const beach = await docsTagged(user, root, "beach");
        assert.deepEqual(
            beach.docs.map((d) => d.doc_id),
            [pier.doc_id]
        );
    });

    it("orders the tagged listing by modified vs created (claimed stamps only)", async function () {
        const { user, root } = await makeIdentity("annorder");

        // older first, newer second - then edit the OLDER one so the two orders disagree.
        const older = await createDoc(user, root, "older", "first words");
        await sleep(60);
        const newer = await createDoc(user, root, "newer", "second words");
        await sleep(60);
        await saveDoc(user, root, older.doc_id, "older", "first words, edited", [older.version]);

        await putTag(user, root, older.doc_id, "ordered");
        await putTag(user, root, newer.doc_id, "ordered");

        // modified (the default): the freshly edited older doc has the newest head.
        const modified = await docsTagged(user, root, "ordered", "modified");
        assert.deepEqual(
            modified.docs.map((d) => d.doc_id),
            [older.doc_id, newer.doc_id],
            "modified: newest display head first"
        );
        const byDefault = await docsTagged(user, root, "ordered");
        assert.deepEqual(byDefault.docs, modified.docs, "modified is the default");

        // created: genesis stamps - the newer doc was born last and leads.
        const created = await docsTagged(user, root, "ordered", "created");
        assert.deepEqual(
            created.docs.map((d) => d.doc_id),
            [newer.doc_id, older.doc_id],
            "created: newest genesis first, unmoved by the edit"
        );

        // No received_at anywhere in the response: claimed stamps are the only times served.
        for (const doc of modified.docs) {
            assert.equal(doc.received_at_ms, undefined);
        }

        // An order the API doesn't speak is refused, not silently defaulted.
        const bad = await user(`api/identity/${root}/docs/tagged/ordered?order=chaotic`);
        assert.equal(bad.status, 400);
    });

    it("refuses an oversized field value and names the alternative", async function () {
        const { user, root } = await makeIdentity("anncap");
        const doc = await createDoc(user, root, "novel", "short body");

        // Exactly at the 2 KiB cap is fine; one byte past it is refused with the doctrine.
        const atCap = "d".repeat(2048);
        assert.equal((await putField(user, root, doc.doc_id, "description", atCap)).status, 200);

        const over = await putField(user, root, doc.doc_id, "description", atCap + "!");
        assert.equal(over.status, 400, "past the cap is a client error");
        const body = await over.json();
        assert.ok(
            body.message.includes("becoming") && body.message.includes("document"),
            `the refusal says the description is becoming a document: ${body.message}`
        );
    });

    it("untag removes the document from the tagged listing", async function () {
        const { user, root } = await makeIdentity("annuntag");
        const doc = await createDoc(user, root, "fleeting", "here and gone");

        await putTag(user, root, doc.doc_id, "keeper");
        let tagged = await docsTagged(user, root, "keeper");
        assert.deepEqual(tagged.docs.map((d) => d.doc_id), [doc.doc_id]);

        const del = await deleteTag(user, root, doc.doc_id, "keeper");
        assert.equal(del.status, 200);
        tagged = await docsTagged(user, root, "keeper");
        assert.deepEqual(tagged.docs, [], "untagged docs leave the listing");
        const ann = await getAnnotations(user, root, doc.doc_id);
        assert.deepEqual(ann.tags, [], "and the per-doc direction agrees");
    });

    it("refuses unauthenticated annotation requests", async function () {
        // A real root (so the only thing wrong with these requests is the missing session).
        const { user, root } = await makeIdentity("annanon");
        const doc = await createDoc(user, root, "private", "members only");

        const anon = makeFetch();
        const attempts = [
            anon(`api/identity/${root}/docs/${doc.doc_id}/annotations`),
            anon(`api/identity/${root}/docs/${doc.doc_id}/annotations/fields/description`, {
                method: "PUT",
                body: JSON.stringify({ value: "sneaky" }),
            }),
            anon(`api/identity/${root}/docs/${doc.doc_id}/annotations/tags/sneaky`, {
                method: "PUT",
            }),
            anon(`api/identity/${root}/docs/tagged/sneaky`),
        ];
        for (const attempt of attempts) {
            assert.equal((await attempt).status, 401, "no session, no annotations");
        }
    });
});

// Annotations ride the doc-meta chain, which is private: adoption's member-proven sync carries
// it to a new node exactly like the general-private and documents chains.
(HOST_B ? describe : describe.skip)("annotations across two nodes", function () {
    this.timeout(60000);

    it("annotations written on A appear on adopted B", async function () {
        // --- Act 1: identity on A, one doc annotated before B exists.
        const alice = await makeUserFetch({ prefix: "anntwo" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        const doc = await createDoc(alice, root, "shared", "the annotated words");
        await putField(alice, root, doc.doc_id, "description", "annotated on A");
        await putTag(alice, root, doc.doc_id, "synced");

        // --- Act 2: adopt node B (the grant re-seals epoch history; adoption's member-proven
        // sync pulls the doc-meta chain along with everything else).
        const aliceOnB = await makeUserFetch({ prefix: "anntwob", host: HOST_B });
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

        // --- B reads the same facts, both directions.
        const annOnB = await getAnnotations(aliceOnB, root, doc.doc_id);
        assert.deepEqual(annOnB.fields, { description: "annotated on A" });
        assert.deepEqual(annOnB.tags, ["synced"]);

        const taggedOnB = await docsTagged(aliceOnB, root, "synced");
        assert.deepEqual(
            taggedOnB.docs.map((d) => d.doc_id),
            [doc.doc_id],
            "the tagged listing works on B over the synced chains"
        );
    });
});
