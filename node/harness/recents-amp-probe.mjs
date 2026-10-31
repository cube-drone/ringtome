// Recents (plans/RECENTS.md): a radio station made in hrseAmp heads the dock, and its tile opens it
// again by its address (`/ringtome/amp?station=<id>`), which goes back to hrseAmp's own.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node recents-amp-probe.mjs
import { session, signUp, sleep, waitFor, click } from './boot.mjs';

const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'recentamp');
await s.fetch('/api/identity', { method: 'POST' });
const dom = await s.boot('/ringtome/amp');
const { window } = dom;
const doc = window.document;
const plus = await waitFor(
    doc,
    () => doc.querySelector('.amp-playlists-new'),
    'the + station button',
);
click(window, plus);
const input = await waitFor(doc, () => doc.querySelector('.modal-ask-input'), 'the name box');
input.value = 'night drive';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(100);
doc.querySelector('.modal-ask').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
);
const tile = await waitFor(
    doc,
    () => doc.querySelector('.quickbar-hex-recent'),
    'a recents tile',
    20000,
);
console.log('RESULT the new station heads the dock:', tile.getAttribute('title'));
// Away from the station: "all", then the tile.
click(
    window,
    [...doc.querySelectorAll('.amp-playlists .feed-saved-name')].find(
        (b) => b.textContent.trim() === 'all',
    ),
);
await waitFor(doc, () => !doc.querySelector('.amp-station'), 'the station closed');
click(window, doc.querySelector('.quickbar-hex-recent'));
await waitFor(doc, () => doc.querySelector('.amp-station'), 'the station open again', 15000);
await sleep(300);
console.log(
    'RESULT its tile opens it again; the address is back to:',
    window.location.pathname + window.location.search,
);
process.exit(0);
