// Feed's rules, pure: which bucket its drafts live in, and what a document's publication
// state is - has it been said in public? (Whether it was open for EDITING was once a second,
// per-device half - a seal that cost a fifteen-second unlock; posts edit forever and at once
// since 2026-10-02, so publication is the whole of it.)

import { bandOrdinal } from './contact.js';
import { plainWords } from './excerpt.js';
import { ownMediaKind } from './mediakind.js';

/// Feed's home bucket. One notebook, deliberately: public posting has no buckets yet,
/// because a bucket is a private annotation and a public post has nowhere to keep one.
export const FEED_STYLE = 'feed';

/// The annotation naming a note's published form (mirrors the server's constant).
export const PUBLISHED_AS = 'published_as';

/**
 * How this document stands with the public, for one row of the stack.
 *
 * @param row   the mirror's docs row (its `fields` carry annotations)
 */
export function publishedState(row) {
    const postId = ((row && row.fields) || {})[PUBLISHED_AS] || '';
    const published = !!postId;
    // No lock (2026-10-02): a posted item opens for editing at once, as a draft does. It once wore a
    // seal that cost a fifteen-second unlock, against a day after which it froze; posts edit forever.
    return { postId, published, label: published ? 'posted' : 'draft' };
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

/// The doc row a write leaves, stated ahead of the stream (pure/optimistic.js, 2026-10-01): each
/// `with*` makes the row, its `*Settled` says when the server's row has caught up. A row the
/// mirror doesn't hold yet stays absent - there's nothing to wear the fact.
const withFields = (row, change) => row && { ...row, fields: change({ ...((row && row.fields) || {}) }) };

/// Published as `postId`, the public version this row's head.
export const withPublished = (row, postId) =>
    withFields(row, (f) => ({ ...f, [PUBLISHED_AS]: postId, published_head: row.head }));
export const publishedSettled = (postId) => (row) =>
    !!row && (row.fields || {})[PUBLISHED_AS] === postId && (row.fields || {}).published_head === row.head;

/// Waiting on a plan to publish at `at`.
export const withScheduled = (row, at) => withFields(row, (f) => ({ ...f, publish_plan: JSON.stringify({ at }) }));
export const scheduledSettled = (row) => isScheduled(row);

/// Taken down: no post, no public version.
export const withoutPublication = (row) =>
    withFields(row, (f) => {
        const { [PUBLISHED_AS]: _p, published_head: _h, ...rest } = f;
        return rest;
    });
export const unpublishedSettled = (row) => !publishedState(row).published;

/// The plan cancelled.
export const withoutSchedule = (row) =>
    withFields(row, (f) => {
        const { publish_plan: _, ...rest } = f;
        return rest;
    });
export const unscheduledSettled = (row) => !isScheduled(row);

/// THE open draft, out of this app's documents (newest claim first): the newest one that has
/// not been posted. One at a time, deliberately - the composer is a place, not a list, and
/// an app that can only ever have one open draft cannot be made to mint a pile of them.
/// Older unposted drafts (from before this rule, or from a post that moved the slot along)
/// are not lost - they fall into the stack, visible and editable.
export function openDraftOf(docs) {
    return (
        (docs || []).find((d) => !publishedState(d).published && isTextDoc(d) && !isScheduled(d)) ||
        null
    );
}

/// A draft with a publish plan on it (PUBLISH.md slice 2) is spoken for: it waits at the top
/// of the stream, badged, and is never the composer's open draft. Without this the composer
/// flipped back to it the moment the mirror caught up - the bucket sorts by CLAIMED date,
/// and a post scheduled for 2030 is the "newest" unpublished thing there is (Curtis,
/// 2026-09-02: "it keeps that post open in my drafts").
export function isScheduled(d) {
    return !!(d && d.fields && d.fields.publish_plan);
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
/// aggressively; high-interest sources are never cut for length - that is their touch of importance.
/// Counted in the words a reader reads: a picture's markup, and a link's address, cost nothing
/// (Curtis, 2026-09-27 - an embed's address is a hundred-odd characters, and a post of pictures
/// spent the whole budget on them, cutting the sixth in half).
const CUT_BUDGET = { low: 280, normal: 900 };

/// A picture (an embed): `![caption](target)`. A link: `[text](target)`. Neither is ever cut.
const EMBED = /!\[[^\]\n]*\]\([^)\s]*\)/g;
const MARKUP = /!?\[[^\]\n]*\]\([^)\s]*\)/g;

/// The spans of text an item's lead may not end inside, and what each costs toward the budget: a
/// picture nothing, a link its text.
function spansOf(text) {
    return [...text.matchAll(MARKUP)].map((m) => ({
        from: m.index,
        to: m.index + m[0].length,
        cost: m[0].startsWith('!') ? 0 : m[0].indexOf(']') - 1,
    }));
}

