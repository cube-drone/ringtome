// The two-node state builder: construct a multi-device field scenario over live throwaway
// nodes via the plain HTTP API, leave the state in place, and print the credentials + ids so
// a UI probe (ui.mjs) can open the result in the real SPA. The companion to drive.mjs: drive
// walks the UI from scratch, this builds histories the UI *couldn't* easily produce - version
// chains alternating between devices, revocations, divergence shapes.
//
// First use (2026-07-30): the good/good/good/bad(B)/good(A) revocation scenario - a field
// report said the resolved doc came back empty; this rebuilt the exact history on HEAD and
// proved the resolution lossless at both the API and (via ui.mjs) the editor, isolating the
// report to a stale-bundle session. The SCENARIO half below stays disposable - rewrite it per
// investigation.
//
// Usage:
//   S=/tmp/harness-field; rm -rf $S
//   RINGTOME_PORT=5297 RINGTOME_DATA_DIRECTORY=$S/a RINGTOME_LOCAL_TEST=1 \
//     RINGTOME_DISCOVERY="local:$S/dht" RINGTOME_SYNC_DEBOUNCE_MS=250 \
//     RINGTOME_NODE_NAME=alpha cargo run --bin ringtome &
//   RINGTOME_PORT=5296 RINGTOME_DATA_DIRECTORY=$S/b RINGTOME_LOCAL_TEST=1 \
//     RINGTOME_DISCOVERY="local:$S/dht" RINGTOME_SYNC_DEBOUNCE_MS=250 \
//     RINGTOME_NODE_NAME=bravo cargo run --bin ringtome &
//   node state.mjs             # then: node ui.mjs <base> <user> <pw> <docId>
import { inflateRawSync } from 'node:zlib';
import { session, signUp } from './boot.mjs';

const A = process.env.HARNESS_A || 'http://localhost:5297';
const B = process.env.HARNESS_B || 'http://localhost:5296';
const J = { 'Content-Type': 'application/json' };

// The adoption codes are deflated JSON under an `rt1.` prefix (integration/test/helpers.cjs
// is the reference decoder).
const decodeCode = (code) => {
    const t = code.trim();
    if (t.startsWith('{')) return JSON.parse(t);
    return JSON.parse(inflateRawSync(Buffer.from(t.slice(4), 'base64url')).toString('utf8'));
};

const a = session(A);
const b = session(B);
const { username, password } = await signUp(a, 'field');
await signUp(b, 'fieldb');

const made = await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json();
const root = made.root_pubkey;

// Adoption: B requests, A grants (one-trip when the nodes can reach each other).
const req = await (await b.fetch('/api/identity/adopt/begin', { method: 'POST', headers: J })).json();
const leaf = decodeCode(req.code).leaf_pubkey;
const grant = await (await a.fetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J, body: JSON.stringify({ code: req.code }) })).json();
if (!grant.delivered) {
    await b.fetch('/api/identity/adopt/complete', { method: 'POST', headers: J, body: JSON.stringify({ code: grant.code }) });
}

const sync = async () => {
    await (await a.fetch(`/api/identity/${root}/sync`, { method: 'POST', headers: J })).json();
};
const save = async (s, docId, body, parents) => {
    const r = await (await s.fetch(`/api/identity/${root}/docs/${docId}`, {
        method: 'PUT',
        headers: J,
        body: JSON.stringify({ title: 'shared', body, parents, format: 'marquee' }),
    })).json();
    return r.version;
};

// ---------------------------------------------------------------------------------------------
// The scenario (disposable - rewrite per investigation). Currently: the revocation field test.
// good(A) <- good(A) <- good(A) <- bad(B) <- good(A), then A strikes B with the genesis cut.

const doc0 = await (await a.fetch(`/api/identity/${root}/docs`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ title: 'shared', body: 'good1', format: 'marquee' }),
})).json();
const doc = doc0.doc_id;
const v2 = await save(a, doc, 'good1\ngood2', [doc0.version]);
const v3 = await save(a, doc, 'good1\ngood2\ngood3', [v2]);
await sync();
const v4 = await save(b, doc, 'good1\ngood2\ngood3\nbad', [v3]);
await sync();
await save(a, doc, 'good1\ngood2\ngood3\nbad\ngood5', [v4]);

await a.fetch(`/api/identity/${root}/keys/${leaf}/revoke`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ disposition: 'repudiation', cut: 'genesis' }),
});

const after = await (await a.fetch(`/api/identity/${root}/docs/${doc}`)).json();
console.log('API-level resolution:', JSON.stringify({ resolution: after.resolution, body: after.body }).slice(0, 300));
console.log(JSON.stringify({ user: username, pw: password, root, doc }));
console.log(`next: node ui.mjs ${A} ${username} ${password} ${doc}`);
