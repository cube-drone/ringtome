// The minted address round trip: A's /id face now mints ?via= as identity LEAVES; a
// stranger node resolves each hint through its signed serving record (root-checked) and
// dials the endpoint it names. No endpoint id anywhere in the shared string.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };

const a = session('http://localhost:5298');
await signUp(a, 'mint-alice');
const root = (await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
await a.fetch(`/api/identity/${root}/profile`, { method: 'POST', headers: J,
    body: JSON.stringify({ field: 'name', value: 'Mint Alice' }) });
await sleep(1500);

const anon = session('http://localhost:5298'); // the public face renders for strangers
const face = await (await anon.fetch(`/id/${root}`)).text();
const via = face.match(/via=([^"&]+)/)?.[1];
console.log('RESULT minted via:', via ? `${via.split(',').length} hint(s), leads ${via.split(',')[0].slice(0, 12)}…` : 'NONE');

const b = session('http://localhost:5299');
await signUp(b, 'mint-bob');
const seen = await b.fetch(`/api/id/${root}/profile?via=${via}`);
const body = await seen.json();
console.log('RESULT stranger resolved through the leaf via:', seen.status, '| name:',
    JSON.stringify(body?.profile?.name ?? body?.name ?? null));
process.exit(0);
