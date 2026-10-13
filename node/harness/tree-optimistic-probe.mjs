// The tree moves when you move it (2026-10-13), not when a busy server has answered: a new page
// made in a section shows in that section - never a beat in unfiled - and a dragged page shows where
// it was dropped, while the writes and the tree's read are HELD here. Let through, nothing snaps
// back; a write the node refuses puts the page back where it was, and says why.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node tree-optimistic-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';

const J = { 'Content-Type': 'application/json' };
const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'treefast');
const api = async (path, method = 'GET', body) =>
    (await s.fetch(path, { method, headers: J, body: body && JSON.stringify(body) })).json();
const root = (await api('/api/identity', 'POST')).root_pubkey;
const tax = (title) => api(`/api/identity/${root}/taxonomies`, 'POST', { title });
const place = (into, id) =>
    s.fetch(`/api/identity/${root}/taxonomies/${into}/members/${id}`, {
        method: 'PUT',
        headers: J,
        body: '{}',
    });
// The notebook's tree: its root, a section "Landscapes", and a note "mesa" in it.
const top = (await tax('wiki:default')).taxonomy_id;
const landscapes = (await tax('Landscapes')).taxonomy_id;
await place(top, landscapes);
const mesa = await api(`/api/identity/${root}/docs`, 'POST', {
    title: 'mesa',
    body: 'a flat top',
    format: 'marquee',
});
await s.fetch(`/api/identity/${root}/docs/${mesa.doc_id}/buckets/default`, { method: 'PUT' });
await place(landscapes, mesa.doc_id);

const dom = await s.boot('/ringtome/notes');
const { window } = dom;
const doc = window.document;
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await waitFor(doc, () => doc.querySelector('.pane-rail[title="show tree"]'), 'the tree rail');
click(doc.querySelector('.pane-rail[title="show tree"]'));
const rows = () => [...doc.querySelectorAll('.tree-pane .tree-row')];
const row = (title) =>
    rows().find(
        (r) =>
            !r.closest('.tree-unfiled') &&
            r.querySelector('.tree-row-title')?.textContent.trim() === title,
    );
const depth = (r) => r && parseFloat(r.style.paddingLeft);
const unfiled = () =>
    [...doc.querySelectorAll('.tree-unfiled .tree-row-title')].map((t) => t.textContent.trim());
await waitFor(doc, () => row('mesa'), 'the tree, with mesa in Landscapes');
console.log('RESULT mesa starts inside Landscapes:', depth(row('mesa')) > depth(row('Landscapes')));

// Hold the tree's writes and its reads: the server as slow as it was.
const real = window.fetch;
let gate = null;
let refuse = false;
window.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    const write = /\/taxonomies\/[0-9a-f]+\/members\//.test(u) && method !== 'GET';
    const read = /\/taxonomies\/[0-9a-f]+$/.test(u) && method === 'GET';
    if (write && refuse) throw new Error('the node said no');
    if ((write || read) && gate) await gate;
    return real(url, opts);
};
let release;
gate = new Promise((r) => (release = r));

// A new note, made in the section.
const plus = row('Landscapes').querySelector('.tree-act');
const paneBefore = doc.querySelector('aside.tree-pane');
click(plus);
await sleep(600);
console.log(
    'DEBUG same pane after opening the new note:',
    paneBefore === doc.querySelector('aside.tree-pane'),
    doc.location.pathname,
);
const fresh = row('untitled');
console.log(
    'RESULT a new note shows in its section before the node answers:',
    !!fresh && depth(fresh) > depth(row('Landscapes')),
);
console.log('RESULT and never in unfiled:', !unfiled().includes('untitled'));

// A new note from the list's "new": filed at the top of the tree, and shown there at once.
const listNew = doc.querySelector('.notes-new');
if (listNew) {
    const before = rows().length;
    click(listNew);
    await sleep(600);
    const tops = rows().filter(
        (r) => !r.closest('.tree-unfiled') && depth(r) === depth(row('Landscapes')),
    );
    console.log(
        'RESULT a note from the list shows at the top of the tree before the node answers:',
        rows().length > before &&
            tops.some((r) => r.querySelector('.tree-row-title')?.textContent.trim() === 'untitled'),
    );
    console.log('RESULT and never in unfiled either:', !unfiled().includes('untitled'));
} else {
    console.log('RESULT the list has its new button:', false);
}

// Drag mesa out to the top of the tree: dropped on the pane's background.
const lift = new window.Event('dragstart', { bubbles: true });
Object.defineProperty(lift, 'dataTransfer', {
    value: { setData() {}, effectAllowed: '', dropEffect: '' },
});
row('mesa').dispatchEvent(lift);
const drop = new window.Event('drop', { bubbles: true, cancelable: true });
doc.querySelector('aside.tree-pane').dispatchEvent(drop);
await sleep(300);
console.log(
    'RESULT a dragged note shows where it was dropped, before the node answers:',
    depth(row('mesa')) === depth(row('Landscapes')),
);

// Let everything through: the read that follows confirms, and nothing snaps back.
release();
gate = null;
await sleep(3000);
console.log(
    'RESULT after the node answers, mesa stays at the top:',
    depth(row('mesa')) === depth(row('Landscapes')),
);
console.log(
    'RESULT and the new note stays in Landscapes:',
    !!row('untitled') &&
        depth(row('untitled')) > depth(row('Landscapes')) &&
        !unfiled().includes('untitled'),
);
const held = await api(`/api/identity/${root}/taxonomies/${top}`);
console.log(
    'RESULT the node agrees - mesa at the top:',
    held.members.some((m) => m.doc_id === mesa.doc_id),
);

// A refused move: shown, then put back, with the reason.
refuse = true;
const again = new window.Event('dragstart', { bubbles: true });
Object.defineProperty(again, 'dataTransfer', { value: { setData() {}, effectAllowed: '' } });
row('mesa').dispatchEvent(again);
const into = row('Landscapes');
into.dispatchEvent(new window.Event('dragover', { bubbles: true, cancelable: true }));
into.dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true }));
await sleep(2000);
console.log(
    'RESULT a refused move goes back where it was:',
    depth(row('mesa')) === depth(row('Landscapes')),
);
console.log('RESULT and says why:', (doc.body.textContent || '').includes('the node said no'));
process.exit(0);
