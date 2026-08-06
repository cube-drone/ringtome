// Editing a published post, in BOTH homes of the shared card (postentry.js): the feed stream
// and your own /id page. The 15-second unlock can't run in jsdom (no CSS animations), so the
// probe fires animationend by hand - driving the app's real handler, not standing in for it.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const s = session('http://localhost:5299');
await signUp(s, 'editboth');
const me = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

// A published post of my own, via the API (title + body land, then publish).
const d = await (await s.fetch(`/api/identity/${me}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'Editable', body: 'original words', format: 'marquee' }) })).json();
await s.fetch(`/api/identity/${me}/docs/${d.doc_id}/buckets/feed`, { method: 'PUT', headers: J });
await s.fetch(`/api/identity/${me}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
await sleep(2500);

const ceremony = async (dom, doc, where) => {
    const click = (el) => el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    for (let t = 0; t < 240 && !doc.querySelector('.feed-entry'); t++) await sleep(50);
    // Own item: wait for the edit wiring (the mirror must answer before the lock appears).
    for (let t = 0; t < 120 && !doc.querySelector('.feed-entry .journal-lock, .feed-entry .feed-edit'); t++)
        await sleep(50);
    const entry = doc.querySelector('.feed-entry');
    const lock = entry?.querySelector('.journal-lock');
    const editBtn = entry?.querySelector('.feed-edit');
    console.log(`RESULT ${where}: entry=${!!entry} lock=${!!lock} edit=${!!editBtn}`);
    if (lock) {
        click(lock);
        for (let t = 0; t < 60 && !entry.querySelector('.journal-unlock-bar'); t++) await sleep(50);
        entry.querySelector('.journal-unlock-bar')
            ?.dispatchEvent(new dom.window.Event('animationend', { bubbles: true }));
    } else if (editBtn) {
        click(editBtn);
    }
    for (let t = 0; t < 240 && !entry.querySelector('.cm-editor'); t++) await sleep(50);
    console.log(`RESULT ${where}: editor opens in place=${!!entry.querySelector('.cm-editor')}`,
        '| holds the words:', !!entry.querySelector('.cm-content')?.textContent?.includes('words'),
        '| offers:', JSON.stringify(entry.querySelector('.feed-post')?.textContent));
    // CHANGE something before posting: retitle via the composer's own input (a plain field,
    // typeable in jsdom where the CodeMirror body is not).
    const titleBox = entry.querySelector('.feed-title');
    const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(titleBox, `Amended in the ${where}`);
    titleBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(300);
    click(entry.querySelector('.feed-post'));
    for (let t = 0; t < 240 && entry.querySelector('.cm-editor'); t++) await sleep(50);
    console.log(`RESULT ${where}: re-posting closes the editor=${!entry.querySelector('.cm-editor')}`,
        '| the card wears the NEW title with no reload:',
        JSON.stringify(entry.querySelector('.feed-entry-title')?.textContent));
};

// Home one: the feed.
const dom1 = await s.boot('/home/feed');
await ceremony(dom1, dom1.window.document, 'feed');

// Home two: my own /id page (the same card; seal state re-locked by the feed's post above).
const speak = (await (await s.fetch(`/api/id/${me}/profile`)).json()).speakable;
const dom2 = await s.boot(`/id/${speak}`);
await ceremony(dom2, dom2.window.document, 'own page');

// And the world still sees exactly one post.
const prof = await (await s.fetch(`/api/id/${me}/profile`)).json();
console.log('RESULT still one post, publicly:', prof.posts.length === 1);
process.exit(0);
