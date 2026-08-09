// Populate the currently-running nodes with a vibrant fake network.
//
//   just test-data [personas-per-node] [actions-per-persona] [seed]
//
// Finds every booted node (the dev ports), registers PERSONAS fresh accounts on each - one
// persona per account, named, credentialed - then has every persona perform ACTIONS actions
// drawn from a weighted hat: posting in public, following and trusting strangers across
// nodes, keeping private notebooks, spreading onto other nodes. The point is a network worth
// testing against after a schema wipe, without rebuilding it by hand.
//
// EXTENDING IT is the design center, because "populating a vibrant fake network" is a
// permanent testing need, not this script's one-off shape. An action is one entry in ACTIONS:
//
//   { name: 'do-a-thing', weight: 10, run: async (ctx, p, rng) => { ... } }
//
//   - `weight` is its share of the hat - relative, not a percentage.
//   - `p` is the acting persona: { base, root, fetch, bases } (fetch carries their session).
//   - `ctx` is the world: { personas, nodes, endpointOf(base), lorem(rng), pick(rng, arr) }.
//   - Throwing is fine - a failed action is logged and the run continues, because one refused
//     dial must not cost the other twenty thousand actions.
//
// TODO, deliberately left on the surface: richer Marquee (spans, headers) and posts with
// IMAGES - the media pipeline wants real bytes, which wants a small corpus checked in.
//
// Reproducible: same seed, same network (modulo wall-clock timestamps). The seed prints at
// start; pass it back to replay. Credentials land in testdata-state.json beside this script,
// so any generated persona can be logged into by hand afterwards.
import fs from 'node:fs';
import { httpSession as session } from './http.mjs';
import { WORDS } from '../js/pure/words.js';

const J = { 'Content-Type': 'application/json' };
// Every generated account's password. Four characters is legal here because the dev nodes
// bind loopback, and the password floor is audience-aware (Config::password_min_len - 8
// facing the network, relaxed on loopback). A strict node refuses these registrations, which
// the birth loop reports rather than silently generating logins that never worked.
const PASSWORD = 'test';

// ---------------------------------------------------------------------------------------------
// The hat.

/// The document apps' STYLES - what a bucket's `app` field is matched against. Kept as a
/// literal rather than derived from js/pure/apps.js so this harness stays free of the UI's
/// module graph; if the app registry gains a style, add it here and the generator seeds it.
const BUCKET_STYLES = ['default', 'journal'];

