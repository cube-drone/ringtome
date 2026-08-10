// The follow lifecycle against a live node: an author with existing posts, a reader arriving
// late. Follow -> their page backfills NOW. Unfollow -> their rows excised, own post stays.
// Re-follow -> the page returns. (The integration suite pins this too; this is the live run.)
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const BASE = 'http://localhost:5299';

async function user(name) {
    const s = session(BASE);
    await signUp(s, name);
    const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
    return { s, root };
}
const post = async (u, title) => {
    const d = await (await u.s.fetch(`/api/identity/${u.root}/docs`, { method: 'POST', headers: J,
        body: JSON.stringify({ title, body: `body of ${title}`, format: 'plaintext' }) })).json();
    await u.s.fetch(`/api/identity/${u.root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
};
const dial = (u, them, level) =>
    u.s.fetch(`/api/identity/${u.root}/private/kv/contact:${them}/interest`, {
        method: 'PUT', headers: J, body: JSON.stringify({ value: String(level) }) });
const feedTitles = async (u) => {
    const f = await (await u.s.fetch(`/api/identity/${u.root}/feed`)).json();
    return (f.items || f.rows || f).map((r) => r.title).sort();
};
const settle = async (fn, tries = 80) => {
    for (let i = 0; i < tries; i++) { const got = await fn(); if (got) return got; await sleep(250); }
    return null;
};

const author = await user('excise-author');
const reader = await user('excise-reader');
await post(author, 'Alpha'); await post(author, 'Beta');
await sleep(1000);

await dial(reader, author.root, 'medium');
const filled = await settle(async () => {
    const t = await feedTitles(reader);
    return t.includes('Alpha') && t.includes('Beta') ? t : null;
});
console.log('RESULT backfill on follow :', JSON.stringify(filled));

await post(reader, 'Mine stays');
await settle(async () => (await feedTitles(reader)).includes('Mine stays') || null);
await dial(reader, author.root, 'none');
const excised = await settle(async () => {
    const t = await feedTitles(reader);
    return t.includes('Alpha') ? null : t;
});
console.log('RESULT after unfollow     :', JSON.stringify(excised));

await dial(reader, author.root, 'medium');
const back = await settle(async () => {
    const t = await feedTitles(reader);
    return t.includes('Alpha') ? t : null;
});
console.log('RESULT after re-follow    :', JSON.stringify(back));
process.exit(0);
