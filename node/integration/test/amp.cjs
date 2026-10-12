/*
    hrseAmp's library (plans/AUDIO.md, slice 1): the sound in a reader's feed, from the node - a
    sound posted on its own, and one with words around it, each a row with what the table
    needs of it: who made it, its post, how long it plays, and the post's score for this reader.
    The reader's own sounds are the browser's (its mirror), never the door's; a post with no sound
    is no row. And the door reads an author's database once per version of a post, into the node's
    memo (`amp_sounds`), not once per request.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, sql } = require('./fetch.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));

describe('hrseAmp: the library of sound in your feed', function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot;
    let alone, aloneSound, embedded, written, writtenNote, twin, silent, mine;
    const setField = (who, root, doc, field, value) =>
        who(`api/identity/${root}/docs/${doc}/annotations/fields/${encodeURIComponent(field)}`, {
            method: value ? 'PUT' : 'DELETE',
            body: value ? JSON.stringify({ value }) : undefined,
        });

    const persona = async (prefix) => {
        const who = await makeUserFetch({ prefix });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(who, `api/identity/${root}/serve`, {});
        return [who, root];
    };
    // Different bytes for each: the same bytes uploaded twice are one document.
    const uploaded = async (who, root, title, file = 'buck-audio.ogg') => {
        const made = await (
            await who(`api/identity/${root}/docs/binary?title=${title}`, {
                method: 'POST',
                body: sample(file),
                file: true,
            })
        ).json();
        for (let i = 0; i < 240; i++) {
            if ((await who(`api/identity/${root}/docs/${made.doc_id}/body`)).status === 200)
                return made.doc_id;
            await wait(500);
        }
        throw new Error(`${title} never finished ingesting`);
    };
    const published = async (who, root, doc) => {
        for (let i = 0; i < 200; i++) {
            const r = await j(who, `api/identity/${root}/docs/${doc}/publish`, {});
            const said = await r.text();
            if (r.status === 200) return JSON.parse(said).post_id;
            // Still baking, or the words still landing: both settle on their own.
            assert.ok(
                r.status === 202 || said.includes('this-notes-words-havent-arrived'),
                `${r.status} ${said}`,
            );
            await wait(500);
        }
        throw new Error('never published');
    };
    const written_ = async (who, root, title, body) =>
        (
            await (
                await j(who, `api/identity/${root}/docs`, { title, body, format: 'marquee' })
            ).json()
        ).doc_id;
    const library = async () => {
        const r = await ada(`api/identity/${adaRoot}/amp/library`);
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
    };

    before(async () => {
        [ada, adaRoot] = await persona('ampada');
        [bea, beaRoot] = await persona('ampbea');
        await j(bea, `api/identity/${beaRoot}/profile`, { field: 'name', value: 'Bea' });
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/interest`,
            { value: 'max' },
            'PUT',
        );
        // A post that is a sound and nothing else, and one with words around it.
        const embed = (doc) => `![buck](/api/identity/${beaRoot}/docs/${doc}/body/buck.opus)\n`;
        aloneSound = await uploaded(bea, beaRoot, 'buck');
        alone = await published(
            bea,
            beaRoot,
            await written_(bea, beaRoot, 'Buck', embed(aloneSound)),
        );
        embedded = await uploaded(bea, beaRoot, 'second buck', 'buck-audio.mp3');
        // Its fields, as bea set them on her own sound: they travel to its twin (slice 4).
        for (const [field, value] of [
            ['track', 'Second Buck'],
            ['artist', 'The Bucks'],
            ['album', 'Meadow'],
        ]) {
            const r = await setField(bea, beaRoot, embedded, field, value);
            assert.equal(r.status, 200, await r.text());
        }
        writtenNote = await written_(bea, beaRoot, 'Noises', `listen\n\n${embed(embedded)}`);
        written = await published(bea, beaRoot, writtenNote);
        // Words alone: no row.
        silent = await published(
            bea,
            beaRoot,
            await written_(bea, beaRoot, 'Quiet', 'nothing to hear'),
        );
        // Ada's own sound: hers are the mirror's, never the door's.
        const myBuck = await uploaded(ada, adaRoot, 'my buck', 'buck-cover.mp3');
        mine = await published(
            ada,
            adaRoot,
            await written_(
                ada,
                adaRoot,
                'Mine',
                `![buck](/api/identity/${adaRoot}/docs/${myBuck}/body/buck.opus)\n`,
            ),
        );

        let arrived = false;
        for (let i = 0; i < 40 && !arrived; i++) {
            await beat(HOST, 'journal-fill');
            const posts = new Set((await library()).sounds.map((s) => s.post));
            arrived = posts.has(alone) && posts.has(written);
            if (!arrived) await wait(300);
        }
        assert.ok(arrived, "bea's sound reached ada's library");
    });

    it('a post that is a sound and one with words around it are each a row; words alone and your own are not', async () => {
        const { sounds, names } = await library();
        const of = (post) => sounds.filter((s) => s.post === post);
        assert.equal(of(alone).length, 1, JSON.stringify(sounds));
        assert.notEqual(of(alone)[0].doc, alone, 'the row is the sound the post carries');
        assert.equal(of(alone)[0].author, beaRoot);
        assert.ok(of(alone)[0].duration_ms > 0, 'it says how long it plays');

        assert.equal(of(written).length, 1, 'the written post carries one sound');
        twin = of(written)[0].doc;
        assert.notEqual(twin, of(alone)[0].doc, 'two sounds, two rows');
        assert.notEqual(twin, written, 'the row is the embedded sound, not the words');
        assert.ok(of(written)[0].duration_ms > 0);

        assert.equal(of(silent).length, 0, 'words alone are no row');
        assert.equal(of(mine).length, 0, "ada's own sound is her mirror's");
        assert.equal(names[beaRoot], 'Bea', 'the By column has a name to show');
    });

    it("the row's sound plays from the author's public door", async () => {
        const row = (await library()).sounds.find((s) => s.post === written);
        const body = await ada(`id/${row.author}/docs/${row.doc}/body`);
        assert.equal(body.status, 200);
    });

    it("carries the post's score for this reader", async () => {
        // Someone ada trusts likes it, as the feed's score would have it.
        const [cal, calRoot] = await persona('ampcal');
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${calRoot}/trust`,
            { value: 'max' },
            'PUT',
        );
        const liked = await j(
            cal,
            `api/identity/${calRoot}/public-annotations/${beaRoot}/${alone}`,
            { key: 'tag', value: '\u{1F44D}' },
            'PUT',
        );
        assert.equal(liked.status, 200, await liked.text());
        let score = 0;
        for (let i = 0; i < 30 && !score; i++) {
            score = (await library()).sounds.find((s) => s.post === alone).score;
            if (!score) await wait(300);
        }
        assert.ok(score > 0, `a like lifts it: ${score}`);
        // Whose tags (ruling 12): the friend's like is a tag ada can see, but not the author's or hers.
        const row = (await library()).sounds.find((s) => s.post === alone);
        assert.ok(row.tags.includes('\u{1F44D}'), JSON.stringify(row.tags));
        assert.ok(!row.our_tags.includes('\u{1F44D}'), JSON.stringify(row.our_tags));
        assert.equal(row.tag_counts['\u{1F44D}'], 1, 'how many said it, for the Score column');
    });

    it("reads an author's database once per version of a post, into the node's memo", async () => {
        const memo = async () =>
            (
                await sql(
                    `SELECT post_doc, sound_doc, post_updated_ms FROM amp_sounds WHERE author_root = '${beaRoot}' ORDER BY post_doc`,
                )
            ).rows;
        const before = await memo();
        assert.ok(
            before.some((r) => r.post_doc === written && r.sound_doc === twin),
            JSON.stringify(before),
        );
        // Change what the memo says, under the door: if it read bea's database again, the
        // title would come back.
        await sql(
            `UPDATE amp_sounds SET title = 'from the memo' WHERE author_root = '${beaRoot}' AND post_doc = '${alone}'`,
        );
        const row = (await library()).sounds.find((s) => s.post === alone);
        assert.equal(row.title, 'from the memo', 'the memo answered; the database was not opened');
        assert.deepEqual(await memo(), before, 'the memo is as it was');
    });

    it('a sound posted again is one row, from the newest post it came in', async () => {
        const again = await published(
            bea,
            beaRoot,
            await written_(
                bea,
                beaRoot,
                'Noises again',
                `once more\n\n![buck](/api/identity/${beaRoot}/docs/${embedded}/body/buck.opus)\n`,
            ),
        );
        let rows = [];
        for (let i = 0; i < 40; i++) {
            await beat(HOST, 'journal-fill');
            rows = (await library()).sounds.filter((s) => s.doc === twin);
            if (rows.some((r) => r.post === again)) break;
            await wait(300);
        }
        assert.equal(rows.length, 1, JSON.stringify(rows));
        assert.equal(rows[0].post, again);
    });

    it("an embedded sound's fields travel to its twin, and a republish keeps them current (slice 4)", async () => {
        // By the sound: an earlier claim posted it again, so its row is the newest post's.
        const row = async () => (await library()).sounds.find((s) => s.doc === twin);
        const first = await row();
        assert.deepEqual(
            [first.fields.track, first.fields.artist, first.fields.album],
            ['Second Buck', 'The Bucks', 'Meadow'],
            JSON.stringify(first.fields),
        );
        // Bea renames the artist and clears the album, then publishes the post again.
        await setField(bea, beaRoot, embedded, 'artist', 'Bucks Unlimited');
        await setField(bea, beaRoot, embedded, 'album', '');
        assert.equal(await published(bea, beaRoot, writtenNote), written, 'the same post');
        let now = null;
        for (let i = 0; i < 30; i++) {
            await beat(HOST, 'fold', beaRoot);
            now = await row();
            if (now.fields.artist === 'Bucks Unlimited' && !now.fields.album) break;
            await wait(300);
        }
        assert.equal(now.fields.artist, 'Bucks Unlimited');
        assert.equal(now.fields.album, undefined, 'a cleared field is taken back');
        assert.equal(now.fields.track, 'Second Buck');
        // And how loud it is (section 9): measured at the ingest, said on the twin with the rest.
        assert.ok(Number(now.fields.loudness) < 0, `a loudness in LUFS: ${now.fields.loudness}`);
    });

    it("a copied sound carries its author's fields onto the copy", async () => {
        // Ada embeds bea's public sound in a post of her own: publishing copies it into ada's twin.
        const note = await written_(
            ada,
            adaRoot,
            'Heard',
            `![buck](/id/${beaRoot}/docs/${twin}/body/buck.opus)\n`,
        );
        const post = await published(ada, adaRoot, note);
        const words = await (await ada(`id/${adaRoot}/docs/${post}/body`)).text();
        const copy = (words.match(/\/doc\/([0-9a-f]{32})\//) || [])[1];
        assert.ok(copy, `the post embeds ada's own copy: ${words}`);
        let said = [];
        for (let i = 0; i < 30; i++) {
            const r = await ada(`api/identity/${adaRoot}/public-annotations/${adaRoot}/${copy}`);
            said = ((await r.json()).items || []).map((a) => `${a.key}=${a.value}`);
            if (said.includes('artist=Bucks Unlimited')) break;
            await wait(300);
        }
        assert.ok(said.includes('track=Second Buck'), JSON.stringify(said));
        assert.ok(said.includes('artist=Bucks Unlimited'), JSON.stringify(said));
    });

    it('keeps a song in one of your mixtapes after it leaves your feed (section 5)', async () => {
        const before = await library();
        const alonesSound = before.sounds.find((s) => s.post === alone).doc;
        // Ada puts bea's second song on a mixtape: a taxonomy titled mixtape:<name>.
        const made = await j(ada, `api/identity/${adaRoot}/taxonomies`, {
            title: 'mixtape:Keepers',
        });
        const tape = (await made.json()).taxonomy_id;
        const put = await j(
            ada,
            `api/identity/${adaRoot}/taxonomies/${tape}/members/${twin}`,
            {
                member_root: beaRoot,
            },
            'PUT',
        );
        assert.equal(put.status, 200, await put.text());
        // Then stops following bea: her songs leave the feed, and the library with it - but not
        // the one ada kept.
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/interest`,
            { value: 'none' },
            'PUT',
        );
        let sounds = [];
        for (let i = 0; i < 30; i++) {
            sounds = (await library()).sounds;
            if (!sounds.some((s) => s.doc === alonesSound)) break;
            await wait(300);
        }
        assert.ok(
            !sounds.some((s) => s.doc === alonesSound),
            'an unkept song leaves with the follow',
        );
        const kept = sounds.find((s) => s.doc === twin);
        assert.ok(kept, `the mixtape's song stays: ${JSON.stringify(sounds.map((s) => s.doc))}`);
        assert.equal(kept.kept, true);
        assert.equal(kept.author, beaRoot);
        assert.equal(kept.fields.artist, 'Bucks Unlimited', 'with its fields, from its twin');
        assert.ok(kept.duration_ms > 0);
    });
});
