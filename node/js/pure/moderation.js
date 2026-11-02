// Moderation lists, as one post's author meets them (plans/MODERATION.md, 2026-11-02). What the
// reader takes arrives folded from the node (moderation.rs): their own entries and those of the
// people they trust to moderate for them, one hop, each target with its strongest level, every
// source and reason, and whether the reader overruled it. Their own private block counts too,
// as a block they need give no reason for. Pure: the judgment has a test.

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
