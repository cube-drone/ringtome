// The reason this feature exists: media INTO a post, from the composer, live. The upload chip
// opens a file picker (undriveable in jsdom), so the upload itself goes through the same API
// the picker calls - then the embed, the post, and the bake are all real.
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const png = readFileSync(new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname);
const s = session('http://localhost:5299');
await signUp(s, 'mediacomposer');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

const queued = await (await s.fetch(`/api/identity/${root}/docs/binary?title=inline`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
})).json();
let mediaDoc = null;
for (let i = 0; i < 300 && !mediaDoc; i++) {
    const jobs = await (await s.fetch(`/api/identity/${root}/ingest`)).json();
    const job = jobs.find((j) => j.job_id === queued.job_id);
    if (job?.status === 'done') mediaDoc = job.doc_id;
    await sleep(300);
}
const dom = await s.boot('/home/feed');
const doc = dom.window.document;
for (let t = 0; t < 240 && !doc.querySelector('.feed-post'); t++) await sleep(50);
const drafts = await (await s.fetch(`/api/identity/${root}/docs`)).json();
const draft = (Array.isArray(drafts) ? drafts : drafts.docs || []).find((d) =>
    (d.buckets || []).includes('feed'));
const detail = await (await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`)).json();
await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`, { method: 'PUT', headers: J,
    body: JSON.stringify({ title: 'Cat Content', format: 'marquee', parents: detail.save_parents,
        body: `Behold:\n\n![the cat](/api/identity/${root}/docs/${mediaDoc}/body/cat.avif)\n` }) });
await sleep(1500);
doc.querySelector('.feed-post').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
for (let t = 0; t < 200 && !doc.querySelector('.feed-entry'); t++) await sleep(50);
console.log('RESULT posted from the composer:', 
    JSON.stringify(doc.querySelector('.feed-entry .feed-entry-title')?.textContent));
const prof = await (await fetch(`http://localhost:5299/api/id/${root}/profile`)).json();
const body = await (await fetch(`http://localhost:5299/id/${root}/docs/${prof.posts[0].doc_id}/body`)).text();
const target = body.match(/\]\((\/id\/[^)]+)\)/)?.[1];
const media = target && await fetch(`http://localhost:5299${target}`);
console.log("RESULT the post's image baked and serves publicly:", media?.status === 200,
    media?.headers?.get('content-type'));
process.exit(0);