const ACTIONS = [
    {
        name: 'post-in-public',
        weight: 30,
        run: async (ctx, p, rng) => {
            const titled = rng() < 0.7; // untitled posts are a first-class case
            const d = await api(p, 'POST', `/api/identity/${p.root}/docs`, {
                title: titled ? ctx.lorem(rng, 1).slice(0, 48).replace(/\.$/, '') : '',
                body: ctx.lorem(rng, 1 + Math.floor(rng() * 3)),
                format: 'marquee',
            });
            await api(p, 'POST', `/api/identity/${p.root}/docs/${d.doc_id}/publish`);
        },
    },
    {
        name: 'follow-someone',
        weight: 20,
        run: async (ctx, p, rng) => {
            const them = ctx.pick(rng, ctx.personas.filter((o) => o.root !== p.root));
            if (!them) return;
            // Follow the way a human does: from their page - which, for a persona on
            // another node, is also the fetch that makes the follow feed-capable.
            if (them.base !== p.base) {
                const via = await ctx.endpointOf(them.base);
                await api(p, 'GET', `/api/id/${them.root}/profile?via=${via}`);
            }
            const level = ctx.pick(rng, [25, 50, 75, 100]);
            await api(p, 'PUT', `/api/identity/${p.root}/private/kv/contact:${them.root}/interest`, {
                value: String(level),
            });
        },
    },
    {
        name: 'unfollow-someone',
        weight: 4,
        run: async (ctx, p, rng) => {
            const them = ctx.pick(rng, ctx.personas.filter((o) => o.root !== p.root));
            if (!them) return;
            await api(p, 'PUT', `/api/identity/${p.root}/private/kv/contact:${them.root}/interest`, {
                value: '',
            });
        },
    },
    {
        name: 'trust-someone',
        weight: 10,
        run: async (ctx, p, rng) => {
            const them = ctx.pick(rng, ctx.personas.filter((o) => o.root !== p.root));
            if (!them) return;
            const stop = ctx.pick(rng, [5, 20, 50, 80, 95]);
            await api(p, 'PUT', `/api/identity/${p.root}/private/kv/contact:${them.root}/trust`, {
                value: String(stop),
            });
            if (rng() < 0.4) {
                // Some trust is published - the consent that feeds the node's standing table.
                await api(p, 'PUT', `/api/identity/${p.root}/private/kv/contact:${them.root}/trust_public`, {
                    value: 'true',
                });
            }
        },
    },
    {
        name: 'untrust-someone',
        weight: 3,
        run: async (ctx, p, rng) => {
            const them = ctx.pick(rng, ctx.personas.filter((o) => o.root !== p.root));
            if (!them) return;
            await api(p, 'PUT', `/api/identity/${p.root}/private/kv/contact:${them.root}/trust`, {
                value: '',
            });
        },
    },
    {
        // A bucket's app-type is its STYLE, not the app's id (js/pure/apps.js: `bucketsForApp`
        // filters on `app.style`). Registering `app: 'notes'` looked right and was invisible -
        // TurboNotes' style is 'default', so the bucket matched no app's rail and the notes
        // filed in it could not be opened from anywhere (Curtis, 2026-08-08, from the UI).
        // Drawing across the real styles also seeds every document app, not just one.
        name: 'keep-a-private-notebook',
        weight: 6,
        run: async (ctx, p, rng) => {
            const name = `${ctx.pick(rng, WORDS)}-${ctx.pick(rng, WORDS)}`;
            const app = ctx.pick(rng, BUCKET_STYLES);
            await api(p, 'POST', `/api/identity/${p.root}/buckets`, { name, app });
            p.buckets.push(name);
        },
    },
    {
        name: 'write-in-private',
        weight: 20,
        run: async (ctx, p, rng) => {
            const d = await api(p, 'POST', `/api/identity/${p.root}/docs`, {
                title: ctx.lorem(rng, 1).slice(0, 40),
                body: ctx.lorem(rng, 1 + Math.floor(rng() * 4)),
                format: 'marquee',
            });
            if (p.buckets.length && rng() < 0.8) {
                const bucket = ctx.pick(rng, p.buckets);
                await api(p, 'PUT',
                    `/api/identity/${p.root}/docs/${d.doc_id}/buckets/${encodeURIComponent(bucket)}`);
            }
            // Remembered so it can be edited, tagged and filed later - the deep behaviours
            // only exist if a note outlives the round that wrote it.
            p.notes.push({ doc_id: d.doc_id, head: d.version });
        },
    },
    {
        // The commonest thing anyone does with a note: open it again and change it. Each
        // save is a new VERSION asserting its parent, so a persona's notes accumulate real
        // version DAGs rather than one entry apiece.
        name: 'edit-a-private-note',
        weight: 14,
        run: async (ctx, p, rng) => {
            const note = ctx.pick(rng, p.notes);
            if (!note) return;
            const saved = await api(p, 'PUT', `/api/identity/${p.root}/docs/${note.doc_id}`, {
                title: ctx.lorem(rng, 1).slice(0, 40),
                body: ctx.lorem(rng, 1 + Math.floor(rng() * 5)),
                parents: [note.head],
                format: 'marquee',
            });
            note.head = saved.version; // the next edit forks from here, not from genesis
        },
    },
    {
        // A private fact about a document (PROJECT_PLAN, Annotations) - the doc-meta chain,
        // which nothing else in this set exercises.
        name: 'tag-a-private-note',
        weight: 10,
        run: async (ctx, p, rng) => {
            const note = ctx.pick(rng, p.notes);
            if (!note) return;
            const tag = ctx.pick(rng, WORDS);
            await api(p, 'PUT',
                `/api/identity/${p.root}/docs/${note.doc_id}/annotations/tags/${encodeURIComponent(tag)}`);
        },
    },
    {
        // Taxonomies: ordered lists whose membership is per-element facts. Starts one if this
        // persona has none, so the action is useful from the first time it is drawn.
        name: 'file-a-note-in-a-list',
        weight: 8,
        run: async (ctx, p, rng) => {
            const note = ctx.pick(rng, p.notes);
            if (!note) return;
            if (!p.taxonomies.length || rng() < 0.25) {
                const made = await api(p, 'POST', `/api/identity/${p.root}/taxonomies`, {
                    title: `${ctx.pick(rng, WORDS)} ${ctx.pick(rng, WORDS)}`,
                });
                p.taxonomies.push(made.taxonomy_id);
            }
            const list = ctx.pick(rng, p.taxonomies);
            await api(p, 'PUT',
                `/api/identity/${p.root}/taxonomies/${list}/members/${note.doc_id}`, {});
        },
    },
    {
        // A picture into a private notebook. Deliberately the SMALLEST fixture we have
        // (its_webp.webp, ~11KB): this rides the ingest pipeline - quarantine, transcode to
        // canonical AVIF, thumbnail - which is the most expensive single act in the set, so
        // its weight is low and its bytes are few.
        name: 'upload-a-picture',
        weight: 4,
        run: async (ctx, p, rng) => {
            const title = ctx.lorem(rng, 1).slice(0, 32).replace(/\.$/, '');
            const made = await upload(p, `/api/identity/${p.root}/docs/binary`
                + `?title=${encodeURIComponent(title)}&parents=`, ctx.picture);
            if (!made.doc_id) return;
            if (p.buckets.length) {
                const bucket = ctx.pick(rng, p.buckets);
                await api(p, 'PUT',
                    `/api/identity/${p.root}/docs/${made.doc_id}/buckets/${encodeURIComponent(bucket)}`);
            }
        },
    },
    {
        name: 'go-public',
        weight: 4,
        run: async (ctx, p) => {
            // Serve: consent to the anonymous shelf and the directory. Idempotent.
            await api(p, 'POST', `/api/identity/${p.root}/serve`);
        },
    },
    {
        name: 'spread-to-another-node',
        weight: 2,
        run: async (ctx, p, rng) => {
            // The add-a-node ceremony, whole: a fresh account on the target node begins,
            // the persona's own session grants, the target completes. Afterwards the persona
            // lives on both - true MIGRATION (departing the old node) is a retirement flow,
            // and an extension for the day the hat wants it.
            const elsewhere = ctx.nodes.filter((base) => !p.bases.includes(base));
            const target = ctx.pick(rng, elsewhere);
            if (!target) return;
            const s = session(target);
            // The same login on the other node: hammer-lantern signs in wherever their
            // persona lives. The pair is usually free there; a rare clash gets a suffix.
            let username = p.username;
            let creds = JSON.stringify({ username, password: PASSWORD });
            let reg = await s.fetch('/api/auth/register', { method: 'POST', headers: J, body: creds });
            if (reg.status >= 400) {
                username = `${p.username}-${1 + Math.floor(rng() * 98)}`;
                creds = JSON.stringify({ username, password: PASSWORD });
                reg = await s.fetch('/api/auth/register', { method: 'POST', headers: J, body: creds });
                if (reg.status >= 400) return;
            }
            await s.fetch('/api/auth/login', { method: 'POST', headers: J, body: creds });
            const begin = await (await s.fetch('/api/identity/adopt/begin', { method: 'POST', headers: J })).json();
            const grant = await api(p, 'POST', `/api/identity/${p.root}/nodes`, { code: begin.code });
            const done = await s.fetch('/api/identity/adopt/complete', {
                method: 'POST', headers: J, body: JSON.stringify({ code: grant.code }),
            });
            if (done.status === 200) p.bases.push(target);
        },
    },
];

