// The mirror un-pinned from its first source: bob (on C) fetched alice through her founding
// node A; A dies; alice keeps posting from her second device B. Bob's revalidation must find
// B through the STORED TREE's leaves - last_via is dead, and the zeroth root rung resolves
// to the dead founder too.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const settle = async (fn, tries = 240) => {
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
await signUp(a, 'ladder-alice');
const root = (await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const b = session('http://localhost:5298');
await signUp(b, 'ladder-device');
await adopt(a, b, root);
await sleep(2000);

const bob = session('http://localhost:5299');
await signUp(bob, 'ladder-bob');
const first = await bob.fetch(`/api/id/${root}/profile`);
console.log('RESULT bob mirrored alice via her founder:', first.status);

const apid = readFileSync('/tmp/ringtome-scratch-5297.pid', 'utf8').trim();
execSync(`kill ${apid}`);
console.log(`RESULT killed the founder (pid ${apid})`);
await sleep(1000);

const d = await (await b.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'After The Fall', body: 'still here', format: 'plaintext' }) })).json();
await b.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
console.log('RESULT alice posted from her second device');

await sleep(31000); // let the revalidate window open
const healed = await settle(async () => {
    const prof = await (await bob.fetch(`/api/id/${root}/profile`)).json();
    return (prof.posts || []).some((p) => p.title === 'After The Fall') ? true : null;
});
console.log('RESULT mirror healed through a stored-tree leaf:', healed === true);
process.exit(0);
