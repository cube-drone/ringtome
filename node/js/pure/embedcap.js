// The embed-count cap, client side: counting, and the paste-rescue rewrite.
//
// The server refuses a marquee save embedding more than fifty of the author's own documents
// (proto `DocHeaderPlain::MAX_REFS`; `Store::save` and the publish bake both enforce it). A
// refusal at save time is the WRONG surface to meet that rule for the first time: the editor's
// autosave would fail identically forever - "will keep retrying" over words that only exist in
// the browser - so the client stops the problem at the two places it can actually be stopped:
//
//   * the GESTURE: the upload funnel refuses to insert an embed that would cross the cap;
//   * the PASTE: embeds that arrive in the body anyway are REPLACED with refusal text, which
//     is saveable - the document heals to something the server accepts, visibly, instead of
//     wedging (Curtis, 2026-08-14: "replace the offending image link with our refusal text,
//     which _is_ saveable").
//
// Import-free on purpose (the pure-module rule): the caller parses - these functions take the
// AST and the source, and give back counts and surgery. The surgery is best-effort string work
// verified by the caller RE-PARSING the result; the marquee grammar punishes pattern-matching
// (bake.rs says why), so the parse decides what counts and the string work only relocates what
// the parse identified. Anything the surgery cannot confidently rewrite is left alone, and the
// server's refusal remains the backstop.

/// Mirrors proto `DocHeaderPlain::MAX_REFS`. The server is the authority; if the two ever
/// drift, the client merely gates at the wrong number and the server's door still decides.
export const EMBED_CAP = 50;

/// Walk every embed node in a parsed marquee document. The container set mirrors
/// `bake.rs::walk`: anything with children recurses, embeds are leaves.
function walkEmbeds(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'embed' && typeof node.target === 'string') {
        fn(node);
        return;
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) walkEmbeds(child, fn);
    }
}

/// The doc id an embed target names, when it is one of this author's own documents - the
/// picker's minted shape, `/api/identity/<root>/docs/<32hex>/body[...]`. External URLs and
/// other people's documents return null: a URL is not a document, and only own-doc embeds
/// count against the cap (the same classification `bake.rs::classify` makes).
export function ownDocOf(target, rootHex) {
    const prefix = `/api/identity/${rootHex}/docs/`;
    if (!target.startsWith(prefix)) return null;
    const rest = target.slice(prefix.length);
    const slash = rest.indexOf('/body');
    if (slash === -1) return null;
    const docHex = rest.slice(0, slash);
    return /^[0-9a-f]{32}$/.test(docHex) ? docHex : null;
}

/// Every distinct own document this body embeds, in order of first appearance, with the
/// target strings that name each. The order is what makes "the first fifty stay" stable.
export function ownDocEmbeds(ast, rootHex) {
    const order = [];
    const targets = new Map(); // docHex -> Set<target>
    walkEmbeds(ast, (node) => {
        const doc = ownDocOf(node.target, rootHex);
        if (!doc) return;
        if (!targets.has(doc)) {
            order.push(doc);
            targets.set(doc, new Set());
        }
        targets.get(doc).add(node.target);
    });
    return { order, targets };
}

/// The target strings belonging to documents past the cap - what the rescue rewrites. Empty
/// set means the body is fine as it stands.
export function overCapTargets(ast, rootHex, cap = EMBED_CAP) {
    const { order, targets } = ownDocEmbeds(ast, rootHex);
    const over = new Set();
    for (const doc of order.slice(cap)) {
        for (const t of targets.get(doc)) over.add(t);
    }
    return { over, distinct: order.length };
}

/// Replace every `![alt](target)` whose target is in `targets` with `makeNote(alt)`.
///
/// Best-effort by design: the scan finds `](target)` and walks back to the nearest `![`,
/// which is right for every body a picker or an honest paste produces and can be confused by
/// adversarial nesting - so a candidate whose "alt" spans a blank line is skipped rather than
/// mangled, and the CALLER re-parses the result before trusting it. What the surgery cannot
/// fix, the server's refusal still catches.
export function replaceTargets(source, targets, makeNote) {
    let out = source;
    let replaced = 0;
    for (const target of targets) {
        const needle = `](${target})`;
        let from = 0;
        for (;;) {
            const i = out.indexOf(needle, from);
            if (i === -1) break;
            const start = out.lastIndexOf('![', i);
            if (start === -1 || out.slice(start, i).includes('\n\n')) {
                from = i + needle.length;
                continue;
            }
            const alt = out.slice(start + 2, i);
            const note = makeNote(alt);
            out = out.slice(0, start) + note + out.slice(i + needle.length);
            from = start + note.length;
            replaced += 1;
        }
    }
    return { source: out, replaced };
}
