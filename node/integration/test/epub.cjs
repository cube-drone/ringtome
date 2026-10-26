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

    // A book is made in the background (2026-10-09): ask until it is ready, as the page does.
    const fetchEpub = async (who, p) => {
        let res;
        for (let i = 0; i < 120; i++) {
            res = await who(p);
            if (res.status !== 202) break;
            const made = await res.json();
            assert.notEqual(made.status, 'failed', made.error);
            await new Promise((r) => setTimeout(r, 250));
        }
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
        // Asked for the first time, it is made in the background, and the asker is told how far.
        const asked = await ada(`api/identity/${adaRoot}/buckets/${bucket}/epub`);
        assert.equal(asked.status, 202);
        const made = await asked.json();
        assert.equal(made.status, 'building');
        assert.ok(
            made.total >= 4,
            `a picture, three pages and a drawing to make: ${JSON.stringify(made)}`,
        );
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

    it('as the chronological tab lists it: newest first, no sections, a book of its own (2026-10-22)', async () => {
        const path = `api/identity/${adaRoot}/buckets/${bucket}/epub`;
        const { book } = await fetchEpub(ada, `${path}?order=chronological&tz=0`);
        assert.deepEqual(book.bad, [], 'every page is well-formed XML');
        const chapters = Object.keys(book.text)
            .filter((n) => /chapter-\d+\.xhtml$/.test(n))
            .sort()
            .map((n) => /<h1[^>]*>([^<]*)</.exec(book.text[n])?.[1] || n);
        assert.deepEqual(
            chapters,
            ['A doodle', 'The first page', 'The second page'],
            'newest first, the doodle the tree never placed among them',
        );
        assert.doesNotMatch(book.text['OEBPS/nav.xhtml'], /Part one/, 'no sections');
        const id = (opf) => /<dc:identifier[^>]*>([^<]+)</.exec(opf)?.[1];
        const tree = (await fetchEpub(ada, path)).book;
        assert.notEqual(
            id(book.text['OEBPS/content.opf']),
            id(tree.text['OEBPS/content.opf']),
            "an e-reader keeps it apart from the tree's",
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

    it('a deleted page is in neither book (2026-10-24)', async () => {
        // Deleting unfiles a page from every tree but leaves its notebook name on it, and the tree's
        // book ended on every unplaced page the notebook named - the deleted among them.
        const gone = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'A deleted page',
                    body: 'Thrown away.',
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        await ada(`api/identity/${adaRoot}/docs/${gone}/buckets/${bucket}`, { method: 'PUT' });
        const del = await ada(`api/identity/${adaRoot}/docs/${gone}`, { method: 'DELETE' });
        assert.ok(del.ok, await del.text());
        const path = `api/identity/${adaRoot}/buckets/${bucket}/epub`;
        for (const p of [path, `${path}?order=chronological&tz=0`]) {
            const { book } = await fetchEpub(ada, p);
            const pages = Object.values(book.text).join('\n');
            assert.doesNotMatch(pages, /A deleted page/, `${p}: the deleted page left out`);
            assert.match(pages, /The second page/, `${p}: the kept pages still in`);
        }
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

    // Downloads as files (Curtis, 2026-10-26: "replace "ePub" with "download" and have that bring
    // up a list of download types"): the same pages, in one folder, as the tree nests them, with
    // their links and pictures pointing into it.
    const ZIP = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
out = {"names": z.namelist(), "text": {}}
for n in z.namelist():
    if n.endswith((".md", ".mq", ".html", ".css", ".txt")):
        out["text"][n] = z.read(n).decode()
print(json.dumps(out))
`;
    const fetchZip = async (who, p, named) => {
        let res;
        for (let i = 0; i < 120; i++) {
            res = await who(p);
            if (res.status !== 202) break;
            const made = await res.json();
            assert.notEqual(made.status, 'failed', made.error);
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.equal(res.status, 200, await res.clone().text());
        assert.equal(res.headers.get('content-type'), 'application/zip');
        assert.match(res.headers.get('content-disposition'), new RegExp(`filename="${named}"`));
        const file = path.join(work, `${crypto.randomBytes(4).toString('hex')}.zip`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        return JSON.parse(execFileSync('python3', ['-c', ZIP, file], { encoding: 'utf8' }));
    };

    it('a notebook downloads as Markdown, Markdown with front matter, Marquee, and HTML', async () => {
        const door = `api/identity/${adaRoot}/buckets/${bucket}/download`;
        const md = await fetchZip(ada, `${door}/markdown`, 'stable.markdown.zip');
        const first = md.text['stable/The first page.md'];
        assert.ok(first, `the page, named for its title: ${md.names.join(', ')}`);
        assert.ok(md.text['stable/Part one/The second page.md'], 'the section, a folder');
        assert.match(first, /\]\(Part%20one\/The%20second%20page\.md\)/, 'the link, to its file');
        const plate = new RegExp(`\\]\\((pictures/${pic}\\.(avif|png))\\)`).exec(first);
        assert.ok(plate, `the picture, to its file: ${first}`);
        assert.ok(md.names.includes(`stable/${plate[1]}`), 'which is in the zip, as stored');
        assert.ok(md.names.includes('stable/A doodle.png'), 'the drawing, painted');
        assert.doesNotMatch(first, /^---/, 'no front matter');

        const yml = await fetchZip(ada, `${door}/markdown-yaml`, 'stable.markdown.yaml.zip');
        const front = yml.text['stable/The first page.md'];
        assert.match(front, /^---\n/);
        assert.match(front, /"title": "The first page"/);
        assert.match(front, /"buckets": \["stable"\]/);

        const mq = await fetchZip(ada, `${door}/marquee`, 'stable.marquee.zip');
        const source = mq.text['stable/The first page.mq'];
        assert.match(source, /^:::meta /);
        assert.match(source, /\[the next page\]\(Part%20one\/The%20second%20page\.mq\)/);

        const web = await fetchZip(ada, `${door}/html`, 'stable.html.zip');
        assert.match(web.text['stable/index.html'], /href="Part%20one\/The%20second%20page\.html"/);
        assert.match(
            web.text['stable/The first page.html'],
            /href="Part%20one\/The%20second%20page\.html"/,
        );
        assert.match(web.text['stable/The first page.html'], new RegExp(`src="pictures/${pic}\\.`));
        const deep = web.text['stable/Part one/The second page.html'];
        assert.match(deep, /href="\.\.\/style\.css"/, 'a page in a section finds the stylesheet');
        assert.match(deep, /href="\.\.\/index\.html"/, 'and the contents');
        assert.ok(web.text['stable/style.css'], 'the stylesheet');

        assert.equal((await ada(`${door}/docx`)).status, 404, 'no such download');
        const eve = await makeUserFetch({ prefix: 'epubeve2' });
        assert.notEqual((await eve(`${door}/markdown`)).status, 200, "the persona's alone");
    });

    it('a public book downloads as files too, for anyone', async () => {
        const stranger = makeFetch();
        const door = `ringtome/user/${adaRoot}/post/${bookId}/download`;
        const md = await fetchZip(stranger, `${door}/markdown`, '[a-z0-9-]+\\.markdown\\.zip');
        const pages = Object.entries(md.text)
            .filter(([n]) => n.endsWith('.md'))
            .map(([, text]) => text)
            .join('\n');
        assert.match(pages, /renamed/, `its pages: ${md.names.join(', ')}`);
        assert.ok(
            md.names.some((n) => /\/pictures\/[0-9a-f]{32}\.(avif|png)$/.test(n)),
            `the published picture, as stored: ${md.names.join(', ')}`,
        );
        const res = await stranger(`${door}/epub`);
        assert.ok([200, 202].includes(res.status), 'the ePub, by the same door');
    });
});
