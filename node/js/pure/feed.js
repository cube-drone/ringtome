// Feed's rules, pure: which bucket its drafts live in, and what a document's publication
// state is - has it been said in public, and is it open for writing right now?
//
// Publication state has two independent halves, which is the whole subtlety: whether a
// document HAS a public form (a durable fact, synced, recorded by the publish act as the
// `published_as` annotation) and whether it is open for EDITING (a local, per-device
// gesture - the same seal pref Journal uses, never synced, because "I'm working on this
// again" is a personal act, not a document fact).

/// Feed's home bucket. One notebook, deliberately: public posting has no buckets yet,
/// because a bucket is a private annotation and a public post has nowhere to keep one.
export const FEED_STYLE = 'feed';

/// The annotation naming a note's published form (mirrors the server's constant).
export const PUBLISHED_AS = 'published_as';

/**
 * How this document stands with the public, for one row of the stack.
 *
 * @param row   the mirror's docs row (its `fields` carry annotations)
 * @param seal  this device's override for this doc: 'open' | 'locked' | undefined
 */
export function publishedState(row, seal) {
    const postId = ((row && row.fields) || {})[PUBLISHED_AS] || '';
    const published = !!postId;
    // Published means sealed by default; an explicit 'open' (the unlock) beats it, and an
    // explicit 'locked' can seal a draft the author considers finished.
    const locked = seal === 'open' ? false : seal === 'locked' ? true : published;
    return {
        postId,
        published,
        locked,
        label: published ? (locked ? 'posted' : 'posted - editing') : 'draft',
    };
}

/// THE open draft, out of this app's documents (newest claim first): the newest one that has
/// not been posted. One at a time, deliberately - the composer is a place, not a list, and
/// an app that can only ever have one open draft cannot be made to mint a pile of them.
/// Older unposted drafts (from before this rule, or from a post that moved the slot along)
/// are not lost - they fall into the stack, visible and editable.
export function openDraftOf(docs) {
    return (docs || []).find((d) => !publishedState(d).published) || null;
}
