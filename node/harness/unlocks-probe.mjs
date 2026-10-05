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
await waitFor(
    bdoc,
    () => bdoc.querySelectorAll('.bank-market-body > .bank-unlock').length > 0,
    'the Market',
);
console.log(
    'RESULT the Market sells fifteen, video last:',
    bdoc.querySelectorAll('.bank-market-body > .bank-unlock').length === 15 &&
        bdoc
            .querySelector('.bank-market-body > .bank-unlock:last-of-type')
            .textContent.includes('Video'),
);
console.log(
    'RESULT eight colorways, apart:',
    bdoc.querySelectorAll('.bank-colorways .bank-unlock').length === 8,
);
console.log('RESULT no hrseBond before Horse Financial:', !bdoc.querySelector('.bank-instrument'));

await fetch(`${base}/test/credit`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ root, pennies: 350000 }), // Writer now, Friends below: one credit
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

// The profile's picker offers the free colourways, and says where the rest are.
const profile = await s.boot('/ringtome/persona/profile');
const pdoc = profile.window.document;
await waitFor(pdoc, () => pdoc.querySelectorAll('.colorway-option').length > 0, 'the picker');
await sleep(500);
console.log(
    'RESULT the picker offers horse-relax and witchlight:',
    [...pdoc.querySelectorAll('.colorway-option')].map((b) => b.textContent.trim()).join(',') ===
        'horse-relax,witchlight',
);

// Bought from the Market itself: the card's button, and the dock grows hrsePeople at once.
const market = await s.boot('/ringtome/bank');
const mdoc = market.window.document;
await waitFor(
    mdoc,
    () => mdoc.querySelectorAll('.bank-market-body > .bank-unlock').length === 14,
    'the Market',
);
const card = [...mdoc.querySelectorAll('.bank-market-body > .bank-unlock')].find((c) =>
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
const ownedNames = [...mdoc.querySelectorAll('.bank-owned-name')].map((n) => n.textContent.trim());
console.log(
    'RESULT the Market lists what is owned:',
    ownedNames.length === 2 && ownedNames.some((n) => n.includes('Friends')),
);
// A day's purchases fold into one ledger row, which names them all.
const ledger = await s.boot('/ringtome/bank');
const ldoc = ledger.window.document;
await waitFor(ldoc, () => ldoc.querySelectorAll('.bank-line').length > 0, 'the ledger');
const bought2 = [...ldoc.querySelectorAll('.bank-line-what')].find((l) =>
    l.textContent.startsWith('unlocked'),
);
console.log(
    'RESULT one row names both purchases:',
    !!bought2 && /Friends/.test(bought2.textContent) && /Private notes/.test(bought2.textContent),
    bought2 && bought2.textContent,
);
process.exit(0);
