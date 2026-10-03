// Whose labels a reader sees (PROJECT_PLAN's Public annotations, ruling 5, simplified 2026-08-31 - the
// author/followed/everyone dial was too conservative and fussy, Curtis's words): everyone's,
// always. A label is a claim under a name, and the name is the safeguard; the one filter
// that survives is the block, because a blocked annotator never shows anywhere. The
// author's and the reader's own labels show even with no ledger to consult.
export function visibleAnnotations(annotations, { author, factsByRoot, me }) {
    const list = annotations || [];
    const facts = factsByRoot || null;
    const blocked = (root) => !!(facts && facts[root] && facts[root].blocked === 'yes');
    const shown = list.filter((a) => {
        // The claimed date is the post's DATE, worn as the header's stamp, never a chip -
        // posts minted before 2026-09-02 restated it, and this is where they stop.
        if (a.key === 'display_date') return false;
        if (a.annotator === author) return true;
        if (me && a.annotator === me) return true;
        return !blocked(a.annotator);
    });
    return boundedTags(shown, { author });
}

/// How many tags one person may put on somebody else's post (Curtis, 2026-09-27) - the
/// node's `annotations::MAX_TAGS_PER_LABELLER`, which is the authority; a Rust test pins
/// the two equal.
export const MAX_TAGS_PER_LABELLER = 2;

// Code-point order - the node's byte order - not JavaScript's UTF-16 order, which puts an
// emoji (a surrogate pair) before some ordinary characters the node sorts ahead of it.
const byCodePoint = (x, y) => {
    const a = [...x];
    const b = [...y];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const d = a[i].codePointAt(0) - b[i].codePointAt(0);
        if (d) return d;
    }
    return a.length - b.length;
};

/**
 * The tag rules every reader keeps (Curtis, 2026-09-27; the node's annotations.rs `bounded`,
 * restated for what the client holds that the node never filtered): an author's emoji tag
 * on their own post falls - a reaction is for somebody else's post - and anyone else's tags
 * stand only MAX_TAGS_PER_LABELLER to a person, the first in code-point order, so every
 * reader keeps the same two. Everything that is not a tag passes, in its order.
 */
export function boundedTags(labels, { author }) {
    const byPerson = new Map();
    for (const a of labels) {
        if (a.key !== 'tag' || a.annotator === author) continue;
        if (!byPerson.has(a.annotator)) byPerson.set(a.annotator, new Set());
        byPerson.get(a.annotator).add(a.value);
    }
    const kept = new Map();
    for (const [who, values] of byPerson) {
        kept.set(who, new Set([...values].sort(byCodePoint).slice(0, MAX_TAGS_PER_LABELLER)));
    }
    return labels.filter((a) => {
        if (a.key !== 'tag') return true;
        if (a.annotator === author) return !isEmojiTag(a.value);
        return kept.get(a.annotator).has(a.value);
    });
}

/**
 * May `me` say this tag on a post by `author`, given the labels it already wears? Not an
 * emoji on your own post; not a third tag of yours on anybody else's (saying one you
 * already said again is fine). The card's door - the node refuses the same.
 */
export function mayTag(labels, { author, me, value }) {
    if (!me) return false;
    if (me === author) return !isEmojiTag(value);
    const mine = new Set(
        (labels || []).filter((a) => a.key === 'tag' && a.annotator === me).map((a) => a.value),
    );
    return mine.has(value) || mine.size < MAX_TAGS_PER_LABELLER;
}

/// How many more tags `me` may put on a post by `author`: unbounded (Infinity) on your own.
export function tagsLeft(labels, { author, me }) {
    if (!me) return 0;
    if (me === author) return Infinity;
    const mine = new Set(
        (labels || []).filter((a) => a.key === 'tag' && a.annotator === me).map((a) => a.value),
    );
    return Math.max(0, MAX_TAGS_PER_LABELLER - mine.size);
}

/**
 * Collapse identical labels said by different people into one chip's worth of facts
 * (Curtis, 2026-08-31: "beef" by Jeff Dorp and "beef" by Darn Hot are ONE chip, worn by
 * both). Groups by (key, value); within a group the post author's copy leads, everyone
 * else in arrival order; groups sort most-agreed-first (ties keep their arrival order -
 * Array.prototype.sort is stable).
 */
export function groupLabels(labels, { author }) {
    const groups = new Map();
    for (const a of labels || []) {
        const k = `${a.key}\u0000${a.value}`;
        if (!groups.has(k)) groups.set(k, { key: a.key, value: a.value, contributors: [] });
        const g = groups.get(k);
        if (!g.contributors.some((c) => c.annotator === a.annotator)) g.contributors.push(a);
    }
    const out = [...groups.values()];
    for (const g of out) {
        const i = g.contributors.findIndex((c) => c.annotator === author);
        if (i > 0) g.contributors.unshift(g.contributors.splice(i, 1)[0]);
    }
    return out.sort((x, y) => y.contributors.length - x.contributors.length);
}

/**
 * Is this tag value ONE emoji (a reaction, now first-class - Curtis, 2026-08-31)? One
 * pictographic cluster: a base emoji with optional variation selector and skin tone,
 * ZWJ-joined to more of the same (families, flags-of-choice). Two separate emoji, plain
 * text, and "asshole 100" all fail - Emoji_Component is deliberately not used, because it
 * would bless bare digits.
 */
const ONE_EMOJI =
    /^\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*$/u;
/// A tag's length, in characters - `PublicAnnotation::MAX_TAG_CHARS` on the wire, which is
/// the authority; this is the client's copy, so an input can stop at the same place the
/// door would refuse (Curtis, 2026-09-20). A Rust test pins the two equal.
export const MAX_TAG_CHARS = 32;

export function isEmojiTag(value) {
    return typeof value === 'string' && ONE_EMOJI.test(value);
}
