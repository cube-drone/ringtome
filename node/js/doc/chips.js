// The chip row: the little icon-only buttons along a document's header. Their tooltips carry the
// words, which is the whole convention - a chip is a glyph and a title, and the title is not
// optional because it is the only label the user gets.
//
// Two components, because the pair of them was written out eleven times across the editor and the
// reader (the prev/next pair byte-identical between the files). `.chip` + a modifier is the house
// pattern for this - the one place a shared CSS primitive genuinely earned itself - so this is that
// pattern with the markup said once.
import { h } from 'preact';
import htm from 'htm';

import { Icons } from '../icons.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/**
 * One chip. `on` gives it the lit look (an open panel); `modifier` is a FULL class name for the
 * chips that mean something stronger than "a button" - `chip-delete`, `chip-pinned`,
 * `chip-diverged`, `chip-merged`.
 *
 * Full class names, never `chip-${fragment}`: a constructed name is invisible to the dead-CSS cop
 * (integration/test/pure/conventions.cjs searches the JS for the literal), so building one silently
 * turns off the check for that rule. Caught by the cop itself the first time this file was written
 * with a `tone="delete"` shorthand - which is the cop working.
 *
 * Rendered as a <span> when there is no onClick, because a chip can also be a STATUS - the format
 * name, the save spinner - and a button you cannot press is a lie to a keyboard.
 */
export const Chip = ({ icon, title, onClick, disabled, on, modifier, children }) => {
    const cls = ['chip', onClick && 'chip-button', on && 'chip-open', modifier]
        .filter(Boolean)
        .join(' ');
    const inner = children || (icon && html`<${icon} />`);
    if (!onClick) return html`<span class=${cls} title=${title}>${inner}</span>`;
    return html`<button class=${cls} title=${title} disabled=${disabled} onClick=${onClick}>
        ${inner}
    </button>`;
};

/// The prev/next pair, walking whatever order the host is in. Absent when there is nowhere to go;
/// an end-of-the-book arrow stays PRESENT but disabled, so the pair never changes shape under the
/// pointer. The tips come from the host because what "previous" means depends on the order.
export const NavChips = ({ nav }) => {
    if (!nav) return null;
    return html`<${Chip}
            icon=${Icons.navPrev}
            title=${nav.prevTip || t('doc.chips.the-previous-document', 'the previous document')}
            disabled=${!nav.prev}
            onClick=${() => nav.prev && nav.go(nav.prev)}
        />
        <${Chip}
            icon=${Icons.navNext}
            title=${nav.nextTip || t('doc.chips.the-next-document', 'the next document')}
            disabled=${!nav.next}
            onClick=${() => nav.next && nav.go(nav.next)}
        />`;
};