/// The words a reader reads, counted: every character, less the markup's.
function readLength(text, spans) {
    return text.length - spans.reduce((n, s) => n + (s.to - s.from) - s.cost, 0);
}

/// Where the budget runs out in `text`, as an index never inside a picture or a link.
function budgetEnd(text, spans, budget) {
    let spent = 0;
    let i = 0;
    for (const s of spans) {
        if (spent + (s.from - i) >= budget) return i + (budget - spent);
        spent += s.from - i;
        if (spent + s.cost > budget) return s.from; // the link would run over: stop before it
        spent += s.cost;
        i = s.to;
    }
    return Math.min(text.length, i + (budget - spent));
}

/**
 * The lead of a body, per the item's emphasis. A SECOND picture always ends it, whatever the
 * interest (Curtis, 2026-09-27): `[picture] words [picture]` shows as `[picture] words`, and the
 * rest is a click away. Within that, by the budget: the first paragraph when there are several,
 * else a word-boundary slice - never inside a picture or a link. `cut` says whether anything was
 * held back - the item's "see more" appears exactly when it is true.
 */
export function leadOf(body, emphasis) {
    const { lead, cut } = leadAt(body, emphasis);
    return { lead, cut };
}

/// `leadOf`, and `end`: where in the body the lead stops (before its ellipsis) - what the
/// over-render continues from.
function leadAt(body, emphasis) {
    const full = body || '';
    const pictures = [...full.matchAll(EMBED)];
    const second = pictures.length > 1 ? pictures[1].index : -1;
    const text = second >= 0 ? full.slice(0, second).replace(/\s+$/, '') : full;
    const atSecond = second >= 0;
    if (emphasis === 'high') return { lead: text, cut: atSecond, end: text.length };
    const budget = CUT_BUDGET[emphasis] ?? CUT_BUDGET.normal;
    const spans = spansOf(text);
    const over = readLength(text, spans) > budget;
    const paras = text.split(/\n[ \t]*\n/);
    if (paras.length > 1 && (emphasis === 'low' || over)) {
        return { lead: paras[0], cut: true, end: paras[0].length };
    }
    if (over) {
        const end = budgetEnd(text, spans, budget);
        // Back to a word boundary, but never into markup and never past half the budget.
        let at = text.lastIndexOf(' ', end);
        const inside = spans.find((s) => at > s.from && at < s.to);
        if (inside) at = inside.from;
        if (at <= end / 2) at = end;
        return { lead: text.slice(0, at).replace(/\s+$/, '') + '\u2026', cut: true, end: at };
    }
    return { lead: text, cut: atSecond, end: text.length };
}

/// How far past the lead a held-back card draws, in read characters: a few lines for the fade
/// to fall across (Curtis, 2026-10-02: "over-render the words a little bit and use a gradient
/// fade-away to indicate there's more").
export const OVERRUN = 240;

/**
 * What a held-back card draws: its lead and a little past it - up to `OVERRUN` more read
 * characters, never into the next picture and never inside a link - for the card's fade to
 * fall across. No ellipsis: the fade says it. A card with nothing held back draws its lead.
 */
export function overrunOf(body, emphasis) {
    const full = body || '';
    const { lead, cut, end } = leadAt(full, emphasis);
    if (!cut) return lead;
    let rest = full.slice(end);
    const picture = rest.search(/!\[[^\]\n]*\]\([^)\s]*\)/);
    if (picture >= 0) rest = rest.slice(0, picture);
    const spans = spansOf(rest);
    let at = budgetEnd(rest, spans, OVERRUN);
    if (at < rest.length) {
        const space = rest.lastIndexOf(' ', at);
        if (space > 0) at = space;
        const inside = spans.find((s) => at > s.from && at < s.to);
        if (inside) at = inside.from;
    }
    return (full.slice(0, end) + rest.slice(0, at)).replace(/\s+$/, '');
}

