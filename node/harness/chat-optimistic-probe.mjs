// A chat line is on the floor the moment it is sent (2026-10-02), not a round trip later: the send
// is HELD here, and the line must already show, faded; let through, it lands once and only once; a
// send the room refuses stays on the floor with why, and discard takes it away.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node chat-optimistic-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';
import { toBase58 } from '../js/speakable.js';

const J = { 'Content-Type': 'application/json' };
const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'chatfast');
const api = async (path, method = 'GET', body) =>
    (await s.fetch(path, { method, headers: J, body: body && JSON.stringify(body) })).json();
const root = (await api('/api/identity', 'POST')).root_pubkey;
const made = await api(`/api/identity/${root}/docs`, 'POST', {
    title: 'fast room',
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
let view = null;
for (let t = 0; t < 60 && !view; t++) {
    await sleep(250);
    const content = doc.querySelector('.chat-composer .cm-content');
    view = content && content.cmTile && content.cmTile.view;
}
if (!view) {
    console.log('no composer; body:', JSON.stringify(doc.body.textContent).slice(0, 300));
    process.exit(1);
}
const say = async (words) => {
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: words },
        userEvent: 'input.type',
    });
    await sleep(100);
    doc.querySelector('.chat-composer').dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
    );
};
const linesSaying = (words) =>
    [...doc.querySelectorAll('.chat-line')].filter((l) => l.textContent.includes(words));

// Hold every line's send until released (or refuse it).
const real = window.fetch;
let gate = null;
let refuse = false;
window.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST' && /\/messages$/.test(String(url))) {
        if (refuse) throw new Error('the room is out of reach');
        if (gate) await gate;
    }
    return real(url, opts);
};

let release;
gate = new Promise((r) => (release = r));
await say('hello at once');
await sleep(300);
const early = linesSaying('hello at once');
console.log(
    'RESULT on the floor before the room answered:',
    early.length === 1 && early[0].classList.contains('chat-line-pending'),
);
console.log('RESULT the composer is free again:', view.state.doc.toString() === '');
release();
gate = null;
await waitFor(
    doc,
    () =>
        linesSaying('hello at once').length === 1 &&
        !linesSaying('hello at once')[0].classList.contains('chat-line-pending'),
    'the line to land',
);
await sleep(1500); // a poll or two more: the stand-in must not come back beside the real line
console.log('RESULT landed once, not twice:', linesSaying('hello at once').length === 1);

refuse = true;
await say('doomed words');
await waitFor(
    doc,
    () => linesSaying('doomed words')[0]?.classList.contains('chat-line-failed'),
    'the failure',
);
const failed = linesSaying('doomed words')[0];
console.log(
    'RESULT a refused line stays, saying why:',
    failed.textContent.includes('out of reach'),
);
const discard = [...failed.querySelectorAll('.chat-line-unsent-act')].find((b) =>
    /discard/.test(b.textContent),
);
discard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(300);
console.log('RESULT discard takes it away:', linesSaying('doomed words').length === 0);
process.exit(0);
