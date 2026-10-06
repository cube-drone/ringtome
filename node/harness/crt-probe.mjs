// The CRT screen's switch (2026-10-06): "disable CRT" on the profile turns it off, keeps it on the
// persona's private chain, and a fresh browser - nothing kept of its own - comes up with it off.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node crt-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';

const J = { 'Content-Type': 'application/json' };
const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'crtcat');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json())
    .root_pubkey;

const dom = await s.boot('/ringtome/persona/profile');
const doc = dom.window.document;
await waitFor(doc, () => doc.querySelector('.crt-toggle'), 'the switch');
console.log('RESULT on by default:', doc.documentElement.dataset.crt === undefined);
const toggle = doc.querySelector('.crt-toggle');
console.log('RESULT the switch offers to disable:', /disable CRT/.test(toggle.textContent));
toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await waitFor(doc, () => doc.documentElement.dataset.crt === 'off', 'the screen off');
console.log('RESULT off at once:', doc.documentElement.dataset.crt === 'off');
const kv = await (await s.fetch(`/api/identity/${root}/private/kv/appearance`)).json();
console.log(
    'RESULT kept on the private chain:',
    (kv.values || []).some((v) => v.key === 'crt' && v.value === 'off'),
);

const fresh = await s.boot('/ringtome');
const fdoc = fresh.window.document;
await sleep(2000);
console.log(
    'RESULT a fresh browser comes up with it off:',
    fdoc.documentElement.dataset.crt === 'off',
);
process.exit(0);
