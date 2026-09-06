// Whose labels a reader sees (PROJECT_PLAN's Public annotations, ruling 5, simplified 2026-08-31 - the
// author/followed/everyone dial was too conservative and fussy, Curtis's words): everyone's,
// always. A label is a claim under a name, and the name is the safeguard; the one filter
// that survives is the block, because a blocked annotator never shows anywhere. The
// author's and the reader's own labels show even with no ledger to consult.
export function visibleAnnotations(annotations, { author, factsByRoot, me }) {
    const list = annotations || [];
    const facts = factsByRoot || null;
    const blocked = (root) => !!(facts && facts[root] && facts[root].blocked === 'yes');
    return list.filter((a) => {
        // The claimed date is the post's DATE, worn as the header's stamp, never a chip -
        // posts minted before 2026-09-02 restated it, and this is where they stop.
        if (a.key === 'display_date') return false;
        if (a.annotator === author) return true;
        if (me && a.annotator === me) return true;
        return !blocked(a.annotator);
    });
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
const ONE_EMOJI = /^\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*$/u;
export function isEmojiTag(value) {
    return typeof value === 'string' && ONE_EMOJI.test(value);
}
