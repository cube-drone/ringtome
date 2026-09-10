// Contact tags (PROJECT_PLAN's Contact tags, 2026-09-10): private labels on the people you
// know - "family", "trade-show" - kept as one register, `tags`, in the contact's bag on your
// private chain, so every computer you sign in on holds the same lists and nothing else
// ever does. A tag is a key, not prose: lowercased, whitespace collapsed, capped, and never
// twice on one person. The People page filters by them; the audience arc will seal to them.

export const TAG_MAX = 32;
export const TAGS_CAP = 24;

/// One tag as it is kept: lowercased, inner whitespace collapsed, trimmed, capped. Empty
/// when nothing is left.
export function normaliseTag(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TAG_MAX)
        .trim();
}

/// The tags a contact's facts carry, in the order they were given, each once.
export function contactTags(facts) {
    const raw = facts && facts.tags;
    if (!raw) return [];
    let list;
    try {
        list = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
        if (typeof item !== 'string') continue; // junk is not a tag
        const tag = normaliseTag(item);
        if (tag && !out.includes(tag)) out.push(tag);
        if (out.length >= TAGS_CAP) break;
    }
    return out;
}

/// The list with one more tag, or the same list when it is empty, already there, or the
/// cap is reached.
export function withTag(tags, raw) {
    const tag = normaliseTag(raw);
    if (!tag || tags.includes(tag) || tags.length >= TAGS_CAP) return tags;
    return [...tags, tag];
}

export function withoutTag(tags, raw) {
    const tag = normaliseTag(raw);
    return tags.filter((t) => t !== tag);
}

/// How the register is written: a JSON array, or the empty string to clear it.
export function serialiseTags(tags) {
    return tags.length ? JSON.stringify(tags) : '';
}

/// Every tag across these contact rows with how many people wear it, most-worn first,
/// then by name - the People page's row, in the facets' own shape.
export function tagCounts(rows) {
    const counts = new Map();
    for (const row of rows || []) {
        for (const tag of contactTags(row.facts)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/// The rows wearing EVERY picked tag (picks AND, as post tags do); all rows when nothing is
/// picked.
export function rowsTagged(rows, picks) {
    const want = (picks || []).map(normaliseTag).filter(Boolean);
    if (!want.length) return rows;
    return (rows || []).filter((row) => {
        const have = contactTags(row.facts);
        return want.every((w) => have.includes(w));
    });
}
