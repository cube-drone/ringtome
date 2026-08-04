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
// Wait for EVERY body, not the first: they fetch in parallel, and sampling on the first one
// reads a page that is still filling in.
for (let t = 0; t < 200 && doc.querySelectorAll('.public-post-body').length < 3; t++) await sleep(50);
const posts = [...doc.querySelectorAll('.public-post')];
console.log('RESULT posts on their page:', posts.length);
console.log('RESULT in order:', posts.map((p) => JSON.stringify(
    (p.querySelector('.public-post-body') || {}).textContent?.trim() || '(no words)')).join(' | '));
console.log('RESULT titles:', posts.map((p) =>
    (p.querySelector('.public-post-title') || {}).textContent || '(none)').join(' | '));
console.log('RESULT dated:', posts.every((p) => (p.querySelector('.public-post-when') || {}).textContent?.trim()));

// A shelf longer than one page, and the button that walks down it.
const many = session('http://localhost:5299');
await signUp(many, 'prolific');
const big = (await (await many.fetch('/api/identity', { method: 'POST', headers: J })).json())
    .root_pubkey;
for (let i = 0; i < 23; i++) {
    const d = await (await many.fetch(`/api/identity/${big}/docs`, { method: 'POST', headers: J,
        body: JSON.stringify({ title: `post ${i}`, body: `words ${i}`, format: 'plaintext' }) })).json();
    await many.fetch(`/api/identity/${big}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
}
const bigSpeak = (await (await fetch(`http://localhost:5299/api/id/${big}/profile`)).json()).speakable;
const dom2 = await reader.boot(`/id/${bigSpeak}`);
const doc2 = dom2.window.document;
for (let t = 0; t < 200 && !doc2.querySelector('.public-posts-more'); t++) await sleep(50);
console.log('RESULT first page shows:', doc2.querySelectorAll('.public-post').length,
    '| load more offered:', !!doc2.querySelector('.public-posts-more'));
doc2.querySelector('.public-posts-more')
    .dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true }));
for (let t = 0; t < 200 && doc2.querySelectorAll('.public-post').length <= 20; t++) await sleep(50);
await sleep(600);
const ids = [...doc2.querySelectorAll('.public-post-title')].map((n) => n.textContent);
console.log('RESULT after load more:', ids.length, '| all distinct:', new Set(ids).size === ids.length);
console.log('RESULT button gone at the end of the shelf:', !doc2.querySelector('.public-posts-more'));
process.exit(0);
