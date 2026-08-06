// The mode rows, as rendered: feed = interactive + side only; notes = interactive, side, read.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const s = session('http://localhost:5299');
await signUp(s, 'moderow');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const tabsOf = (doc) => [...doc.querySelectorAll('.editor-tabs .tab')].map((t) => t.getAttribute('title'));

const feed = await s.boot('/home/feed');
for (let t = 0; t < 240 && !feed.window.document.querySelector('.editor-tabs'); t++) await sleep(50);
console.log('RESULT feed tabs:', JSON.stringify(tabsOf(feed.window.document)));

const note = await (await s.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'a note', body: 'words', format: 'marquee' }) })).json();
const notes = await s.boot(`/home/notes/${note.doc_id}`);
for (let t = 0; t < 240 && !notes.window.document.querySelector('.editor-tabs'); t++) await sleep(50);
console.log('RESULT notes tabs:', JSON.stringify(tabsOf(notes.window.document)));
console.log('RESULT container-type on the surface:', 
    !!feed.window.document.querySelector('.reader'));
process.exit(0);
