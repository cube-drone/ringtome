/*
    PUBLISH.md slice 2: a future preferred date is a schedule. Nothing touches the public
    chain until the day; the author's node mints it when its moment comes - the same bake
    door, the same after-mint duties - and a second beat mints nothing twice.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');

describe('scheduled posts: a future date holds the mint until its day', function () {
    this.timeout(600000);

    let ada, adaRoot, draft, at;

    const shelf = async () => (await (await ada(`api/id/${adaRoot}/posts`)).json()).posts || [];

    before(async () => {
        ada = await makeUserFetch({ prefix: 'schedada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
    });

    it('publishing with a future date schedules instead of minting', async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: 'POST',
                body: JSON.stringify({
                    title: 'next year',
                    body: 'from the future',
                    format: 'plaintext',
                }),
            })
        ).json();
        draft = made.doc_id;
        await ada(`api/identity/${adaRoot}/docs/${draft}/annotations/fields/display_date`, {
            method: 'PUT',
            body: JSON.stringify({ value: '2031-01-01' }),
        });
        const pub = await ada(`api/identity/${adaRoot}/docs/${draft}/publish`, { method: 'POST' });
        const body = JSON.parse(await pub.text());
        assert.equal(pub.status, 200);
        assert.ok(!body.post_id, 'nothing minted');
        assert.ok(body.scheduled_for > Date.now(), 'scheduled for a moment ahead');
        at = body.scheduled_for;
        assert.equal(
            (await shelf()).some((p) => p.title === 'next year'),
            false,
            'nothing public',
        );
    });

    it('the sweep leaves it alone before its day', async () => {
        const beat = await ada('test/beat', {
            method: 'POST',
            body: JSON.stringify({ pass: 'publish-due', root: adaRoot }),
        });
        assert.equal(beat.status, 200, await beat.text());
        assert.equal(
            (await shelf()).some((p) => p.title === 'next year'),
            false,
            'still nothing public',
        );
    });

    it('and mints it once the day comes - exactly once', async () => {
        const ring = () =>
            ada('test/beat', {
                method: 'POST',
                body: JSON.stringify({ pass: 'publish-due', root: adaRoot, at_ms: at + 1000 }),
            });
        assert.equal((await ring()).status, 200);
        const posts = (await shelf()).filter((p) => p.title === 'next year');
        assert.equal(posts.length, 1, 'minted');
        assert.equal(posts[0].published_ms, at, 'under its scheduled moment');
        assert.equal((await ring()).status, 200);
        assert.equal(
            (await shelf()).filter((p) => p.title === 'next year').length,
            1,
            'never twice',
        );
    });
});

/*
    plans/ONE_PUBLISH.md, rulings 1 and 2, on the public road: a reply or a room is refused a
    future date (it answers, or opens, now), and an edit of a live post publishes at once,
    keeping the date it carries - a date never takes a live post back.
*/
describe('scheduled posts: a future date holds only a new post back', function () {
    this.timeout(600000);

    let ada, adaRoot;

    const j = (path, body, method = 'POST') =>
        ada(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const draftDated = async (title, date) => {
        const made = await (
            await j(`api/identity/${adaRoot}/docs`, {
                title,
                body: `${title}, said`,
                format: 'marquee',
            })
        ).json();
        if (date) {
            const put = await j(
                `api/identity/${adaRoot}/docs/${made.doc_id}/annotations/fields/display_date`,
                { value: date },
                'PUT',
            );
            assert.equal(put.status, 200);
        }
        return made.doc_id;
    };
    const publish = async (doc, body = {}) => {
        const res = await j(`api/identity/${adaRoot}/docs/${doc}/publish`, {
            tz_offset_min: 0,
            ...body,
        });
        return { status: res.status, body: JSON.parse((await res.text()) || '{}') };
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'schedrules' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
    });

    it('a reply or a room is refused a future date, and posts with none', async () => {
        const parent = (await publish(await draftDated('the parent'))).body.post_id;
        assert.ok(parent, 'a post to answer');
        const reply = await draftDated('a later answer', '2031-01-01');
        const refused = await publish(reply, { reply_to: { author: adaRoot, doc_id: parent } });
        assert.equal(refused.status, 400, 'a reply answers now');
        assert.match(refused.body.message, /reply or a room/);
        const room = await publish(await draftDated('a later room', '2031-01-01'), { room: true });
        assert.equal(room.status, 400, 'a room opens now');
        const dated = await j(
            `api/identity/${adaRoot}/docs/${reply}/annotations/fields/display_date`,
            { value: '2020-01-01' },
            'PUT',
        );
        assert.equal(dated.status, 200);
        const answered = await publish(reply, { reply_to: { author: adaRoot, doc_id: parent } });
        assert.equal(answered.status, 200, 'a past date is fine');
        assert.ok(answered.body.post_id);
    });

    it('an edit of a live post with a future date publishes now and keeps its date', async () => {
        const doc = await draftDated('already out', '2020-03-04');
        const first = await publish(doc);
        assert.ok(first.body.post_id, 'live');
        const put = await j(
            `api/identity/${adaRoot}/docs/${doc}/annotations/fields/display_date`,
            { value: '2031-01-01' },
            'PUT',
        );
        assert.equal(put.status, 200);
        const edit = await publish(doc);
        assert.equal(edit.status, 200, JSON.stringify(edit.body));
        assert.equal(edit.body.post_id, first.body.post_id, 'the same post, edited now');
        assert.ok(!edit.body.scheduled_for, 'not a schedule');
        assert.equal(edit.body.date_kept, true, 'and it says the date stayed');
        assert.equal(edit.body.dated_ms, first.body.dated_ms, 'the date it carried');
        const fields = (await (await ada(`api/identity/${adaRoot}/docs/${doc}/annotations`)).json())
            .fields;
        const plan = Array.isArray(fields)
            ? (fields.find(([k]) => k === 'publish_plan') || [])[1]
            : fields.publish_plan;
        assert.ok(!plan, 'and no plan is left to lose it');
    });
});
