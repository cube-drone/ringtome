// The cozy-address rules: how a title becomes a slug, how a path resolves back to a document, and
// what path a document should wear. Load-bearing (every copy-link, every address-bar dressing,
// every crosslink drag goes through here), entirely pure since the doc/naming.js split, and until
// now completely unexercised - `slugify` was doing Unicode property escapes with no vector at all.
//
// The last describe block is the real prize: a ROUND-TRIP property. Build a path for a document,
// resolve it, and you must land back on that document - over randomly generated rosters, trees,
// and titles, including the nasty ones (duplicate titles, punctuation-only titles, diamonds). It
// is the client-side echo of proto's test vectors: an invariant rather than an example.
const assert = require('node:assert');

let slugify, bucketFor, bucketNameFor, needsTree, matchSlugPath, buildSlugPath, rootTitleFor,
    HEX_ID, MEDIA_EXT, pathSegments;
before(async () => {
    ({ slugify, bucketFor, bucketNameFor, needsTree, matchSlugPath, buildSlugPath, rootTitleFor,
       HEX_ID, MEDIA_EXT, pathSegments } = await import('../../../js/pure/naming.js'));
});

// 32 hex chars, so ids look like the real thing (and HEX_ID accepts them).
const id = (n) => String(n).padStart(2, '0').repeat(16);
const doc = (n, title, buckets = ['default']) => ({ doc_id: id(n), title, buckets });
const tax = (tid, title, members) => ({ taxonomy_id: tid, title, members });
const inTree = (t) => ({ doc_id: t.taxonomy_id, taxonomy: t });   // a section member
const leaf = (d) => ({ doc_id: d.doc_id, doc: { title: d.title } }); // a document member
const segsOf = (path) => path.replace(/^\/home\//, '').split('/');

describe('slugify', () => {
    it('lowercases and hyphenates runs of anything that is not a letter or number', () => {
        assert.equal(slugify('I Love Bacon'), 'i-love-bacon');
        assert.equal(slugify('Hello,   world!!'), 'hello-world');
        assert.equal(slugify('a_b'), 'a-b');
    });

    it('keeps letters and numbers from ANY script', () => {
        assert.equal(slugify('Café Ünïcode'), 'café-ünïcode');
        assert.equal(slugify('日本語 memo'), '日本語-memo');
        assert.equal(slugify('Ω 42'), 'ω-42');
    });

    it('strips leading and trailing hyphens', () => {
        assert.equal(slugify('  spaced  '), 'spaced');
        assert.equal(slugify('---x---'), 'x');
    });

    it('is empty in, empty out - the caller falls back to the id', () => {
        assert.equal(slugify(''), '');
        assert.equal(slugify(null), '');
        assert.equal(slugify(undefined), '');
        assert.equal(slugify('!!!'), '');
        assert.equal(slugify('...'), '');
    });
});

describe('small rules', () => {
    it('titles a bucket s tree root under a prefix sections cannot collide with', () => {
        assert.equal(rootTitleFor('default'), 'wiki:default');
        assert.equal(rootTitleFor('grandmas recipes'), 'wiki:grandmas recipes');
    });

    it('accepts exactly 32 lowercase hex as canonical', () => {
        assert.ok(HEX_ID.test(id(1)));
        assert.ok(!HEX_ID.test(id(1).slice(0, 31)));
        assert.ok(!HEX_ID.test('ab'.repeat(16).toUpperCase()));
        assert.ok(HEX_ID.test('ab'.repeat(16)));
        assert.ok(!HEX_ID.test('not-an-id'));
    });

    it('maps each media format to the extension the renderer sniffs', () => {
        assert.equal(MEDIA_EXT.avif, 'avif');
        assert.equal(MEDIA_EXT.apng, 'png'); // NOT "apng" - the sniff wants png
        assert.equal(MEDIA_EXT.webm, 'webm');
        assert.equal(MEDIA_EXT.opus, 'ogg'); // NOT "opus" - the container is ogg
        assert.equal(MEDIA_EXT.plaintext, undefined);
    });

    it('normalizes path segments: blanks dropped, escapes undone', () => {
        assert.deepEqual(pathSegments(['notes', '', 'a%20b']), ['notes', 'a b']);
        assert.deepEqual(pathSegments(undefined), []);
    });

    it('only needs the tree when there are sections to walk and the tail is not canonical', () => {
        assert.equal(needsTree(['notes', 'a-doc']), false);
        assert.equal(needsTree(['notes', 'sec', 'a-doc']), true);
        assert.equal(needsTree(['notes', 'sec', id(1)]), false); // canonical tail
    });

    it('picks the bucket a path is built under: the view, then the doc s own, then the default', () => {
        assert.equal(bucketNameFor({ buckets: ['journal', 'x'] }, 'x'), 'x');
        assert.equal(bucketNameFor({ buckets: ['journal'] }, 'not-mine'), 'journal');
        assert.equal(bucketNameFor({ buckets: [] }, undefined), 'default');
        assert.equal(bucketNameFor(null, undefined), 'default');
    });

    it('an EMPTY bucket list defers to the view: the filing write may not have echoed yet', () => {
        // "+ new entry" is create-then-file; the mirror can stream the row between the two.
        // Preferring the view over the default is what keeps the re-dress from teleporting a
        // fresh entry into TurboNotes (field-found 2026-08-01). The truly-unbucketed case is
        // covered above: it is only ever VIEWED from the default home, where bucket='default'.
        assert.equal(bucketNameFor({ buckets: [] }, 'journal'), 'journal');
        assert.equal(bucketNameFor(null, 'journal'), 'journal');
    });
});

describe('bucketFor', () => {
    it('resolves an app id to that app s home bucket', () => {
        assert.deepEqual(bucketFor('journal', []).name, 'journal');
        assert.equal(bucketFor('notes', []).name, 'default');
        assert.equal(bucketFor('notes', []).app.id, 'notes');
    });

    it('resolves a slugified roster name, and carries its app type', () => {
        const roster = [{ name: "Grandma's Diary", app: 'journal' }];
        const found = bucketFor('grandma-s-diary', roster);
        assert.equal(found.name, "Grandma's Diary");
        assert.equal(found.app.id, 'journal');
    });

    it('is null for a segment that names nothing', () => {
        assert.equal(bucketFor('nowhere', []), null);
        assert.equal(bucketFor('persona', []), null); // a system app owns no bucket
    });

    it('breaks a slug tie on the lowest name, whatever order the roster arrives in', () => {
        const a = { name: 'My Book', app: 'journal' };
        const b = { name: 'my-book', app: 'journal' };
        assert.equal(bucketFor('my-book', [a, b]).name, bucketFor('my-book', [b, a]).name);
    });
});

describe('matchSlugPath', () => {
    const roster = [{ name: 'Cook Book', app: 'journal' }];
    const docs = [doc(1, 'Soup', ['Cook Book']), doc(2, 'Bread', ['Cook Book'])];

    it('needs at least a bucket and a tail', () => {
        assert.equal(matchSlugPath(['notes'], { roster, docs }), null);
        assert.equal(matchSlugPath([], { roster, docs }), null);
    });

    it('takes a canonical tail as-is, without consulting anything', () => {
        const hit = matchSlugPath(['notes', id(9)], {});
        assert.deepEqual(hit, { appId: 'notes', docId: id(9) });
    });

    it('finds a document by title inside its bucket', () => {
        assert.equal(matchSlugPath(['cook-book', 'soup'], { roster, docs }).docId, id(1));
        assert.equal(matchSlugPath(['cook-book', 'bread'], { roster, docs }).docId, id(2));
    });

    it('reports the app that opens the bucket, not the bucket', () => {
        assert.equal(matchSlugPath(['cook-book', 'soup'], { roster, docs }).appId, 'journal');
    });

    it('is null when the title matches nothing in that bucket', () => {
        assert.equal(matchSlugPath(['cook-book', 'cake'], { roster, docs }), null);
        // The same title, but filed in a different bucket: not this path's document.
        const elsewhere = [doc(3, 'Cake', ['default'])];
        assert.equal(matchSlugPath(['cook-book', 'cake'], { roster, docs: elsewhere }), null);
    });

    it('breaks a duplicate-title tie on the lowest doc id', () => {
        const twins = [doc(7, 'Soup', ['Cook Book']), doc(3, 'Soup', ['Cook Book'])];
        assert.equal(matchSlugPath(['cook-book', 'soup'], { roster, docs: twins }).docId, id(3));
    });

    describe('the strict tree walk', () => {
        const soup = doc(1, 'Soup', ['Cook Book']);
        const other = doc(2, 'Soup', ['Cook Book']); // same title, elsewhere in the tree
        const tree = tax('t0', 'wiki:Cook Book', [
            inTree(tax('t1', 'Starters', [leaf(soup)])),
            inTree(tax('t2', 'Mains', [leaf(other)])),
        ]);
        const both = [soup, other];

        it('walks sections by slugified title and matches the leaf inside', () => {
            assert.equal(matchSlugPath(['cook-book', 'starters', 'soup'],
                { roster, docs: both, tree }).docId, id(1));
            assert.equal(matchSlugPath(['cook-book', 'mains', 'soup'],
                { roster, docs: both, tree }).docId, id(2));
        });

        it('falls back to a bucket-wide title match when the section walk misses', () => {
            // A document dragged to a new section keeps its old links working: "puddings" is gone,
            // so the forgiving pass takes over and finds the lowest-id "Soup" in the bucket.
            assert.equal(matchSlugPath(['cook-book', 'puddings', 'soup'],
                { roster, docs: both, tree }).docId, id(1));
        });

        it('falls back when the section exists but holds no such title', () => {
            assert.equal(matchSlugPath(['cook-book', 'starters', 'bread'],
                { roster, docs: [...both, doc(5, 'Bread', ['Cook Book'])], tree }).docId, id(5));
        });

        it('walks two levels down', () => {
            const deep = tax('t0', 'wiki:Cook Book', [
                inTree(tax('t1', 'Starters', [inTree(tax('t2', 'Cold', [leaf(soup)]))])),
            ]);
            assert.equal(matchSlugPath(['cook-book', 'starters', 'cold', 'soup'],
                { roster, docs: both, tree: deep }).docId, id(1));
        });

        it('breaks a duplicate SECTION title on the lowest taxonomy id', () => {
            const dupes = tax('t0', 'wiki:Cook Book', [
                inTree(tax('t9', 'Starters', [leaf(other)])),
                inTree(tax('t1', 'Starters', [leaf(soup)])),
            ]);
            assert.equal(matchSlugPath(['cook-book', 'starters', 'soup'],
                { roster, docs: both, tree: dupes }).docId, id(1));
        });

        it('ignores a stub section (a second placement, carrying no members)', () => {
            const stubbed = tax('t0', 'wiki:Cook Book', [
                inTree({ taxonomy_id: 't1', title: 'Starters' }), // no members: a stub
                inTree(tax('t2', 'Starters', [leaf(soup)])),
            ]);
            assert.equal(matchSlugPath(['cook-book', 'starters', 'soup'],
                { roster, docs: both, tree: stubbed }).docId, id(1));
        });
    });
});

describe('buildSlugPath', () => {
    it('wears the app id for a home bucket', () => {
        assert.equal(buildSlugPath(doc(1, 'Shopping List'), { docs: [doc(1, 'Shopping List')] }),
            '/home/notes/shopping-list');
    });

    it('wears a slugified name for a user bucket', () => {
        const roster = [{ name: 'Cook Book', app: 'journal' }];
        const d = doc(1, 'Soup', ['Cook Book']);
        assert.equal(buildSlugPath(d, { roster, docs: [d], bucket: 'Cook Book' }),
            '/home/cook-book/soup');
    });

    it('falls back to the honest id when the title slugs to nothing', () => {
        const d = doc(1, '!!!');
        assert.equal(buildSlugPath(d, { docs: [d] }), `/home/notes/${id(1)}`);
        const untitled = doc(2, '');
        assert.equal(buildSlugPath(untitled, { docs: [untitled] }), `/home/notes/${id(2)}`);
    });

    it('falls back to the id when a lower-id sibling shares the slug', () => {
        // The loser cannot use the slug: resolving it would land on the other document.
        const winner = doc(3, 'Soup');
        const loser = doc(7, 'Soup');
        const docs = [winner, loser];
        assert.equal(buildSlugPath(winner, { docs }), '/home/notes/soup');
        assert.equal(buildSlugPath(loser, { docs }), `/home/notes/${id(7)}`);
    });

    it('spells out the section path down to the document s first occurrence', () => {
        const d = doc(1, 'Soup');
        const tree = tax('t0', 'wiki:default', [
            inTree(tax('t1', 'Starters', [inTree(tax('t2', 'Cold', [leaf(d)]))])),
        ]);
        assert.equal(buildSlugPath(d, { docs: [d], tree }),
            '/home/notes/starters/cold/soup');
    });

    it('uses the FIRST occurrence of a diamond-placed document', () => {
        const d = doc(1, 'Soup');
        const tree = tax('t0', 'wiki:default', [
            inTree(tax('t1', 'Starters', [leaf(d)])),
            inTree(tax('t2', 'Mains', [leaf(d)])),
        ]);
        assert.equal(buildSlugPath(d, { docs: [d], tree }), '/home/notes/starters/soup');
    });

    it('judges the slug tie among the document s SECTION siblings, not the whole bucket', () => {
        // A same-titled document in another section does not cost this one its slug.
        const mine = doc(7, 'Soup');
        const elsewhere = doc(3, 'Soup');
        const tree = tax('t0', 'wiki:default', [
            inTree(tax('t1', 'Starters', [leaf(mine)])),
            inTree(tax('t2', 'Mains', [leaf(elsewhere)])),
        ]);
        assert.equal(buildSlugPath(mine, { docs: [mine, elsewhere], tree }),
            '/home/notes/starters/soup');
    });

    it('is null for no document', () => {
        assert.equal(buildSlugPath(null, {}), null);
    });
});

// --- the round trip -------------------------------------------------------------------------
//
// The invariant the whole scheme rests on. Deterministic generation (a seeded LCG, so a failure is
// reproducible from its seed) over the shapes that actually break things: duplicate titles,
// punctuation-only titles, unicode, sections that slugify alike, diamonds, and unfiled documents.
describe('build -> match round trip', () => {
    const lcg = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    const TITLES = ['Soup', 'soup', 'SOUP!', 'Bread', '', '!!!', 'Café', '日本語', 'a b', 'Bread'];
    const SECTIONS = ['Starters', 'starters', 'Mains', 'Odds & Ends', ''];

    // One random world: a roster, some documents, and a tree that places some of them.
    function world(rand) {
        const userBucket = rand() < 0.5;
        const bucketName = userBucket ? 'Cook Book' : 'default';
        const roster = userBucket ? [{ name: bucketName, app: 'journal' }] : [];
        const count = 2 + Math.floor(rand() * 5);
        const docs = [];
        for (let i = 0; i < count; i++) {
            docs.push(doc(i + 1, TITLES[Math.floor(rand() * TITLES.length)], [bucketName]));
        }
        // A tree over a random subset, at random depth, with the occasional diamond.
        let tree = null;
        if (rand() < 0.75) {
            const sections = [];
            for (let s = 0; s < 1 + Math.floor(rand() * 3); s++) {
                const members = docs.filter(() => rand() < 0.5).map(leaf);
                let node = tax(`t${s}`, SECTIONS[Math.floor(rand() * SECTIONS.length)], members);
                if (rand() < 0.3) {
                    node = tax(`t${s}o`, SECTIONS[Math.floor(rand() * SECTIONS.length)],
                        [inTree(node)]);
                }
                sections.push(inTree(node));
            }
            tree = tax('root', rootTitleFor(bucketName), sections);
        }
        return { roster, docs, tree, bucket: bucketName };
    }

    it('lands back on the same document, over 400 generated worlds', () => {
        let checked = 0;
        for (let seed = 1; seed <= 400; seed++) {
            const rand = lcg(seed);
            const { roster, docs, tree, bucket } = world(rand);
            for (const row of docs) {
                const path = buildSlugPath(row, { roster, docs, tree, bucket });
                assert.ok(path, `seed ${seed}: no path for ${row.doc_id}`);
                const hit = matchSlugPath(segsOf(path), { roster, docs, tree });
                assert.ok(hit, `seed ${seed}: ${path} resolved to nothing`);
                assert.equal(hit.docId, row.doc_id,
                    `seed ${seed}: ${path} resolved to ${hit.docId}, wanted ${row.doc_id} ` +
                    `(title ${JSON.stringify(row.title)})`);
                checked++;
            }
        }
        assert.ok(checked > 1000, `expected a decent sample, only checked ${checked}`);
    });

    it('lands back on the same document when the tree is absent entirely', () => {
        for (let seed = 500; seed < 560; seed++) {
            const rand = lcg(seed);
            const { roster, docs, bucket } = world(rand);
            for (const row of docs) {
                const path = buildSlugPath(row, { roster, docs, tree: null, bucket });
                const hit = matchSlugPath(segsOf(path), { roster, docs, tree: null });
                assert.equal(hit && hit.docId, row.doc_id, `seed ${seed}: ${path}`);
            }
        }
    });
});
