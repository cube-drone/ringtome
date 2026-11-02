// A blocked person's page when nothing of theirs can be reached (js/blockmodal.js's BlockedCard,
// 2026-11-02): it says they're blocked, with the reason, and unblocks from there - instead of an
// error with no way back. Then the page looks again, and the error reads as one sentence.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node blocked-page-probe.mjs
import { click, session, signUp, sleep, waitFor } from './boot.mjs';

const J = { 'Content-Type': 'application/json' };
const base = `http://localhost:${process.env.PROBE_PORT || 5299}`;
const s = session(base);
await signUp(s, 'blocker');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json())
    .root_pubkey;
// Somebody no node here has heard of: a key, and nowhere to look for it.
const nobody = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const put = (key, value) =>
    s.fetch(`/api/identity/${root}/private/kv/contact:${nobody}/${key}`, {
        method: 'PUT',
        headers: J,
        body: JSON.stringify({ value }),
    });
await put('blocked', 'yes');
await put('blocked_reason', 'spammed my mentions');

const dom = await s.boot(`/ringtome/user/${nobody}`);
const { window } = dom;
const doc = window.document;
const card = await waitFor(
    doc,
    () => doc.querySelector('.blocked-card'),
    'the blocked card',
    30000,
);
console.log('RESULT it says so:', /This user is blocked/.test(card.textContent));
console.log('RESULT with the reason:', /spammed my mentions/.test(card.textContent));
console.log('RESULT and how:', /blocked this user privately/.test(card.textContent));

click(window, card.querySelector('.ledger-block'));
const form = await waitFor(doc, () => doc.querySelector('.block-form'), 'the block modal');
await sleep(100);
click(
    window,
    [...form.querySelectorAll('.block-actions button')].find(
        (b) => b.textContent.trim() === 'Unblock',
    ),
);
await waitFor(doc, () => !doc.querySelector('.blocked-card'), 'the card to go', 30000);
const said = await waitFor(
    doc,
    () => [...doc.querySelectorAll('p')].find((p) => /Couldn't reach/.test(p.textContent)),
    'the page to look again and say it is unreachable',
    30000,
);
console.log(
    'RESULT looked again, and says it in one sentence:',
    /, and its address carries/.test(said.textContent.replace(/\s+/g, ' ')),
    said.textContent.replace(/\s+/g, ' ').trim(),
);
process.exit(0);