// ---------------------------------------------------------------------------------------------
// Small machinery.

/// POST raw bytes (the binary-upload door: query-string metadata, body is the file). Its own
/// helper because `api` JSON-encodes everything it is handed, and an image is not JSON.
async function upload(p, path, bytes) {
    const resp = await p.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
    });
    if (resp.status >= 400) {
        throw new Error(`POST ${path} -> ${resp.status} ${(await resp.text()).slice(0, 120)}`);
    }
    try {
        return JSON.parse(await resp.text());
    } catch {
        return {};
    }
}

async function api(p, method, path, body) {
    const resp = await p.fetch(path, {
        method,
        headers: body ? J : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status >= 400) {
        throw new Error(`${method} ${path} -> ${resp.status} ${(await resp.text()).slice(0, 120)}`);
    }
    const text = await resp.text();
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

// The upload fixture, read once: the smallest bitmap in sample_media (~11KB). Small on
// purpose - this exercises the ingest pipeline's SHAPE (quarantine, transcode, thumbnail),
// and a bigger file would only measure the transcoder.
const picture = fs.readFileSync(
    new URL('../../sample_media/its_webp.webp', import.meta.url)
);

// Deterministic RNG (mulberry32): same seed, same network.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Names draw from the SAME pinned wordlist the speakable checksums use (pure/words.js, the
// EFF short list - 1296 words, so ~1.7M pairs): one vocabulary for the whole cozy register.
// The login IS the name: you sign in as `hammer-lantern` and meet persona "Hammer Lantern",
// so the roster this prints at the end is directly a list of people to walk around as.
const title = (w) => w.charAt(0).toUpperCase() + w.slice(1);
function namePair(rng) {
    const a = WORDS[Math.floor(rng() * WORDS.length)];
    let b = WORDS[Math.floor(rng() * WORDS.length)];
    if (b === a) b = WORDS[(WORDS.indexOf(a) + 1) % WORDS.length];
    return { username: `${a}-${b}`, display: `${title(a)} ${title(b)}` };
}

const LOREM = [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco.',
    'Duis aute irure dolor in reprehenderit in voluptate velit.',
    'Excepteur sint occaecat cupidatat non proident, sunt in culpa.',
    'At vero eos et accusamus et iusto odio dignissimos ducimus.',
    'Nam libero tempore, cum soluta nobis est eligendi optio.',
    'Temporibus autem quibusdam et aut officiis debitis aut rerum.',
];

function lorem(rng, paragraphs) {
    const para = () =>
        Array.from({ length: 1 + Math.floor(rng() * 4) }, () => LOREM[Math.floor(rng() * LOREM.length)])
            .join(' ');
    return Array.from({ length: paragraphs }, para).join('\n\n');
}

const pick = (rng, arr) => (arr.length ? arr[Math.floor(rng() * arr.length)] : undefined);

function drawAction(rng) {
    const total = ACTIONS.reduce((n, a) => n + a.weight, 0);
    let roll = rng() * total;
    for (const a of ACTIONS) {
        roll -= a.weight;
        if (roll <= 0) return a;
    }
    return ACTIONS[ACTIONS.length - 1];
}

// ---------------------------------------------------------------------------------------------
// The run.

// Defaults sized for "a vibrant town in under a minute" (settled 2026-08-05 after the 100x100
// original spent its evenings measuring the node instead of populating it - useful, but a
// seeding tool should seed). Scale up explicitly when you WANT a soak test: `just test-data 100 100`.
const PERSONAS = Number(process.argv[2]) || 15;
const PER = Number(process.argv[3]) || 15;
const SEED = Number(process.argv[4]) || Math.floor(Math.random() * 2 ** 31);
const rng = mulberry32(SEED);

const candidatePorts = (process.env.RINGTOME_TESTDATA_PORTS || '5281,5282,5283').split(',');
const nodes = [];
for (const port of candidatePorts) {
    const base = `http://localhost:${port.trim()}`;
    try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) nodes.push(base);
    } catch {
        // not running - not part of this network
    }
}
if (!nodes.length) {
    console.error('no nodes are up (tried ports ' + candidatePorts.join(', ') + ') - `just start` first');
    process.exit(1);
}
console.log(`seed ${SEED} | nodes: ${nodes.join(', ')} | ${PERSONAS} personas x ${PER} actions each`);

