// The document tree pane, extracted from the wiki so any documents app can wear it (the wiki
// keeps it as its whole navigation; Notes mounts it as one column of the everything-app). The
// tree IS a taxonomy (PROJECT_PLAN, Taxonomies - trees are composition): one ROOT taxonomy per
// bucket, associated by title convention (`wiki:<bucket>`), sections as child taxonomies placed
// inside their parent (titled, renameable - interior nodes are first-class), pages as document
// leaves. Renders the expanded tree straight off `GET /taxonomies/{root}`, refetched when the
// streamed roster ticks; drag-to-reorganize rides the member PUT's drag-shaped index contract.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { openMirror, useLive } from './cache.js';
import { useSearch } from './search.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body.message || `request failed (${res.status})`);
    }
    return body;
}

// The root taxonomy's title for a bucket's tree. The prefix keeps user-titled SECTIONS (also
// taxonomies, also on the roster) from ever colliding with a root lookup. (`wiki:` even when
// Notes wears the tree - it names the shape, and existing wikis already use it.)
const rootTitleFor = (bucket) => `wiki:${bucket}`;

// The bucket's tree root, found (mirror roster, lowest id wins a concurrent-mint tie) or minted.
// ONE module-level dedupe for everyone who might need the root - the tree pane and the list's
// "+ new item" alike - so two writes racing on first touch still share a single create.
const rootMints = new Map(); // `${root}:${bucket}` -> in-flight create promise
export async function ensureTreeRoot(root, bucket) {
    const rows = await openMirror(root).taxonomies.toArray();
    const match = rows
        .filter((t) => t.title === rootTitleFor(bucket))
        .sort((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1))[0];
    if (match) return match.taxonomy_id;
    const key = `${root}:${bucket}`;
    if (!rootMints.has(key)) {
        rootMints.set(
            key,
            api(`/api/identity/${root}/taxonomies`, {
                method: 'POST',
                body: JSON.stringify({ title: rootTitleFor(bucket) }),
            }).then((r) => r.taxonomy_id)
        );
    }
    return rootMints.get(key);
}

// One page leaf. Title reads LIVE from the mirror row (so an editor rename re-titles the tree
// immediately); the tree snapshot's summary is the fallback. A search filters pages out of the
// tree; sections stay as scaffolding. Draggable: a page moves between sections and reorders
// within one; dropping on a page's top half inserts before it, bottom half after. `parent` is
// the containing node (null for unfiled rows, which are draggable but not drop targets).
const PageRow = ({ id, summary, depth, ops, parent }) => {
    const [hover, setHover] = useState(null); // 'before' | 'after' | null
    const [lifting, setLifting] = useState(false);
    if (ops.hits !== null && !ops.hits.has(id)) return null;
    const live = ops.byId.get(id);
    const title = (live && live.title) || (summary && summary.title) || 'untitled';
    const cls = [
        'wiki-row',
        ops.docId === id ? 'selected' : '',
        hover ? `drop-${hover}` : '',
        lifting ? 'lifting' : '',
    ]
        .filter(Boolean)
        .join(' ');
    return html`<div
        class=${cls}
        style=${`padding-left: ${0.4 + depth * 0.9}rem`}
        onClick=${() => ops.select(id)}
        draggable=${true}
        onDragStart=${(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', id); // Firefox needs data to start a drag
            ops.drag.current = { kind: 'page', id, parentId: parent ? parent.taxonomy_id : null };
            setLifting(true);
        }}
        onDragEnd=${() => {
            ops.drag.current = null;
            setLifting(false);
            setHover(null);
        }}
        onDragOver=${(e) => {
            const drag = ops.drag.current;
            if (!drag || drag.id === id || !parent) return;
            e.preventDefault();
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setHover((e.clientY - r.top) / r.height < 0.5 ? 'before' : 'after');
        }}
        onDragLeave=${(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setHover(null);
        }}
        onDrop=${(e) => {
            e.preventDefault();
            e.stopPropagation();
            const after = hover === 'after';
            setHover(null);
            if (parent) ops.completeDrag({ parentNode: parent, refId: id, after });
        }}
    >
        <${Icons.page} />
        <span class="wiki-row-title">${title}</span>
    </div>`;
};

