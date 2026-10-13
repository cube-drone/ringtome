// An open picture asks for its detail once (2026-10-13): a media document's detail never carries
// its bytes - they have their own address - and the reader took that `body: null` for a body on its
// way, asking the node every two seconds for as long as the picture stayed open.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node media-poll-probe.mjs
import { readFileSync } from 'node:fs';
import { session, signUp, sleep, waitFor } from './boot.mjs';
import { toBase58 } from '../js/speakable.js';

const png = readFileSync(new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname);
const s = session(`http://localhost:${process.env.PROBE_PORT || 5299}`);
await signUp(s, 'mediapoll');
const root = (await (await s.fetch('/api/identity', { method: 'POST' })).json()).root_pubkey;
const queued = await (
    await s.fetch(`/api/identity/${root}/docs/binary?title=righteous`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: png,
    })
).json();
let media = null;
for (let i = 0; i < 300 && !media; i++) {
    const jobs = await (await s.fetch(`/api/identity/${root}/ingest`)).json();
    const j = jobs.find((x) => x.job_id === queued.job_id);
    if (j?.status === 'done') media = j.doc_id;
    await sleep(300);
}
console.log('DEBUG picture', media);

const dom = await s.boot(`/ringtome/user/${toBase58(root)}/doc/${media}`);
const { window } = dom;
const asked = [];
const real = window.fetch;
window.fetch = (url, opts) => {
    if (String(url).endsWith(`/docs/${media}`)) asked.push(Date.now());
    return real(url, opts);
};
await waitFor(window.document, () => window.document.querySelector('.reader-media'), 'the picture');
const before = asked.length;
await sleep(10000);
console.log(
    'DEBUG asked for its detail',
    asked.length,
    'times; after it showed:',
    asked.length - before,
);
console.log('RESULT an open picture stops asking for itself:', asked.length - before === 0);
process.exit(0);
