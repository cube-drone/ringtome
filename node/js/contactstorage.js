// The relationship panel's storage section (person.js; Curtis, 2026-11-20): what a person you
// follow takes on this computer or server - the same figure and pie as their row on the Storage
// page (storagepage.js) - and three switches to stop syncing their images, audio or video, each
// with a button beside it, once on, to delete the ones already here. Both are keys in your
// private record of them (pure/contact.js, `SYNC_SKIPS`), which the node reads when it decides
// which of their files to fetch and which to keep. A quarantined file is never deleted this way:
// the node's reaper keeps those whatever anyone asks (node/src/reaper.rs).
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { sizeLabel } from './pure/backups.js';
import { SYNC_SKIPS } from './pure/contact.js';
import { personParts } from './pure/storageshare.js';
import { Breakdown, FILE_WORDS } from './storagepage.js';

const html = htm.bind(h);

/// Each switch, the button beside it once it is on, and what stands there once pressed - the
/// first two in Curtis's words.
const SKIP_WORDS = () => ({
    pictures: {
        skip: t('contact-storage.skip-pictures', 'do not sync images from this user'),
        purge: t('contact-storage.purge-pictures', 'Delete existing images'),
        deleted: t('contact-storage.purged-pictures', 'existing images will be deleted soon'),
    },
    audio: {
        skip: t('contact-storage.skip-audio', 'do not sync audio from this user'),
        purge: t('contact-storage.purge-audio', 'Delete existing audio'),
        deleted: t('contact-storage.purged-audio', 'existing audio will be deleted soon'),
    },
    video: {
        skip: t('contact-storage.skip-video', 'do not sync video from this user'),
        purge: t('contact-storage.purge-video', 'Delete existing video'),
        deleted: t('contact-storage.purged-video', 'existing video will be deleted soon'),
    },
});

export const ContactStorage = ({ myRoot, theirRoot, facts, put }) => {
    // undefined while asking; null when nothing of theirs is kept here (or the asking failed).
    const [theirs, setTheirs] = useState(undefined);
    useEffect(() => {
        let live = true;
        setTheirs(undefined);
        api(`/api/identity/${myRoot}/storage/overview`)
            .then(
                (a) =>
                    live &&
                    setTheirs((a.following || []).find((p) => p.root === theirRoot) || null),
            )
            .catch(() => live && setTheirs(null));
        return () => {
            live = false;
        };
    }, [myRoot, theirRoot]);
    const words = SKIP_WORDS();
    return html`
        <div class="ledger-storage">
            <div class="ledger-storage-head">
                <span class="ledger-storage-title">${t('contact-storage.title', 'storage')}</span>
                ${theirs && html`<span class="storage-row-size">${sizeLabel(theirs.bytes)}</span>`}
            </div>
            ${
                theirs === null &&
                html`<p class="ledger-note">${t('contact-storage.nothing-here', 'nothing of theirs is kept here yet')}</p>`
            }
            ${
                theirs &&
                (theirs.counted
                    ? html`<${Breakdown} parts=${personParts(theirs)} words=${FILE_WORDS()} label=${t('contact-storage.title', 'storage')} />`
                    : html`<p class="ledger-note">${t('storage.still-counting', 'still counting their files')}</p>`)
            }
            ${SYNC_SKIPS.map(({ kind, key, purge }) => {
                const declined = facts[key] === 'yes';
                const purged = declined && facts[purge] === 'yes';
                return html`
                    <div key=${key} class="ledger-skip">
                        <label class="ledger-check">
                            <input
                                type="checkbox"
                                checked=${declined}
                                onChange=${(e) => {
                                    const on = e.currentTarget.checked;
                                    put(key, on ? 'yes' : 'no');
                                    // Taking a decline back takes the deleting back with it.
                                    if (!on && facts[purge] === 'yes') put(purge, 'no');
                                }}
                            />
                            ${words[kind].skip}
                        </label>
                        ${
                            declined &&
                            (purged
                                ? html`<small class="ledger-note">${words[kind].deleted}</small>`
                                : html`<button class="ledger-purge" onClick=${() => put(purge, 'yes')}>
                                      ${words[kind].purge}
                                  </button>`)
                        }
                    </div>
                `;
            })}
        </div>
    `;
};
