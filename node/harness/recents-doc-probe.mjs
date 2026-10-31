// Recents (plans/RECENTS.md): save a note in Writer, and the note heads the dock in Writer's name.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node recents-doc-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';
import { toBase58 } from '../js/speakable.js';

const J = { 'Content-Type': 'application/json' };
const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'recentdoc');
const api = async (path, method = 'GET', body) =>
    (await s.fetch(path, { method, headers: J, body: body && JSON.stringify(body) })).json();
const root = (await api('/api/identity', 'POST')).root_pubkey;
const made = await api(`/api/identity/${root}/docs`, 'POST', {
    title: 'oat rations',
    body: 'two scoops',
    format: 'marquee',
});
await s.fetch(`/api/identity/${root}/docs/${made.doc_id}/buckets/default`, { method: 'PUT' });

const dom = await s.boot(`/ringtome/user/${toBase58(root)}/doc/${made.doc_id}`);
const { window } = dom;
const doc = window.document;
let view = null;
for (let t = 0; t < 60 && !view; t++) {
    await sleep(250);
    const content = doc.querySelector('.cm-content');
    view = content && content.cmTile && content.cmTile.view;
}
if (!view) {
    console.log('no editor; body:', JSON.stringify(doc.body.textContent).slice(0, 300));
    process.exit(1);
}
view.dispatch({
    changes: { from: view.state.doc.length, insert: ' and a carrot' },
    userEvent: 'input.type',
});
await sleep(300);
// The tab hides: the session flushes its save.
Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
doc.dispatchEvent(new window.Event('visibilitychange'));
const tile = await waitFor(
    doc,
    () => doc.querySelector('.quickbar-hex-recent'),
    'a recents tile',
    20000,
);
console.log('tile:', JSON.stringify(tile.getAttribute('title')));
console.log(
    'RESULT the saved note heads the dock, in Writer:',
    /oat rations/.test(tile.getAttribute('title')) && /Writer/.test(tile.getAttribute('title')),
);
process.exit(0);
