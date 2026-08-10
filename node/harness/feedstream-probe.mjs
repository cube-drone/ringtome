// The feed stream, rendered: chronology, emphasis, truncation, seen, own posts.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const s = session('http://localhost:5299');
await signUp(s, 'feedstream');
const me = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const loud = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const quiet = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
await s.fetch(`/api/identity/${loud}/profile`, { method: 'POST', headers: J,
    body: JSON.stringify({ field: 'name', value: 'Louder' }) });
await s.fetch(`/api/identity/${quiet}/profile`, { method: 'POST', headers: J,
    body: JSON.stringify({ field: 'name', value: 'Quieter' }) });
// I follow loud at high interest, quiet at low.
for (const [them, level] of [[loud, 'max'], [quiet, 'low']]) {
    await s.fetch(`/api/identity/${me}/private/kv/contact:${them}/interest`, {
        method: 'PUT', headers: J, body: JSON.stringify({ value: String(level) }) });
}
await sleep(2500); // subscriptions memo
const post = async (who, title, body) => {
    const d = await (await s.fetch(`/api/identity/${who}/docs`, { method: 'POST', headers: J,
        body: JSON.stringify({ title, body, format: 'plaintext' }) })).json();
    await s.fetch(`/api/identity/${who}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
    await sleep(1100);
};
await post(quiet, 'Long and quiet', 'the lead paragraph.\n\n' + 'endless detail. '.repeat(60));
await post(loud, 'Loud and important', 'short and vital.');
await sleep(2000);

const dom = await s.boot('/home/feed');
const doc = dom.window.document;
// Wait for the entries AND their bodies AND the emphasis classes - bodies fetch async, and
// the interest dials arrive with the mirror's contacts a beat after first paint. Elements are
// re-queried after every wait: a re-render may replace nodes, and a stale reference reads the
// page as it was, not as it is.
for (let t = 0; t < 240 && doc.querySelectorAll('.feed-entry .feed-entry-body').length < 2; t++)
    await sleep(50);
for (let t = 0; t < 100 && !doc.querySelector('.feed-entry-low'); t++) await sleep(50);
const entries = [...doc.querySelectorAll('.feed-entry')];
console.log('RESULT entries:', entries.length,
    '| order:', entries.map((e) => e.querySelector('.feed-entry-title')?.textContent).join(' | '));
const loudEntry = entries.find((e) => e.textContent.includes('Loud and important'));
const quietEntry = entries.find((e) => e.textContent.includes('Long and quiet'));
console.log('RESULT high wears emphasis:', loudEntry?.className,
    '| low wears:', quietEntry?.className);
console.log('RESULT low-interest long entry is cut:',
    !quietEntry?.textContent.includes('endless detail') ,
    '| offers the whole thing:', !!quietEntry?.querySelector('.feed-entry-more'));
console.log('RESULT titles are links:', !!loudEntry?.querySelector('.feed-entry-title a')?.href);
// Expand the cut one - re-queried fresh before and after the click.
doc.querySelectorAll('.feed-entry').forEach((e) => {
    if (e.textContent.includes('Long and quiet')) {
        e.querySelector('.feed-entry-more')?.dispatchEvent(
            new dom.window.MouseEvent('click', { bubbles: true }));
    }
});
await sleep(400);
const quietNow = [...doc.querySelectorAll('.feed-entry')].find((e) =>
    e.textContent.includes('Long and quiet'));
console.log('RESULT opened on request:', !!quietNow?.textContent.includes('endless detail'));

// My own post appears, as mine.
await post(me, 'Mine own', 'from my own hand.');
await sleep(1500);
const dom2 = await s.boot('/home/feed');
const doc2 = dom2.window.document;
for (let t = 0; t < 240 && !doc2.querySelector('.feed-entry'); t++) await sleep(50);
await sleep(1000);
const all2 = [...doc2.querySelectorAll('.feed-entry')];
console.log('RESULT my own post in my feed:', all2.some((e) => e.textContent.includes('Mine own')),
    '| newest first:', all2[0]?.textContent.includes('Mine own'));

// Read state is gone entirely (2026-08-09, PROJECT_PLAN One Cursor): no dots, no toggle, no
// per-post chain writes. What the feed still owes is that every arrival is simply THERE, so
// the last check is that a reload shows the whole river rather than a filtered slice.
const dom3 = await s.boot('/home/feed');
const doc3 = dom3.window.document;
for (let t = 0; t < 240 && doc3.querySelectorAll('.feed-entry').length < 3; t++) await sleep(50);
await sleep(400);
const shown = [...doc3.querySelectorAll('.feed-entry')].map((e) =>
    e.querySelector('.feed-entry-title')?.textContent);
console.log('RESULT the whole river, unfiltered:', JSON.stringify(shown));
console.log('RESULT no read-state chrome:',
    doc3.querySelectorAll('.feed-entry-new, .feed-unseen-toggle').length === 0);
process.exit(0);
