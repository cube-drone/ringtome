// Feed's rules, pure: which bucket its drafts live in, and what a document's publication
// state is - has it been said in public, and is it open for writing right now?
//
// Publication state has two independent halves, which is the whole subtlety: whether a
// document HAS a public form (a durable fact, synced, recorded by the publish act as the
// `published_as` annotation) and whether it is open for EDITING (a local, per-device
// gesture - the same seal pref Journal uses, never synced, because "I'm working on this
// again" is a personal act, not a document fact).

import { bandOrdinal } from './contact.js';

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
    return (docs || []).find((d) => !publishedState(d).published && isTextDoc(d)) || null;
}

/// Only TEXT can be a draft. Uploading an image from the composer files the media document
/// into the feed bucket (so the picker lists it) - and since a fresh upload is the NEWEST
/// unpublished thing in the bucket, it would otherwise BECOME the open draft: the composer's
/// docId flips to the image, the text session (upload placeholder and all) unmounts, and the
/// reference swap fires into the void (field-found 2026-08-06 - "the image uploaded but never
/// landed in the document").
export function isTextDoc(d) {
    return !d || !d.format || d.format === 'marquee' || d.format === 'plaintext';
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
/// The dial as its ladder rung (0-4), or null for "no opinion".
///
/// Silence and 'none' must stay distinct: an unset dial is no opinion, while 'none' is the
/// bottom stop meaning "Don't show". When the dial was a number this distinction collapsed
/// through `Number(null)` being 0, and `emphasisOf` rendered never-set dials as low emphasis
/// (dimmed and truncated) until a vector caught it 2026-08-08; `bandOrdinal` keeps the two
/// apart by construction (garbage and silence are both null, never 'none').
function dialValue(interest) {
    return bandOrdinal(interest);
}

export function emphasisOf(interest) {
    const n = dialValue(interest);
    if (n === null) return 'normal'; // your own posts, or a dial never set
    if (n <= 1) return 'low';
    if (n >= 3) return 'high';
    return 'normal';
}

/// The whole card's size, as a multiplier on the feed's base type - the quiet half of the
/// interest dial. A reader's dials shape RENDERING only (fanout.rs says the same from the other
/// side): a source you care less about takes less room on the page, never a different place in
/// the order.
///
/// Twenty-five percent across the whole range, 6.25% per stop. It began at 10% and was raised
/// on 2026-08-09 for the plainest possible reason: the thing it replaced was a 15% step on the
/// `low` bucket, and Curtis had never noticed that either. A difference nobody can see is not a
/// subtle difference, it is an absent one - so the range is now wide enough that a page of mixed
/// interest reads as visibly uneven, which is the point.
///
/// A source with no dial set gets FULL size, not the middle: you have expressed no opinion, and
/// the ramp is here to carry an opinion you did express. Same for your own posts.
export const POST_SCALE_MIN = 0.75;

export function postScale(interest) {
    const n = dialValue(interest);
    if (n === null) return 1;
    return round(POST_SCALE_MIN + (1 - POST_SCALE_MIN) * (n / 4));
}

/// Four decimals, not three: the gap between stops is 0.0625, and three would round it to an
/// uneven 0.063/0.062 alternation - real, if invisible, and enough to fail the evenness vector.
const round = (n) => Math.round(n * 10000) / 10000;

/// The widest an image may draw inside a post, in CSS pixels - the loud half of the same dial.
///
/// The ceiling is 800 because that is where the transcode already lands (media/image.rs,
/// `MAIN_BOUND`), so top interest is deliberately a no-op: the cap only ever takes room away,
/// never grants it. The floor is 50, which is a thumbnail - at "Don't show" you are told a
/// picture is there without being shown it.
///
/// Sixteen-to-one across the range, against 1.33-to-1 for the type: images are the thing that
/// actually costs a feed its shape, and a quarter-size card carrying a full-size photograph is
/// still a full-size interruption. Same no-opinion rule as `postScale` - an unset dial caps at
/// 800, which is to say not at all.
export const POST_IMAGE_MAX = 800;
export const POST_IMAGE_MIN = 50;

export function postImageCap(interest) {
    const n = dialValue(interest);
    if (n === null) return POST_IMAGE_MAX;
    return Math.round(POST_IMAGE_MIN + (POST_IMAGE_MAX - POST_IMAGE_MIN) * (n / 4));
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

/**
 * The share/reply pair, collapsed at render (COMMENTS.md: a reply pins its parent, so a
 * follower of the replier meets the thread twice - the parent journaled by the pin's share,
 * bylined via the replier, and the reply as the replier's own post). When BOTH are on
 * screen, the reply's quote-card already says everything the share row says, so the share
 * row yields. Render-only by ruling: the journal stays honest about both rows.
 *
 * The rule is deliberately narrow: only a row that is HERE BY SHARE (has a lead sharer),
 * is not the reader's own, and whose lead sharer authored a loaded reply to it. A parent
 * the reader follows directly journals via-less and never collapses - it is a first-class
 * post in its own right. And only within the loaded window: the journal orders by the
 * PARENT's original publish time, so a reply to an old post sits pages away from its pin's
 * row, and both honestly render - collapsing across pages would need server-side memory of
 * what the client has shown, which is machinery this rule is not worth.
 */
export function collapseReplyPairs(items) {
    const replied = new Set(
        items
            .filter((i) => i.reply_to)
            .map((i) => `${i.author}:${i.reply_to.author}:${i.reply_to.doc_id}`)
    );
    return items.filter(
        (i) => i.mine || !i.via || !replied.has(`${i.via}:${i.author}:${i.doc_id}`)
    );
}

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
