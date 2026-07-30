// Reading ONE document, for the surfaces that only display it: cache-first, remembered, and
// patient about bodies that haven't arrived yet. The read-only sibling of doc/session.js, which
// keeps its own loader deliberately - that one also sets the save machine's parents and its
// divergence fingerprint, and the code carries a data-loss scar it is worth keeping faithful.
//
// The patience is why this is shared rather than written twice. A document's headers travel ahead
// of its blobs, so a resolution can arrive with `body: null`, and the only honest answer is to
// keep asking. Notes' reader did that; the journal's sealed-entry reader did not - so a sealed
// entry whose blobs were still in flight read "(not on this computer yet)" and stayed that way
// until you navigated away and back. Two copies of a loader, one of them missing a clause.
import { useState, useEffect } from 'preact/hooks';

import { api } from '../net.js';
import { cachedDoc, rememberDoc } from '../mirror/doccache.js';

// How long to wait before asking the node again for a body that hasn't landed. Cheap: one GET per
// waiting document, and only while a reader is actually open on it.
const BODY_RETRY_MS = 2000;

/**
 * One document's resolved detail, as `{ doc, error }` - both null until something arrives, and
 * `doc` stays null for a null `docId` (nothing selected). A cache hit paints with no fetch and no
 * flash; a miss fetches, remembers, and - if the body is still travelling - keeps asking.
 */
export function useDocDetail(root, docId) {
    const [doc, setDoc] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        setDoc(null);
        setError(null);
        if (!docId) return;
        let alive = true;
        let timer = null;
        const fetchDoc = () =>
            api(`/api/identity/${root}/docs/${docId}`)
                .then((d) => {
                    if (!alive) return;
                    rememberDoc(root, docId, d); // a null body is never remembered
                    setDoc(d);
                    if (d.body == null) timer = setTimeout(fetchDoc, BODY_RETRY_MS);
                })
                .catch((e) => alive && setError(e.message));
        // Cache-first (mirror/doccache.js): a copy the mirror row still vouches for is as
        // trustworthy as a fetch under that row, so it paints straight from disk. A remembered
        // copy always has a body, so only the fetch path can land in the waiting room.
        cachedDoc(root, docId).then((hit) => {
            if (!alive) return;
            if (hit) setDoc(hit);
            else fetchDoc();
        });
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, [root, docId]);
    return { doc, error };
}
