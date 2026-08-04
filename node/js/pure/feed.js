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

/**
 * A row wearing a publication we know about but the mirror hasn't carried home yet.
 *
 * Publishing is a chain append and the fact comes back through the stream, so between the
 * click and the echo the app knows something true that its own view doesn't show. This states
 * it locally - and yields the moment the mirror agrees, which is what makes the overlay safe
 * to leave in place rather than something to remember to clear: once the row carries the
 * annotation, this function is the identity.
 */
export function overlayPosted(row, postId) {
    if (!postId || ((row && row.fields) || {})[PUBLISHED_AS]) return row;
    return { ...row, fields: { ...((row && row.fields) || {}), [PUBLISHED_AS]: postId } };
}

/// THE open draft, out of this app's documents (newest claim first): the newest one that has
/// not been posted. One at a time, deliberately - the composer is a place, not a list, and
/// an app that can only ever have one open draft cannot be made to mint a pile of them.
/// Older unposted drafts (from before this rule, or from a post that moved the slot along)
/// are not lost - they fall into the stack, visible and editable.
export function openDraftOf(docs) {
    return (docs || []).find((d) => !publishedState(d).published) || null;
}

/**
 * Someone's public posts, newest first.
 *
 * The server already answers in this order; sorting here anyway is the cheap kind of
 * defensiveness - display order is a display concern, and a page that depends on a remote
 * node's ORDER (this list can arrive from a fetch-and-serve across the network) is depending
 * on something it doesn't control. Posts with no timestamp sort last rather than jumping to
 * the top on a NaN comparison.
 */
export function recentPosts(posts) {
    return (posts || [])
        .slice()
        .sort((a, b) => (b.published_ms || 0) - (a.published_ms || 0));
}

/**
 * A page of posts joined onto the ones already read.
 *
 * DEDUPED by doc_id, and not defensively: re-publishing moves a document to the head of the
 * shelf, so a reader paging down a shelf someone is actively posting to can genuinely be
 * handed the same document twice. The cursor can't prevent that - the shelf changed - so the
 * reader is where it gets settled. First sighting wins, which keeps what is already on screen
 * where the eye left it.
 */
export function mergePosts(seen, page) {
    const out = (seen || []).slice();
    const have = new Set(out.map((p) => p.doc_id));
    for (const p of page || []) {
        if (p && !have.has(p.doc_id)) {
            have.add(p.doc_id);
            out.push(p);
        }
    }
    return recentPosts(out);
}

/**
 * Where to ask for the next page: the last post shown, as `{ after_ms, after_doc }`.
 *
 * The cursor is the row itself rather than a count, so posts arriving at the head while
 * someone reads down the shelf can't shift the window under them (the server's keyset query
 * is the other half of this). Null when there is nothing to page from.
 */
export function postCursor(posts) {
    const last = (posts || [])[(posts || []).length - 1];
    if (!last) return null;
    return { after_ms: last.published_ms || 0, after_doc: last.doc_id };
}
