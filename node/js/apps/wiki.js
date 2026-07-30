// The wiki app: pages in a tree, and nothing else - the whole tree apparatus lives in doc/tree.js
// (WikiTree, shared with the Notes everything-app); this file is just the app shell around it:
// routing, the last-open-page memory, and the shared Editor as the page surface.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from '../mirror.js';
import { WikiTree } from '../doc/tree.js';
import { useColWidths } from '../panes.js';
import { RightColumn, useArrowNav } from './notes.js';
import { useSlugDocId, useCozyAddress } from '../doc/slugs.js';
import { featuresOf } from '../apps.js';

const html = htm.bind(h);

// The page you last had open, keyed `${root}:${app.id}` - the same session memory as Notes'
// last-open document (and the shell's last-open bucket). Forgotten on reload.
const lastPageMemory = new Map();

export const WikiApp = ({ app, current, docId, searchQuery, bucket }) => {
    const root = current.root;
    const loc = useLocation();
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    // A non-hex :docId is a cozy slug - resolved to the effective id in place, no redirect
    // (cozy URLs REST); and a hex URL dresses itself in the doc's cozy address (doc/slugs.js).
    const selected = useSlugDocId(root, app.id, docId);
    const select = (id) => loc.route(id ? `/home/${app.id}/${id}` : `/home/${app.id}`);
    useCozyAddress(root, selected, bucket);

    // A deleted page never touches the taxonomy roster, so the tree wouldn't notice on its own -
    // this bump tells it to look again.
    const [treeReload, setTreeReload] = useState(0);

    // The tree drags at its right edge, like the Notes columns (panes.js).
    const { resizer, colStyle } = useColWidths(root, app.id, ['tree']);

    // Prev/next walk the tree as a book: the depth-first doc order, reported by the tree pane
    // after each fetch. Next reads DOWN the tree, previous back up. Shown only when there's
    // somewhere to go (more than one page, and the open page is in the order).
    const [treeOrder, setTreeOrder] = useState(null);
    const order = treeOrder || [];
    const at = selected ? order.indexOf(selected) : -1;
    const nav =
        at !== -1 && order.length > 1
            ? {
                  prev: at > 0 ? order[at - 1] : null,
                  next: at < order.length - 1 ? order[at + 1] : null,
                  go: select,
                  prevTip: 'Previous — back up the tree',
                  nextTip: 'Next — down the tree',
              }
            : null;
    // The arrow keys walk the book too.
    useArrowNav(nav, order, selected, select);

    // Resume where you left off - the Notes pattern verbatim: remember the open page, and when
    // you ENTER the app with nothing selected, return to it (once, if it's still in the current
    // bucket). The redirect REPLACES history so Back still exits cleanly. The docs guard means
    // this decides only after the mirror answers - by which point the shell has restored the
    // remembered bucket, so the membership check runs against the right notebook.
    const restored = useRef(false);
    useEffect(() => {
        if (selected) lastPageMemory.set(`${root}:${app.id}`, selected);
    }, [selected, root, app.id]);
    useEffect(() => {
        if (restored.current || !docs) return;
        restored.current = true;
        if (selected) return;
        const last = lastPageMemory.get(`${root}:${app.id}`);
        if (last && docs.some((d) => d.doc_id === last && (d.buckets || []).includes(bucket))) {
            loc.route(`/home/${app.id}/${last}`, true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docs, selected]);

    return html`
        <div class="wiki">
            <div class="wiki-columns" style=${colStyle}>
                <${WikiTree}
                    root=${root}
                    bucket=${bucket}
                    selected=${selected}
                    onSelect=${select}
                    searchQuery=${searchQuery}
                    reloadKey=${treeReload}
                    onOrder=${setTreeOrder}
                />${resizer('tree')}
                <div class="wiki-main">
                    ${/* The shared right column (apps/notes.js): text formats open the Editor, media
                        opens the Reader - so an uploaded image/video page renders instead of
                        landing in a text editor that can't hold it. */ ''}
                    <${RightColumn}
                        root=${root}
                        docId=${selected}
                        docs=${docs}
                        nav=${nav}
                        bucket=${bucket}
                        features=${featuresOf(app)}
                        onDeleted=${() => {
                            select(null);
                            setTreeReload((k) => k + 1);
                        }}
                    />
                </div>
            </div>
        </div>
    `;
};
