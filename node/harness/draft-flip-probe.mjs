// The field bug, replayed: write words in the open draft, upload an image (filed into the
// feed bucket, as the composer's upload does), and the composer must KEEP the text draft -
// not flip to the image.
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const png = readFileSync(new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname);
const s = session('http://localhost:5299');
await signUp(s, 'flipcheck');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

const warm = await s.boot('/home/feed');
for (let t = 0; t < 240 && !warm.window.document.querySelector('.feed-composer'); t++) await sleep(50);
await sleep(400);
const drafts = await (await s.fetch(`/api/identity/${root}/docs`)).json();
const draft = (Array.isArray(drafts) ? drafts : drafts.docs || []).find((d) =>
    (d.buckets || []).includes('feed'));
const detail = await (await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`)).json();
await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`, { method: 'PUT', headers: J,
    body: JSON.stringify({ title: 'My Words', body: 'the draft I am writing', format: 'marquee',
        parents: detail.save_parents }) });

// The upload, exactly as the composer's capture performs it: binary + file into 'feed'.
const queued = await (await s.fetch(`/api/identity/${root}/docs/binary?title=pexels-naya-lopez-237906221-12227708`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
})).json();
let media = null;
for (let i = 0; i < 300 && !media; i++) {
    const jobs = await (await s.fetch(`/api/identity/${root}/ingest`)).json();
    const j = jobs.find((x) => x.job_id === queued.job_id);
    if (j?.status === 'done') media = j.doc_id;
    await sleep(300);
}
await s.fetch(`/api/identity/${root}/docs/${media}/buckets/feed`, { method: 'PUT', headers: J });
await sleep(1500);

const dom = await s.boot('/home/feed');
const doc = dom.window.document;
for (let t = 0; t < 240 && !doc.querySelector('.feed-composer .editor-title'); t++) await sleep(50);
await sleep(800);
console.log('RESULT the composer kept the TEXT draft:',
    JSON.stringify(doc.querySelector('.feed-composer .editor-title')?.value),
    '| body:', JSON.stringify(doc.querySelector('.feed-composer .cm-content')?.textContent?.slice(0, 30)));
process.exit(0);
