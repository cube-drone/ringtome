// A notebook or a book as an ePub (plans/EPUB.md, epub.rs): the node makes it - from its cache when
// the same book was made before - and the page saves it as it saves any file it was handed
// (net.js `saveFile`: a download in a browser, a save dialog in the desktop app).
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { downloadFile } from '../net.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/// `path`: the node's ePub door for this notebook or book; `fallback`: the file's name, should the
/// node not give one.
export const EpubButton = ({ path, fallback, className = 'tree-tool jag-line' }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const go = async () => {
        setBusy(true);
        setError(null);
        try {
            await downloadFile(path, fallback);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
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
        ${error && html`<p class="form-error">${error}</p>`}`;
};
