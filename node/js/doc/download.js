// A notebook or a book, downloaded (epub.rs, epub/zips.rs): the ePub, or a zip of its pages as
// Markdown, Markdown with YAML front matter, HTML or Marquee (Curtis, 2026-10-26: "replace "ePub"
// with "download" and have that bring up a list of download types"). The node makes the file -
// from its cache when the same book was made before - and the page saves it as it saves any file
// it was handed (net.js `saveFile`: a download in a browser, a save dialog in the desktop app).
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import htm from 'htm';

import { downloadFile } from '../net.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import { Chip } from './chips.js';
import { Progress } from '../progress.js';

const html = htm.bind(h);

/// What there is to download, the ePub first: the node's name for each (epub.rs `Kind::parse`), and
/// the ending its file downloads with - which is also what the menu calls a zip.
const KINDS = [
    { kind: 'epub', ending: 'epub', name: 'ePub' },
    { kind: 'markdown', ending: 'markdown.zip' },
    { kind: 'markdown-yaml', ending: 'markdown.yaml.zip' },
    { kind: 'html', ending: 'html.zip' },
    { kind: 'marquee', ending: 'marquee.zip' },
];

const hint = (kind) =>
    ({
        epub: t('doc.download.epub-hint', 'a book, for an e-reader'),
        markdown: t('doc.download.markdown-hint', 'every page as Markdown'),
        'markdown-yaml': t(
            'doc.download.markdown-yaml-hint',
            'Markdown, each page opening on its details',
        ),
        html: t('doc.download.html-hint', 'web pages, to open in any browser'),
        marquee: t('doc.download.marquee-hint', 'every page as it is written'),
    })[kind];

/// The list, hung under its button: picking one starts it; a press anywhere else, or the page
/// scrolling out from under it, closes it. It lives at the page's top (a portal, as a modal does),
/// placed by its button, so no column it opens from can clip it - and opens leftward where
/// rightward would leave the window.
const Menu = ({ anchor, onPick, onClose }) => {
    const ref = useRef(null);
    const [at, setAt] = useState(null);
    useLayoutEffect(() => {
        const button = anchor.current && anchor.current.getBoundingClientRect();
        const menu = ref.current && ref.current.getBoundingClientRect();
        if (!button || !menu) return;
        const left = Math.max(8, Math.min(button.left, window.innerWidth - 8 - menu.width));
        setAt({ top: button.bottom + 6, left });
    }, [anchor]);
    // This render's closer, read when the press comes (doc/chips.js `useChipMenu` does the same).
    const closer = useRef(onClose);
    closer.current = onClose;
    useEffect(() => {
        const inside = (e) =>
            (anchor.current && anchor.current.contains(e.target)) ||
            (ref.current && ref.current.contains(e.target));
        const onDown = (e) => inside(e) || closer.current();
        const onMove = (e) => inside(e) || closer.current();
        document.addEventListener('mousedown', onDown);
        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        return () => {
            document.removeEventListener('mousedown', onDown);
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
        };
    }, [anchor]);
    const menu = html`<div
        class="download-menu"
        ref=${ref}
        role="menu"
        style=${at ? `top: ${at.top}px; left: ${at.left}px` : 'visibility: hidden'}
    >
        ${KINDS.map(
            (
                k,
            ) => html`<button class="download-menu-item" role="menuitem" type="button" onClick=${() => onPick(k)}>
                <span class="download-menu-name">${k.name || k.ending}</span>
                <span class="download-menu-hint">${hint(k.kind)}</span>
            </button>`,
        )}
    </div>`;
    return typeof document !== 'undefined' ? createPortal(menu, document.body) : menu;
};

/// The download itself, and how far the node has got making it: `base` is the node's download door
/// for this notebook or book (`…/download`), `query` anything it asks after the kind (a notebook's
/// order), `stem` the file's name should the node not give one.
const useDownload = (base, query, stem) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // A large one is made in the background (epub.rs): how far it has got, while it is.
    const [made, setMade] = useState(null);
    const go = async ({ kind, ending }) => {
        setBusy(true);
        setError(null);
        setMade(null);
        try {
            await downloadFile(`${base}/${kind}${query}`, `${stem}.${ending}`, setMade);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
            setMade(null);
        }
    };
    return { busy, error, made, go };
};

export const DownloadButton = ({ base, query = '', stem, className = 'tree-tool jag-line' }) => {
    const [open, setOpen] = useState(false);
    const anchor = useRef(null);
    const { busy, error, made, go } = useDownload(base, query, stem);
    return html`<span class="download-anchor" ref=${anchor}>
            <button
                class=${className}
                type="button"
                disabled=${busy}
                aria-haspopup="menu"
                aria-expanded=${open}
                title=${t('doc.download.title', 'download it as a book, or as files')}
                onClick=${() => setOpen((o) => !o)}
            >
                <${Icons.download} /> ${busy ? t('doc.download.making-it', 'making it…') : t('doc.download.download', 'download')}
            </button>
            ${
                open &&
                html`<${Menu}
                    anchor=${anchor}
                    onClose=${() => setOpen(false)}
                    onPick=${(k) => {
                        setOpen(false);
                        go(k);
                    }}
                />`
            }
        </span>
        ${
            busy &&
            made &&
            html`<div class="epub-error"><${Progress}
                done=${made.done}
                total=${made.total}
                doing=${t('doc.download.making-it', 'making it…')}
            /></div>`
        }
        ${error && html`<p class="form-error epub-error">${error}</p>`}`;
};

/// A book's card in the feed (Curtis, 2026-10-09): the same downloads behind an icon chip. A chip
/// has no room for words, so a refusal is its tooltip. It keeps a narrow window's chip menu open
/// (doc/chips.js `chip-keeps-menu`), or its own list would close with it.
export const DownloadChip = ({ base, stem = 'book' }) => {
    const [open, setOpen] = useState(false);
    const anchor = useRef(null);
    const { busy, error, made, go } = useDownload(base, '', stem);
    return html`<span class="download-anchor" ref=${anchor}>
        <${Chip}
            icon=${Icons.download}
            modifier="chip-keeps-menu"
            disabled=${busy}
            on=${open}
            title=${error || t('doc.download.title', 'download it as a book, or as files')}
            word=${
                busy && made && made.total
                    ? t('doc.download.percent', '{percent}%', {
                          percent: Math.floor((100 * (made.done || 0)) / made.total),
                      })
                    : busy
                      ? t('doc.download.making-it', 'making it…')
                      : t('doc.download.download', 'download')
            }
            onClick=${() => setOpen((o) => !o)}
        />
        ${
            open &&
            html`<${Menu}
                anchor=${anchor}
                onClose=${() => setOpen(false)}
                onPick=${(k) => {
                    setOpen(false);
                    go(k);
                }}
            />`
        }
    </span>`;
};
