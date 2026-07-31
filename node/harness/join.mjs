// The join-flow probe: B's browser starts the join (the real NullState -> JoinFlow click
// path), A grants via API (one-trip delivery), and we watch what B's tab renders once the
// persona arrives on its own. Two throwaway nodes as in state.mjs's usage header.
//
// First catch (2026-07-30, reproduced on its first run): the arrival watcher cleared the
// join state BEFORE the async `open` finished, so a transitional render met JoinFlow with a
// null join, threw, and the corrupted tree left the new computer showing only the quickbar.
// Fixed in persona.js (open-then-clear, plus a render guard); this script proves the arrival
// now lands on the open console within one poll tick.
import { session, signUp, waitFor, click, sleep } from './boot.mjs';

const A = process.env.HARNESS_A || 'http://localhost:5297';
const B = process.env.HARNESS_B || 'http://localhost:5296';

// A: account + persona, via API.
const a = session(A);
await signUp(a, 'joina');
const J = { 'Content-Type': 'application/json' };
const made = await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json();
const root = made.root_pubkey;

// B: account only; the join happens through the real UI.
const b = session(B);
await signUp(b, 'joinb');
const dom = await b.boot('/home');
const { window } = dom;
const doc = window.document;
const snap = (label) => {
    const text = doc.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
    console.log(`### ${label}\n    url=${window.location.pathname} hexes=${doc.querySelectorAll('.quickbar-hex').length}\n    text="${text}"`);
};

await waitFor(doc, () => [...doc.querySelectorAll('button')].find((x) => /bring your persona/.test(x.textContent)), 'the null state');
snap('null state');
click(window, [...doc.querySelectorAll('button')].find((x) => /bring your persona/.test(x.textContent)));
await waitFor(doc, () => doc.querySelector('.spare-key'), 'the request code');
snap('join screen (request code showing)');
const code = doc.querySelector('.spare-key').textContent.trim();

const grant = await (await a.fetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J, body: JSON.stringify({ code }) })).json();
console.log('grant delivered over the wire:', grant.delivered);

for (let t = 1; t <= 8; t++) {
    await sleep(2000);
    snap(`${t * 2}s after grant`);
    if (doc.querySelector('.console, .app-frame-inner')) break;
}
process.exit(0);
