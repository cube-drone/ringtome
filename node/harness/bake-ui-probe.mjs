// The modal, as a human meets it: type an external embed into the OPEN draft, click Post,
// and the "preparing media for the network" modal must appear, list the item, and clear when
// the bake lands - with the post then at the top of the feed.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const png = readFileSync(new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname);
const web = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
});
await new Promise((r) => web.listen(8124, '127.0.0.1', r));

const s = session('http://localhost:5299');
await signUp(s, 'modalist');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const dom = await s.boot('/home/feed');
const doc = dom.window.document;
for (let t = 0; t < 240 && !doc.querySelector('.feed-post'); t++) await sleep(50);

// Words into the open draft by the API (the composer's own save path), then Post by click.
const drafts = await (await s.fetch(`/api/identity/${root}/docs`)).json();
const draft = (Array.isArray(drafts) ? drafts : drafts.docs || []).find((d) =>
    (d.buckets || []).includes('feed'));
const detail = await (await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`)).json();
await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`, { method: 'PUT', headers: J,
    body: JSON.stringify({ title: 'With Media', format: 'marquee', parents: detail.save_parents,
        body: 'From the web:\n\n![found](http://127.0.0.1:8124/pic.png)\n' }) });
await sleep(1500);
doc.querySelector('.feed-post').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

let sawModal = null;
for (let t = 0; t < 200 && !sawModal; t++) {
    const modal = doc.querySelector('.bake-modal');
    if (modal) sawModal = modal.textContent.replace(/\s+/g, ' ').trim().slice(0, 90);
    await sleep(50);
}
console.log('RESULT the modal appears on Post:', JSON.stringify(sawModal));
for (let t = 0; t < 300 && doc.querySelector('.bake-modal'); t++) await sleep(200);
console.log('RESULT and clears when the bake lands:', !doc.querySelector('.bake-modal'));
for (let t = 0; t < 100 && !doc.querySelector('.feed-entry'); t++) await sleep(100);
console.log('RESULT the post tops the feed:', 
    JSON.stringify(doc.querySelector('.feed-entry .feed-entry-title')?.textContent));
web.close();
process.exit(0);
