// The dead-granter adoption: B grants C a code (carrying sibling leaves), then dies before
// C pastes it. Completion must climb the code's sibling ladder, fetch the tree from A, and
// finish the ceremony - the newborn is not stranded by its recruiter's death.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const settle = async (fn, tries = 160) => {
    for (let i = 0; i < tries; i++) { const got = await fn(); if (got) return got; await sleep(250); }
    return null;
};

const a = session('http://localhost:5297');
await signUp(a, 'boot-a');
const root = (await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
await a.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'Heirloom', body: 'the history worth inheriting', format: 'plaintext' }) });

const b = session('http://localhost:5298');
await signUp(b, 'boot-b');
const reqB = await (await b.fetch('/api/identity/adopt/begin', { method: 'POST', headers: J })).json();
const grantB = await (await a.fetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J,
    body: JSON.stringify({ code: reqB.code }) })).json();
await b.fetch('/api/identity/adopt/complete', { method: 'POST', headers: J,
    body: JSON.stringify({ code: grantB.code }) });
await sleep(3000); // B derives A leaf-bound, so B's grant below can name A as a sibling

const c = session('http://localhost:5299');
await signUp(c, 'boot-c');
const reqC = await (await c.fetch('/api/identity/adopt/begin', { method: 'POST', headers: J })).json();

// Freeze C's NODE through the grant so the in-band delivery (best-effort, fires at grant
// time) cannot beat the human's paste - the fallback ceremony is exactly what we're testing.
const cpid = readFileSync('/tmp/ringtome-scratch-5299.pid', 'utf8').trim();
execSync(`kill -STOP ${cpid}`);
const grantC = await (await b.fetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J,
    body: JSON.stringify({ code: reqC.code }) })).json();
console.log('RESULT granted while the newborn slept (in-band delivery blocked)');
await sleep(2500); // the authorize must escape to A before B dies - a grant that dies with
                   // its granter is unrecoverable by design (nothing can prove the newborn)

const bpid = readFileSync('/tmp/ringtome-scratch-5298.pid', 'utf8').trim();
execSync(`kill ${bpid}`);
console.log(`RESULT granter died before the paste (pid ${bpid})`);
await sleep(15000); // let any pending delivery dial to frozen C time out with B's death
execSync(`kill -CONT ${cpid}`);
await sleep(1000);

const done = await c.fetch('/api/identity/adopt/complete', { method: 'POST', headers: J,
    body: JSON.stringify({ code: grantC.code }) });
console.log('RESULT completion through the sibling ladder:', done.status);

const inherited = await settle(async () => {
    const list = await (await c.fetch(`/api/identity/${root}/docs`)).json();
    const docs = Array.isArray(list) ? list : list.docs || [];
    return docs.some((x) => x.title === 'Heirloom') ? true : null;
});
console.log('RESULT the newborn inherited the history:', inherited === true);
process.exit(0);
