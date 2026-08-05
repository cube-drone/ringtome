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

/// How much visual weight a feed item carries, from the reader's interest dial for its author.
/// RENDERING only, deliberately: chronology is the feed's whole ordering (ranking is a research
/// problem this draft does not attempt), and the dial's stops map to nothing subtler than
/// "smaller and a little transparent" / "a touch more importance".
export function emphasisOf(interest) {
    const n = Number(interest);
    if (!Number.isFinite(n)) return 'normal'; // your own posts, or a dial never set
    if (n <= 25) return 'low';
    if (n >= 75) return 'high';
    return 'normal';
}

/// Character budgets past which an item shows only its lead. Low-interest sources get cut
/// aggressively; high-interest sources are never cut - that is their touch of importance.
const CUT_BUDGET = { low: 280, normal: 900 };

/**
 * The lead of a body, per the item's emphasis: the first paragraph when there are several, a
 * word-boundary slice when one paragraph overruns the budget. `cut` says whether anything was
 * held back - the item's "show the rest" appears exactly when it is true.
 */
export function leadOf(body, emphasis) {
    const text = body || '';
    if (emphasis === 'high') return { lead: text, cut: false };
    const budget = CUT_BUDGET[emphasis] ?? CUT_BUDGET.normal;
    const paras = text.split(/\n[ \t]*\n/);
    if (paras.length > 1 && (emphasis === 'low' || text.length > budget)) {
        return { lead: paras[0], cut: true };
    }
    if (text.length > budget) {
        const slice = text.slice(0, budget);
        const atWord = slice.lastIndexOf(' ');
        return { lead: slice.slice(0, atWord > budget / 2 ? atWord : budget) + '\u2026', cut: true };
    }
    return { lead: text, cut: false };
}

/// A feed item's identity: the same post can reach one reader through one author only, but two
/// AUTHORS can in principle mint colliding doc ids, so the key is the pair.
export const feedKey = (item) => `${item.author}:${item.doc_id}`;

/// A page of feed items joined onto the ones already read - mergePosts' rule (first sighting
/// wins, newest first) under the feed's composite key.
export function mergeFeed(seen, page) {
    const out = (seen || []).slice();
    const have = new Set(out.map(feedKey));
    for (const item of page || []) {
        if (item && !have.has(feedKey(item))) {
            have.add(feedKey(item));
            out.push(item);
        }
    }
    return out.sort((a, b) => (b.published_ms || 0) - (a.published_ms || 0));
}

/// Where to ask for the next page down: the last item shown.
export function feedCursor(items) {
    const last = (items || [])[(items || []).length - 1];
    if (!last) return null;
    return { before_ms: last.published_ms || 0, before_doc: last.doc_id };
}
