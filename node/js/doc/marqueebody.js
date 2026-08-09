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
import htm from 'htm';
import { Marquee, parse } from '@cube-drone/marquee-react-renderer';
import { t } from '../i18n.js';

const html = htm.bind(h);

/// Just the source, unadorned.
export const bareSource = (_error, source) => html`<pre class="reader-plain">${source}</pre>`;

/// The default: what happened, and then the source so nothing is hidden.
export const marqueeApology = (_error, source) => html`<div>
    <p class="null-sub">
        ${t('doc.marqueebody.this-marquee-doesnt-parse-right', "this marquee doesn't parse right now (likely a conflict split a block) - showing the source; edit to tidy it.")}
    </p>
    <pre class="reader-plain">${source}</pre>
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
export const MarqueeBody = ({ source, profile, handle, onNodeClick, onUnparsable = marqueeApology }) => {
    try {
        parse(source);
    } catch (error) {
        return onUnparsable(error, source);
    }
    return html`<div class="reader-marquee"><${Marquee}
        ref=${handle}
        source=${source}
        animate="visible"
        profile=${profile}
        onNodeClick=${onNodeClick}
    /></div>`;
};
