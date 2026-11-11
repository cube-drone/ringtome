// The `recents` table's owner (plans/RECENTS.md), as prefs.js owns `prefs`: what this browser last
// used, per persona - the newest few things saved, said or published (`thing:<what>`), which head
// the dock and the launcher. Local-only, never synced: a gesture of this browser, forgotten with
// the mirror at logout. Which three is pure/recents.js's. (A row per app opened, `app:<id>`, was
// kept until 2026-11-11, when the apps went back to a fixed order; old ones are left where they
// lie and read by nothing.)
//
// Fire-and-forget like every pref: a recent that fails to write costs a tile, never data.
import { useMemo } from 'preact/hooks';

import { openMirror, useLive } from '../mirror.js';
import { RECENT_KEPT, thingTitle } from '../pure/recents.js';
import { homeAppFor } from '../pure/apps.js';
import { docHref, appHref } from '../links.js';

/// A thing's key: one row per thing, the newest touch moving it to the front.
export const docThing = (docId) => `thing:doc:${docId}`;
export const roomThing = (author, doc) => `thing:room:${author}:${doc}`;
export const postThing = (author, doc) => `thing:post:${author}:${doc}`;
/// An hrseAmp playlist: a saved filter, a mixtape or a radio station, by its kind and id.
export const playlistThing = (kind, id) => `thing:playlist:${kind}:${id}`;

/// This thing was touched, now: `{ key, app, href, title, drawing?, person? }` - `drawing` the
/// drawing's doc id, for its kept thumbnail; `person` the other person of an IM, for their face.
/// Past RECENT_KEPT the oldest things go.
export function noteThing(root, thing) {
    if (!root || !thing || !thing.key || !thing.href) return;
    const at = Date.now();
    const table = openMirror(root).recents;
    table
        .put({ ...thing, at })
        .then(() => table.where('key').startsWith('thing:').toArray())
        .then((rows) => {
            const old = rows
                .sort((a, b) => b.at - a.at)
                .slice(RECENT_KEPT)
                .map((r) => r.key);
            return old.length ? table.bulkDelete(old) : null;
        })
        .catch(() => {});
}

/// A document of this persona's was saved: the thing is the document, in its home app (the app of
/// its first notebook, by the mirror's row and roster - doc/session.js has neither).
export function noteDoc(root, docId, title, body) {
    if (!root || !docId) return;
    const db = openMirror(root);
    Promise.all([db.docs.get(docId), db.buckets.toArray()])
        .then(([row, roster]) => {
            // Not streamed here yet: the next save will find it.
            const app = row && homeAppFor(row, roster);
            if (!app) return;
            noteThing(root, {
                key: docThing(docId),
                app: app.id,
                // A feed draft opens the feed itself, its composer open (apps/feed.js `compose`).
                href: app.id === 'feed' ? `${appHref('feed')}?compose=1` : docHref(root, docId),
                // A drawing's body is its strokes, not words.
                title: thingTitle(title, app.id === 'drawing' ? '' : body),
                ...(app.id === 'drawing' ? { drawing: docId } : {}),
            });
        })
        .catch(() => {});
}

/// A thing that is gone (a document deleted) leaves the recents.
export function forgetThing(root, key) {
    if (!root || !key) return;
    openMirror(root)
        .recents.delete(key)
        .catch(() => {});
}

/// The recents, live: `{ things }` - every kept thing, unordered. Empty (never undefined) before
/// the first read.
export function useRecents(root) {
    const rows = useLive(() => (root ? openMirror(root).recents.toArray() : []), [root]);
    return useMemo(
        () => ({ things: (rows || []).filter((r) => r.key.startsWith('thing:')) }),
        [rows],
    );
}
