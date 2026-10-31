// Recents (plans/RECENTS.md): a feed draft saved heads the dock, and its tile takes you to the feed
// itself with the Writer column open (`/ringtome/feed?compose=1`), not to the draft as a document.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node recents-feed-probe.mjs
import { session, signUp, sleep, waitFor, click } from './boot.mjs';

const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'recentfeed');
await s.fetch('/api/identity', { method: 'POST' });
const dom = await s.boot('/ringtome/feed');
const { window } = dom;
const doc = window.document;
// jsdom lays nothing out: CodeMirror's measuring, mounted afresh when the composer reopens, asks
// a Range for rectangles it doesn't have.
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
});
let view = null;
for (let t = 0; t < 80 && !view; t++) {
    await sleep(250);
    const content = doc.querySelector('.feed-compose .cm-content');
    view = content && content.cmTile && content.cmTile.view;
}
if (!view) {
    console.log('no composer; body:', JSON.stringify(doc.body.textContent).slice(0, 300));
    process.exit(1);
}
view.dispatch({ changes: { from: 0, insert: 'a horse, half drawn' }, userEvent: 'input.type' });
await sleep(300);
Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
doc.dispatchEvent(new window.Event('visibilitychange'));
const tile = await waitFor(
    doc,
    () => doc.querySelector('.quickbar-hex-recent'),
    'a recents tile',
    20000,
);
console.log('RESULT the draft heads the dock:', JSON.stringify(tile.getAttribute('title')));
// Tuck the composer away and go to the launcher; then the tile.
click(window, doc.querySelector('.feed-compose .pane-min'));
await waitFor(doc, () => !doc.querySelector('.feed-compose'), 'the composer tucked');
click(window, doc.querySelectorAll('.quickbar-apps .quickbar-hex')[1]);
await waitFor(doc, () => doc.querySelector('.hex-comb'), 'the launcher');
click(window, doc.querySelector('.quickbar-hex-recent'));
await waitFor(doc, () => doc.querySelector('.feed-compose'), 'the feed, composer open', 15000);
await sleep(500);
console.log(
    'RESULT the tile opens the feed with the composer:',
    window.location.pathname + window.location.search,
);
console.log(
    'RESULT on the draft:',
    (doc.querySelector('.feed-compose .cm-content') || {}).textContent || '(no words)',
);
process.exit(0);
