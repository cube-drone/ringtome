// The zeroth rung: a stranger node resolves a persona from its BARE ROOT - no via, no
// hint, nothing but the identity itself. Works because a founding node's leaf IS the root,
// so its serving record lives at the root's own slot.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const a = session('http://localhost:5298');
await signUp(a, 'bare-alice');
const root = (await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
await sleep(1500);
const b = session('http://localhost:5299');
await signUp(b, 'bare-bob');
const seen = await b.fetch(`/api/id/${root}/profile`);
console.log('RESULT bare root resolved, no hints at all:', seen.status);
process.exit(0);
