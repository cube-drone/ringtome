// The display register (ANNOTATIONS.md ruling 5): whose labels a reader sees. The memo
// holds everything the node could verify; this decides, at read, which annotators render.
// Pure attention, like the selectivity slider - network-silent, and a reader's own choice.

/// The stops, in the order the control offers them. 'followed' is the default.
export const ANNOTATION_STOPS = [
    { key: 'author', label: "the author's labels only" },
    { key: 'followed', label: "the author's, and people I follow" },
    { key: 'everyone', label: "everyone's labels" },
];
// Everyone's, by default (Curtis, 2026-08-31): a label is a claim under a name, and the
// name is the safeguard - a blocked annotator still never shows. The narrower stops are
// there for a reader who wants a quieter post.
export const DEFAULT_ANNOTATION_STOP = 'everyone';

/// Which of a post's known labels this reader sees. The author's always; the READER's own
/// always (2026-08-31: at the default stop the register asked "do I follow myself?" and
/// hid the reader's own tags on refresh - nobody follows themselves); others by the stop;
/// a blocked annotator never, whatever the stop - blocked beats everything. `factsByRoot`
/// is the reader's contact ledger (interest = follows); an absent ledger (no persona
/// signed in) reads as "the author's only", which is what an anonymous visitor is owed.
export function visibleAnnotations(annotations, { author, stop, factsByRoot, me }) {
    const list = annotations || [];
    const facts = factsByRoot || null;
    const blocked = (root) => !!(facts && facts[root] && facts[root].blocked === 'yes');
    const follows = (root) => !!(facts && facts[root] && facts[root].interest);
    return list.filter((a) => {
        if (a.annotator === author) return true;
        if (me && a.annotator === me) return true;
        if (!facts || blocked(a.annotator)) return false;
        if (stop === 'everyone') return true;
        if (stop === 'followed') return follows(a.annotator);
        return false;
    });
}
