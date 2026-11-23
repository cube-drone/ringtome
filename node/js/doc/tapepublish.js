// A mixtape's publish row (plans/MIXTAPES.md): the bar Writer and Drawing wear (doc/publishbar.js),
// over an open mixtape of your own. A mixtape is a taxonomy and publishes as a note the node makes
// of it (amp.rs `tape_draft_handler`), so the row's whole job is that note: it asks for it the
// first time ("publish…"), brings it up to the mixtape as it stands before every publish
// (`prepare`), and hands it to the bar - which then knows where it goes, when, and how to take it
// down, as it does for any note.
//
// "update" is offered when the mixtape has moved since it was published: the row brings the note
// up to the mixtape whenever its songs or its name change, and the node stamped the note with the
// version it published (`published_head`, as a drawing's publish does). Then it says how many
// tracks are out beside how many the mixtape holds now.
//
// Thirty tracks is the most a mixtape publishes (ruling 3: "all the songs that will fit on a real
// cassette tape"): past it the row is greyed and says so, and with none it says that.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api, apiText } from '../net.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { openMirror, useLive } from '../mirror.js';
import { PublishBar } from './publishbar.js';
import { useUnlocked } from '../unlocks.js';

const html = htm.bind(h);

/// The most tracks a published mixtape holds (amp.rs `TAPE_MAX`).
export const TAPE_MAX = 30;

/// Where the node keeps each mixtape's draft, by its taxonomy (amp.rs `TAPE_DRAFTS_KV`).
const DRAFTS = 'mixtape_drafts';

export const TapePublish = ({ root, tape, onDraft = () => {} }) => {
    const [draft, setDraft] = useState(undefined); // the note's id, null for none yet
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const social = useUnlocked(root, 'social');
    useEffect(() => {
        let live = true;
        setDraft(undefined);
        setError(null);
        api(`/api/identity/${root}/private/kv/${DRAFTS}`)
            .then((r) => {
                const kept = (r.values || []).find((v) => v.key === tape.id);
                if (live) setDraft((kept && kept.value) || null);
            })
            .catch(() => live && setDraft(null));
        return () => {
            live = false;
        };
    }, [root, tape.id]);
    const row = useLive(() => (draft ? openMirror(root).docs.get(draft) : null), [root, draft]);
    // The note, as the mixtape stands now: made the first time, brought up to date after.
    const bring = () => api(`/api/identity/${root}/amp/tapes/${tape.id}/draft`, { method: 'PUT' });
    const begin = async () => {
        setBusy(true);
        setError(null);
        try {
            const made = (await bring()).doc_id;
            setDraft(made);
            onDraft(made);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };

    const tracks = tape.members.length;
    // The draft follows the mixtape: a song added, taken off or moved, or a new name, and the note
    // is brought up to it - which moves it past the version that was published. (A mixtape with
    // none, or more than thirty, is refused; the row says so itself.)
    const standing = `${tape.name}\n${tape.members.join(',')}`;
    useEffect(() => {
        if (!draft || tracks === 0 || tracks > TAPE_MAX) return;
        bring().catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft, standing]);
    const fields = (row && row.fields) || {};
    const post = fields.published_as || '';
    // A mixtape published before the stamp was kept is always offered its update.
    const differs = !post || !fields.published_head || row.head !== fields.published_head;
    // How many tracks are out, read from the post's own words when it differs.
    const [out, setOut] = useState(null);
    useEffect(() => {
        setOut(null);
        if (!post || !differs) return undefined;
        let live = true;
        apiText(`/id/${root}/docs/${post}/body`)
            .then((words) => live && setOut((JSON.parse(words).tracks || []).length))
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [root, post, differs, fields.published_head]);
    const said = (words) => html`<div class="publish-bar publish-bar-private tape-publish-off">
        <span class="publish-bar-standing"><${Icons.docPrivate} /> ${words}</span>
    </div>`;
    if (tracks > TAPE_MAX)
        return said(
            t('amp.mixtape-too-large', 'this playlist is too large to publish (>{max} tracks)', {
                max: TAPE_MAX,
            }),
        );
    if (draft === undefined) return null;
    if (draft && row)
        return html`<${PublishBar}
                root=${root}
                docId=${draft}
                row=${row}
                prepare=${async () => {
                    await bring();
                    return { words: true };
                }}
                differs=${differs}
                onPublished=${() => {}}
                groupable=${false}
            />
            ${
                post &&
                out !== null &&
                html`<p class="tape-publish-moved">${t('amp.mixtape-moved', 'published with {out} tracks - the mixtape holds {now} now. "update" publishes it as it stands.', { out, now: tracks })}</p>`
            }`;
    // Nothing published and nothing to publish with: no row, as the bar itself has none.
    if (!social) return null;
    if (tracks === 0)
        return said(t('amp.mixtape-empty-publish', 'put a song on this mixtape to publish it'));
    return html`<div class="publish-bar publish-bar-private">
        <span class="publish-bar-standing"><${Icons.docPrivate} /> ${t('amp.mixtape-private', 'private')}</span>
        <span class="publish-bar-acts">
            <button class="publish-bar-publish jag-line" disabled=${busy} onClick=${begin}>
                <${Icons.docPublic} /> ${busy ? '…' : t('amp.mixtape-publish', 'publish…')}
            </button>
        </span>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};
