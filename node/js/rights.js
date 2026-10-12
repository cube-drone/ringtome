// The sign (plans/AUDIO.md, section 8, ruling 16): before a person publishes something carrying a
// song that names its artist or album, the app asks whether they have the right to - every time, in
// the house modal. A sign, not a fence: the node doesn't check it, so agents and the API aren't
// asked, and nothing is recorded (ruling 18). The node does say which tagged songs a draft carries
// (rights.rs), and whether this server publishes them at all (the fence, ruling 17) - so a refusal
// is said up front rather than after a "yes".
import { h } from 'preact';
import htm from 'htm';

import { api } from './net.js';
import { askYes } from './modal.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// Where a published song is served from, in words: this server's name, or "this computer" for the
/// desktop app's own node.
function servedFrom() {
    const host = typeof location !== 'undefined' ? location.hostname : '';
    return !host || host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
        ? t('rights.this-computer', 'this computer')
        : host;
}

const songWords = (s) =>
    [s.title, s.artist, s.album].filter(Boolean).join(' - ') || t('rights.a-song', 'a song');

/// Ask before publishing `ask` (`{ docs: [id…] }`, or `{ bucket }` for a book's pages): null to go
/// on, or why not, in words for the caller to show where it shows its errors - the person said no,
/// or this server doesn't publish tagged songs. Nothing tagged, or no answer from the node, goes on
/// without a word: a sign must never stand between a person and their own post because a question
/// went unanswered.
export async function rightsCheck(root, ask) {
    let answer;
    try {
        answer = await api(`/api/identity/${root}/tagged-songs`, {
            method: 'POST',
            body: JSON.stringify(ask),
        });
    } catch {
        return null;
    }
    const songs = (answer && answer.songs) || [];
    if (!songs.length) return null;
    if (answer.allowed === false) {
        return t(
            'rights.not-from-this-server',
            "this server doesn't publish songs that name their artist or album - its operator's choice",
        );
    }
    const node = servedFrom();
    const yes = await askYes({
        title: t('rights.title', 'publishing a song'),
        body: html`<p>
                ${t(
                    'rights.warning',
                    "You're publishing a song that names its artist or album. You may not have the right to publish it. Nothing here hides where it comes from: it will be served from {node} and from the computers of the people who follow you.",
                    { node },
                )}
            </p>
            <ul class="rights-songs">
                ${songs.slice(0, 5).map((s, i) => html`<li key=${i}>${songWords(s)}</li>`)}
                ${songs.length > 5 && html`<li>${t('rights.and-n-more', 'and {n} more', { n: songs.length - 5 })}</li>`}
            </ul>
            <p><strong>${t('rights.question', 'Do you have the right to publish this file?')}</strong></p>`,
        yes: t('rights.yes', 'Yes, publish it'),
        no: t('rights.no', "No, don't publish this"),
    });
    return yes ? null : t('rights.not-published', 'not published - you chose not to');
}

/// The fence, carrying (plans/AUDIO.md, slice 10): a song in a post that this server won't carry
/// fails to load, and the post says why rather than showing a dead player. One listener for the
/// whole page, since posts' embeds are drawn as markup: an `<audio>` that fails asks its door once,
/// and the operator's refusal is said under it.
export function watchUncarried() {
    if (typeof document === 'undefined') return;
    document.addEventListener(
        'error',
        (e) => {
            const el = e.target;
            if (!el || el.tagName !== 'AUDIO' || el.dataset.asked) return;
            el.dataset.asked = '1';
            const src = el.currentSrc || el.getAttribute('src');
            if (!src) return;
            // One byte's worth of asking: a door that serves it was never the problem.
            api(src, { headers: { Range: 'bytes=0-0' } }).catch((err) => {
                if (err.status !== 404 || err.key !== 'rights.not-carried-here') return;
                const note = document.createElement('p');
                note.className = 'rights-uncarried';
                note.textContent = t(
                    'rights.not-carried',
                    "this song isn't carried on this server - its operator's choice",
                );
                el.after(note);
            });
        },
        true,
    );
}
