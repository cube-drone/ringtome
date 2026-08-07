// The failure edge: A knows only B (ceremony); B adopted C, so C is in A's TREE but not
// A's peer rows; the periodic derive sweep is pinned to an hour away. Kill B, write on A -
// the eager push reaches zero peers, and THAT edge must derive C and retry immediately.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const settle = async (fn, tries = 160) => {
    for (let i = 0; i < tries; i++) { const got = await fn(); if (got) return got; await sleep(250); }
    return null;
};
const adopt = async (haver, joiner, root) => {
    const request = await (await joiner.fetch('/api/identity/adopt/begin', { method: 'POST', headers: J })).json();
    const grant = await (await haver.fetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J,
        body: JSON.stringify({ code: request.code }) })).json();
    const done = await joiner.fetch('/api/identity/adopt/complete', { method: 'POST', headers: J,
        body: JSON.stringify({ code: grant.code }) });
    if (done.status !== 200) throw new Error(`adopt failed: ${await done.text()}`);
};

const a = session('http://localhost:5297');
await signUp(a, 'edge-a');
const root = (await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const b = session('http://localhost:5298');
await signUp(b, 'edge-b');
await adopt(a, b, root);
const c = session('http://localhost:5299');
await signUp(c, 'edge-c');
await adopt(b, c, root);
await sleep(4000); // C's authorize reaches A's tree through B; nothing adds C to A's peers

const bpid = readFileSync('/tmp/ringtome-scratch-5298.pid', 'utf8').trim();
execSync(`kill ${bpid}`);
console.log(`RESULT killed B (pid ${bpid}); A's only known peer is gone`);
await sleep(1000);

const d = await (await a.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'Edge Case', body: 'derived at the moment of failure', format: 'plaintext' }) })).json();
console.log('RESULT wrote on A:', d.doc_id ? 'ok' : JSON.stringify(d));

const arrived = await settle(async () => {
    const list = await (await c.fetch(`/api/identity/${root}/docs`)).json();
    const docs = Array.isArray(list) ? list : list.docs || [];
    return docs.some((x) => x.title === 'Edge Case') ? true : null;
});
console.log('RESULT reached C via the failure-edge derive:', arrived === true);
process.exit(0);
