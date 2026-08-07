// The actual gesture: DROP a file onto the editing surface, in journal and in the feed
// composer, and watch what the capture does - placeholder, modal, reference swap, render.
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const png = readFileSync(new URL('../../sample_media/bowie_comic.png', import.meta.url).pathname);
const s = session('http://localhost:5299');
await signUp(s, 'dropper');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

const drive = async (path, scope, label) => {
    const dom = await s.boot(path);
    const win = dom.window;
    const doc = win.document;
    for (let t = 0; t < 240 && !doc.querySelector(`${scope} .cm-editor, ${scope} textarea, ${scope} .reader`); t++)
        await sleep(50);
    const surface = doc.querySelector(`${scope} .reader`) || doc.querySelector(scope);
    console.log(`RESULT ${label}: drop target = ${surface ? surface.className.split(' ')[0] || surface.tagName : 'NONE'}`);
    const file = new win.File([png], 'dropped-pic.png', { type: 'image/png' });
    const ev = new win.Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { files: [file], types: ['Files'], getData: () => '' };
    surface.dispatchEvent(ev);
    await sleep(800);
    const modal = doc.querySelector('.modal-scrim, [class*=upload]');
    console.log(`RESULT ${label}: upload UI appeared = ${!!modal}`,
        modal ? `(${(modal.className || '').toString().split(' ')[0]})` : '');
    // Confirm through whatever the modal asks, if it asks.
    const go = [...doc.querySelectorAll('button')].find((b) => /upload|attach|add/i.test(b.textContent));
    if (go) go.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    // Wait for the crush + the reference swap to land in the body.
    let swapped = null;
    for (let t = 0; t < 300 && !swapped; t++) {
        const body = doc.querySelector(`${scope} .cm-content`)?.textContent || '';
        if (/\/body\/.*\.(avif|apng)/.test(body)) swapped = body.match(/!\[[^\]]*\]\([^)]*\)/)?.[0];
        await sleep(200);
    }
    console.log(`RESULT ${label}: reference swapped in = ${JSON.stringify(swapped?.slice(0, 90))}`);
    await sleep(1000);
    const img = doc.querySelector(`${scope} img.mq-embed, ${scope} img`);
    console.log(`RESULT ${label}: renders = ${!!img}`);
};
await drive('/home/journal', '.journal', 'journal');
await drive('/home/feed', '.feed-compose', 'feed');
process.exit(0);
