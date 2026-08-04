// Someone's public posts on their /id page: present, newest first, with their words rendered.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };

// An author with three posts, published oldest first so the ORDER has to be undone.
const author = session('http://localhost:5299');
await signUp(author, 'poster');
const made = await (await author.fetch('/api/identity', { method: 'POST', headers: J })).json();
const root = made.root_pubkey;
for (const [title, words] of [['First', 'the oldest thing'], ['Second', 'the middle thing'],
                              ['', 'the newest thing, untitled']]) {
    const d = await (await author.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
        body: JSON.stringify({ title, body: words, format: 'marquee' }) })).json();
    await author.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
    await sleep(1100); // distinct publication timestamps
}
const speak = (await (await fetch(`http://localhost:5299/api/id/${root}/profile`)).json()).speakable;

// A DIFFERENT member visits their page.
const reader = session('http://localhost:5299');
await signUp(reader, 'reader');
await (await reader.fetch('/api/identity', { method: 'POST', headers: J })).json();
const dom = await reader.boot(`/id/${speak}`);
const doc = dom.window.document;
for (let t = 0; t < 200 && !doc.querySelector('.public-post-body'); t++) await sleep(50);
const posts = [...doc.querySelectorAll('.public-post')];
console.log('RESULT posts on their page:', posts.length);
console.log('RESULT in order:', posts.map((p) => JSON.stringify(
    (p.querySelector('.public-post-body') || {}).textContent?.trim() || '(no words)')).join(' | '));
console.log('RESULT titles:', posts.map((p) =>
    (p.querySelector('.public-post-title') || {}).textContent || '(none)').join(' | '));
console.log('RESULT dated:', posts.every((p) => (p.querySelector('.public-post-when') || {}).textContent?.trim()));
process.exit(0);
