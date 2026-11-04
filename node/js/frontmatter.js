// Front matter (node/src/frontmatter.rs, Curtis, 2026-11-01): the terms of service, the privacy
// policy and the license a person agrees to when they make an account, at `/tos`, `/privacy` and
// `/eula` on the node. Three pieces live here:
//
// - The sign-up form's "I agree" line and its three links - a new tab in a browser; in the
//   installed apps, a modal framing the page, since an app has one window and a page opened in it
//   would leave the half-filled form behind with no way back.
// - hrseServer's _Front Matter_ page: what this server adds to each document, with advice on what
//   an operator might put there. Its "write it" opens the addition as a private note in hrseWriter -
//   in a notebook of its own, `front-matter`, the note marked by its `front_matter` field.
// - That note's bar in hrseWriter, in place of the publish bar: publishing it adds it to this
//   server's page, after the application's words and every server's default, never in place of
//   them - and the page lists the change, dated, as a diff.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api, isDevice } from './net.js';
import { holdNewDoc, openMirror } from './mirror.js';
import { docHref } from './links.js';
import { Modal } from './modal.js';
import { toast } from './toasts.js';
import { formatWhen } from './pure/when.js';
import { t, tNodes } from './i18n.js';

/// The notebook an operator's additions are written in, and the field that marks each note.
export const FRONT_MATTER_BUCKET = 'front-matter';
export const FRONT_MATTER_FIELD = 'front_matter';

const html = htm.bind(h);

/// The three documents, by address.
export const FRONT_MATTER = () => [
    ['/tos', t('frontmatter.terms-of-service', 'Terms of Service')],
    ['/privacy', t('frontmatter.privacy-policy', 'Privacy Policy')],
    ['/eula', t('frontmatter.license', 'License')],
];

/// One document's link: a new tab, or the modal in an app.
const DocLink = ({ href, label, onOpen }) => html`<a
    href=${href}
    target="_blank"
    rel="noopener"
    onClick=${(e) => {
        if (!isDevice()) return;
        e.preventDefault();
        onOpen({ href, label });
    }}
>${label}</a>`;

/// "I agree to the Terms of Service, the Privacy Policy and the License" - a required checkbox.
export const AgreeToTerms = ({ agreed, onAgreed }) => {
    const [showing, setShowing] = useState(null); // { href, label }
    const [tos, privacy, eula] = FRONT_MATTER().map(
        ([href, label]) => html`<${DocLink} href=${href} label=${label} onOpen=${setShowing} />`,
    );
    return html`
        <label class="frontmatter-agree">
            <input
                type="checkbox"
                checked=${agreed}
                onChange=${(e) => onAgreed(e.currentTarget.checked)}
                required
            />
            <span>${tNodes('frontmatter.i-agree', 'I agree to the {tos}, the {privacy} and the {eula}.', { tos, privacy, eula })}</span>
        </label>
        ${
            showing &&
            html`<${Modal} title=${showing.label} wide=${true} onClose=${() => setShowing(null)}>
            <iframe class="frontmatter-frame" src=${showing.href} title=${showing.label}></iframe>
        </${Modal}>`
        }
    `;
};

// ---------------------------------------------------------------------------------------------
// hrseServer's Front Matter.

/// Each addition: its address on the node, its name, the note's title, and advice on what goes in it.
const KINDS = () => ({
    tos: {
        href: '/tos',
        name: t('frontmatter.terms-of-service', 'Terms of Service'),
        title: t('frontmatter.tos-note-title', "Terms of Service: this server's additions"),
        advice: [
            t(
                'frontmatter.advice-house-rules',
                "your house rules, beyond the application's: what this server is for, and what doesn't belong here",
            ),
            t('frontmatter.advice-age', 'a minimum age, if it is higher than 13'),
            t(
                'frontmatter.advice-reports',
                'how you handle reports, and when you remove an account',
            ),
        ],
    },
    privacy: {
        href: '/privacy',
        name: t('frontmatter.privacy-policy', 'Privacy Policy'),
        title: t('frontmatter.privacy-note-title', "Privacy Policy: this server's additions"),
        advice: [
            t(
                'frontmatter.advice-logs',
                'whether you keep logs, how long, and whether they hold the addresses people connect from',
            ),
            t(
                'frontmatter.advice-in-front',
                'what sits in front of this server - a content delivery network or a proxy - by name',
            ),
            t('frontmatter.advice-where', 'where the server is, and who hosts it'),
            t('frontmatter.advice-backups', 'your backups: where they are kept, and for how long'),
        ],
    },
});

