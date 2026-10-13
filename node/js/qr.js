// QR codes (plans/QR.md): a person or a post, from one phone to another. A node with a public URL
// says the web address; one without says the app's own `ringtome://` address, which only Horse
// Drawing Tycoon 2 opens (ruling 1). Drawn here as one SVG path, dark on a light plate whatever the
// colourway: scanners want dark on light.
import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import htm from 'htm';
import qrcode from 'qrcode-generator';

import { Modal } from './modal.js';
import { Chip } from './doc/chips.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';
import { nodeKey, publicUrl, writeClipboard } from './links.js';
import { appAddress, intentLink, qrAddress } from './pure/portable.js';

const html = htm.bind(h);

/// The quiet zone round the code, in modules: the standard's four.
const QUIET = 4;

/// `text` as a QR code: error correction M, the smallest version it fits.
export const QrCode = ({ text, className = 'qr-code' }) => {
    const drawn = useMemo(() => {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const n = qr.getModuleCount();
        let d = '';
        for (let r = 0; r < n; r++)
            for (let c = 0; c < n; c++)
                if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
        return { side: n + 2 * QUIET, d };
    }, [text]);
    return html`<svg
        class=${className}
        viewBox=${`0 0 ${drawn.side} ${drawn.side}`}
        role="img"
        aria-label=${t('qr.a-qr-code', 'a QR code')}
        shape-rendering="crispEdges"
    >
        <rect class="qr-plate" width=${drawn.side} height=${drawn.side} />
        <path class="qr-modules" d=${drawn.d} />
    </svg>`;
};

/// What a QR code for this says: `webPath` under the public URL where there is one and `web` allows
/// it, else the app's address for `appPath`. Null while it's asked.
export function useQrAddress(webPath, appPath, web = true) {
    const [said, setSaid] = useState(null);
    useEffect(() => {
        let live = true;
        Promise.all([web ? publicUrl() : '', nodeKey()]).then(([base, via]) => {
            if (live) setSaid(qrAddress({ publicUrl: base, webPath, appPath, via }));
        });
        return () => {
            live = false;
        };
    }, [webPath, appPath, web]);
    return said;
}

/// The code big, in the house modal, with the address under it in words and a copy of it.
const QrModal = ({ title, text, onClose }) => {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await writeClipboard(text);
        } catch {
            return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
    };
    const appOnly = text.startsWith('ringtome:');
    return html`<${Modal} title=${title} onClose=${onClose}>
        <div class="qr-panel">
            <${QrCode} text=${text} className="qr-code qr-code-big" />
            <p class="qr-said"><code>${text}</code></p>
            <p class="qr-note">
                ${
                    appOnly
                        ? t(
                              'qr.app-only',
                              'This server has no public web address, so only the Horse Drawing Tycoon 2 app opens this code.',
                          )
                        : t(
                              'qr.on-the-web',
                              'Any phone opens this code. On Android, the page offers to open it in the Horse Drawing Tycoon 2 app.',
                          )
                }
            </p>
            <div class="modal-ask-buttons">
                <button type="button" class="copy-bucket" onClick=${copy}>
                    ${copied ? t('qr.copied', 'copied!') : t('qr.copy-the-address', 'copy the address')}
                </button>
            </div>
        </div>
    <//>`;
};

/// A post's QR chip (plans/QR.md): Phosphor's QR glyph beside "link".
export const QrChip = ({ webPath, appPath }) => {
    const [open, setOpen] = useState(false);
    const text = useQrAddress(webPath, appPath);
    return html`<${Chip}
            icon=${Icons.qrCode}
            on=${open}
            modifier="chip-keeps-menu"
            title=${t('qr.show-a-qr-code', 'show a QR code for this, to open on another phone')}
            word=${t('chips.qr', 'QR')}
            disabled=${!text}
            onClick=${() => setOpen(true)}
        />
        ${open && text && html`<${QrModal} title=${t('qr.this-post', 'this post')} text=${text} onClose=${() => setOpen(false)} />`}`;
};

/// A person's code, small, on their page's banner: pressed, it opens big.
export const QrBadge = ({ webPath, appPath, web, name }) => {
    const [open, setOpen] = useState(false);
    const text = useQrAddress(webPath, appPath, web);
    if (!text) return null;
    return html`<button
            type="button"
            class="qr-badge"
            title=${t('qr.persons-code', "{name}'s QR code - press to make it bigger", { name })}
            onClick=${() => setOpen(true)}
        >
            <${QrCode} text=${text} />
        </button>
        ${open && html`<${QrModal} title=${name} text=${text} onClose=${() => setOpen(false)} />`}`;
};

/// The Android app's package - its bundle identifier, which never changes (_Two names_).
const ANDROID_PACKAGE = 'net.lassam.ringtome';

/// A phone's browser on Android, not the app's own web view (which sets `__ringtomeInsets`).
const onAndroidWeb = () =>
    typeof navigator !== 'undefined' &&
    /Android/i.test(navigator.userAgent || '') &&
    typeof window !== 'undefined' &&
    !window.__ringtomeInsets;

/// "Open in Horse Drawing Tycoon 2" (plans/QR.md, ruling 2): on an Android phone's browser, a link
/// Chrome hands to the app when it's installed - the app's address for `appPath`, with this node's
/// key, so the app knows whom to ask - and otherwise leaves the page where it is.
export const OpenInApp = ({ appPath }) => {
    const [href, setHref] = useState(null);
    useEffect(() => {
        if (!appPath || !onAndroidWeb()) return undefined;
        let live = true;
        nodeKey().then((via) => {
            if (live)
                setHref(
                    intentLink(appAddress(appPath, via), ANDROID_PACKAGE, window.location.href),
                );
        });
        return () => {
            live = false;
        };
    }, [appPath]);
    if (!href) return null;
    return html`<a class="open-in-app jag-line" href=${href}>
        <${Icons.androidLogo} />
        <span>${t('qr.open-in-the-app', 'open in Horse Drawing Tycoon 2')}</span>
    </a>`;
};