// One section (an interior taxonomy): a fold-toggling row with hover actions, then its members.
// `members: null` marks a stub - this section appears again elsewhere (a diamond's second
// parent, or a merge-minted cycle); its expansion lives at its first encounter, so render a
// marker, not a subtree.
const SectionNode = ({ node, parent, depth, ops }) => {
    const [hover, setHover] = useState(null); // 'before' | 'after' | 'into' | null
    const [lifting, setLifting] = useState(false);
    if (!node.members) {
        return html`<div class="wiki-row wiki-stub" style=${`padding-left: ${0.4 + depth * 0.9}rem`}>
            <${Icons.section} />
            <span class="wiki-row-title">${node.title || '(untitled section)'} ↩</span>
        </div>`;
    }
    const open = !ops.folded.has(node.taxonomy_id);
    const cls = [
        'wiki-row',
        'wiki-row-section',
        hover ? `drop-${hover}` : '',
        lifting ? 'lifting' : '',
    ]
        .filter(Boolean)
        .join(' ');
    return html`
        <div
            class=${cls}
            style=${`padding-left: ${0.4 + depth * 0.9}rem`}
            onClick=${() => ops.toggleFold(node.taxonomy_id)}
            draggable=${true}
            onDragStart=${(e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', node.taxonomy_id);
                // Its whole subtree's taxonomy ids ride along - the client-side cycle guard
                // (the server refuses these too; this keeps the drop from even offering).
                const taxIds = [];
                const collect = (n) => {
                    taxIds.push(n.taxonomy_id);
                    for (const m of n.members || []) {
                        if (m.taxonomy && m.taxonomy.members) collect(m.taxonomy);
                    }
                };
                collect(node);
                ops.drag.current = {
                    kind: 'section',
                    id: node.taxonomy_id,
                    parentId: parent.taxonomy_id,
                    taxIds,
                };
                setLifting(true);
            }}
            onDragEnd=${() => {
                ops.drag.current = null;
                setLifting(false);
                setHover(null);
            }}
            onDragOver=${(e) => {
                const drag = ops.drag.current;
                if (!drag || drag.id === node.taxonomy_id) return;
                // A section can't be dropped into (or beside anything inside) its own subtree.
                if (drag.kind === 'section' && drag.taxIds.includes(node.taxonomy_id)) return;
                e.preventDefault();
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                const frac = (e.clientY - r.top) / r.height;
                setHover(frac < 0.25 ? 'before' : frac > 0.75 ? 'after' : 'into');
            }}
            onDragLeave=${(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setHover(null);
            }}
            onDrop=${(e) => {
                e.preventDefault();
                e.stopPropagation();
                const zone = hover;
                setHover(null);
                if (zone === 'into') {
                    ops.completeDrag({ intoId: node.taxonomy_id });
                } else {
                    ops.completeDrag({
                        parentNode: parent,
                        refId: node.taxonomy_id,
                        after: zone === 'after',
                    });
                }
            }}
        >
            <span class=${open ? 'wiki-caret open' : 'wiki-caret'}><${Icons.forward} /></span>
            <${open ? Icons.sectionOpen : Icons.section} />
            <span class="wiki-row-title">${node.title || '(untitled section)'}</span>
            <span class="wiki-row-actions" onClick=${(e) => e.stopPropagation()}>
                <button
                    class="wiki-act"
                    title="a new page in this section"
                    onClick=${() => ops.newPage(node.taxonomy_id)}
                ><${Icons.pageNew} /></button>
                <button
                    class="wiki-act"
                    title="a new section inside this one"
                    onClick=${() => ops.newSection(node.taxonomy_id)}
                ><${Icons.sectionNew} /></button>
                <button
                    class="wiki-act"
                    title="rename this section"
                    onClick=${() => ops.renameSection(node.taxonomy_id, node.title)}
                ><${Icons.rename} /></button>
                <button
                    class="wiki-act danger"
                    title="delete this section (its pages are not deleted)"
                    onClick=${() => ops.deleteSection(node, parent.taxonomy_id)}
                ><${Icons.trash} /></button>
            </span>
        </div>
        ${open && html`<${MemberList} node=${node} depth=${depth + 1} ops=${ops} />`}
    `;
};

// A node's members in list order: sections recurse, own pages render, anything else (a dangling
// reference to a deleted doc/section, or another identity's document - representable, not yet
// renderable) is skipped.
const MemberList = ({ node, depth, ops }) => html`${node.members.map((m) => {
    if (m.taxonomy) {
        return html`<${SectionNode}
            key=${m.doc_id}
            node=${m.taxonomy}
            parent=${node}
            depth=${depth}
            ops=${ops}
        />`;
    }
    if (m.doc) {
        return html`<${PageRow}
            key=${m.doc_id}
            id=${m.doc_id}
            summary=${m.doc}
            depth=${depth}
            ops=${ops}
            parent=${node}
        />`;
    }
    return null;
})}`;

