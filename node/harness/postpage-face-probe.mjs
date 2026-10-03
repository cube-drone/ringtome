// A post's own page, signed out, wears its author's face (2026-10-03: horsedrawingtycoon.com showed
// "squad-drama" - the speakable words - for a hosted persona named Cube Drone). The card was handed
// an empty profile, which stopped it asking for one.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node postpage-face-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';
import { toBase58 } from '../js/speakable.js';

const J = { 'Content-Type': 'application/json' };
const base = `http://localhost:${process.env.PROBE_PORT || 5299}`;
const author = session(base);
await signUp(author, 'facefull');
const api = async (path, method = 'GET', body) =>
    (await author.fetch(path, { method, headers: J, body: body && JSON.stringify(body) })).json();
const root = (await api('/api/identity', 'POST')).root_pubkey;
await api(`/api/identity/${root}/serve`, 'POST');
await api(`/api/identity/${root}/profile`, 'POST', { field: 'name', value: 'Probe Face' });
const made = await api(`/api/identity/${root}/docs`, 'POST', {
    title: 'a face post',
    body: 'words',
    format: 'marquee',
});
const post = (await api(`/api/identity/${root}/docs/${made.doc_id}/publish`, 'POST', {})).post_id;

const stranger = session(base); // no sign-up: a reader with no session at all
const dom = await stranger.boot(`/ringtome/user/${toBase58(root)}/post/${post}`);
const doc = dom.window.document;
await waitFor(doc, () => doc.querySelector('.feed-entry-head'), 'the card');
await sleep(1500);
const head = doc.querySelector('.feed-entry-head').textContent;
console.log(
    'RESULT the card names its author:',
    head.includes('Probe Face'),
    JSON.stringify(head.slice(0, 80)),
);
process.exit(0);
