// Groups in People (plans/GROUPS.md, section 7): the orderings and choices the Groups tab and a
// group's page make over what the node answered - values in, values out.

/// How the Groups tab orders a persona's groups: invites first, since they wait on an answer -
/// one never opened ahead of one opened - then the groups you keep, then the rest, each by name.
const STANDING_ORDER = ['invite', 'invited', 'owner', 'member'];

export const groupsInOrder = (rows) =>
    [...(rows || [])].sort((a, b) => {
        const rank = (r) => {
            const i = STANDING_ORDER.indexOf(r.standing);
            return i === -1 ? STANDING_ORDER.length : i;
        };
        return (
            rank(a) - rank(b) ||
            (a.name || '').localeCompare(b.name || '') ||
            (a.group < b.group ? -1 : 1)
        );
    });

/// Is this row one waiting on an answer from you?
export const isInvite = (row) => row.standing === 'invite' || row.standing === 'invited';

/// A group's members as its page lists them: the founder, then the other owners, then everyone
/// else - each run in the order the node gave, which is stable.
export const membersInOrder = (roster) => {
    const members = (roster && roster.members) || [];
    const founder = roster && roster.founder;
    const first = members.filter((m) => m.root === founder);
    const owners = members.filter((m) => m.root !== founder && m.owner);
    const rest = members.filter((m) => m.root !== founder && !m.owner);
    return [...first, ...owners, ...rest];
};

/// Who an owner may invite from their own contacts: anyone not already in the group, waiting on
/// an invite or banned from it, and never themselves.
export const inviteCandidates = (contacts, roster, me) => {
    const taken = new Set([
        me,
        ...((roster && roster.members) || []).map((m) => m.root),
        ...((roster && roster.invited) || []),
        ...((roster && roster.banned) || []),
    ]);
    return (contacts || []).filter((c) => c && c.root && !taken.has(c.root));
};
