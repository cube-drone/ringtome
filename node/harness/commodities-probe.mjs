// hrseCommodities in the Market (plans/COMMODITIES.md, 2026-10-06): seven cards under the bond,
// each with a price, its weather and its month drawn; a buy from the card lands a lot in the
// portfolio, held two days.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node commodities-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';

const J = { 'Content-Type': 'application/json' };
const base = `http://localhost:${process.env.PROBE_PORT || 5299}`;
const s = session(base);
await signUp(s, 'hayhand');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json())
    .root_pubkey;
await fetch(`${base}/test/credit`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ root, pennies: 10000000 }),
});

const dom = await s.boot('/ringtome/bank');
const doc = dom.window.document;
await waitFor(doc, () => doc.querySelectorAll('.bank-commodity').length > 0, 'the commodities');
const cards = [...doc.querySelectorAll('.bank-commodity')];
console.log(
    'RESULT seven commodities, hay first:',
    cards.length === 7 && cards[0].querySelector('.bank-commodity-name').textContent === 'hay',
);
console.log(
    'RESULT each draws its month:',
    cards.every((c) => c.querySelector('.bank-spark polyline')),
);
console.log(
    'weather:',
    cards.map((c) => c.querySelector('.bank-commodity-weather').textContent).join(' | '),
);

const hay = cards[0];
const units = hay.querySelector('.bank-commodity-units');
units.value = '3';
units.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await sleep(100);
const button = hay.querySelector('.bank-buy');
console.log(
    'RESULT the button prices the order:',
    /buy for/.test(button.textContent),
    button.textContent.trim(),
);
button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await waitFor(
    doc,
    () =>
        [...doc.querySelectorAll('.bank-holding-kind')].some((k) => k.textContent.includes('hay')),
    'the lot in the portfolio',
);
const lot = [...doc.querySelectorAll('.bank-holding')].find((h) => h.textContent.includes('hay'));
console.log(
    'RESULT the lot holds three, and waits:',
    /3 hay/.test(lot.textContent) && /sells from/.test(lot.textContent),
);
process.exit(0);