/// Open the operator's note for one addition in hrseWriter: found in this browser's mirror by its
/// field, or made now - in the `front-matter` notebook, holding what is published today.
async function openAddition(root, kind, published, route) {
    const mine = await openMirror(root)
        .docs.filter((d) => !!d.fields && d.fields[FRONT_MATTER_FIELD] === kind)
        .first();
    if (mine) return route(docHref(root, mine.doc_id, { bucket: FRONT_MATTER_BUCKET }));
    // The notebook first: defining it twice is a refusal we don't need to hear.
    await api(`/api/identity/${root}/buckets`, {
        method: 'POST',
        body: JSON.stringify({ name: FRONT_MATTER_BUCKET, app: 'default' }),
    }).catch(() => {});
    const title = KINDS()[kind].title;
    // Nothing published yet: one comment line saying what the blank is for. A `%%` line is a
    // Marquee comment - never shown, and dropped on publishing (frontmatter.rs `uncommented`).
    const hint = `%% ${t('frontmatter.additions-hint', 'Your additions go here. The application’s terms and the server default already show above them on {href}.', { href: KINDS()[kind].href })}\n\n`;
    const made = await api(`/api/identity/${root}/docs`, {
        method: 'POST',
        body: JSON.stringify({ title, body: published || hint, format: 'marquee' }),
    });
    await holdNewDoc(root, made, { title, format: 'marquee', bucket: FRONT_MATTER_BUCKET });
    await api(
        `/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(FRONT_MATTER_BUCKET)}`,
        { method: 'PUT' },
    );
    await api(
        `/api/identity/${root}/docs/${made.doc_id}/annotations/fields/${FRONT_MATTER_FIELD}`,
        {
            method: 'PUT',
            body: JSON.stringify({ value: kind }),
        },
    );
    route(docHref(root, made.doc_id, { bucket: FRONT_MATTER_BUCKET }));
}

/// The page: what this server adds to each document, and the way to write it.
export const FrontMatterPage = ({ current }) => {
    const loc = useLocation();
    const [view, setView] = useState(null);
    const [error, setError] = useState(null);
    const [opening, setOpening] = useState(null);
    useEffect(() => {
        api('/api/admin/front-matter')
            .then(setView)
            .catch((e) => setError(e.message));
    }, []);
    const open = async (kind) => {
        if (!current) return;
        setOpening(kind);
        try {
            await openAddition(current.root, kind, view && view[kind].body, (to) => loc.route(to));
        } catch (e) {
            setError(e.message);
            setOpening(null);
        }
    };
    const kinds = KINDS();
    return html`<div class="device frontmatter-page">
        <h2>${t('frontmatter.front-matter', 'Front Matter')}</h2>
        <p class="null-sub">
            ${t('frontmatter.page-intro', "Customize your Terms of Service and Privacy Policy here. Every server shows the application's own, then the terms every server starts with; what you write here is added after them. It can add rules, but not remove any. Each version you publish is listed at the end of the page, dated.")}
        </p>
        ${error && html`<p class="form-error">${error}</p>`}
        ${view && html`<${OperatorFacts} view=${view} />`}
        ${['tos', 'privacy'].map((kind) => {
            const k = kinds[kind];
            const added = view && view[kind];
            return html`<section class="frontmatter-kind" key=${kind}>
                <h3>${k.name}</h3>
                <p class="field-note">
                    ${
                        !view
                            ? '…'
                            : added.at_ms
                              ? t(
                                    'frontmatter.last-published',
                                    'your additions, last published {when}',
                                    { when: formatWhen(added.at_ms) },
                                )
                              : t(
                                    'frontmatter.nothing-added',
                                    'nothing added yet: the page shows the defaults alone',
                                )
                    }
                </p>
                <p class="frontmatter-advice-head">${t('frontmatter.what-you-might-add', 'what you might add:')}</p>
                <ul class="frontmatter-advice">${k.advice.map((a) => html`<li>${a}</li>`)}</ul>
                <div class="frontmatter-actions">
                    <button class="removal-option" disabled=${!view || !!opening} onClick=${() => open(kind)}>
                        <span class="removal-option-title">${opening === kind ? '…' : t('frontmatter.write-it', 'write it in hrseWriter')}</span>
                    </button>
                    <a class="removal-option" href=${k.href} target="_blank" rel="noopener">
                        <span class="removal-option-title">${t('frontmatter.see-the-page', 'see the page')}</span>
                    </a>
                </div>
            </section>`;
        })}
    </div>`;
};