// The unfiled bin: also a drop target - dragging a page here removes it from its section
// (pages only; a section unhooked from the tree would be an invisible orphan).
const UnfiledBin = ({ unfiled, ops }) => {
    const [over, setOver] = useState(false);
    return html`<div
        class=${over ? 'wiki-unfiled drop-hover' : 'wiki-unfiled'}
        onDragOver=${(e) => {
            const drag = ops.drag.current;
            if (!drag || drag.kind !== 'page' || !drag.parentId) return;
            e.preventDefault();
            e.stopPropagation();
            setOver(true);
        }}
        onDragLeave=${(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setOver(false);
        }}
        onDrop=${(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            ops.completeDrag({ unfile: true });
        }}
    >
        <div class="wiki-unfiled-title">unfiled</div>
        ${unfiled.map(
            (d) => html`<${PageRow} key=${d.doc_id} id=${d.doc_id} summary=${d} depth=${0} ops=${ops} />`
        )}
    </div>`;
};

/**
 * The tree pane. Self-contained: finds (or lazily mints) the bucket's root taxonomy, fetches
 * and renders the expanded tree, and owns every tree operation (new page/section, rename,
 * delete, drag-to-reorganize, folds).
 *
 * @param selected     the open doc's id (highlights its row)
 * @param onSelect     called with a doc_id when a page row is clicked
 * @param reloadKey    bump to force a refetch (e.g. after deleting a doc from the editor)
 * @param showUnfiled  the unfiled bin; off when a sibling list column already plays that role
 * @param onMinimize   when present, the toolbar grows a tuck-away button (collapsible column)
 */
