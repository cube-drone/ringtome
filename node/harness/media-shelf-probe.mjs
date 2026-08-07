// Publish a post that embeds an uploaded (private) image, then read every listing surface:
// the shelf (/api/id/.../profile + /posts) and the reader's feed. Media documents are minted
// onto the public lane by baking - the listings must show the POST only, never the AVIF.
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const png = readFileSync(new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname);
const s = session('http://localhost:5299');
await signUp(s, 'shelfcheck');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

const queued = await (await s.fetch(`/api/identity/${root}/docs/binary?title=shelfpic`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
})).json();
let media = null;
for (let i = 0; i < 300 && !media; i++) {
    const jobs = await (await s.fetch(`/api/identity/${root}/ingest`)).json();
    const j = jobs.find((x) => x.job_id === queued.job_id);
    if (j?.status === 'done') media = j.doc_id;
    await sleep(300);
}

const note = await (await s.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'Picture Post',
        body: `words first\n\n![shelfpic](/api/identity/${root}/docs/${media}/body/shelfpic_1.avif)`,
        format: 'marquee' }) })).json();
let postId = null;
for (let i = 0; i < 60 && !postId; i++) {
    const r = await s.fetch(`/api/identity/${root}/docs/${note.doc_id}/publish`, { method: 'POST', headers: J });
    const b = JSON.parse(await r.text());
    if (r.status === 200) postId = b.post_id;
    else await sleep(500);
}
await sleep(2500); // let fanout journal the arrival

const prof = await (await s.fetch(`/api/id/${root}/profile`)).json();
const posts = await (await s.fetch(`/api/id/${root}/posts`)).json();
const feed = await (await s.fetch(`/api/identity/${root}/feed`)).json();
const brief = (rows) => (rows || []).map((p) => `${p.title}:${p.format}`).join(', ') || '(empty)';
console.log('RESULT profile shelf:', brief(prof.posts));
console.log('RESULT posts pager  :', brief(posts.posts));
console.log('RESULT feed         :', brief(feed.items || feed.rows || feed));
console.log('RESULT post minted  :', !!postId, '| media doc:', media);
process.exit(0);
