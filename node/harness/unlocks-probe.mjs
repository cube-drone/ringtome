// Unlocks (plans/UNLOCKS.md, 2026-10-05): a new persona sees the starting set - persona, hrseMsg,
// hrseDrawing, hrseBank - and a locked app's address says what opens it; the Market sells the
// rest, and a purchase opens its app.
//
// The rig's nodes unlock everything, so this needs a node that keeps the locks:
//
//   RINGTOME_TEST_LOCKS=1 just scratch 1   (prints the port)
//   PROBE_PORT=<port> node unlocks-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';

const J = { 'Content-Type': 'application/json' };
const base = `http://localhost:${process.env.PROBE_PORT || 5299}`;
const s = session(base);
await signUp(s, 'unlocker');
const api = async (path, method = 'GET', body) =>
    (await s.fetch(path, { method, headers: J, body: body && JSON.stringify(body) })).json();
const root = (await api('/api/identity', 'POST')).root_pubkey;

const owned = await api(`/api/identity/${root}/bank/unlocks`);
console.log('RESULT the node keeps the locks:', owned.everything === false);

const tiles = async () => {
    const dom = await s.boot('/ringtome');
    const doc = dom.window.document;
    await waitFor(doc, () => doc.querySelectorAll('.app-tile').length > 0, 'the launcher');
    await sleep(500); // the gates' first answer
    return [...doc.querySelectorAll('button.app-tile')].map((b) => b.title.split('\n')[0]);
};
const first = await tiles();
console.log('launcher:', first.join(' | '));
console.log(
    'RESULT no Writer, People, Feed, Chat or Files on the launcher:',
    !first.some((n) => /hrse(Writer|People|Feed|Chat|Files)/.test(n)),
);
console.log(
    'RESULT the starting set is there:',
    ['hrseMsg', 'hrseDrawing', 'hrseBank'].every((n) => first.some((f) => f.includes(n))),
);

const notes = await s.boot('/ringtome/notes');
const ndoc = notes.window.document;
await waitFor(ndoc, () => ndoc.querySelector('.unlock-locked-card'), 'the locked card');
console.log(
    "RESULT Writer's address says what opens it:",
    ndoc.querySelector('.unlock-locked-card').textContent.includes('Private notes'),
);

const bank = await s.boot('/ringtome/bank');
const bdoc = bank.window.document;
await waitFor(bdoc, () => bdoc.querySelectorAll('.bank-unlock').length > 0, 'the Market');
console.log(
    'RESULT the Market sells fourteen:',
    bdoc.querySelectorAll('.bank-unlock').length === 14,
);

await fetch(`${base}/test/credit`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ root, pennies: 250000 }),
});
const bought = await api(`/api/identity/${root}/bank/unlocks`, 'POST', { id: 'private-notes' });
console.log('RESULT bought:', bought.id === 'private-notes');

const after = await tiles();
console.log(
    'RESULT Writer is on the launcher now:',
    after.some((n) => n.includes('hrseWriter')),
);
const notes2 = await s.boot('/ringtome/notes');
const n2 = notes2.window.document;
await sleep(1500);
console.log('RESULT and its address opens it:', !n2.querySelector('.unlock-locked-card'));

// Bought from the Market itself: the card's button, and the dock grows hrsePeople at once.
await fetch(`${base}/test/credit`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ root, pennies: 100000 }),
});
const market = await s.boot('/ringtome/bank');
const mdoc = market.window.document;
await waitFor(mdoc, () => mdoc.querySelectorAll('.bank-unlock').length === 13, 'the Market');
const card = [...mdoc.querySelectorAll('.bank-unlock')].find((c) =>
    c.textContent.includes('Friends'),
);
console.log('RESULT Friends is affordable:', !card.classList.contains('unaffordable'));
card.querySelector('.bank-buy').dispatchEvent(
    new market.window.MouseEvent('click', { bubbles: true }),
);
await waitFor(
    mdoc,
    () => [...mdoc.querySelectorAll('.quickbar-hex')].some((b) => /hrsePeople/.test(b.title)),
    'hrsePeople in the dock',
);
console.log(
    'RESULT bought, the card leaves the Market:',
    ![...mdoc.querySelectorAll('.bank-unlock')].some((c) => c.textContent.includes('Friends')),
);
process.exit(0);
