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

// File both docs inside a SECTION of the tree, so the dial's tree behavior is observable:
// pages filter, the directory stays as scaffolding.
const troot = await (await s.fetch(`/api/identity/${root}/taxonomies`, { method: 'POST', headers: J, body: JSON.stringify({ title: 'wiki:default' }) })).json();
const sect = await (await s.fetch(`/api/identity/${root}/taxonomies`, { method: 'POST', headers: J, body: JSON.stringify({ title: 'stuff' }) })).json();
await s.fetch(`/api/identity/${root}/taxonomies/${troot.taxonomy_id}/members/${sect.taxonomy_id}`, { method: 'PUT', headers: J, body: '{}' });
const list0 = await (await s.fetch(`/api/identity/${root}/docs`)).json();
for (const d of list0.docs) {
    await s.fetch(`/api/identity/${root}/taxonomies/${sect.taxonomy_id}/members/${d.doc_id}`, { method: 'PUT', headers: J, body: '{}' });
}

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

// The kind dial (the funnel beside the search box): rotate through the three positions and
// watch the list narrow - the mixed doc/media list above is exactly its test bed.
const { click } = await import('./boot.mjs');
const titles = () =>
    [...doc.querySelectorAll('.note-row')].map((r) =>
        (r.querySelector('.note-row-title-text') || r.querySelector('.note-row-title')).textContent.trim()
    );
click(dom.window, doc.querySelector('.search-opts-btn'));
await waitFor(doc, () => doc.querySelector('.search-opts-kind'), 'the options dropdown');
const dial = () => doc.querySelector('.search-opts-kind');
const tree = () => ({
    sections: doc.querySelectorAll('.tree-row-section').length,
    pages: [...doc.querySelectorAll('.tree-row:not(.tree-row-section)')].length,
});
console.log('dial:', dial().textContent.trim(), '->', JSON.stringify(titles()), 'tree:', JSON.stringify(tree()));
for (let i = 0; i < 3; i++) {
    click(dom.window, dial());
    await sleep(300);
    console.log('dial:', dial().textContent.trim(), '->', JSON.stringify(titles()), 'tree:', JSON.stringify(tree()));
}

// --- The everything-view: file the image into a recipes-typed bucket, then browse /home/all.
await s.fetch(`/api/identity/${root}/buckets`, { method: 'POST', headers: J, body: JSON.stringify({ name: 'shots', app: 'recipes' }) });
await s.fetch(`/api/identity/${root}/docs/${queued.doc_id}/buckets/shots`, { method: 'PUT', headers: J });
click(dom.window, [...doc.querySelectorAll('.quickbar-hex')].find((b) => b.title === 'All Documents'));
await waitFor(doc, () => dom.window.location.pathname === '/home/all' && doc.querySelectorAll('.note-row').length >= 2, 'the everything-view');
await sleep(500);
const allRows = [...doc.querySelectorAll('.note-row')].map((r) => ({
    title: r.querySelector('.note-row-title-text').textContent.trim(),
    buckets: r.querySelector('.note-row-buckets')?.textContent.trim(),
    bigThumb: !!r.querySelector('.note-row-thumb-big'),
    home: !!r.querySelector('.note-row-home'),
}));
console.log('all-view rows:', JSON.stringify(allRows, null, 2));
console.log('new-button hidden:', !doc.querySelector('.notes-new'));

// Open the image IN the everything-view: the URL must stay in /all (no cozy re-dress).
click(dom.window, [...doc.querySelectorAll('.note-row')].find((r) => r.textContent.includes('bowie')));
await sleep(1500);
console.log('selected in /all, url:', dom.window.location.pathname);

// Follow me home: the image lives in a recipes-typed bucket, so home is the Recipes app.
click(dom.window, doc.querySelector('.note-row.selected .note-row-home') || doc.querySelector('.note-row-home'));
await sleep(1500);
console.log('after follow-me-home, url:', dom.window.location.pathname);
process.exit(0);