/// Who runs this server, as both pages say it: a way to reach the operator, and whose law it runs
/// under (Curtis, 2026-11-01: not a name or a home address - "operator@gooble.email" and "BC,
/// Canada" suffice).
const OperatorFacts = ({ view }) => {
    const [contact, setContact] = useState(view.contact || '');
    const [jurisdiction, setJurisdiction] = useState(view.jurisdiction || '');
    const [saved, setSaved] = useState({
        contact: view.contact || '',
        jurisdiction: view.jurisdiction || '',
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const changed = contact.trim() !== saved.contact || jurisdiction.trim() !== saved.jurisdiction;
    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await api('/api/admin/front-matter/facts', {
                method: 'PUT',
                body: JSON.stringify({ contact, jurisdiction }),
            });
            setSaved({ contact: contact.trim(), jurisdiction: jurisdiction.trim() });
            toast(t('frontmatter.facts-saved', 'saved - both pages say so now'));
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };
    return html`<form class="frontmatter-kind frontmatter-facts" onSubmit=${save}>
        <h3>${t('frontmatter.you-as-operator', 'You, as this server’s operator')}</h3>
        <p class="field-note">
            ${t('frontmatter.facts-note', 'Both pages show these under the server default. Neither needs your name or your home address.')}
        </p>
        <label>
            ${t('frontmatter.contact', 'how to reach you')}
            <input
                class="jag-field"
                type="text"
                maxlength="200"
                placeholder=${t('frontmatter.contact-placeholder', 'operator@example.com')}
                value=${contact}
                onInput=${(e) => setContact(e.currentTarget.value)}
            />
        </label>
        <label>
            ${t('frontmatter.jurisdiction', 'whose laws this server runs under')}
            <input
                class="jag-field"
                type="text"
                maxlength="200"
                placeholder=${t('frontmatter.jurisdiction-placeholder', 'BC, Canada')}
                value=${jurisdiction}
                onInput=${(e) => setJurisdiction(e.currentTarget.value)}
            />
        </label>
        ${error && html`<p class="form-error">${error}</p>`}
        <button class="removal-option" type="submit" disabled=${busy || !changed}>
            <span class="removal-option-title">${busy ? '…' : t('frontmatter.save', 'save')}</span>
        </button>
    </form>`;
};

// ---------------------------------------------------------------------------------------------
// hrseWriter's bar for an addition's note.

/// Which addition a document's row is the note for - 'tos', 'privacy' - or null.
export const frontMatterOf = (row) => {
    const kind = row && row.fields && row.fields[FRONT_MATTER_FIELD];
    return kind === 'tos' || kind === 'privacy' ? kind : null;
};

/// In place of the publish bar: publishing this note adds it to this server's page.
export const FrontMatterBar = ({ root, docId, kind, prepare }) => {
    const [busy, setBusy] = useState(false);
    const k = KINDS()[kind];
    const publish = async () => {
        setBusy(true);
        try {
            await prepare();
            const done = await api(`/api/admin/front-matter/${kind}`, {
                method: 'POST',
                body: JSON.stringify({ root, doc_id: docId }),
            });
            toast(
                done.changed
                    ? t('frontmatter.published-to', 'published to {href}', { href: k.href })
                    : t('frontmatter.already-published', 'already published - nothing changed'),
            );
        } catch (e) {
            toast(
                t('frontmatter.couldnt-publish', "couldn't publish it: {message}", {
                    message: e.message,
                }),
                {
                    kind: 'error',
                },
            );
        } finally {
            setBusy(false);
        }
    };
    return html`<div class="publish-bar frontmatter-bar jag-line">
        <span class="frontmatter-bar-what">
            ${tNodes('frontmatter.this-note-is', "This note is this server's additions to its {page}. Publishing adds it after the application's words, and lists the change, dated, at the end of the page.", { page: html`<a href=${k.href} target="_blank" rel="noopener">${k.name}</a>` })}
        </span>
        <button class="publish-bar-update jag-line" disabled=${busy} onClick=${publish}>
            ${busy ? '…' : t('frontmatter.publish-to-this-server', 'publish to this server')}
        </button>
    </div>`;
};
