// Groups in People (plans/GROUPS.md, section 7): the orderings and choices the Groups tab and a
// group's page make over what the node answered - values in, values out.
import { canonicalPicks, searchWords } from './savedfeeds.js';

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

/// The feed's implicit feeds (plans/GROUPS.md, section 7: "an implicit saved feed filter for every
/// group you're in"): one per group you're a member of, by name, picking that group alone. Made
/// from your groups rather than stored, so one comes with joining and goes with leaving; never an
/// invite's, since its posts aren't yours to read yet.
export const groupFeeds = (rows) =>
    groupsInOrder(
        (rows || []).filter((g) => g.standing === 'member' || g.standing === 'owner'),
    ).map((g) => ({
        id: `group:${g.group}`,
        name: g.name,
        group: g.group,
        public: !!g.public,
        picks: { groups: [g.group] },
        stop: null,
        sort: null,
        q: null,
    }));

/// The faces a group's page shows at a glance (Curtis, 2026-10-16): the founder, the other owners,
/// then whoever posted most recently, then everyone else - at most `cap`. `posts` are the group's
/// feed items, newest first; someone who posted but has since left isn't in it.
export const membersAtAGlance = (roster, posts, cap) => {
    const members = membersInOrder(roster);
    const inIt = new Set(members.map((m) => m.root));
    const leading = members.filter((m) => m.root === roster.founder || m.owner).map((m) => m.root);
    const posters = (posts || []).map((p) => p.author).filter((r) => inIt.has(r));
    const rest = members.map((m) => m.root);
    return [...new Set([...leading, ...posters, ...rest])].slice(0, cap);
};

/// Is this group's feed the one on screen? A group's feed is a pick, not a saved feed: it is lit
/// while the picks are that group alone and nothing is searched for, whatever the curiosity and
/// the order (choosing it leaves those as they were - Curtis, 2026-10-16: it set the filter, and
/// didn't light).
export const groupFeedOn = (feed, now) =>
    !!feed &&
    !!now &&
    JSON.stringify(canonicalPicks(feed.picks)) === JSON.stringify(canonicalPicks(now.picks)) &&
    !searchWords(now.q);

/// A group post's card as its author's composer knows it the moment the node says it's posted
/// (`post`, the group post's id): drawn on its own page at once, and swapped for the node's own
/// answer when that comes (the optimistic pattern - pure/optimistic.js - for a page the mirror
/// doesn't hold). `draft` is the mirror's row of the draft it was posted from.
export const groupPostItem = ({ root, post, draft, group, settled = false, now }) => ({
    author: root,
    doc_id: post,
    title: (draft && draft.title) || '',
    format: 'marquee',
    published_ms: now,
    updated_ms: now,
    minted_ms: now,
    arrived_ms: now,
    settled: !!settled,
    mine: true,
    annotations: [],
    group: { id: group.group, name: group.name },
});

/// A group's page, pinned first (slice 4d; Curtis, 2026-10-15: "owner pins display above member
/// pins"): the posts an owner pinned, then those a member pinned, each run newest first as the feed
/// gave them, and every other post after - a pinned post isn't listed twice.
export const pinnedFirst = (items) => {
    const pin = (i) => (i.group && i.group.pinned) || null;
    const all = items || [];
    return {
        pinned: [
            ...all.filter((i) => pin(i) === 'owner'),
            ...all.filter((i) => pin(i) === 'member'),
        ],
        rest: all.filter((i) => !pin(i)),
    };
};
