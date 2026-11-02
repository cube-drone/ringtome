// Moderation lists, as one post's author meets them (plans/MODERATION.md, 2026-11-02). What the
// reader takes arrives folded from the node (moderation.rs): their own entries and those of the
// people they trust to moderate for them, one hop, each target with its strongest level, every
// source and reason, and whether the reader overruled it. Their own private block counts too,
// as a block they need give no reason for. Pure: the judgment has a test.
//
// Pictures (plans/SCANNING.md, _Community picture entries_): the node judges the pictures a post
// shows against the picture entries the reader takes (moderation.rs, `verdicts`) - the same file at
// its entry's level, a lookalike only ever warned about - and the post meets the strongest of its
// author's verdict and its pictures'.

/// A reason, as the reader's form counts it: UTF-8 bytes, the node's cap (512) in its own units.
export const MAX_REASON_BYTES = 512;
export const reasonBytes = (text) => new TextEncoder().encode(String(text || '')).length;

/// The element naming one target in the reader's overrule set.
export const overruleKey = (kind, target) => `${kind}:${target}`;

/// The element naming one post in the reader's hidden set - what a report does first.
export const hiddenKey = (author, doc) => `${author}:${doc}`;

/// The verdict for one author: `{ kind: 'block' | 'warn' | null, reason, sources }` - the
/// strongest level, and the reasons it was given, strongest first. Never about the reader. A post
/// the reader hid (`doc`, against `hidden`) goes as their own block does.
export function moderationFor(author, { me, taken, factsByRoot, doc, hidden }) {
    const none = { kind: null, reason: '', sources: [] };
    if (!author || author === me) return none;
    if (doc && (hidden || []).includes(hiddenKey(author, doc)))
        return { kind: 'block', reason: '', sources: [], mine: true, hidden: true };
    const facts = factsByRoot && factsByRoot[author];
    if (facts && facts.blocked === 'yes')
        return { kind: 'block', reason: '', sources: [], mine: true };
    const entry = (taken || []).find(
        (e) => e.kind === 'persona' && e.target === author && !e.overruled,
    );
    if (!entry) return none;
    const reason =
        (entry.sources.find((s) => s.level === entry.level && s.reason) || {}).reason || '';
    return { kind: entry.level, reason, sources: entry.sources };
}

/// The most picture addresses one post asks about.
const MAX_PICTURES = 16;
// One of our own picture addresses, at any origin: `/ringtome/user/<root>/doc/<twin>/body…`, or
// the older `/id/<root>/docs/<twin>/body…`.
const TWIN =
    /\/(?:ringtome\/user\/[A-Za-z0-9-]{16,}\/doc|id\/[A-Za-z0-9-]{16,}\/docs)\/[0-9a-f]{32}\/body/;

// A sound or a video, by the extension a reference spells (pure/mediakind.js, pure/feed.js).
const NOT_A_PICTURE = /\.(?:opus|ogg|mp3|wav|flac|m4a|mp4|mov|m4v|webm)$/i;

/// The pictures a post's words show that a node can judge: its own picture addresses, never a
/// sound or a video, each once.
export function pictureAddresses(body) {
    const out = [];
    for (const m of String(body || '').matchAll(/!\[[^\]\n]*\]\(([^)\s]*)\)/g)) {
        const target = m[1];
        const path = target.split(/[?#]/, 1)[0];
        if (NOT_A_PICTURE.test(path) || !TWIN.test(path) || out.includes(target)) continue;
        out.push(target);
        if (out.length >= MAX_PICTURES) break;
    }
    return out;
}

const RANK = { block: 2, warn: 1 };

/// The stronger of two verdicts: block beats warn beats nothing; a tie keeps the first.
export const stronger = (a, b) => ((RANK[b.kind] || 0) > (RANK[a.kind] || 0) ? b : a);

/// What a post's pictures say, from the node's verdicts by address: the strongest, as a verdict
/// `moderationFor` would give - `near` when it is only a lookalike's warning.
export function pictureVerdictFor(addresses, verdicts) {
    let out = { kind: null, reason: '', sources: [] };
    for (const address of addresses || []) {
        const v = verdicts && verdicts[address];
        if (!v) continue;
        out = stronger(out, {
            kind: v.level,
            reason: v.reason || '',
            sources: v.sources || [],
            near: !!v.near,
        });
    }
    return out;
}

/// What the reader has said about someone (blockmodal.js): 'private', 'public-block',
/// 'public-warn' or null, from their contact facts and their own public list's entry for them. A
/// public block outranks the private one it carries.
export function blockState(facts, listed) {
    if (listed && listed.level === 'block') return 'public-block';
    if ((facts || {}).blocked === 'yes') return 'private';
    if (listed && listed.level === 'warn') return 'public-warn';
    return null;
}