const endpoints = new Map();
const endpointOf = async (base) => {
    if (!endpoints.has(base)) {
        // Any resident's session will do - /api/node answers members, not the anonymous.
        const resident = personas.find((q) => q.base === base);
        const { toBase58 } = await import('../js/speakable.js');
        const node = await (await resident.fetch('/api/node')).json();
        endpoints.set(base, toBase58(node.endpoint_id));
    }
    return endpoints.get(base);
};

// Births: one account + one named persona per slot, on each node.
const personas = [];
const t0 = Date.now();
for (const base of nodes) {
    for (let i = 0; i < PERSONAS; i++) {
        const s = session(base);
        // Draw until a free pair lands: a collision (same seed re-run, or 1.7M-to-one luck)
        // just draws again, still deterministically - the rng sequence carries on.
        let who = null;
        for (let tries = 0; tries < 8 && !who; tries++) {
            const pair = namePair(rng);
            const creds = JSON.stringify({ username: pair.username, password: PASSWORD });
            const reg = await s.fetch('/api/auth/register', { method: 'POST', headers: J, body: creds });
            if (reg.status < 400) {
                who = pair;
            } else {
                const why = (await reg.text()).slice(0, 120);
                if (!why.includes('taken')) {
                    console.error(`registration refused on ${base}: ${why}`
                        + (why.includes('password')
                            ? ' (a network-facing node keeps the 8-char password floor)'
                            : ''));
                    process.exit(1);
                }
            }
        }
        if (!who) {
            console.error(`could not find a free name on ${base} after 8 draws - wipe or reseed`);
            process.exit(1);
        }
        await s.fetch('/api/auth/login', {
            method: 'POST', headers: J,
            body: JSON.stringify({ username: who.username, password: PASSWORD }),
        });
        const made = await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json();
        const p = {
            base, bases: [base], root: made.root_pubkey, username: who.username,
            fetch: s.fetch, buckets: [], name: who.display,
            // What this persona has made, so the actions below have something to revisit:
            // private notes as { doc_id, head } (head is the parent an edit asserts), and
            // the taxonomies they have started. A life needs a history to act on.
            notes: [], taxonomies: [],
        };
        await api(p, 'POST', `/api/identity/${p.root}/profile`, { field: 'name', value: p.name });
        personas.push(p);
    }
    console.log(`  ${base}: ${PERSONAS} personas born (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// Lives: interleaved rounds, one action per persona per round, order shuffled per round -
// the network grows the way a real one does, everyone at once, rather than one biography
// completing before the next begins.
let done = 0;
let failed = 0;
const failures = new Map();
let lastReport = Date.now(); // per-decade rate, so the log can't read as "each step slower"
for (let round = 0; round < PER; round++) {
    const order = personas.slice().sort(() => rng() - 0.5);
    for (const p of order) {
        const action = drawAction(rng);
        try {
            await action.run({ personas, nodes, endpointOf, lorem, pick, picture }, p, rng);
        } catch (e) {
            failed++;
            failures.set(action.name, (failures.get(action.name) || 0) + 1);
            if (failed <= 5) console.error(`  [${action.name}] ${e.message}`);
        }
        done++;
    }
    if ((round + 1) % 10 === 0 || round === PER - 1) {
        // Both clocks, labeled: the DELTA is the health signal (a rising ms/action means the
        // node is slowing), the total is just how long you've waited. An earlier version
        // printed only elapsed-since-start, which read as "every round is slower than the
        // last" even when the rate was flat.
        const now = Date.now();
        const batch = personas.length * 10;
        const rate = ((now - lastReport) / Math.min(batch, done || 1)).toFixed(0);
        lastReport = now;
        console.log(`  round ${round + 1}/${PER}: ${done} actions, ${failed} failed`
            + ` (${rate}ms/action this stretch, ${((now - t0) / 1000).toFixed(0)}s total)`);
    }
}

const statePath = new URL('./testdata-state.json', import.meta.url).pathname;
fs.writeFileSync(statePath, JSON.stringify({
    seed: SEED,
    password: PASSWORD,
    generated_at: new Date().toISOString(),
    personas: personas.map((p) => ({
        username: p.username, name: p.name, root: p.root, nodes: p.bases,
    })),
}, null, 2));
console.log(`done: ${done} actions (${failed} failed`
    + (failures.size ? `: ${[...failures].map(([k, v]) => `${k} x${v}`).join(', ')}` : '')
    + `) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// The roster: who you can walk around as. The login is the name.
console.log(`\nlog in as any of these (password for everyone: ${PASSWORD}):`);
const shown = personas.slice(0, 24);
for (const p of shown) {
    const ports = p.bases.map((b) => ':' + new URL(b).port).join(',');
    console.log(`  ${p.username.padEnd(22)} ${ports.padEnd(14)} "${p.name}"`);
}
if (personas.length > shown.length) {
    console.log(`  ...and ${personas.length - shown.length} more in testdata-state.json`);
}
console.log(`credentials -> ${statePath}`);
process.exit(0);
