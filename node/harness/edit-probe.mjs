// Editing something already in the stack, in place. The 15-second unlock itself can't be
// driven here (jsdom runs no CSS animations, so animationend never fires) - what IS driven is
// everything it leads to: the editor mounting on the item, holding its words, and re-posting.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const s = session('http://localhost:5299');
await signUp(s, 'editor');
const made = await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json();
const root = made.root_pubkey;

// One UNTITLED post - the case where unlocking used to do nothing at all, because the only
// affordance was a title link and there was no title.
const d = await (await s.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: '', body: 'first words', format: 'marquee' }) })).json();
await s.fetch(`/api/identity/${root}/docs/${d.doc_id}/buckets/feed`, { method: 'PUT', headers: J });
await s.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
await sleep(1500);

const dom = await s.boot('/home/feed');
const doc = dom.window.document;
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
for (let t = 0; t < 200 && !doc.querySelector('.feed-item'); t++) await sleep(50);
const item = () => doc.querySelector('.feed-stack .feed-item');
console.log('RESULT the untitled post is in the stack:', !!item(),
    '| it offers the lock:', !!item()?.querySelector('.journal-lock'),
    '| and no dead title link:', !item()?.querySelector('.feed-item-title a'));

// The real ceremony: click the lock, then end its animation by hand. jsdom never runs the
// 15-second fill, but the app's own handler hangs off `animationend`, so firing that event
// drives exactly the path a real unlock takes - seal pref and all.
click(item().querySelector('.journal-lock'));
for (let t = 0; t < 60 && !item()?.querySelector('.journal-unlock-bar'); t++) await sleep(50);
console.log('RESULT clicking the lock starts the fill:', !!item()?.querySelector('.journal-unlock-bar'));
item().querySelector('.journal-unlock-bar')
    .dispatchEvent(new dom.window.Event('animationend', { bubbles: true }));

for (let t = 0; t < 200 && !item()?.querySelector('.cm-editor'); t++) await sleep(50);
console.log('RESULT the unlock opens the editor ON the item:', !!item()?.querySelector('.cm-editor'),
    '| holding its words:', JSON.stringify(
        (item()?.querySelector('.cm-content') || {}).textContent?.trim()));
console.log('RESULT and offers to say it again:',
    JSON.stringify((item()?.querySelector('.feed-post') || {}).textContent));
console.log('RESULT the state reads:',
    JSON.stringify((item()?.querySelector('.feed-item-state') || {}).textContent));

// Saying it again from the stack: it re-seals, and does NOT mint a next page - there is no
// slot to move along, and a blank composer for pressing a button on an old post is nonsense.
const feedDocs = async () => {
    const r = await (await s.fetch(`/api/identity/${root}/docs`)).json();
    return (Array.isArray(r) ? r : r.docs || []).filter((x) => (x.buckets || []).includes('feed'));
};
const before = (await feedDocs()).length;
click(item().querySelector('.feed-post'));
for (let t = 0; t < 200 && item()?.querySelector('.cm-editor'); t++) await sleep(50);
await sleep(2000);
console.log('RESULT re-posting closes the editor:', !item()?.querySelector('.cm-editor'),
    '| and seals it again:', !!item()?.querySelector('.journal-lock'));
console.log('RESULT feed documents before/after re-posting:', before, '/', (await feedDocs()).length,
    '(unchanged - no next page for an old post)');
const prof = await (await fetch(`http://localhost:5299/api/id/${root}/profile`)).json();
console.log('RESULT the world still sees exactly one post:', prof.posts.length);
process.exit(0);
