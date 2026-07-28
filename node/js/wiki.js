// The wiki app: pages in a tree, and nothing else - the whole tree apparatus lives in tree.js
// (WikiTree, shared with the Notes everything-app); this file is just the app shell around it:
// routing, the last-open-page memory, and the shared Editor as the page surface.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from './cache.js';
import { WikiTree } from './tree.js';
import { Editor } from './editor.js';
import { featuresOf } from './apps.js';

const html = htm.bind(h);

// The page you last had open, keyed `${root}:${app.id}` - the same session memory as Notes'
// last-open document (and the shell's last-open bucket). Forgotten on reload.
const lastPageMemory = new Map();

export const WikiApp = ({ app, current, docId, searchQuery, bucket }) => {
    const root = current.root;
    const loc = useLocation();
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const selected = docId || null;
    const select = (id) => loc.route(id ? `/home/${app.id}/${id}` : `/home/${app.id}`);

    // A deleted page never touches the taxonomy roster, so the tree wouldn't notice on its own -
    // this bump tells it to look again.
    const [treeReload, setTreeReload] = useState(0);

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
            <div class="wiki-columns">
                <${WikiTree}
                    root=${root}
                    bucket=${bucket}
                    selected=${selected}
                    onSelect=${select}
                    searchQuery=${searchQuery}
                    reloadKey=${treeReload}
                />
                <div class="wiki-main">
                    ${selected
                        ? html`<${Editor}
                              root=${root}
                              docId=${selected}
                              key=${selected}
                              features=${featuresOf(app)}
                              onDeleted=${() => {
                                  select(null);
                                  setTreeReload((k) => k + 1);
                              }}
                          />`
                        : html`<div class="reader reader-empty">
                              <p class="null-sub">pick a page on the left, or start a new one.</p>
                          </div>`}
                </div>
            </div>
        </div>
    `;
};
