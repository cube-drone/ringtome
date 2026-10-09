// A notebook or a book as an ePub (plans/EPUB.md, epub.rs): the node makes it - from its cache when
// the same book was made before - and the page saves it as it saves any file it was handed
// (net.js `saveFile`: a download in a browser, a save dialog in the desktop app).
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { downloadFile } from '../net.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import { Chip } from './chips.js';
import { Progress } from '../progress.js';

const html = htm.bind(h);

/// `path`: the node's ePub door for this notebook or book; `fallback`: the file's name, should the
/// node not give one.
export const EpubButton = ({ path, fallback, className = 'tree-tool jag-line' }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // A large book is made in the background (epub.rs): how far it has got, while it is.
    const [made, setMade] = useState(null);
    const go = async () => {
        setBusy(true);
        setError(null);
        setMade(null);
        try {
            await downloadFile(path, fallback, setMade);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
            setMade(null);
        }
    };
    return html`<button
            class=${className}
            type="button"
            disabled=${busy}
            title=${t('doc.epubbutton.download-as-an-epub', 'download as an ePub, for an e-reader')}
            onClick=${go}
        >
            <${Icons.download} /> ${busy ? t('doc.epubbutton.making-it', 'making it…') : t('doc.epubbutton.epub', 'ePub')}
        </button>
        ${
            busy &&
            made &&
            html`<div class="epub-error"><${Progress}
                done=${made.done}
                total=${made.total}
                doing=${t('doc.epubbutton.making-it', 'making it…')}
            /></div>`
        }
        ${error && html`<p class="form-error epub-error">${error}</p>`}`;
};

/// A book's card in the feed (Curtis, 2026-10-09): the same download as an icon chip. A chip has no
/// room for words, so a refusal is its tooltip.
export const EpubChip = ({ path }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [made, setMade] = useState(null);
    const go = async () => {
        setBusy(true);
        setError(null);
        setMade(null);
        try {
            await downloadFile(path, 'book.epub', setMade);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    return html`<${Chip}
        icon=${Icons.book}
        disabled=${busy}
        title=${error || t('doc.epubbutton.download-as-an-epub', 'download as an ePub, for an e-reader')}
        word=${
            busy && made && made.total
                ? t('doc.epubbutton.percent', '{percent}%', {
                      percent: Math.floor((100 * (made.done || 0)) / made.total),
                  })
                : busy
                  ? t('doc.epubbutton.making-it', 'making it…')
                  : t('doc.epubbutton.epub', 'ePub')
        }
        onClick=${go}
    />`;
};
