// The text helpers (plans/TEXT_HELPERS.md): four chips in Writer's tool row - effects, text style,
// link, blocks - each opening a small menu of what Marquee can do, for people who don't know its
// markup. What a pick does to the words is pure/markuphelp.js's; this is the menus, and the host
// (doc/editor.js) applies the answer to whichever surface is showing.
//
// A menu stays open through picks, so trying six fonts is six clicks (each edits the same span -
// markuphelp's rule), and closes on a press elsewhere or on its chip. Pressing inside a menu never
// takes the focus from the words, so the selection stays where it was - except the link's
// address box, which needs it.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { FONTS } from '@cube-drone/marquee-html-renderer';

import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import { Chip } from './chips.js';
import { EFFECTS, SIZES } from '../pure/markuphelp.js';
import { COLORS } from '../pure/markcolors.js';

const html = htm.bind(h);

/// What each effect does, in a line - chosen here rather than in the pure module, which speaks no
/// language; a switch, so every phrase is a literal the strings tool can see.
function effectWords(name) {
    switch (name) {
        case 'rainbow':
            return t('texthelpers.rainbow', 'a rainbow running through it');
        case 'wave':
            return t('texthelpers.wave', 'ripples like water');
        case 'bounce':
            return t('texthelpers.bounce', 'bounces');
        case 'blink':
            return t('texthelpers.blink', 'blinks on and off');
        case 'jitter':
            return t('texthelpers.jitter', 'shivers');
        case 'rubber':
            return t('texthelpers.rubber', 'squashes and stretches');
        case 'marquee':
            return t('texthelpers.marquee', 'scrolls across, like a sign');
        case 'typewriter':
            return t('texthelpers.typewriter', 'types itself out');
        case 'fadein':
            return t('texthelpers.fadein', 'fades in');
        case 'spoiler':
            return t('texthelpers.spoiler', 'hidden until it is clicked');
        default:
            return '';
    }
}

function sizeWord(n) {
    switch (n) {
        case 1:
            return t('texthelpers.size-teeny', 'teeny');
        case 2:
            return t('texthelpers.size-tiny', 'tiny');
        case 3:
            return t('texthelpers.size-normal', 'normal');
        case 4:
            return t('texthelpers.size-big', 'big');
        case 5:
            return t('texthelpers.size-bigger', 'bigger');
        case 6:
            return t('texthelpers.size-huge', 'huge');
        default:
            return t('texthelpers.size-enormous', 'enormous');
    }
}

/// The effects whose letters can move one at a time (`by=letter`).
const BY_LETTER = new Set(['rainbow', 'wave', 'bounce', 'blink', 'jitter', 'rubber', 'fadein']);

/// The block buttons, in the menu's order, each with its words.
const blockItems = () => [
    ['quote', t('texthelpers.quote', 'quote')],
    ['heading1', t('texthelpers.heading-1', 'big heading')],
    ['heading2', t('texthelpers.heading-2', 'heading')],
    ['heading3', t('texthelpers.heading-3', 'small heading')],
    ['bullets', t('texthelpers.bullets', 'bulleted list')],
    ['numbers', t('texthelpers.numbers', 'numbered list')],
    ['center', t('texthelpers.center', 'centred')],
    ['spoiler', t('texthelpers.spoiler-block', 'spoiler')],
    ['divider', t('texthelpers.divider', 'divider line')],
    ['table', t('texthelpers.table', 'table')],
];

/// Keep the words' focus (and so their selection) through a press on a menu.
const keepFocus = (e) => e.preventDefault();

