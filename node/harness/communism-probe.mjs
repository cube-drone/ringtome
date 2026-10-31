// Automated Luxury Horse Communism (bank.rs `COMMUNISM`, 2026-10-31): the last card in the Market;
// bought - after a "destroy the bank" confirm - the launcher opens, hrseBank leaves the dock and the
// launcher, the corner's HorseBucks go, and every app is open.
//
// The rig's nodes unlock everything, so this needs a node that keeps the locks:
//
//   RINGTOME_TEST_LOCKS=1 just scratch 1   (prints the port)
//   PROBE_PORT=<port> node communism-probe.mjs
import { session, signUp, sleep, waitFor, click } from './boot.mjs';

const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'commie');
const root = (await (await s.fetch('/api/identity', { method: 'POST' })).json()).root_pubkey;
for (let i = 0; i < 5; i++) await s.fetch(`/api/identity/${root}/bank/gift`, { method: 'POST' });

const dom = await s.boot('/ringtome/bank');
const { window } = dom;
const doc = window.document;
const dock = () =>
    [...doc.querySelectorAll('.quickbar-apps .quickbar-hex')].map((b) =>
        b.getAttribute('aria-label'),
    );
await waitFor(
    doc,
    () => doc.querySelectorAll('.bank-market-body > .bank-unlock').length > 3,
    'the market',
);
await sleep(800);
const cards = [...doc.querySelectorAll('.bank-market-body > .bank-unlock')];
const last = cards[cards.length - 1];
console.log('RESULT the last card:', last.querySelector('.bank-unlock-name').textContent.trim());
console.log(
    'before: corner balance',
    !!doc.querySelector('.quickbar-bank'),
    '| dock',
    JSON.stringify(dock()),
);
click(window, last.querySelector('.bank-buy'));
const yes = await waitFor(doc, () => doc.querySelector('.modal-ask-danger'), 'the confirm');
console.log(
    'RESULT asked first:',
    JSON.stringify(doc.querySelector('.modal-ask-body').textContent.trim().slice(0, 60)),
    '/',
    yes.textContent.trim(),
);
click(window, yes);
await waitFor(doc, () => window.location.pathname === '/ringtome', 'the launcher', 20000);
await sleep(1500);
console.log('RESULT on the launcher:', window.location.pathname);
console.log('RESULT corner balance gone:', !doc.querySelector('.quickbar-bank'));
console.log(
    'RESULT hrseBank gone from the dock:',
    !dock().some((l) => /Bank/.test(l || '')),
    JSON.stringify(dock()),
);
const tiles = [...doc.querySelectorAll('.hex-comb .app-tile:not(.blank)')].map((b) =>
    b.textContent.trim(),
);
console.log(
    'RESULT hrseBank gone from the launcher:',
    !tiles.some((x) => /Bank/.test(x)),
    '| Writer open:',
    tiles.some((x) => /Writer/.test(x)),
);
window.history.pushState(null, '', '/ringtome/bank');
window.dispatchEvent(new window.PopStateEvent('popstate'));
await sleep(2000);
console.log('RESULT its address sends you home:', window.location.pathname);
process.exit(0);
