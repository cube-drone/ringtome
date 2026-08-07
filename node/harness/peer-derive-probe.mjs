// The dead-introducer partition, healed: A adopts B, B adopts C - so A and C share no
// ceremony and, before the derive sweep, no knowledge of each other. The tree x serving
// records must teach them anyway: kill B, write on C, and the words must reach A.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
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
await signUp(a, 'chain-a');
const root = (await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

const b = session('http://localhost:5298');
await signUp(b, 'chain-b');
await adopt(a, b, root);

const c = session('http://localhost:5299');
await signUp(c, 'chain-c');
await adopt(b, c, root); // C's whole ceremonial world is B; A has never heard of C

await sleep(9000); // serving records published at adoption; two derive beats at 4s

const bpid = readFileSync('/tmp/ringtome-scratch-5298.pid', 'utf8').trim();
execSync(`kill ${bpid}`);
console.log(`RESULT killed the introducer (pid ${bpid})`);
await sleep(1000);

const d = await (await c.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'Across the Gap', body: 'no introducer needed', format: 'plaintext' }) })).json();
console.log('RESULT wrote on C:', d.doc_id ? 'ok' : JSON.stringify(d));

const arrived = await settle(async () => {
    const list = await (await a.fetch(`/api/identity/${root}/docs`)).json();
    const docs = Array.isArray(list) ? list : list.docs || [];
    return docs.some((x) => x.title === 'Across the Gap') ? true : null;
});
console.log('RESULT arrived on A without B:', arrived === true);
process.exit(0);
