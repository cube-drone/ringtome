// The chip row: the little icon-only buttons along a document's header. Their tooltips carry the
// words, which is the whole convention - a chip is a glyph and a title, and the title is not
// optional because it is the only label the user gets.
//
// Two components, because the pair of them was written out eleven times across the editor and the
// reader (the prev/next pair byte-identical between the files). `.chip` + a modifier is the house
// pattern for this - the one place a shared CSS primitive genuinely earned itself - so this is that
// pattern with the markup said once.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';

import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import { useNarrow } from '../panes.js';

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
export const Chip = ({ icon, title, onClick, disabled, on, modifier, children, word }) => {
    const cls = [
        'chip',
        onClick && 'chip-button',
        on && 'chip-open',
        word && 'chip-worded',
        modifier,
    ]
        .filter(Boolean)
        .join(' ');
    // `word`: what the chip is for, in one word - shown under 900px only (Curtis, 2026-10-08: a phone
    // can't hover, so a tooltip there is a secret). Chips that already say their word in their
    // children need none.
    const glyph = children || (icon && html`<${icon} />`);
    const inner = word ? html`${glyph}<span class="chip-word">${word}</span>` : glyph;
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
            word=${t('chips.previous', 'previous')}
            disabled=${!nav.prev}
            onClick=${() => nav.prev && nav.go(nav.prev)}
        />
        <${Chip}
            icon=${Icons.navNext}
            title=${nav.nextTip || t('doc.chips.the-next-document', 'the next document')}
            word=${t('chips.next', 'next')}
            disabled=${!nav.next}
            onClick=${() => nav.next && nav.go(nav.next)}
        />`;
};

/**
 * A row of chips that, in a narrow window (under 900px), folds behind one "options" chip (Curtis,
 * 2026-10-08: the rows never fit a phone - in Writer, then chat rooms, drawings and feed cards).
 *
 *     const menu = useChipMenu();
 *     ...where the row was:            ${menu.narrow ? menu.chip : deck}
 *     ...on a full-width line of its own: ${menu.panel(deck)}
 *
 * The panel is a line of the layout, not an overlay - dropped from its chip it spread under whatever
 * stood beside it (a narrow window's tab strip). Picking a chip or pressing elsewhere closes it -
 * by hiding, never unmounting: a chip whose button owns a modal (a confirm, a copy) keeps it
 * open, and a modal is a portal, so a press inside one reads as "elsewhere" too. A chip whose
 * answer is on itself - "link" turning to "copied" - wears `chip-keeps-menu`, and the menu stays
 * open to show it (2026-10-08).
 */
export function useChipMenu() {
    const narrow = useNarrow();
    const [open, setOpen] = useState(false);
    const anchor = useRef(null);
    const panelRef = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            const inChip = anchor.current && anchor.current.contains(e.target);
            const inPanel = panelRef.current && panelRef.current.contains(e.target);
            if (!inChip && !inPanel) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);
    const chip = html`<span class="chip-menu-anchor" ref=${anchor}>
        <${Chip}
            icon=${Icons.menu}
            word=${t('chips.options', 'options')}
            on=${open}
            title=${t('doc.chips.options-title', 'options')}
            onClick=${() => setOpen((v) => !v)}
        />
    </span>`;
    const panel = (deck) =>
        narrow
            ? html`<div
                  class="chip-menu jag-line"
                  hidden=${!open}
                  ref=${panelRef}
                  onClick=${(e) =>
                      e.target.closest('.chip-button') &&
                      !e.target.closest('.chip-keeps-menu') &&
                      setOpen(false)}
              >
                  ${deck}
              </div>`
            : null;
    return { narrow, open, chip, panel };
}

/// The publish bar's chip, for a narrow window where the bar hides until summoned (Curtis,
/// 2026-10-08: "it summons the publication options to keep them out of the way"): wearing the
/// document's standing as the bar does - private, live, scheduled. Writer's and the drawing
/// editor's alike.
export const PublishChip = ({ standing, open, onClick }) =>
    html`<${Chip}
        icon=${standing === 'scheduled' ? Icons.scheduled : standing === 'public' ? Icons.docPublic : Icons.docPrivate}
        word=${t('chips.publish', 'publish')}
        on=${open}
        title=${t('doc.editor.publish-options-title', 'publishing this document')}
        onClick=${onClick}
    />`;