export const TextHelpers = ({ onSpan, onLink, onBlock }) => {
    const [open, setOpen] = useState(null); // 'effects' | 'style' | 'link' | 'blocks' | null
    const [byLetter, setByLetter] = useState(false);
    const [address, setAddress] = useState('');
    const wrap = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (wrap.current && !wrap.current.contains(e.target)) setOpen(null);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);
    const toggle = (which) => setOpen((now) => (now === which ? null : which));

    const effects = html`<div class="texthelp-panel jag-line" onMouseDown=${keepFocus}>
        <label class="texthelp-letter">
            <input type="checkbox" checked=${byLetter} onChange=${(e) => setByLetter(e.currentTarget.checked)} />
            ${t('texthelpers.letter-by-letter', 'letter by letter')}
        </label>
        ${EFFECTS.map(
            (name) => html`<button
                key=${name}
                type="button"
                class="texthelp-item"
                onClick=${() => onSpan(byLetter && BY_LETTER.has(name) ? `${name} by=letter` : name)}
            >
                <strong>${name}</strong>
                <span class="texthelp-about">${effectWords(name)}</span>
            </button>`,
        )}
    </div>`;

    const style = html`<div class="texthelp-panel jag-line" onMouseDown=${keepFocus}>
        <p class="texthelp-heading">${t('texthelpers.font', 'font')}</p>
        <div class="texthelp-fonts">
            ${Object.keys(FONTS).map(
                (token) => html`<button
                    key=${token}
                    type="button"
                    class="texthelp-item"
                    title=${FONTS[token]}
                    onClick=${() => onSpan(`font=${token}`)}
                >
                    <span class=${`mq-font-${token}`}>${token}</span>
                </button>`,
            )}
        </div>
        <p class="texthelp-heading">${t('texthelpers.size', 'size')}</p>
        <div class="texthelp-sizes">
            ${SIZES.map(
                ([
                    n,
                ]) => html`<button key=${n} type="button" class="texthelp-item" onClick=${() => onSpan(`size=${n}`)}>
                    ${sizeWord(n)}
                </button>`,
            )}
        </div>
        <p class="texthelp-heading">${t('texthelpers.colour', 'colour')}</p>
        <div class="texthelp-swatches">
            ${COLORS.map(
                ([name, hex]) => html`<button
                    key=${name}
                    type="button"
                    class="texthelp-swatch"
                    title=${name}
                    aria-label=${name}
                    style=${`--swatch: ${hex}`}
                    onClick=${() => onSpan(`color=${name}`)}
                ></button>`,
            )}
        </div>
    </div>`;

    const linking = html`<form
        class="texthelp-panel jag-line"
        onSubmit=${(e) => {
            e.preventDefault();
            if (!address.trim()) return;
            onLink(address.trim());
            setAddress('');
            setOpen(null);
        }}
    >
        <label class="texthelp-heading" for="texthelp-address">${t('texthelpers.link-to', 'link to')}</label>
        <input
            id="texthelp-address"
            class="texthelp-address"
            type="url"
            placeholder=${t('texthelpers.address-placeholder', 'https://')}
            value=${address}
            onInput=${(e) => setAddress(e.currentTarget.value)}
        />
        <button type="submit" class="texthelp-item">${t('texthelpers.make-the-link', 'make the link')}</button>
    </form>`;

    const blocks = html`<div class="texthelp-panel jag-line" onMouseDown=${keepFocus}>
        ${blockItems().map(
            ([
                block,
                words,
            ]) => html`<button key=${block} type="button" class="texthelp-item" onClick=${() => onBlock(block)}>
                ${words}
            </button>`,
        )}
    </div>`;

    // `chip-keeps-menu`: inside a narrow window's "edit" menu, pressing one of these opens its own
    // menu rather than shutting the one it sits in (doc/chips.js useChipMenu).
    const chip = (which, icon, word, title) => html`<span class="texthelp" onMouseDown=${keepFocus}>
        <${Chip}
            icon=${icon}
            word=${word}
            title=${title}
            on=${open === which}
            modifier="chip-keeps-menu"
            onClick=${() => toggle(which)}
        />
    </span>`;
    return html`<span class="texthelp-row" ref=${wrap}>
        <span class="texthelp-anchor">
            ${chip('effects', Icons.effects, t('chips.effects', 'effects'), t('texthelpers.effects-title', 'make the words move: rainbow, wave, blink...'))}
            ${open === 'effects' && effects}
        </span>
        <span class="texthelp-anchor">
            ${chip('style', Icons.textStyle, t('chips.style', 'style'), t('texthelpers.style-title', 'font, size and colour'))}
            ${open === 'style' && style}
        </span>
        <span class="texthelp-anchor">
            ${chip('link', Icons.link, t('chips.link-words', 'link'), t('texthelpers.link-title', 'make the words a link'))}
            ${open === 'link' && linking}
        </span>
        <span class="texthelp-anchor">
            ${chip('blocks', Icons.blocks, t('chips.blocks', 'blocks'), t('texthelpers.blocks-title', 'quotes, headings, lists, a table...'))}
            ${open === 'blocks' && blocks}
        </span>
    </span>`;
};
