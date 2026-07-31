// The media-list probe: upload a real image via the ingest pipeline, then open the notes list
// in the real SPA (live-cache stream and all) and check the sidebar row wears its thumbnail.
// First use (2026-07-31): proving the 32px sidebar thumbs - and, en route, discovering the
// harness needed a real WebSocket bridge, because the notes list is a pure-mirror surface.
//
// Usage: a throwaway node on 5299 (see state.mjs's env recipe), then `node thumbs.mjs`.
import { readFileSync } from 'node:fs';
import { session, signUp, waitFor, sleep } from './boot.mjs';

const BASE = process.env.HARNESS_BASE || 'http://localhost:5299';
const IMAGE = new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname;

const s = session(BASE);
await signUp(s, 'thumb');
const J = { 'Content-Type': 'application/json' };
const made = await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json();
const root = made.root_pubkey;

// One text note (the fallback glyph) and one real image (the thumbnail).
await s.fetch(`/api/identity/${root}/docs`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ title: 'plain note', body: 'words', format: 'marquee' }),
});
const queued = await (await s.fetch(`/api/identity/${root}/docs/binary?title=bowie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: readFileSync(IMAGE),
})).json();
let job;
for (let i = 0; i < 300; i++) {
    const jobs = await (await s.fetch(`/api/identity/${root}/ingest`)).json();
    job = jobs.find((j) => j.job_id === queued.job_id);
    if (job && (job.status === 'done' || job.status === 'failed')) break;
    await sleep(200);
}
console.log('ingest:', job && job.status);

const dom = await s.boot('/home/notes');
const doc = dom.window.document;
await waitFor(doc, () => doc.querySelectorAll('.note-row').length >= 2, 'both rows in the list');
await sleep(500);
const rows = [...doc.querySelectorAll('.note-row')].map((r) => ({
    title: (r.querySelector('.note-row-title-text') || r.querySelector('.note-row-title')).textContent.trim(),
    thumb: r.querySelector('img.note-row-thumb')?.getAttribute('src') || null,
    kindIcon: !!r.querySelector('.note-row-kind'),
}));
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
