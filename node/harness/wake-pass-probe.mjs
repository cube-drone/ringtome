// The laptop-close reunion: bob's node sleeps through alice's post (the push fails against
// a frozen process and is never retried), wakes, and - with NO visit to alice's page -
// the follow-refresh sweep must notice the stale mirror, re-fetch it, and land the missed
// post in bob's feed.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const settle = async (fn, tries = 240) => {
    for (let i = 0; i < tries; i++) { const got = await fn(); if (got) return got; await sleep(250); }
    return null;
};

const a = session('http://localhost:5297');
await signUp(a, 'wake-alice');
const root = (await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const post = async (title) => {
    const d = await (await a.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
        body: JSON.stringify({ title, body: title, format: 'plaintext' }) })).json();
    await a.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
};
await post('Before Sleep');

const bob = session('http://localhost:5299');
await signUp(bob, 'wake-bob');
const bobRoot = (await (await bob.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
await bob.fetch(`/api/id/${root}/profile`); // mirror alice (bare root - the zeroth rung)
await bob.fetch(`/api/identity/${bobRoot}/private/kv/contact:${root}/interest`, {
    method: 'PUT', headers: J, body: JSON.stringify({ value: '80' }) });
const seeded = await settle(async () => {
    const f = await (await bob.fetch(`/api/identity/${bobRoot}/feed`)).json();
    return (f.items || []).some((i) => i.title === 'Before Sleep') ? true : null;
});
console.log('RESULT followed, feed seeded:', seeded === true);

const cpid = readFileSync('/tmp/ringtome-scratch-5299.pid', 'utf8').trim();
execSync(`kill -STOP ${cpid}`);
console.log('RESULT laptop closed (SIGSTOP)');
await post('While You Slept');
await sleep(45000); // outlast QUIC's handshake patience: a frozen socket buffers the push's
                    // dial and completes it on thaw if the nap is short - the 12s version of
                    // this probe was healed by exactly that
execSync(`kill -CONT ${cpid}`);
console.log('RESULT laptop opened (SIGCONT) - and nobody visits alice');

const caught = await settle(async () => {
    const f = await (await bob.fetch(`/api/identity/${bobRoot}/feed`)).json();
    return (f.items || []).some((i) => i.title === 'While You Slept') ? true : null;
});
console.log('RESULT the wake pass caught the missed post:', caught === true);
process.exit(0);
