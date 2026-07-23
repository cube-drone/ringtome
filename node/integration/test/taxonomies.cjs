/*
    Taxonomies: user-defined ordered lists of document references, as per-element ranked facts
    on the doc-meta chain (PROJECT_PLAN, Taxonomies - amended 2026-07-22) - over HTTP.

    The load-bearing behaviors: an empty list exists the moment it's created; appends hold
    insertion order; place is add AND move (one write, drag-and-drop index semantics); the
    member listing joins the memoized doc rows in list order; a foreign identity's document is
    representable (doc: null); rename rides the ordinary annotations route because taxonomy
    facts ARE annotations; deletion is one roster remove; nothing here is reachable without a
    session.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

async function createDoc(fetch, root, title, body) {
    const res = await fetch(`api/identity/${root}/docs`, {
        method: "POST",
        body: JSON.stringify({ title, body }),
    });
    assert.equal(res.status, 200);
    return res.json();
}

async function createTaxonomy(fetch, root, title) {
    const res = await fetch(`api/identity/${root}/taxonomies`, {
        method: "POST",
        body: JSON.stringify({ title }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).taxonomy_id;
}

async function listTaxonomies(fetch, root) {
    const res = await fetch(`api/identity/${root}/taxonomies`);
    assert.equal(res.status, 200);
    return (await res.json()).taxonomies;
}

async function getTaxonomy(fetch, root, taxId) {
    const res = await fetch(`api/identity/${root}/taxonomies/${taxId}`);
    assert.equal(res.status, 200);
    return res.json();
}

async function place(fetch, root, taxId, docId, body = {}) {
    const res = await fetch(`api/identity/${root}/taxonomies/${taxId}/members/${docId}`, {
        method: "PUT",
        body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return res.json();
}

async function removeMember(fetch, root, taxId, docId) {
    const res = await fetch(`api/identity/${root}/taxonomies/${taxId}/members/${docId}`, {
        method: "DELETE",
    });
    assert.equal(res.status, 200);
    return res.json();
}

// A fresh user with an identity and its root - every test here starts this way.
async function makeIdentity(prefix) {
    const user = await makeUserFetch({ prefix });
    const created = await (await user("api/identity", { method: "POST" })).json();
    return { user, root: created.root_pubkey };
}

describe("taxonomies: ordered lists of documents", function () {
    this.timeout(30000);

    it("creates an empty list, appends in order, and joins the doc rows", async function () {
        const { user, root } = await makeIdentity("taxbasic");
        const taxId = await createTaxonomy(user, root, "BOOK ABOUT HORSES");

        // The empty list exists - existence is a roster fact, not "has members".
        let all = await listTaxonomies(user, root);
        assert.equal(all.length, 1);
        assert.equal(all[0].title, "BOOK ABOUT HORSES");
        assert.equal(all[0].members, 0);

        const dressage = await createDoc(user, root, "dressage", "horses dancing");
        const mucking = await createDoc(user, root, "mucking", "the honest work");
        const gallop = await createDoc(user, root, "gallop", "fast horse mode");
        for (const doc of [dressage, mucking, gallop]) {
            await place(user, root, taxId, doc.doc_id);
        }

        const tax = await getTaxonomy(user, root, taxId);
        assert.equal(tax.title, "BOOK ABOUT HORSES");
        assert.deepEqual(
            tax.members.map((m) => m.doc_id),
            [dressage.doc_id, mucking.doc_id, gallop.doc_id],
            "appends hold insertion order"
        );
        // The join carries the same per-doc shape as the docs list.
        assert.equal(tax.members[0].doc.title, "dressage");
        assert.equal(tax.members[0].doc.format, "plaintext");
    });

    it("place is add and move: drag to an index, one write, order follows", async function () {
        const { user, root } = await makeIdentity("taxmove");
        const taxId = await createTaxonomy(user, root, "reading order");
        const docs = [];
        for (const n of ["one", "two", "three"]) {
            const doc = await createDoc(user, root, n, `chapter ${n}`);
            docs.push(doc.doc_id);
            await place(user, root, taxId, doc.doc_id);
        }

        // Move the last chapter to the front (index counts positions without the member).
        await place(user, root, taxId, docs[2], { index: 0 });
        let tax = await getTaxonomy(user, root, taxId);
        assert.deepEqual(
            tax.members.map((m) => m.doc_id),
            [docs[2], docs[0], docs[1]]
        );

        // Insert-at-middle for a NEW member: same operation, same semantics.
        const four = await createDoc(user, root, "four", "chapter four");
        await place(user, root, taxId, four.doc_id, { index: 1 });
        tax = await getTaxonomy(user, root, taxId);
        assert.deepEqual(
            tax.members.map((m) => m.doc_id),
            [docs[2], four.doc_id, docs[0], docs[1]]
        );

        // Out-of-range index clamps to append rather than erroring.
        await place(user, root, taxId, four.doc_id, { index: 99 });
        tax = await getTaxonomy(user, root, taxId);
        assert.equal(tax.members[3].doc_id, four.doc_id);

        // Remove: the member leaves the list; the others keep their order.
        await removeMember(user, root, taxId, docs[0]);
        tax = await getTaxonomy(user, root, taxId);
        assert.deepEqual(
            tax.members.map((m) => m.doc_id),
            [docs[2], docs[1], four.doc_id]
        );
    });

    it("references another identity's document as a rendable-later null", async function () {
        const { user, root } = await makeIdentity("taxforeign");
        const taxId = await createTaxonomy(user, root, "their greatest hits");
        const foreignRoot = "ee".repeat(32);
        const foreignDoc = "07".repeat(16);

        await place(user, root, taxId, foreignDoc, { member_root: foreignRoot });
        const tax = await getTaxonomy(user, root, taxId);
        assert.equal(tax.members.length, 1);
        assert.equal(tax.members[0].root, foreignRoot);
        assert.equal(tax.members[0].doc_id, foreignDoc);
        assert.equal(tax.members[0].doc, null, "no local rows for a stranger's document yet");
    });

    it("renames through the annotations route - taxonomy facts are annotations", async function () {
        const { user, root } = await makeIdentity("taxrename");
        const taxId = await createTaxonomy(user, root, "drafty title");

        const res = await user(`api/identity/${root}/docs/${taxId}/annotations/fields/title`, {
            method: "PUT",
            body: JSON.stringify({ value: "EQUINE COMPENDIUM" }),
        });
        assert.equal(res.status, 200);

        const all = await listTaxonomies(user, root);
        assert.equal(all[0].title, "EQUINE COMPENDIUM");
    });

    it("deletes a list without touching its documents", async function () {
        const { user, root } = await makeIdentity("taxdelete");
        const taxId = await createTaxonomy(user, root, "doomed");
        const doc = await createDoc(user, root, "survivor", "still here");
        await place(user, root, taxId, doc.doc_id);

        await (await user(`api/identity/${root}/taxonomies/${taxId}`, { method: "DELETE" })).json();
        assert.deepEqual(await listTaxonomies(user, root), [], "the list is gone");

        const docs = await (await user(`api/identity/${root}/docs`)).json();
        assert.equal(docs.docs.length, 1, "the document is not");
    });

    it("expands nested lists in place - trees are composition", async function () {
        const { user, root } = await makeIdentity("taxtree");
        const book = await createTaxonomy(user, root, "BOOK ABOUT HORSES");
        const anatomy = await createTaxonomy(user, root, "Horse Anatomy");
        const intro = await createDoc(user, root, "intro", "a horse is a horse");
        const skeleton = await createDoc(user, root, "skeleton", "many bones");

        await place(user, root, book, intro.doc_id);
        await place(user, root, book, anatomy, {});
        await place(user, root, anatomy, skeleton.doc_id);

        const tree = await getTaxonomy(user, root, book);
        assert.equal(tree.members.length, 2);
        assert.equal(tree.members[0].doc.title, "intro", "plain doc, summarized");
        const nested = tree.members[1].taxonomy;
        assert.equal(nested.title, "Horse Anatomy", "nested list, titled");
        assert.equal(nested.members.length, 1);
        assert.equal(nested.members[0].doc.title, "skeleton", "nested docs get summaries too");
    });

    it("refuses a locally visible cycle with a 400 that names it", async function () {
        const { user, root } = await makeIdentity("taxcycle");
        const outer = await createTaxonomy(user, root, "outer");
        const inner = await createTaxonomy(user, root, "inner");
        await place(user, root, outer, inner);

        const res = await user(`api/identity/${root}/taxonomies/${inner}/members/${outer}`, {
            method: "PUT",
            body: JSON.stringify({}),
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.ok(JSON.stringify(body).includes("cycle"), "the refusal names the cycle");
    });

    it("refuses unauthenticated taxonomy requests", async function () {
        const { user, root } = await makeIdentity("taxauth");
        const taxId = await createTaxonomy(user, root, "private business");

        const anon = makeFetch();
        for (const [path, init] of [
            [`api/identity/${root}/taxonomies`, {}],
            [`api/identity/${root}/taxonomies/${taxId}`, {}],
            [
                `api/identity/${root}/taxonomies/${taxId}/members/${"07".repeat(16)}`,
                { method: "PUT", body: JSON.stringify({}) },
            ],
        ]) {
            const res = await anon(path, init);
            assert.equal(res.status, 401, `${init.method || "GET"} ${path}`);
        }
    });
});
