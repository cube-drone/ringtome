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
// investigation; the boot/jar/adoption plumbing is the keepable part.
//
// Usage:
//   S=/tmp/harness-field; rm -rf $S
//   RINGTOME_PORT=5297 RINGTOME_DATA_DIRECTORY=$S/a RINGTOME_LOCAL_TEST=1 \
//     RINGTOME_DISCOVERY="local:$S/dht" RINGTOME_SYNC_DEBOUNCE_MS=250 \
//     RINGTOME_NODE_NAME=alpha cargo run --bin ringtome &
//   RINGTOME_PORT=5296 RINGTOME_DATA_DIRECTORY=$S/b RINGTOME_LOCAL_TEST=1 \
//     RINGTOME_DISCOVERY="local:$S/dht" RINGTOME_SYNC_DEBOUNCE_MS=250 \
//     RINGTOME_NODE_NAME=bravo cargo run --bin ringtome &
//   node state.mjs             # then: node ui.mjs http://localhost:5297 <user> <pw> <docId>
import { inflateRawSync } from 'node:zlib';

const A = process.env.HARNESS_A || 'http://localhost:5297';
const B = process.env.HARNESS_B || 'http://localhost:5296';

// One cookie jar per node: each node has its own account/session for the same human.
function jar() {
    let cookies = '';
    return async (base, path, init = {}) => {
        const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
        if (cookies) headers.cookie = cookies;
        const resp = await fetch(base + path, { ...init, headers });
        const setc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
        for (const c of setc) {
            const pair = c.split(';')[0];
            const name = pair.split('=')[0];
            cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(name + '=')), pair].join('; ');
        }
        return resp;
    };
}

// The adoption codes are deflated JSON under an `rt1.` prefix (integration/test/helpers.cjs
// is the reference decoder).
const decodeCode = (code) => {
    const t = code.trim();
    if (t.startsWith('{')) return JSON.parse(t);
    return JSON.parse(inflateRawSync(Buffer.from(t.slice(4), 'base64url')).toString('utf8'));
};

const a = jar();
const b = jar();
const user = `field${Date.now() % 100000}`;
const pw = 'field-password-123';

for (const [f, base] of [[a, A], [b, B]]) {
    await f(base, '/api/auth/register', { method: 'POST', body: JSON.stringify({ username: user, password: pw }) });
    await f(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password: pw }) });
}

const made = await (await a(A, '/api/identity', { method: 'POST' })).json();
const root = made.root_pubkey;

// Adoption: B requests, A grants (one-trip when the nodes can reach each other).
const req = await (await b(B, '/api/identity/adopt/begin', { method: 'POST' })).json();
const leaf = decodeCode(req.code).leaf_pubkey;
const grant = await (await a(A, `/api/identity/${root}/nodes`, { method: 'POST', body: JSON.stringify({ code: req.code }) })).json();
if (!grant.delivered) {
    await b(B, '/api/identity/adopt/complete', { method: 'POST', body: JSON.stringify({ code: grant.code }) });
}

const sync = async () => {
    await (await a(A, `/api/identity/${root}/sync`, { method: 'POST' })).json();
};
const save = async (f, base, docId, body, parents) => {
    const r = await (await f(base, `/api/identity/${root}/docs/${docId}`, {
        method: 'PUT',
        body: JSON.stringify({ title: 'shared', body, parents, format: 'marquee' }),
    })).json();
    return r.version;
};

// ---------------------------------------------------------------------------------------------
// The scenario (disposable - rewrite per investigation). Currently: the revocation field test.
// good(A) <- good(A) <- good(A) <- bad(B) <- good(A), then A strikes B with the genesis cut.

const doc0 = await (await a(A, `/api/identity/${root}/docs`, {
    method: 'POST',
    body: JSON.stringify({ title: 'shared', body: 'good1', format: 'marquee' }),
})).json();
const doc = doc0.doc_id;
const v2 = await save(a, A, doc, 'good1\ngood2', [doc0.version]);
const v3 = await save(a, A, doc, 'good1\ngood2\ngood3', [v2]);
await sync();
const v4 = await save(b, B, doc, 'good1\ngood2\ngood3\nbad', [v3]);
await sync();
await save(a, A, doc, 'good1\ngood2\ngood3\nbad\ngood5', [v4]);

await a(A, `/api/identity/${root}/keys/${leaf}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ disposition: 'repudiation', cut: 'genesis' }),
});

const after = await (await a(A, `/api/identity/${root}/docs/${doc}`)).json();
console.log('API-level resolution:', JSON.stringify({ resolution: after.resolution, body: after.body }).slice(0, 300));
console.log(JSON.stringify({ user, pw, root, doc }));
console.log(`next: node ui.mjs ${A} ${user} ${pw} ${doc}`);