/// An embed's kind from its address: ringtome's own spellings first, then the web's usual
/// extensions; anything else drawn with `![...]` is a picture.
const WEB_MEDIA_KINDS = { mp3: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', wav: 'audio', flac: 'audio', mp4: 'video', mov: 'video', m4v: 'video' };
function embedKind(target) {
    const own = ownMediaKind(target);
    if (own) return own;
    const path = String(target || '').split(/[?#]/, 1)[0];
    return WEB_MEDIA_KINDS[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] || 'image';
}

function counted(body) {
    const out = { words: plainWords(body).length, images: 0, audio: 0, videos: 0 };
    for (const m of (body || '').matchAll(/!\[[^\]\n]*\]\(([^)\s]*)\)/g)) {
        const kind = embedKind(m[1]);
        if (kind === 'audio') out.audio += 1;
        else if (kind === 'video') out.videos += 1;
        else out.images += 1;
    }
    return out;
}

/**
 * What a card holds back - the body against what it `shown`: words, pictures, sounds and
 * videos still to see, for the "see more" button's summary ("+1833 words, +3 images", Curtis
 * 2026-10-02). Never negative.
 */
export function heldBack(body, shown) {
    const all = counted(body);
    const seen = counted(shown);
    const less = (k) => Math.max(0, all[k] - seen[k]);
    return { words: less('words'), images: less('images'), audio: less('audio'), videos: less('videos') };
}

/// A feed item's identity: the same post can reach one reader through one author only, but two
/// AUTHORS can in principle mint colliding doc ids, so the key is the pair.
export const feedKey = (item) => `${item.author}:${item.doc_id}`;

/**
 * The share/reply pair, collapsed at render (PROJECT_PLAN's Replies: a reply pins its parent, so a
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
    // A FRESH post of your own holds the top whatever its date (Curtis, 2026-09-02: a
    // backdated post sorting itself into 2019 the instant you press Post would vanish, and
    // you would have no sign you did anything). The next page load files it properly - that
    // reload is the deliberate end of the grace, not a bug.
    return out.sort(
        (a, b) => (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0) || (b.published_ms || 0) - (a.published_ms || 0)
    );
}

/// A private document's standing in public (PUBLISH.md ruling 6): `scheduled` when a publish
/// plan waits on its private meta, `public` once it has been published, else `private`. A
/// scheduled re-publication of a public post reads as scheduled - the plan is the newer fact.
export function docStatus(row) {
    if (isScheduled(row)) return 'scheduled';
    if (publishedState(row).published) return 'public';
    return 'private';
}

/// Backdated: the author claimed a date (PUBLISH.md) more than a minute before the post was
/// actually written down. A bare claim of "today" lands at the publish hour and reads as
/// fresh; a scheduled post mints within a minute of its claim and reads as fresh too.
export function isBackdated(item) {
    if (!item || item.dated_ms == null || !item.minted_ms) return false;
    return item.dated_ms < item.minted_ms - 60_000;
}

/// Where to ask for the next page down: the last item shown.
/// The feed's orders (PROJECT_PLAN's Scores and sort orders): newest first; hot - each post at its
/// time plus an hour for every like (slice 2); or best - the reader's score, highest first - over a
/// window, a year at the longest (Curtis: no "best ever"). Keys only; the page words them.
export const FEED_SORTS = ['new', 'hot', 'day', 'week', 'month', 'year'];
export const DEFAULT_SORT = 'new';

/// Is this sort one of the best orders (a window)?
export const isBestSort = (sort) => FEED_SORTS.includes(sort) && sort !== 'new' && sort !== 'hot';

/// Is this sort ranked by the node - hot (slice 2: time plus an hour a like) or a best window -
/// rather than newest first? A ranked page merges in the node's order and has no "newer".
export const isRankedSort = (sort) => sort === 'hot' || isBestSort(sort);

/// The feed door's words for a sort: nothing for newest, `sort=hot`, or `sort=best` and its window.
export function sortParams(sort) {
    if (sort === 'hot') return 'sort=hot';
    return isBestSort(sort) ? `sort=best&window=${sort}` : '';
}

/// A thread's orders (PROJECT_PLAN's Scores and sort orders, slice 3), each level's replies
/// sorted among themselves: oldest first - the conversation's own order, and the default - hot, or
/// best. Keys only; the page words them.
export const REPLY_SORTS = ['old', 'hot', 'best'];

/// The replies door's words for a thread order, asked as the viewing persona (the scores are
/// theirs): nothing for oldest first, or with no one signed in to be scored for.
export function replySortParams(order, viewer) {
    if (!viewer || (order !== 'hot' && order !== 'best')) return '';
    return `sort=${order}&as=${viewer}`;
}

/// A ranked page onto what is shown, in the node's order: `mergeFeed` sorts by date, which
/// would undo the ranking, so a best page is appended as it came, deduplicated - a score may
/// move between pages and bring a post round twice.
export function mergeRanked(seen, page) {
    const out = (seen || []).slice();
    const have = new Set(out.map(feedKey));
    for (const item of page || []) {
        if (item && !have.has(feedKey(item))) {
            have.add(feedKey(item));
            out.push(item);
        }
    }
    return out;
}

export function feedCursor(items) {
    const last = (items || [])[(items || []).length - 1];
    if (!last) return null;
    return { before_ms: last.published_ms || 0, before_doc: last.doc_id };
}
