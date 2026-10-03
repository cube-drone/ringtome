// A document's own address waits rather than flashing "that isn't here" (2026-10-03): the mirror not
// holding a document is not the document not existing, so the node is asked and only its 404 says
// "isn't here". Here: a document that does exist never shows the words, and one that doesn't
// reaches them through the 404 rather than spinning forever.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node docroute-probe.mjs
import { session, signUp, sleep, waitFor } from './boot.mjs';
import { toBase58 } from '../js/speakable.js';

const J = { 'Content-Type': 'application/json' };
const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'docroute');
const api = async (path, method = 'GET', body) =>
    (await s.fetch(path, { method, headers: J, body: body && JSON.stringify(body) })).json();
const root = (await api('/api/identity', 'POST')).root_pubkey;
const made = await api(`/api/identity/${root}/docs`, 'POST', {
    title: 'a real note',
    body: 'here I am',
    format: 'marquee',
});
await s.fetch(`/api/identity/${root}/docs/${made.doc_id}/buckets/notes`, { method: 'PUT' });
const NOT_HERE = "that isn't here";

const watch = async (doc, ms) => {
    let saw = false;
    for (let t = 0; t < ms / 50; t++) {
        if (doc.body.textContent.includes(NOT_HERE)) saw = true;
        await sleep(50);
    }
    return saw;
};

const real = await s.boot(`/ringtome/user/${toBase58(root)}/doc/${made.doc_id}`);
console.log(
    "RESULT a real document never says it isn't here:",
    !(await watch(real.window.document, 4000)),
);

const ghost = await s.boot(`/ringtome/user/${toBase58(root)}/doc/${'ab'.repeat(16)}`);
await waitFor(
    ghost.window.document,
    () => ghost.window.document.body.textContent.includes(NOT_HERE),
    'the 404',
    15000,
);
console.log('RESULT a missing one says so, once the node has:', true);
process.exit(0);
