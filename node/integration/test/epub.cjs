/*
    ePubs (plans/EPUB.md, epub.rs): a notebook, and a public book, as one .epub. The zip begins with
    its mimetype, stored; every page is well-formed XML; the contents nest as the tree does; a link
    from one page to another leads to that page's chapter; a picture is a JPEG or PNG inside the
    book, never the AVIF; a drawing is painted. The same book asked for twice is the same file (the
    cache), and an edit makes a new one. A notebook is its persona's own; a public book is anyone's.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { makeFetch, HOST_B } = require('./fetch.cjs');
const { beat, pullAndFold } = require('./beat.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });

// What a reader checks first, and what an XML parser makes of every page: the zip's entries in
// order, whether `mimetype` leads uncompressed, its words, every XML file parsed, and the files.
const INSPECT = `
import sys, zipfile, json, xml.etree.ElementTree as ET
z = zipfile.ZipFile(sys.argv[1])
infos = z.infolist()
out = {"first": infos[0].filename, "stored": infos[0].compress_type == zipfile.ZIP_STORED,
       "mimetype": z.read("mimetype").decode(), "names": [i.filename for i in infos], "bad": [], "text": {}}
for i in infos:
    if i.filename.endswith((".xhtml", ".opf", ".xml")):
        data = z.read(i.filename)
        try:
            ET.fromstring(data)
        except ET.ParseError as e:
            out["bad"].append(i.filename + ": " + str(e))
        out["text"][i.filename] = data.decode()
print(json.dumps(out))
`;

describe('ePubs: notebooks and books to carry off', function () {
    this.timeout(180000);

    let ada, adaRoot, work, one, two, pic, doodle, bookId;
    const bucket = 'stable';

    const fetchEpub = async (who, p) => {
        const res = await who(p);
        assert.equal(res.status, 200, await res.clone().text());
        assert.equal(res.headers.get('content-type'), 'application/epub+zip');
        const bytes = Buffer.from(await res.arrayBuffer());
        const file = path.join(work, `${crypto.randomBytes(4).toString('hex')}.epub`);
        fs.writeFileSync(file, bytes);
        const book = JSON.parse(
            execFileSync('python3', ['-c', INSPECT, file], { encoding: 'utf8' }),
        );
        return { bytes, book };
    };

    before(async () => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ringtome-epub-'));
        ada = await makeUserFetch({ prefix: 'epubada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
        pic = (
            await (
                await ada(`api/identity/${adaRoot}/docs/binary?title=plate`, {
                    method: 'POST',
                    body: makePng(48, 32),
                    file: true,
                })
            ).json()
        ).doc_id;
        for (let i = 0; i < 60; i++) {
            if ((await ada(`api/identity/${adaRoot}/docs/${pic}/body`)).status === 200) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        const mk = async (title, body, format = 'marquee') =>
            (await (await j(ada, `api/identity/${adaRoot}/docs`, { title, body, format })).json())
                .doc_id;
        two = await mk('The second page', 'The pony returns.');
        one = await mk(
            'The first page',
            `A pony :horse: - see [the next page](/ringtome/user/${adaRoot}/doc/${two}).\n\n![a plate](/api/identity/${adaRoot}/docs/${pic}/body/plate.avif)\n`,
        );
        doodle = await mk(
            'A doodle',
            JSON.stringify({
                strokes: [
                    {
                        id: '0000000000000001',
                        t: 1,
                        tool: 'brush',
                        color: '#000000',
                        size: 12,
                        points: [100, 100, 500, 300],
                    },
                ],
            }),
            'drawing',
        );
        for (const id of [one, two, doodle]) {
            await ada(`api/identity/${adaRoot}/docs/${id}/buckets/${bucket}`, { method: 'PUT' });
        }
        const tree = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: `wiki:${bucket}` })
            ).json()
        ).taxonomy_id;
        const part = (
            await (await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'Part one' })).json()
        ).taxonomy_id;
        await j(ada, `api/identity/${adaRoot}/taxonomies/${tree}/members/${one}`, {}, 'PUT');
        await j(ada, `api/identity/${adaRoot}/taxonomies/${tree}/members/${part}`, {}, 'PUT');
        await j(ada, `api/identity/${adaRoot}/taxonomies/${part}/members/${two}`, {}, 'PUT');
    });

    it('makes a notebook a well-formed ePub, in its tree order, its pictures its own', async () => {
        const { book } = await fetchEpub(ada, `api/identity/${adaRoot}/buckets/${bucket}/epub`);
        assert.equal(book.first, 'mimetype', 'the mimetype leads');
        assert.ok(book.stored, 'and is stored, not compressed');
        assert.equal(book.mimetype, 'application/epub+zip');
        assert.deepEqual(book.bad, [], 'every page is well-formed XML');
        const opf = book.text['OEBPS/content.opf'];
        const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(spine.slice(0, 4), [
            'cover-xhtml',
            'title-xhtml',
            'chapter-001-xhtml',
            'chapter-002-xhtml',
        ]);
        // The cover (2026-10-09): the first picture on the title page - here, the first page's plate.
        assert.match(opf, /properties="cover-image"/);
        assert.match(opf, /<meta name="cover" content="images-[0-9a-f]{32}-(jpg|png)"\/>/);
        assert.match(book.text['OEBPS/cover.xhtml'], /epub:type="cover"/);
        assert.match(book.text['OEBPS/chapter-001.xhtml'], /The first page/);
        assert.match(book.text['OEBPS/chapter-002.xhtml'], /The second page/);
        assert.match(book.text['OEBPS/nav.xhtml'], /<span>Part one<\/span>/, 'the section nests');
        const first = book.text['OEBPS/chapter-001.xhtml'];
        assert.match(first, /href="chapter-002.xhtml"/, 'the link leads to its chapter');
        assert.match(first, /🐴/, 'the emoji is its character');
        const img = /src="(images\/[0-9a-f]{32}\.(jpg|png))"/.exec(first);
        assert.ok(img, `the picture is the book's own: ${first}`);
        assert.ok(book.names.includes(`OEBPS/${img[1]}`));
        assert.ok(!book.names.some((n) => n.endsWith('.avif')), 'never an AVIF');
        assert.ok(
            book.names.includes(`OEBPS/images/${doodle}.png`),
            `the drawing, painted: ${book.names.join(', ')}`,
        );
    });

    it('the same notebook again is the same file; an edit is a new one', async () => {
        const first = await fetchEpub(ada, `api/identity/${adaRoot}/buckets/${bucket}/epub`);
        const again = await fetchEpub(ada, `api/identity/${adaRoot}/buckets/${bucket}/epub`);
        assert.ok(first.bytes.equals(again.bytes), 'served from the cache, byte for byte');
        const got = await (await ada(`api/identity/${adaRoot}/docs/${two}`)).json();
        await j(
            ada,
            `api/identity/${adaRoot}/docs/${two}`,
            {
                title: 'The second page',
                body: 'The pony returns, renamed.',
                parents: got.save_parents,
                format: 'marquee',
            },
            'PUT',
        );
        const edited = await fetchEpub(ada, `api/identity/${adaRoot}/buckets/${bucket}/epub`);
        assert.ok(!edited.bytes.equals(first.bytes), 'a new book');
        assert.match(edited.book.text['OEBPS/chapter-002.xhtml'], /renamed/);
    });

    it("a notebook's ePub is its persona's alone", async () => {
        const eve = await makeUserFetch({ prefix: 'epubeve' });
        assert.notEqual((await eve(`api/identity/${adaRoot}/buckets/${bucket}/epub`)).status, 200);
    });

    it("a public book is anyone's ePub: its pages, its pictures, nobody signed in", async () => {
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/books/${bucket}`,
            { value: JSON.stringify({ mode: 'book' }) },
            'PUT',
        );
        const asked = await j(ada, `api/identity/${adaRoot}/books/${bucket}/rollout`, {});
        assert.equal(asked.status, 200, await asked.text());
        let plan = null;
        for (let i = 0; i < 60; i++) {
            await beat(undefined, 'book-rollout', adaRoot);
            const r = await (await ada(`api/identity/${adaRoot}/private/kv/book_rollout`)).json();
            const row = (r.values || []).find((v) => v.key === bucket);
            plan = row ? JSON.parse(row.value) : null;
            if (plan && (plan.status === 'done' || plan.status === 'failed')) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        assert.equal(plan && plan.status, 'done', JSON.stringify(plan));
        const stranger = makeFetch();
        const { book } = await fetchEpub(
            stranger,
            `ringtome/user/${adaRoot}/post/${plan.book}/epub`,
        );
        assert.equal(book.first, 'mimetype');
        assert.deepEqual(book.bad, []);
        const pages = Object.entries(book.text)
            .filter(([n]) => /chapter-\d+\.xhtml$/.test(n))
            .map(([, text]) => text)
            .join('\n');
        assert.match(pages, /The first page/);
        assert.match(pages, /renamed/);
        assert.ok(
            book.names.some((n) => /^OEBPS\/images\/[0-9a-f]{32}\.(jpg|png)$/.test(n)),
            `the published picture, converted: ${book.names.join(', ')}`,
        );
        assert.equal(
            (await stranger(`ringtome/user/${adaRoot}/post/${'00'.repeat(16)}/epub`)).status,
            404,
            'no such book',
        );
        bookId = plan.book;
    });

    // A book sealed for trusted readers (2026-10-09): its own author - whom the seal always admits -
    // gets it opened; a stranger gets nothing, not even from the cache the author's copy filled.
    it("a trusted-only book is its trusted readers' ePub, opened, and nobody else's", async () => {
        const sealed = 'sealed-stable';
        const page = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'A sealed page',
                    body: 'Words for the trusted.',
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        await ada(`api/identity/${adaRoot}/docs/${page}/buckets/${sealed}`, { method: 'PUT' });
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/books/${sealed}`,
            { value: JSON.stringify({ mode: 'book' }) },
            'PUT',
        );
        const asked = await j(ada, `api/identity/${adaRoot}/books/${sealed}/rollout`, {
            trusted_only: true,
        });
        assert.equal(asked.status, 200, await asked.text());
        let plan = null;
        for (let i = 0; i < 60; i++) {
            await beat(undefined, 'book-rollout', adaRoot);
            const r = await (await ada(`api/identity/${adaRoot}/private/kv/book_rollout`)).json();
            const row = (r.values || []).find((v) => v.key === sealed);
            plan = row ? JSON.parse(row.value) : null;
            if (plan && (plan.status === 'done' || plan.status === 'failed')) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        assert.equal(plan && plan.status, 'done', JSON.stringify(plan));
        const at = `ringtome/user/${adaRoot}/post/${plan.book}/epub`;
        const { book } = await fetchEpub(ada, at);
        assert.deepEqual(book.bad, []);
        const pages = Object.entries(book.text)
            .filter(([n]) => /chapter-\d+\.xhtml$/.test(n))
            .map(([, text]) => text)
            .join('\n');
        assert.match(pages, /Words for the trusted\./, "opened with the reader's key");
        assert.equal((await makeFetch()(at)).status, 404, 'a stranger gets nothing');
        // Someone the author publishes trust for: the seal admits them, so the book is theirs too.
        const cal = await makeUserFetch({ prefix: 'epubcal' });
        const calRoot = (await (await cal('api/identity', { method: 'POST' })).json()).root_pubkey;
        assert.equal((await cal(at)).status, 404, 'not before the trust');
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${calRoot}/trust`,
            { value: 'max' },
            'PUT',
        );
        await beat(undefined, 'mint', adaRoot);
        await beat(undefined, 'fold', adaRoot);
        const theirs = await fetchEpub(cal, at);
        const words = Object.entries(theirs.book.text)
            .filter(([n]) => /chapter-\d+\.xhtml$/.test(n))
            .map(([, text]) => text)
            .join('\n');
        assert.match(words, /Words for the trusted\./, 'a trusted reader gets it opened');
    });

    // Field-found 2026-10-09: an ePub asked for on a node that FOLLOWS the author, not hosts them -
    // a book being read there - answered "no such book here". Held is enough, as for its pages.
    (HOST_B ? it : it.skip)(
        "a book followed from elsewhere is the follower's node's ePub too",
        async () => {
            const bea = await makeUserFetch({ prefix: 'epubbea', host: HOST_B });
            const beaRoot = (await (await bea('api/identity', { method: 'POST' })).json())
                .root_pubkey;
            await j(
                bea,
                `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`,
                { value: 'high' },
                'PUT',
            );
            const onB = makeFetch(HOST_B);
            let res;
            for (let i = 0; i < 20; i++) {
                await beat(HOST_B, 'follow-refresh');
                await pullAndFold(HOST_B, adaRoot);
                await beat(HOST_B, 'bodies-sweep');
                res = await onB(`ringtome/user/${adaRoot}/post/${bookId}/epub`);
                if (res.status === 200) break;
                await new Promise((r) => setTimeout(r, 500));
            }
            assert.equal(res.status, 200, await res.text());
            assert.equal(res.headers.get('content-type'), 'application/epub+zip');
        },
    );
});
