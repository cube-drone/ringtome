// Feed's reshaped flow: the app opens into ONE draft it made itself, you type in place, you
// post, and the slot moves on. The bug this shape exists to prevent - a create button clicked
// seven times - is checked directly: reload the app repeatedly and count the documents.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const s = session('http://localhost:5299');
await signUp(s, 'feed2');
const made = await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json();
const root = made.root_pubkey;

const feedDocs = async () => {
    const d = await (await s.fetch(`/api/identity/${root}/docs`)).json();
    const list = Array.isArray(d) ? d : d.docs || [];
    return list.filter((x) => (x.buckets || []).includes('feed'));
};

// Open the app three times over. Each visit must find the previous visit's draft.
for (let visit = 1; visit <= 3; visit++) {
    const dom = await s.boot('/home/feed');
    const doc = dom.window.document;
    // Time it: the first visit has no draft to find and must make one, and how long the
    // placeholder sits there IS the complaint this shape was reworked to answer.
    const t0 = Date.now();
    for (let t = 0; t < 240 && !doc.querySelector('.feed-composer'); t++) await sleep(50);
    console.log(`RESULT visit ${visit}: composer=${!!doc.querySelector('.feed-composer')}`,
        `after ${Date.now() - t0}ms | drafts on the node: ${(await feedDocs()).length}`);
    if (visit === 1) {
        // The columns are the documents apps' chrome, so check it is really THAT chrome:
        // a resizable, tuckable pane with the live editor inside it.
        const has = (sel) => !!doc.querySelector(sel);
        console.log('RESULT columns:', has('.feed-columns'), '| resizer:', has('.col-resizer'),
            '| editor in the column:', has('.feed-compose .cm-editor'), '| stream:', has('.feed-stack'));
        doc.querySelector('.pane-min').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        for (let t = 0; t < 60 && !doc.querySelector('.pane-rail'); t++) await sleep(50);
        const tucked = has('.pane-rail') && !has('.feed-composer');
        doc.querySelector('.pane-rail').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        for (let t = 0; t < 60 && !doc.querySelector('.feed-composer'); t++) await sleep(50);
        console.log('RESULT tucks to a rail:', tucked, '| and comes back:', has('.feed-composer'));
    }
    // Deliberately NOT closed: a closed jsdom window keeps its live-query subscriptions, and
    // the next render draws into a document that is gone. That throw is the instrument's, not
    // the app's - leave the windows open and let the process exit take them.
    await sleep(600);
}

// Write into the open draft and post it.
const [draft] = await feedDocs();
const detail = await (await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`)).json();
await s.fetch(`/api/identity/${root}/docs/${draft.doc_id}`, {
    method: 'PUT', headers: J,
    body: JSON.stringify({
        title: 'Hello, world', body: 'said in public, on purpose',
        format: 'marquee', parents: detail.save_parents,
    }),
});
await sleep(1500);

const dom = await s.boot('/home/feed');
const { window } = dom;
const doc = window.document;
for (let t = 0; t < 24 && !doc.querySelector('.feed-post'); t++) await sleep(500);
console.log('RESULT composer holds the words:', doc.querySelector('.feed-title').value);
console.log('RESULT stream before the click holds:',
    doc.querySelectorAll('.feed-stack .feed-item').length, 'items');
const clickAt = Date.now();
doc.querySelector('.feed-post').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
// The wait Curtis timed: click to the words appearing in the stream. Read from the DOM, not
// from the server - what matters is when it is on screen.
let inStream = 0;
for (let t = 0; t < 200 && !inStream; t++) {
    if (doc.querySelector('.feed-stack .feed-item')) inStream = Date.now() - clickAt;
    await sleep(5);
}
const state = (doc.querySelector('.feed-item-state') || {}).textContent;
console.log(`RESULT click to the post joining the stream: ${inStream}ms, reading "${state}"`);
let posted = null;
for (let t = 0; t < 30 && !posted; t++) {
    await sleep(500);
    const p = await (await fetch(`http://localhost:5299/api/id/${root}/profile`)).json();
    posted = (p.posts || [])[0] || null;
}
console.log('RESULT the post landed:', !!posted, posted ? `(${posted.title})` : '');
await sleep(2500);
// Every window left open above is still an app, and each one minted its own next page when
// the post left the slot - so this count is windows+1, not two. The one-draft rule is
// per-window by construction (the guard is a ref); the visits above are what prove it holds.
console.log('RESULT feed drafts after posting:', (await feedDocs()).length,
    `(the posted one, plus a fresh draft per live window)`);

const prof = await (await fetch(`http://localhost:5299/api/id/${root}/profile`)).json();
console.log('RESULT the world sees:', prof.posts.map((p) => p.title).join(', '));
const body = await (await fetch(`http://localhost:5299/id/${root}/docs/${prof.posts[0].doc_id}/body`)).text();
console.log('RESULT and reads:', JSON.stringify(body));
process.exit(0);
