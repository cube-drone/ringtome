// A search result's snippet (moved out of apps/notes.js 2026-10-22, when the tree learned to show
// one too): the first few body lines that contain the query, with the hits marked.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { cachedDoc, rememberDoc } from '../mirror/doccache.js';
import { queryWords } from '../search.js';

const html = htm.bind(h);

// --- search snippets: the first few body lines that contain the query, with hits highlighted.
// The mirror only holds a token bag (no line structure), so the body is fetched per result and
// cached - once per doc, not per keystroke, so matching stays local and instant.
const snippetBodyCache = new Map(); // doc_id -> body text (string)

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The first `max` non-blank body lines that contain any query word (case-insensitive substring).
function snippetLines(body, words, max = 3) {
    if (!body || !words.length) return [];
    const out = [];
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (line && words.some((w) => line.toLowerCase().includes(w))) {
            out.push(line);
            if (out.length >= max) break;
        }
    }
    return out;
}

// Split a line around the query words, wrapping each hit in <mark>.
function highlight(line, words) {
    if (!words.length) return line;
    const re = new RegExp('(' + words.map(escapeRegex).join('|') + ')', 'gi');
    return line
        .split(re)
        .map((part, i) =>
            i % 2 === 1 ? html`<mark class="snippet-hit" key=${i}>${part}</mark>` : part,
        );
}

// A row reads its note only once it is on (or near) the screen, from the remembered copy when the
// mirror still vouches for one, and a row that leaves before the read lands calls it off. Every
// result used to read at once: a search over a 1500-note persona sent 128 note reads in one
// breath, each queued on the persona's one database connection, and the whole persona - every
// page, every poll - waited ten seconds behind them (2026-10-02).
export const Snippet = ({ root, docId, query }) => {
    const [body, setBody] = useState(() =>
        snippetBodyCache.has(docId) ? snippetBodyCache.get(docId) : null,
    );
    const [seen, setSeen] = useState(false);
    const spot = useRef(null);
    useEffect(() => {
        if (seen || body != null) return undefined;
        const el = spot.current;
        if (!el || typeof IntersectionObserver === 'undefined') {
            setSeen(true);
            return undefined;
        }
        const watch = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setSeen(true);
                    watch.disconnect();
                }
            },
            { rootMargin: '200px' },
        );
        watch.observe(el);
        return () => watch.disconnect();
    }, [seen, body]);
    useEffect(() => {
        if (snippetBodyCache.has(docId)) {
            setBody(snippetBodyCache.get(docId));
            return undefined;
        }
        if (!seen) return undefined;
        let alive = true;
        const stop = new AbortController();
        const keep = (b) => {
            snippetBodyCache.set(docId, b);
            if (alive) setBody(b);
        };
        cachedDoc(root, docId)
            .then((hit) => {
                if (!alive) return undefined;
                if (hit) return keep(typeof hit.body === 'string' ? hit.body : '');
                return api(`/api/identity/${root}/docs/${docId}`, { signal: stop.signal }).then(
                    (d) => {
                        rememberDoc(root, docId, d);
                        keep(d && typeof d.body === 'string' ? d.body : '');
                    },
                );
            })
            .catch(() => alive && setBody(''));
        return () => {
            alive = false;
            stop.abort();
        };
    }, [root, docId, seen]);

    if (body == null) return html`<span ref=${spot} class="note-row-snippet-wait"></span>`; // not read yet
    const words = queryWords(query);
    const lines = snippetLines(body, words, 3);
    if (!lines.length) return null;
    return html`<small class="note-row-snippet">
        ${lines.map(
            (line, i) => html`<span class="snippet-line" key=${i}>${highlight(line, words)}</span>`,
        )}
    </small>`;
};
