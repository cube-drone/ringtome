// Relationship stories (Curtis, 2026-11-21): the four routing dials of the contact ledger -
// who sees the relationship, trust, interest, interest in their rebroadcasts - read as one of
// seven named relationships, or "custom" for any other setting. "Even I, a person who came up
// with the whole thing, often struggle to look at that and quickly turn it into a meaningful
// relationship": a story is one icon and one word where the dials were three icons and three
// bar graphs.
//
// All of it is reading and writing the same four keys (pure/contact.js); nothing is stored
// about which story was picked, so a relationship dialled by hand into a story's exact
// settings IS that story, and one nudged off it is custom. The words and icons live with the
// UI (js/person.js), where they can go through the catalog.
import { bandOrdinal } from './contact.js';

/// The stories, most distant first - the order they are offered in, and the order their icons
/// gain opacity in. Each is a full setting of the four dials, in Curtis's table, but for
/// `follow`'s interest: his table gave it the same settings as `quiet-follow`, which no reading
/// of the dials could then tell apart, so the plain follow sits one stop of interest above.
export const STORIES = [
    { id: 'quiet-follow', open: false, trust: 'none', interest: 'low', rebroadcasts: 'none' },
    { id: 'follow', open: false, trust: 'none', interest: 'medium', rebroadcasts: 'none' },
    { id: 'fan', open: true, trust: 'low', interest: 'medium', rebroadcasts: 'medium' },
    { id: 'acquaintance', open: true, trust: 'medium', interest: 'low', rebroadcasts: 'low' },
    { id: 'friend', open: true, trust: 'high', interest: 'medium', rebroadcasts: 'medium' },
    { id: 'quiet-friend', open: true, trust: 'high', interest: 'low', rebroadcasts: 'none' },
    { id: 'family', open: true, trust: 'max', interest: 'high', rebroadcasts: 'high' },
];

/// Any setting of the dials that is no story.
export const CUSTOM = 'custom';

const rung = (value) => bandOrdinal(value) || 0;

/// Is the relationship published? The resting state is yes (node/src/publish.rs): only an
/// explicit "no" keeps it quiet.
const open = (facts) => facts.edges_public !== 'no';

/// The story these facts tell: a story's id, `CUSTOM`, or null where no dial is above its
/// bottom stop - nothing to tell. An unset dial and one set to its bottom stop read alike.
export function storyOf(facts) {
    const f = facts || {};
    const [trust, interest, rebroadcasts] = [
        rung(f.trust),
        rung(f.interest),
        rung(f.interest_rebroadcasts),
    ];
    if (trust === 0 && interest === 0 && rebroadcasts === 0) return null;
    const told = STORIES.find(
        (s) =>
            s.open === open(f) &&
            rung(s.trust) === trust &&
            rung(s.interest) === interest &&
            rung(s.rebroadcasts) === rebroadcasts,
    );
    return told ? told.id : CUSTOM;
}

/// A custom relationship's name, as parts (Curtis, 2026-11-21: the seven keep their concrete
/// names, "the matrix is just the auto-generated names for custom relationships"). One word a
/// dial, stacked: `secret` when the relationship is private, then interest, then interest in
/// their rebroadcasts, then a core noun for trust - each the band it stands at. The UI turns
/// the bands into words (js/person.js): "secret devoted all-in fan", "quiet solo friend".
///
/// Interest at its middle stop says nothing, so the commonest names are short; rebroadcast
/// interest always speaks, which is what keeps a generated name from ever spelling one of the
/// seven's ("quiet friend" the story is low interest and no rebroadcasts; low interest and
/// medium rebroadcasts must not read the same).
export function customName(facts) {
    const f = facts || {};
    const band = (value) => ['none', 'low', 'medium', 'high', 'max'][rung(value)];
    const interest = band(f.interest);
    return {
        secret: !open(f),
        interest: interest === 'medium' ? null : interest,
        rebroadcasts: band(f.interest_rebroadcasts),
        trust: band(f.trust),
    };
}

/// What picking a story writes: the four keys, as `[key, value]` pairs, less the ones `facts`
/// already hold - one private record per dial that actually moves. Nothing for an unknown id.
export function storyWrites(id, facts) {
    const story = STORIES.find((s) => s.id === id);
    if (!story) return [];
    const f = facts || {};
    return [
        ['edges_public', story.open ? 'yes' : 'no', open(f) === story.open],
        ['trust', story.trust, rung(f.trust) === rung(story.trust)],
        ['interest', story.interest, rung(f.interest) === rung(story.interest)],
        [
            'interest_rebroadcasts',
            story.rebroadcasts,
            rung(f.interest_rebroadcasts) === rung(story.rebroadcasts),
        ],
    ]
        .filter(([, , same]) => !same)
        .map(([key, value]) => [key, value]);
}

/// How solid a story's icon is drawn: 70% for the most distant, climbing evenly to 100% for
/// the closest. A custom relationship says nothing of closeness, and is drawn whole.
export function storyOpacity(id) {
    const at = STORIES.findIndex((s) => s.id === id);
    if (at < 0) return 1;
    return Math.round((0.7 + (0.3 * at) / (STORIES.length - 1)) * 100) / 100;
}
