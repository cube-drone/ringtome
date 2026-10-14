// A deleted note leaves its notebook's tree (Curtis, 2026-10-13: two deleted notes stayed in a big
// tree, each opening on "that isn't here"): the node takes it out of every list, and a pane that
// mounts from its cache doesn't bring it back.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node tree-delete-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';

const J = { 'Content-Type': 'application/json' };
const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'treedelete');
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
const top = (await tax('wiki:default')).taxonomy_id;
const section = (await tax('Landscapes')).taxonomy_id;
await place(top, section);
const note = async (title) => {
    const d = await api(`/api/identity/${root}/docs`, 'POST', {
        title,
        body: 'words',
        format: 'marquee',
    });
    await s.fetch(`/api/identity/${root}/docs/${d.doc_id}/buckets/default`, { method: 'PUT' });
    await place(section, d.doc_id);
    return d.doc_id;
};
const mesa = await note('mesa');
await note('butte');

const open = async () => {
    const dom = await s.boot('/ringtome/notes');
    const doc = dom.window.document;
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    // Tucked by default; a second visit remembers it shown.
    await waitFor(
        doc,
        () => doc.querySelector('.pane-rail[title="show tree"]') || doc.querySelector('.tree-pane'),
        'the tree or its rail',
    );
    const rail = doc.querySelector('.pane-rail[title="show tree"]');
    if (rail) click(rail);
    const titles = () =>
        [...doc.querySelectorAll('.tree-pane .tree-row:not(.tree-unfiled *) .tree-row-title')].map(
            (t) => t.textContent.trim(),
        );
    await waitFor(doc, () => titles().includes('butte'), 'the tree');
    return { titles };
};

const first = await open();
console.log(
    'RESULT both notes in the tree:',
    first.titles().includes('mesa') && first.titles().includes('butte'),
);
await s.fetch(`/api/identity/${root}/docs/${mesa}`, { method: 'DELETE' });
let gone = false;
for (let i = 0; i < 40 && !gone; i++) {
    await sleep(250);
    gone = !first.titles().includes('mesa');
}
console.log('RESULT a deleted note leaves the open tree:', gone);
const members = (await api(`/api/identity/${root}/taxonomies/${section}`)).members.map(
    (m) => m.doc_id,
);
console.log('RESULT and its list on the node:', !members.includes(mesa));

const again = await open();
await sleep(1500);
console.log(
    'RESULT a pane mounted from its cache leaves it out too:',
    !again.titles().includes('mesa'),
    again.titles(),
);
process.exit(0);
