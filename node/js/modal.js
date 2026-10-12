// The house modal: a floating panel speaking the app-window language - the chunky frame with a
// thick Press-Start title band, a punched-out square [x], and the pixel-rough-rounded bottom -
// but wearing the BOLD QUICKBAR TEAL instead of the app ink, so a modal reads as the system
// stepping forward, not another app. Built to be reused (file upload first; whatever needs a
// modal next, this is it).
import { h, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import htm from 'htm';

import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/**
 * @param title    the band title (thick, chunky)
 * @param onClose  the [x] / Escape / scrim-click handler
 */
export const Modal = ({ title, onClose, children, wide = false }) => {
    // Escape is the [x]'s keyboard twin.
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    // Rendered at the body, not where it was opened (Curtis, 2026-09-10: the copy modal
    // sat "trapped inside of the post"): every card wears the jagged clip-path, which
    // clips a fixed descendant along with everything else, so a modal that stays in the
    // card's subtree never reaches the page.
    const node = html`
        <div
            class="modal-scrim"
            onPointerDown=${(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div class=${wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true">
                <header class="modal-head">
                    <span class="modal-title">${title}</span>
                    <button class="modal-close" title=${t('modal.close', 'close')} onClick=${onClose}>
                        <${Icons.close} />
                    </button>
                </header>
                <div class="modal-body">${children}</div>
            </div>
        </div>
    `;
    return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
};

/// A name or a short line, asked in the house modal instead of the browser's `prompt()` (Curtis,
/// 2026-10-12: saving a filter or making a mixtape "we're using a system modal when we should
/// probably use a HDT modal of our own"). Resolves to the trimmed words, or null when closed or
/// cancelled. Mounted on its own at the page, so any handler can ask without a component to host
/// it - as `prompt()` could.
export function askText({ title, label = null, placeholder = '', initial = '', ok = null }) {
    if (typeof document === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const done = (value) => {
            render(null, host);
            host.remove();
            resolve(value);
        };
        render(
            html`<${AskText}
                title=${title}
                label=${label}
                placeholder=${placeholder}
                initial=${initial}
                ok=${ok || t('modal.ok', 'ok')}
                onDone=${done}
            />`,
            host,
        );
    });
}

const AskText = ({ title, label, placeholder, initial, ok, onDone }) => {
    const [value, setValue] = useState(initial || '');
    const words = value.trim();
    return html`<${Modal} title=${title} onClose=${() => onDone(null)}>
        <form
            class="modal-ask"
            onSubmit=${(e) => {
                e.preventDefault();
                if (words) onDone(words);
            }}
        >
            ${label && html`<label class="modal-ask-label" for="modal-ask-input">${label}</label>`}
            <input
                id="modal-ask-input"
                class="modal-ask-input"
                value=${value}
                placeholder=${placeholder}
                onInput=${(e) => setValue(e.currentTarget.value)}
                ref=${(el) => el && !el.dataset.focused && ((el.dataset.focused = '1'), el.focus(), el.select())}
            />
            <div class="modal-ask-buttons">
                <button type="button" class="copy-bucket" onClick=${() => onDone(null)}>${t('modal.cancel', 'cancel')}</button>
                <button type="submit" class="copy-bucket modal-ask-ok" disabled=${!words}>${ok}</button>
            </div>
        </form>
    <//>`;
};
