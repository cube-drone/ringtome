// The house modal: a floating panel speaking the app-window language - the chunky frame with a
// thick Press-Start title band, a punched-out square [x], and the pixel-rough-rounded bottom -
// but wearing the BOLD QUICKBAR TEAL instead of the app ink, so a modal reads as the system
// stepping forward, not another app. Built to be reused (file upload first; whatever needs a
// modal next, this is it).
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import htm from 'htm';

import { Icons } from './icons.js';

const html = htm.bind(h);

/**
 * @param title    the band title (thick, chunky)
 * @param onClose  the [x] / Escape / scrim-click handler
 */
export const Modal = ({ title, onClose, children }) => {
    // Escape is the [x]'s keyboard twin.
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    return html`
        <div
            class="modal-scrim"
            onPointerDown=${(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div class="modal" role="dialog" aria-modal="true">
                <header class="modal-head">
                    <span class="modal-title">${title}</span>
                    <button class="modal-close" title="close" onClick=${onClose}>
                        <${Icons.close} />
                    </button>
                </header>
                <div class="modal-body">${children}</div>
            </div>
        </div>
    `;
};
