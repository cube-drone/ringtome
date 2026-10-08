// Rendering a Marquee document, with an honest fallback when it doesn't parse.
//
// A conflict hunk can split a block element - the accepted cost of per-hunk marquee conflicts
// (NOTES_APP, the merge model) - so a document that parsed yesterday may not today, and every
// surface has to degrade rather than blank. The strict parse here is that gate: it is deliberately
// a second parse (the renderer does its own), because "would this render?" is a question worth
// asking before answering it.
//
// What differs between surfaces is only what to show INSTEAD, so that is the parameter. Three
// fallbacks ship: `marqueeApology` (the default - say what happened, then the source), `bareSource`
// (the journal, where an apology per entry in a scrolling stream would be noise), and `parseError`
// (the editor's side-by-side pane, where you are actively editing and want the reason).
//
// The absent-body state - "the blobs haven't reached this computer yet" - deliberately stays with
// each surface: the journal wants a waiting dot, the editor a whole panel, the reader a line. That
// is chrome, not parsing.
import { h } from 'preact';
import { memo } from 'preact/compat';
import htm from 'htm';
import { Marquee, parse } from '@cube-drone/marquee-react-renderer';

import { marqueeHooks } from './usercard.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/// Just the source, unadorned.
export const bareSource = (_error, source) =>
    html`<pre class="reader-plain jag-line">${source}</pre>`;

/// The default: what happened, and then the source so nothing is hidden.
export const marqueeApology = (_error, source) => html`<div>
    <p class="null-sub">
        ${t('doc.marqueebody.this-marquee-doesnt-parse-right', 'this page has a formatting problem. Showing the plain text.')}
    </p>
    <pre class="reader-plain jag-line">${source}</pre>
</div>`;

/// The parser's own complaint, for someone with the document open in an editor.
export const parseError = (error) =>
    html`<p class="form-error">${t('doc.marqueebody.marquee-doesnt-parse', "marquee doesn't parse: {message}", { message: error.message })}</p>`;

/**
 * @param handle       a ref for the MarqueeHandle, when the host drives scrolling (the editor's
 *                     side-by-side sync). Passed as a prop rather than a `ref`, which a plain
 *                     Preact function component does not forward.
 * @param onUnparsable (error, source) => vnode
 */
const MarqueeBodyInner = ({
    source,
    profile,
    handle,
    onNodeClick,
    onUnparsable = marqueeApology,
}) => {
    const error = parseFailure(source);
    if (error) return onUnparsable(error, source);
    return html`<div class="reader-marquee jag-line"><${Marquee}
        ref=${handle}
        source=${source}
        animate="visible"
        profile=${profile}
        hooks=${marqueeHooks}
        onNodeClick=${onNodeClick}
    /></div>`;
};

/// Memoized on its props (2026-10-08, the frontend audit): a page re-rendering above it - a chat
/// floor, a feed - no longer re-parses and re-renders words that didn't change. Callers that hand a
/// fresh profile or click handler each render still re-render; the gate below spares them its parse.
export const MarqueeBody = memo(MarqueeBodyInner);

/// The gate's verdict for a source - its parse error, or null - kept for the sources seen lately, so
/// a re-render asks the parser once per text, not once per render (the renderer keeps its own parse
/// the same way). Bounded: the oldest verdicts go first.
const verdicts = new Map();
const VERDICTS_KEPT = 500;

function parseFailure(source) {
    if (verdicts.has(source)) return verdicts.get(source);
    let error = null;
    try {
        parse(source);
    } catch (e) {
        error = e;
    }
    verdicts.set(source, error);
    if (verdicts.size > VERDICTS_KEPT) verdicts.delete(verdicts.keys().next().value);
    return error;
}
