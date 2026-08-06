// Publication media baking, end to end: a marquee post embedding (a) a PRIVATE image and
// (b) an EXTERNAL image served by this probe's own tiny http server. Clicking Post must
// surface the "preparing media" modal for the external item, bake both, rewrite the public
// body to /id/... targets, and leave the words readable - media and all - to a stranger.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const IMAGE = new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname;
const png = readFileSync(IMAGE);

// The "open web": one PNG on a loopback port (allowed under LOCAL_TEST, and only there).
const web = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
});
await new Promise((r) => web.listen(8123, '127.0.0.1', r));

const s = session('http://localhost:5299');
await signUp(s, 'baker');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

// A private image through the real ingest pipeline.
const queued = await (await s.fetch(`/api/identity/${root}/docs/binary?title=housecat`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
})).json();
let mediaDoc = null;
for (let i = 0; i < 300 && !mediaDoc; i++) {
    const jobs = await (await s.fetch(`/api/identity/${root}/ingest`)).json();
    const job = jobs.find((j) => j.job_id === queued.job_id);
    if (job?.status === 'done') mediaDoc = job.doc_id;
    if (job?.status === 'failed') { console.log('RESULT ingest failed:', job.error); process.exit(1); }
    await sleep(300);
}
console.log('RESULT private image ingested:', !!mediaDoc);

// The draft: both embeds.
const bodyText = `Look at this!\n\n![my cat](/api/identity/${root}/docs/${mediaDoc}/body/housecat.avif)\n\nAnd from the web:\n\n![found](http://127.0.0.1:8123/pic.png)\n`;
const d = await (await s.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'Media Post', body: bodyText, format: 'marquee' }) })).json();
await s.fetch(`/api/identity/${root}/docs/${d.doc_id}/buckets/feed`, { method: 'PUT', headers: J });
await sleep(1200);

// Boot the feed, click Post on the composer's draft... the composer holds the OPEN draft -
// our doc is a second draft; simplest honest UI path: publish via the API loop the client
// uses (202s then 200), then verify the modal path via the raw responses.
const first = await (await s.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J }));
const firstBody = await first.json();
console.log('RESULT first publish answers 202 with the modal items:', first.status === 202,
    '| items:', (firstBody.baking || []).map((i) => `${i.kind}:${i.status}`).join(', '));

let done = null;
for (let i = 0; i < 120 && !done; i++) {
    const r = await s.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
    const b = await r.json();
    if (r.status === 200 && b.post_id) done = b.post_id;
    else if ((b.baking || []).some((x) => x.status === 'failed')) {
        console.log('RESULT bake failed:', JSON.stringify(b.baking)); process.exit(1);
    }
    await sleep(600);
}
console.log('RESULT publish completed after baking:', !!done);

// The world reads it: anonymous body, rewritten targets, and the baked media itself.
const pub = await (await fetch(`http://localhost:5299/id/${root}/docs/${done}/body`)).text();
const rewritten = [...pub.matchAll(/\]\((\/id\/[^)]+)\)/g)].map((m) => m[1]);
console.log('RESULT public body has NO private links:', !pub.includes('/api/identity/'),
    '| rewritten to /id targets:', rewritten.length === 2);
for (const target of rewritten) {
    const r = await fetch(`http://localhost:5299${target}`);
    console.log(`RESULT stranger fetches ${target.slice(0, 40)}... -> ${r.status} ${r.headers.get('content-type')}`);
}
// The private draft keeps its private links - the crossing mints, never moves.
const priv = await (await s.fetch(`/api/identity/${root}/docs/${d.doc_id}`)).json();
console.log('RESULT the draft still holds its private links:', priv.body.includes('/api/identity/'));
web.close();
process.exit(0);
