// The standing probe: log in with existing credentials and report what the persona layer
// concludes - each persona's standing, and whether the SPA boots to the console or the
// farewell screen. The diagnostic half of the wipe-recovery scenarios (2026-08-02, "can't
// tell is not goodbye"); the wiping half is operator work by design, because the scenarios
// are about node lifecycle, which no test suite should own:
//
//   Shape 1 - journal replay (also a unit test: db.rs empty_db_under_a_nonempty_journal...):
//     kill the node; rm data/users/<root>.db*; boot; run this. Expect: active, console,
//     "rebuilt empty database from its journal" in the node log.
//   Shape 2 - peer heal: two adopted nodes; kill B; rm B's users/* AND journals/*; boot B
//     (A still up); run this against B. Expect: active within seconds (identity_peers +
//     the resync loop dial on boot).
//   Shape 3 - peer down: as shape 2 but with A ALSO down. Expect: standing "unknown",
//     console anyway, NO farewell - can't-tell is not goodbye. Boot A later and re-run:
//     active.
//
// Usage: node standing.mjs <base> <username> <password>
import { session, sleep } from './boot.mjs';

const [BASE, USER, PW] = process.argv.slice(2);
if (!PW) {
    console.error('usage: node standing.mjs <base> <username> <password>');
    process.exit(2);
}

const s = session(BASE);
const J = { 'Content-Type': 'application/json' };
const login = await s.fetch('/api/auth/login', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ username: USER, password: PW }),
});
if (login.status !== 200) {
    console.error(`login failed (${login.status})`);
    process.exit(1);
}
const personas = await (await s.fetch('/api/identity')).json();
for (const p of personas) {
    console.log(`persona ${p.root_pubkey.slice(0, 8)}…  standing: ${p.standing}`);
}
if (personas.length === 0) console.log('no personas on this account');

const dom = await s.boot('/home');
const doc = dom.window.document;
await sleep(5000);
const text = doc.body.textContent || '';
const farewell = text.includes('left the persona') || text.includes('no longer part');
console.log(`SPA: landed at ${dom.window.location.pathname}, farewell=${farewell}`);
process.exit(0);
