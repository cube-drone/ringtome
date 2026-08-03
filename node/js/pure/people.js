// The People app's list rules - pure: how the rolodex orders itself. Rows are the mirror's
// `contacts` kind ({ root, facts }); the sort dial picks which fact ranks them. Values in,
// values out; the reactive plumbing lives in apps/people.js.

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

// (The three names moved to pure/person.js with the rest of a person's look.)
