// The composer wearing the real editor: format chip, upload chip, tags & description (and NO
// date), delete-clears-the-draft, and Post still working through the editor's foot.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const s = session('http://localhost:5299');
await signUp(s, 'composerful');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const dom = await s.boot('/home/feed');
const doc = dom.window.document;
const click = (el) => el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
for (let t = 0; t < 240 && !doc.querySelector('.feed-composer .cm-editor, .feed-composer textarea'); t++) await sleep(50);
const composer = doc.querySelector('.feed-composer');
const chips = [...(composer?.querySelectorAll('.reader-chips button, .reader-chips [title]') || [])]
    .map((c) => c.getAttribute('title') || '').filter(Boolean);
console.log('RESULT editor chrome present:', !!composer?.querySelector('.reader-chips'));
console.log('RESULT format chip:', chips.some((t) => /Marquee|Plaintext/.test(t)),
    '| upload chip:', chips.some((t) => /Upload/.test(t)),
    '| delete chip:', chips.some((t) => /Delete/.test(t)),
    '| meta chip:', chips.some((t) => /tags, date & description/.test(t)));
// Open the meta dropdown: tags & description yes, DATE no.
click([...composer.querySelectorAll('[title]')].find((c) => /tags, date/.test(c.getAttribute('title'))));
await sleep(400);
const meta = composer.querySelector('.editor-meta');
const placeholders = [...(meta?.querySelectorAll('input, textarea') || [])]
    .map((i) => i.getAttribute('placeholder') || '');
console.log('RESULT meta panel:', !!meta,
    '| has tags:', placeholders.some((p) => p.includes('tag')),
    '| has description:', placeholders.some((p) => p.includes('description')),
    '| has NO date field:', !meta?.querySelector('input[type=date], input[type=datetime-local]'));
// Delete clears the draft: the one-draft rule mints a fresh page. (jsdom has no confirm
// dialog; a human clicking through it is the same yes.)
dom.window.confirm = () => true;
const before = await (await s.fetch(`/api/identity/${root}/docs`)).json();
const beforeIds = (Array.isArray(before) ? before : before.docs || []).map((d) => d.doc_id);
click([...composer.querySelectorAll('[title]')].find((c) => /Delete/.test(c.getAttribute('title'))));
await sleep(2500);
const after = await (await s.fetch(`/api/identity/${root}/docs`)).json();
const afterList = (Array.isArray(after) ? after : after.docs || []).filter((d) => (d.buckets || []).includes('feed'));
console.log('RESULT delete cleared and a fresh draft was minted:',
    afterList.length === 1 && !beforeIds.includes(afterList[0]?.doc_id));
process.exit(0);
