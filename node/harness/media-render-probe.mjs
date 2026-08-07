// The same uploaded image, embedded identically in a journal entry and the feed draft: where
// does it render, where doesn't it, and what does the DOM say instead?
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const png = readFileSync(new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname);
const s = session('http://localhost:5299');
await signUp(s, 'renderer');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

const queued = await (await s.fetch(`/api/identity/${root}/docs/binary?title=righteous`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
})).json();
let media = null;
for (let i = 0; i < 300 && !media; i++) {
    const jobs = await (await s.fetch(`/api/identity/${root}/ingest`)).json();
    const j = jobs.find((x) => x.job_id === queued.job_id);
    if (j?.status === 'done') media = j.doc_id;
    await sleep(300);
}
const embed = `An image:\n\n![righteous](/api/identity/${root}/docs/${media}/body/righteous_1.avif)\n`;

// Journal: today's entry.
const jdoc = await (await s.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'today', body: embed, format: 'marquee' }) })).json();
await s.fetch(`/api/identity/${root}/docs/${jdoc.doc_id}/buckets/journal`, { method: 'PUT', headers: J });

// Feed: the open draft - which exists only after the app's first visit mints it.
const warm = await s.boot('/home/feed');
for (let t = 0; t < 240 && !warm.window.document.querySelector('.feed-composer'); t++) await sleep(50);
await sleep(500);
const drafts = await (await s.fetch(`/api/identity/${root}/docs`)).json();
const draft = (Array.isArray(drafts) ? drafts : drafts.docs || []).find((d) =>
    (d.buckets || []).includes('feed'));
const detail = await (await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`)).json();
await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`, { method: 'PUT', headers: J,
    body: JSON.stringify({ title: 'draft', body: embed, format: 'marquee', parents: detail.save_parents }) });
await sleep(1200);

const inspect = async (path, scope, label) => {
    const dom = await s.boot(path);
    const doc = dom.window.document;
    for (let t = 0; t < 240 && !doc.querySelector(`${scope} .cm-editor, ${scope} .marquee-root, ${scope} img`); t++)
        await sleep(50);
    await sleep(1500);
    const host = doc.querySelector(scope);
    const imgs = [...(host?.querySelectorAll('img, picture, [class*=media]') || [])]
        .map((n) => `${n.tagName}${n.className ? '.' + String(n.className).split(' ')[0] : ''}`);
    const text = host?.textContent?.slice(0, 160)?.replace(/\s+/g, ' ');
    console.log(`RESULT ${label}: media nodes = [${imgs.join(', ')}]`);
    console.log(`RESULT ${label} text: ${JSON.stringify(text)}`);
};
await inspect('/home/journal', '.journal', 'journal');
await inspect('/home/feed', '.feed-compose', 'feed composer');
process.exit(0);
