// One publish in the client (plans/ONE_PUBLISH.md, slice 2): the feed's composer and a new chat
// room, driven in the real app, each going out through `publishTo` to the door its choice means -
// everyone, a group, a copy of a sealed post that keeps its seal, a room in a group.
//
//   RINGTOME_SCRATCH_1=http://localhost:<port> node harness/publish-to-probe.mjs
import { session, signUp, sleep, waitFor, click } from './boot.mjs';

const BASE = process.env.RINGTOME_SCRATCH_1 || 'http://localhost:5299';
const J = { 'Content-Type': 'application/json' };
const s = session(BASE);
await signUp(s, 'publishto');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json())
    .root_pubkey;
const api = async (path, method = 'GET', body) => {
    const r = await s.fetch(path, { method, headers: J, body: body && JSON.stringify(body) });
    const text = await r.text();
    return text ? JSON.parse(text) : {};
};
const docs = async () => {
    const all = await api(`/api/identity/${root}/docs`);
    return Array.isArray(all) ? all : all.docs || [];
};
const field = (doc, name, value) =>
    api(`/api/identity/${root}/docs/${doc}/annotations/fields/${name}`, 'PUT', { value });
const fieldsOf = async (doc) => {
    const a = await api(`/api/identity/${root}/docs/${doc}/annotations`);
    return Array.isArray(a.fields) ? Object.fromEntries(a.fields) : a.fields || {};
};
let failed = 0;
const check = (what, ok, detail = '') => {
    if (!ok) failed++;
    console.log(`RESULT ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` - ${detail}` : ''}`);
};

/// The composer's open draft, given words, then posted from the real composer at `path`.
const compose = async (path, words, before, choice = null) => {
    const warm = await s.boot('/ringtome/feed');
    await waitFor(
        warm.window.document,
        () => warm.window.document.querySelector('.feed-composer'),
        'the composer',
    );
    await sleep(600);
    const draft = (await docs()).find(
        (d) => (d.buckets || []).includes('feed') && !(d.fields || {}).published_as,
    );
    const detail = await api(`/api/identity/${root}/docs/${draft.doc_id}`);
    await api(`/api/identity/${root}/docs/${draft.doc_id}`, 'PUT', {
        title: words,
        body: `${words}, said`,
        format: 'marquee',
        parents: detail.save_parents,
    });
    if (before) await before(draft.doc_id);
    await sleep(800);
    const dom = await s.boot(path);
    const doc = dom.window.document;
    const button = await waitFor(
        doc,
        () => {
            const b = doc.querySelector('.feed-composer .feed-post');
            return b && !b.disabled ? b : null;
        },
        'a post button with words behind it',
    );
    if (choice !== null) {
        // Chosen in the composer's own "only show to", as a person picks it.
        const select = await waitFor(
            doc,
            () => {
                const sel = doc.querySelector('.feed-audience');
                return sel && [...sel.options].some((o) => o.value === choice) ? sel : null;
            },
            `${choice} in the composer's picker`,
        );
        select.value = choice;
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await sleep(300);
    }
    click(dom.window, button);
    for (let i = 0; i < 60; i++) {
        await sleep(250);
        const f = await fieldsOf(draft.doc_id);
        const groups = await api(`/api/identity/${root}/docs/${draft.doc_id}/groups`);
        if (f.published_as || (Array.isArray(groups) && groups.length)) break;
    }
    const error = doc.querySelector('.feed-composer ~ .form-error, .form-error');
    return { draft: draft.doc_id, error: error && error.textContent };
};

// 1. Everyone: a public post.
{
    const { draft, error } = await compose('/ringtome/feed', 'open words');
    const f = await fieldsOf(draft);
    check('the composer posts to everyone', !!f.published_as, error || '');
}

// 2. A group, chosen in the composer.
const { group } = await api(`/api/identity/${root}/groups`, 'POST', { name: 'Probe Club' });
{
    const { draft, error } = await compose('/ringtome/feed', 'club words', null, `group:${group}`);
    const where = await api(`/api/identity/${root}/docs/${draft}/groups`);
    const f = await fieldsOf(draft);
    check(
        'the composer posts into a group',
        Array.isArray(where) && where.some((w) => w.group === group) && !f.published_as,
        error || JSON.stringify(where),
    );
}

// 3. A copy of a sealed post: "everyone" in the composer is nothing picked, so its seal holds.
{
    const { draft, error } = await compose('/ringtome/feed', 'sealed words', (doc) =>
        field(doc, 'seal', 'yes'),
    );
    const f = await fieldsOf(draft);
    const head = f.published_as && (await api(`/api/id/${root}/posts/${f.published_as}`));
    check(
        'a copy of a sealed post keeps its seal',
        !!head && head.trusted_only === true,
        error || '',
    );
}

// 4. A new room, in the group: chat's own form, through the one publish. A public group of
// theirs too, so the picker has an "in public, as" it could wrongly offer.
const square = (
    await api(`/api/identity/${root}/groups`, 'POST', { name: 'Probe Square', public: true })
).group;
{
    const dom = await s.boot('/ringtome/chat/new');
    const doc = dom.window.document;
    const name = await waitFor(
        doc,
        () => doc.querySelector('.chat-new input'),
        'the new-room form',
    );
    name.value = 'probe room';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const select = await waitFor(
        doc,
        () => {
            const sel = doc.querySelector('.chat-new select');
            const values = sel ? [...sel.options].map((o) => o.value) : [];
            return values.includes(`group:${group}`) && values.includes(`group:${square}`)
                ? sel
                : null;
        },
        'both groups in the room picker',
    );
    check(
        'the room picker offers no "in public, as a group"',
        ![...select.options].some((o) => o.value.startsWith('as-group:')),
    );
    select.value = `group:${group}`;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep(200);
    const form = doc.querySelector('.chat-new');
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    let rooms = [];
    for (let i = 0; i < 40 && !rooms.length; i++) {
        await sleep(250);
        const page = await api(`/api/identity/${root}/groups/${group}/posts`);
        rooms = (page.posts || []).filter((p) => p.title === 'probe room');
    }
    check('a new room goes into the group', rooms.length === 1);
}

console.log(failed ? `FAILED ${failed}` : 'ALL OK');
process.exit(failed ? 1 : 0);
