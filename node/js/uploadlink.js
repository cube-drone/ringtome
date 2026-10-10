// An upload link's page (uploadlink.rs, plans/MCP.md _Pictures_, 2026-10-10): an AI assistant in a
// chat window asked for an address to send a picture to, and gave it to the person, who opens it
// here and chooses the file. No sign-in: the address is the permission, and it works once. The
// file goes up as the request's body, as an agent's `curl --data-binary` sends it.
//
// Drawn by index.js's `App` for `/upload/<token>`, signed in or not.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { api } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

export const UploadLink = ({ token }) => {
    const [about, setAbout] = useState(null);
    const [error, setError] = useState(null);
    const [file, setFile] = useState(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(null);

    useEffect(() => {
        api(`/api/upload/${token}`)
            .then(setAbout)
            .catch((e) => setError(e.message));
    }, [token]);

    const send = async () => {
        if (!file) return;
        if (about && file.size > about.max_bytes) {
            setError(
                t('uploadlink.too-large', 'That file is larger than this place takes ({mb} MB).', {
                    mb: Math.floor(about.max_bytes / (1024 * 1024)),
                }),
            );
            return;
        }
        setBusy(true);
        setError(null);
        try {
            setDone(
                await api(`/api/upload/${token}`, {
                    method: 'POST',
                    body: file,
                    headers: { 'Content-Type': file.type || 'application/octet-stream' },
                }),
            );
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const head = html`<h2><${Icons.upload} /> ${t('uploadlink.title', 'Send a file to your assistant')}</h2>`;
    if (done) {
        const words =
            done.status === 'failed'
                ? t(
                      'uploadlink.failed',
                      "It arrived, but couldn't be made into a picture, video or sound: {why}",
                      {
                          why: done.error || '',
                      },
                  )
                : done.status === 'pending'
                  ? t(
                        'uploadlink.pending',
                        "It's uploaded, and still being made - tell your assistant, and it can use it in a minute.",
                    )
                  : t(
                        'uploadlink.ready',
                        "It's uploaded. Tell your assistant it's there - it can use it now.",
                    );
        return html`<div class="console upload-link">${head}<p>${words}</p></div>`;
    }
    if (!about) {
        return html`<div class="console upload-link">
            ${head}
            ${
                error
                    ? html`<p class="form-error">${error}</p>`
                    : html`<p class="null-sub">${t('uploadlink.looking', 'looking…')}</p>`
            }
        </div>`;
    }
    return html`<div class="console upload-link">
        ${head}
        <p>
            ${t(
                'uploadlink.what',
                'Your assistant asked for "{title}": choose a picture, video or sound to send it. This link works once.',
                { title: about.title },
            )}
        </p>
        <input type="file" accept="image/*,video/*,audio/*" onChange=${(e) => setFile(e.currentTarget.files[0] || null)} />
        ${error && html`<p class="form-error">${error}</p>`}
        <div class="oauth-consent-answers">
            <button class="upload-link-go" type="button" disabled=${busy || !file} onClick=${send}>
                ${busy ? t('uploadlink.sending', 'sending…') : t('uploadlink.send', 'send')}
            </button>
        </div>
    </div>`;
};
