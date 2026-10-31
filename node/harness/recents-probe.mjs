// Recents (plans/RECENTS.md): say a line in a room, and the room heads the dock - after the persona
// tile and home, in a recents tile - and the launcher; and chat moves up to be the first app after
// them. Home, second, opens the launcher.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node recents-probe.mjs
import { session, signUp, sleep, waitFor, click } from './boot.mjs';
import { toBase58 } from '../js/speakable.js';

const J = { 'Content-Type': 'application/json' };
const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'recents');
const api = async (path, method = 'GET', body) =>
    (await s.fetch(path, { method, headers: J, body: body && JSON.stringify(body) })).json();
const root = (await api('/api/identity', 'POST')).root_pubkey;
const made = await api(`/api/identity/${root}/docs`, 'POST', {
    title: 'the stable',
    body: '',
    format: 'marquee',
});
await s.fetch(`/api/identity/${root}/docs/${made.doc_id}/buckets/chat`, { method: 'PUT' });
const room = (
    await api(`/api/identity/${root}/docs/${made.doc_id}/publish`, 'POST', { room: true })
).post_id;

const dom = await s.boot(`/ringtome/user/${toBase58(root)}/room/${room}`);
const { window } = dom;
const doc = window.document;
const dockOrder = () =>
    [...doc.querySelectorAll('.quickbar-apps .quickbar-hex')].map((b) =>
        b.classList.contains('quickbar-hex-recent')
            ? `recent:${b.getAttribute('aria-label')}`
            : b.getAttribute('aria-label'),
    );
await waitFor(
    doc,
    () => doc.querySelectorAll('.quickbar-apps .quickbar-hex').length > 3,
    'the dock',
);
console.log('dock before:', JSON.stringify(dockOrder()));
let view = null;
for (let t = 0; t < 60 && !view; t++) {
    await sleep(250);
    const content = doc.querySelector('.chat-composer .cm-content');
    view = content && content.cmTile && content.cmTile.view;
}
view.dispatch({ changes: { from: 0, insert: 'hay is in' }, userEvent: 'input.type' });
await sleep(100);
doc.querySelector('.chat-composer').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
);
await waitFor(doc, () => doc.querySelector('.quickbar-hex-recent'), 'a recents tile', 20000);
const after = dockOrder();
console.log('dock after:', JSON.stringify(after));
console.log('RESULT home is second, always:', after[1] === 'home');
console.log('RESULT the room comes after persona and home:', after[2] === 'recent:the stable');
console.log('RESULT chat is the first app after the recents:', /chat/i.test(after[3] || ''));
// The launcher, by the dock's home tile.
click(window, doc.querySelectorAll('.quickbar-apps .quickbar-hex')[1]);
await waitFor(doc, () => doc.querySelector('.hex-comb'), 'the launcher, from home');
console.log('RESULT home opens the launcher:', window.location.pathname);
await sleep(500);
const comb = [...doc.querySelectorAll('.hex-comb .app-tile:not(.blank)')].map((b) =>
    b.classList.contains('app-tile-recent')
        ? `recent:${b.textContent.trim()}`
        : b.textContent.trim(),
);
console.log('launcher:', JSON.stringify(comb.slice(0, 5)));
console.log('RESULT the launcher heads with the room too:', comb[1] === 'recent:the stable');
process.exit(0);
