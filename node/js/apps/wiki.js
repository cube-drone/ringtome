// The wiki app: pages in a tree, and nothing else. The tree apparatus is doc/tree.js (shared with
// the TurboNotes everything-app), the page surface is doc/reader.js, and the routing/resume/nav
// spine is doc/docapp.js - so this file is just the two-column arrangement of them.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { WikiTree } from '../doc/tree.js';
import { RightColumn } from '../doc/reader.js';
import { useDocApp, useDocNav } from '../doc/docapp.js';
import { useColWidths } from '../panes.js';
import { featuresOf, itemNoun } from '../apps.js';

const html = htm.bind(h);

export const WikiApp = ({ app, current, docId, searchQuery, bucket }) => {
    const root = current.root;
    // The shared documents-app spine (doc/docapp.js): the live documents, the open page and how to
    // change it, and the tree-reload bump a delete needs.
    const { docs, selected, select, treeReload, bumpTree } = useDocApp(root, app, docId, bucket);

    // The tree drags at its right edge, like the Notes columns (panes.js).
    const { resizer, colStyle } = useColWidths(root, app.id, ['tree']);

    // Prev/next walk the tree as a BOOK: the depth-first page order, reported by the tree pane
    // after each fetch. Next reads down the tree, previous back up.
    const [treeOrder, setTreeOrder] = useState(null);
    const nav = useDocNav(treeOrder, selected, select, {
        prev: 'Previous — back up the tree',
        next: 'Next — down the tree',
    });

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
                    itemNoun=${itemNoun(app)}
                />${resizer('tree')}
                <div class="wiki-main">
                    ${/* The shared right column (doc/reader.js): text formats open the Editor, media
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
                            bumpTree();
                        }}
                    />
                </div>
            </div>
        </div>
    `;
};
