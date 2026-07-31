// The single-doc UI probe: sign in with existing credentials, deep-link the real SPA straight
// onto one document, and report what the editor buffer actually holds. The reading half of
// state.mjs's writing half - state builds a history the UI couldn't, this shows what the UI
// makes of it.
//
// Usage: node ui.mjs <base> <user> <pw> <docId>     (state.mjs prints this line ready-made)
import { session, signIn, sleep } from './boot.mjs';

const [BASE, USER, PW, DOC] = process.argv.slice(2);
if (!DOC) {
    console.error('usage: node ui.mjs <base> <user> <pw> <docId>');
    process.exit(2);
}

const s = session(BASE);
await signIn(s, USER, PW);
const dom = await s.boot(`/home/notes/${DOC}`);
const { window } = dom;
const doc = window.document;

for (let t = 0; t < 20; t++) {
    await sleep(500);
    const ta = doc.querySelector('textarea.editor-source, .editor textarea, textarea');
    const cm = doc.querySelector('.cm-content');
    if (ta || cm) {
        console.log('--- editor surface found at', t * 0.5, 's');
        if (ta) console.log('textarea value:', JSON.stringify(ta.value).slice(0, 400));
        if (cm) console.log('cm content:', JSON.stringify(cm.textContent).slice(0, 400));
        break;
    }
    if (t === 19) {
        console.log('no editor surface found');
        console.log('body text:', JSON.stringify(doc.body.textContent).slice(0, 400));
    }
}
console.log('final url:', window.location.pathname);
process.exit(0);
