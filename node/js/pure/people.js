// The People app's list rules - pure: how the rolodex orders, filters, and bounds itself.
// Rows are the mirror's `contacts` kind ({ root, name, facts }), optionally wearing a
// `words` field (their speakable spelling - the CALLER derives it, once per list, because
// this module stays pure and speakable.js is not); the sort dial picks which fact ranks
// them; the filter box narrows them; the slice keeps the DOM bounded however many thousands
// the ledger holds. Values in, values out; the reactive plumbing lives in apps/people.js.

/// The two orderings the shelf offers. Both descend (most first); the tie-break is the root,
/// so two same-scored contacts never shuffle between renders or devices.
export const PEOPLE_SORTS = [
    { key: 'trust', label: 'by trust' },
    { key: 'interest', label: 'by interest' },
];

/// Order contact rows by one fact, descending, blocked personas sinking to the bottom
/// regardless (a blocked contact is still YOURS to see and unblock - hidden would mean
/// unfindable - but it never outranks the living relationships).
export function sortContacts(rows, by) {
    const score = (r) => {
        const n = Number((r.facts || {})[by]);
        return Number.isFinite(n) ? n : 0;
    };
    const blocked = (r) => ((r.facts || {}).blocked === 'yes' ? 1 : 0);
    return [...(rows || [])].sort(
        (a, b) => blocked(a) - blocked(b) || score(b) - score(a) || (a.root < b.root ? -1 : 1)
    );
}

/// How many rows the shelf renders before "show more". The search-first rule (settled
/// 2026-08-08, the 50k-contact audit): the FILTER is how you find someone; the slice is
/// only what idle browsing shows - so the DOM holds at most this many rows regardless of
/// how many the ledger does, and no virtualization machinery is ever needed.
export const PEOPLE_SHELF_SLICE = 100;

/// Filter contact rows by a typed query: case-insensitive substring over every spelling a
/// person is known by - your nickname for them, their self-claimed name, their root hex
/// (prefix), and the speakable words when the row wears them. An empty query keeps
/// everything.
export function filterContacts(rows, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return rows || [];
    return (rows || []).filter((r) => {
        const nickname = ((r.facts || {}).nickname || '').toLowerCase();
        const name = (r.name || '').toLowerCase();
        if (nickname.includes(q) || name.includes(q)) return true;
        if ((r.words || '').toLowerCase().includes(q)) return true;
        return !!r.root && r.root.toLowerCase().startsWith(q);
    });
}

// (The three names moved to pure/person.js with the rest of a person's look.)