export const WikiTree = ({
    root,
    bucket,
    selected,
    onSelect,
    searchQuery,
    reloadKey = 0,
    showUnfiled = true,
    onMinimize,
}) => {
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const taxRows = useLive(() => openMirror(root).taxonomies.toArray(), [root]);

    // This bucket's root taxonomy, found on the streamed roster by the title convention. Ties
    // (two devices minting concurrently) resolve to the lowest id - the loser's root just goes
    // quietly unused.
    const rootRow = (taxRows || [])
        .filter((t) => t.title === rootTitleFor(bucket))
        .sort((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1))[0];
    // A root minted THIS session, before its roster row has streamed back.
    const [mintedRoot, setMintedRoot] = useState(null);
    const rootId = (rootRow && rootRow.taxonomy_id) || mintedRoot;

    // Mint the root lazily, on the first write that needs it - opening an empty tree creates
    // nothing. The shared `ensureTreeRoot` dedupe means the list's "+ new item" and the tree's
    // own toolbar can race on first touch and still share one create.
    useEffect(() => {
        setMintedRoot(null);
    }, [root, bucket]);
    const ensureRoot = () => {
        if (rootId) return Promise.resolve(rootId);
        return ensureTreeRoot(root, bucket).then((id) => {
            setMintedRoot(id);
            return id;
        });
    };

    // The expanded tree, fetched whole (cozy-sized). Refetches when the roster changes shape
    // (any member count or title ticking over), after our own writes (`refetch`), and when the
    // host bumps `reloadKey` (a doc deleted from the editor never touches the roster).
    const [tree, setTree] = useState(null);
    const [bump, setBump] = useState(0);
    const refetch = () => setBump((b) => b + 1);
    const rosterKey = (taxRows || []).map((t) => `${t.taxonomy_id}:${t.title}:${t.members}`).join(',');
    useEffect(() => {
        if (!rootId) {
            setTree(null);
            return;
        }
        let alive = true;
        api(`/api/identity/${root}/taxonomies/${rootId}`)
            .then((t) => alive && setTree(t))
            .catch(() => {});
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, rootId, rosterKey, bump, reloadKey]);

    // Fold state lives in Dexie prefs (like the journal's seals): per-section, durable in this
    // browser, live across tabs, never synced.
    const foldRows = useLive(
        () => openMirror(root).prefs.where('key').startsWith('wikifold:').toArray(),
        [root]
    );
    const folded = new Set(
        (foldRows || []).filter((r) => r.value === '1').map((r) => r.key.slice('wikifold:'.length))
    );
    const toggleFold = (taxId) => {
        openMirror(root)
            .prefs.put({ key: `wikifold:${taxId}`, value: folded.has(taxId) ? '0' : '1' })
            .catch(() => {});
    };

    const newPage = async (parentTaxId) => {
        try {
            const pid = parentTaxId || (await ensureRoot());
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: 'untitled', body: '', format: 'marquee' }),
            });
            await api(
                `/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(bucket)}`,
                { method: 'PUT' }
            );
            await api(`/api/identity/${root}/taxonomies/${pid}/members/${made.doc_id}`, {
                method: 'PUT',
                body: JSON.stringify({}),
            });
            refetch();
            onSelect(made.doc_id);
        } catch (e) {
            alert(`couldn't start the page: ${e.message}`);
        }
    };

    const newSection = async (parentTaxId) => {
        const title = (prompt('A name for the new section:') || '').trim();
        if (!title) return;
        try {
            const pid = parentTaxId || (await ensureRoot());
            const made = await api(`/api/identity/${root}/taxonomies`, {
                method: 'POST',
                body: JSON.stringify({ title }),
            });
            await api(`/api/identity/${root}/taxonomies/${pid}/members/${made.taxonomy_id}`, {
                method: 'PUT',
                body: JSON.stringify({}),
            });
            refetch();
        } catch (e) {
            alert(`couldn't create the section: ${e.message}`);
        }
    };

    // Rename: a taxonomy's title is an ordinary annotation on its own id.
    const renameSection = async (taxId, currentTitle) => {
        const title = (prompt('Rename this section:', currentTitle || '') || '').trim();
        if (!title || title === currentTitle) return;
        try {
            await api(`/api/identity/${root}/docs/${taxId}/annotations/fields/title`, {
                method: 'PUT',
                body: JSON.stringify({ value: title }),
            });
            refetch();
        } catch (e) {
            alert(`couldn't rename it: ${e.message}`);
        }
    };

    // Delete a section: unhook it from its parent, then delete it and every DESCENDANT section
    // (collected from the snapshot we're looking at). Pages are never deleted by this - with an
    // unfiled bin they land there (visible, re-fileable); WITHOUT one (Notes hides it, the list
    // plays that role) they'd fall out of the tree with no way back in, so instead they're
    // re-placed at the top level FIRST, then the sections come down - place-before-remove, the
    // same ordering doctrine as a move, so a failure mid-way leaves visible duplicates, never a
    // page lost from the tree. A page that also lives in another section (a diamond) is left
    // alone - its other home keeps it in the tree already.
    const deleteSection = async (node, parentId) => {
        const descendants = [];
        const collect = (n) => {
            descendants.push(n.taxonomy_id);
            for (const m of n.members || []) {
                if (m.taxonomy && m.taxonomy.members) collect(m.taxonomy);
            }
        };
        collect(node);
        const subs = descendants.length - 1;
        if (
            !confirm(
                `Delete the section “${node.title || '(untitled)'}”?` +
                    (subs ? ` Its ${subs} sub-section${subs === 1 ? '' : 's'} go too.` : '') +
                    ` Pages are not deleted - they ${showUnfiled ? 'land in unfiled' : 'move to the top level'}.`
            )
        )
            return;
        try {
            if (!showUnfiled && tree) {
                // Which pages live ONLY inside the doomed subtree? Walk the whole tree sorting
                // page occurrences into inside/outside; only the inside-only ones move to root.
                const doomed = new Set(descendants);
                const inside = new Set();
                const outside = new Set();
                const walk = (n, inSub) => {
                    const here = inSub || doomed.has(n.taxonomy_id);
                    for (const m of n.members || []) {
                        if (m.taxonomy) {
                            if (m.taxonomy.members) walk(m.taxonomy, here);
                        } else if (m.doc) {
                            (here ? inside : outside).add(m.doc_id);
                        }
                    }
                };
                walk(tree, false);
                const rid = await ensureRoot();
                for (const id of inside) {
                    if (outside.has(id)) continue;
                    await api(`/api/identity/${root}/taxonomies/${rid}/members/${id}`, {
                        method: 'PUT',
                        body: JSON.stringify({}),
                    });
                }
            }
            await api(`/api/identity/${root}/taxonomies/${parentId}/members/${node.taxonomy_id}`, {
                method: 'DELETE',
            });
            for (const id of descendants) {
                await api(`/api/identity/${root}/taxonomies/${id}`, { method: 'DELETE' });
            }
            refetch();
        } catch (e) {
            alert(`couldn't delete it: ${e.message}`);
        }
    };

    // The bucket's pages (live), the tree's filed doc ids, and the difference: unfiled.
    const pages = (docs || []).filter((d) => (d.buckets || []).includes(bucket));
    const byId = new Map(pages.map((d) => [d.doc_id, d]));
    const filed = new Set();
    const sweep = (n) => {
        for (const m of n.members || []) {
            if (m.taxonomy) sweep(m.taxonomy);
            else filed.add(m.doc_id);
        }
    };
    if (tree) sweep(tree);
    const unfiled = showUnfiled ? pages.filter((d) => !filed.has(d.doc_id)) : [];

    const hits = useSearch(root, searchQuery);

    // Drag-to-reorganize. The payload lives in a ref for the drag's duration (dataTransfer is
    // read-locked during dragover, so everyone reads this instead). The server API is already
    // drag-shaped: member PUT with an index is add-and-move in one op (position counted without
    // the member itself), and a cross-section move is the documented place + remove pair -
    // place FIRST, so a failure between the writes leaves a visible duplicate, never a lost
    // page. Same-parent reorders skip the remove entirely.
    const dragRef = useRef(null);
    const completeDrag = async (drop) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;
        try {
            if (drop.unfile) {
                // Unfiling is pages-only: a section unhooked from every parent would be an
                // invisible orphan, so sections can't land here.
                if (drag.kind !== 'page' || !drag.parentId) return;
                await api(
                    `/api/identity/${root}/taxonomies/${drag.parentId}/members/${drag.id}`,
                    { method: 'DELETE' }
                );
                refetch();
                return;
            }
            let destParent, index;
            if (drop.intoId) {
                destParent = drop.intoId; // append into a section (or the root)
                index = undefined;
            } else {
                if (drag.id === drop.refId) return; // dropped beside itself: nothing to do
                destParent = drop.parentNode.taxonomy_id;
                // The arrival index, counted without the dragged member (the PUT's contract).
                const list = (drop.parentNode.members || [])
                    .map((m) => m.doc_id)
                    .filter((x) => x !== drag.id);
                const i = list.indexOf(drop.refId);
                index = i === -1 ? undefined : drop.after ? i + 1 : i;
            }
            if (drag.kind === 'section' && drag.taxIds && drag.taxIds.includes(destParent)) {
                return; // cycle: into itself or its own subtree (the server refuses these too)
            }
            await api(`/api/identity/${root}/taxonomies/${destParent}/members/${drag.id}`, {
                method: 'PUT',
                body: JSON.stringify(index === undefined ? {} : { index }),
            });
            if (drag.parentId && drag.parentId !== destParent) {
                await api(
                    `/api/identity/${root}/taxonomies/${drag.parentId}/members/${drag.id}`,
                    { method: 'DELETE' }
                );
            }
            refetch();
        } catch (e) {
            alert(`couldn't move that: ${e.message}`);
        }
    };

    const ops = {
        docId: selected,
        select: onSelect,
        byId,
        hits,
        folded,
        toggleFold,
        newPage,
        newSection,
        renameSection,
        deleteSection,
        drag: dragRef,
        completeDrag,
    };

    const empty = !tree || !(tree.members || []).length;

    return html`
        <aside
            class="wiki-tree"
            onDragOver=${(e) => {
                // The pane background is the root's drop zone (rows stopPropagation, so only
                // true background drags reach here): drop to file at top level.
                if (dragRef.current && tree) e.preventDefault();
            }}
            onDrop=${(e) => {
                e.preventDefault();
                if (tree) completeDrag({ intoId: tree.taxonomy_id });
            }}
        >
            <div class="wiki-toolbar">
                <button class="wiki-tool" onClick=${() => newPage(null)}>
                    <${Icons.pageNew} /> page
                </button>
                <button class="wiki-tool" onClick=${() => newSection(null)}>
                    <${Icons.sectionNew} /> section
                </button>
                ${onMinimize &&
                html`<span class="wiki-toolbar-spring"></span>
                    <button class="pane-min" title="tuck the tree away" onClick=${onMinimize}>
                        <${Icons.back} />
                    </button>`}
            </div>
            ${tree && html`<${MemberList} node=${tree} depth=${0} ops=${ops} />`}
            ${empty &&
            !unfiled.length &&
            html`<p class="null-sub wiki-empty">
                nothing here yet - start a page, or a section to put pages in.
            </p>`}
            ${!!unfiled.length && html`<${UnfiledBin} unfiled=${unfiled} ops=${ops} />`}
        </aside>
    `;
};
