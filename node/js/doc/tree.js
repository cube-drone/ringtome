// The document tree pane, extracted from the wiki so any documents app can wear it (the wiki
// keeps it as its whole navigation; Notes mounts it as one column of the everything-app). The
// tree IS a taxonomy (PROJECT_PLAN, Taxonomies - trees are composition): one ROOT taxonomy per
// bucket, associated by title convention (`wiki:<bucket>`), sections as child taxonomies placed
// inside their parent (titled, renameable - interior nodes are first-class), pages as document
// leaves. Renders the expanded tree straight off `GET /taxonomies/{root}`, refetched when the
// streamed roster ticks; drag-to-reorganize rides the member PUT's drag-shaped index contract.
import { h } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { EpubButton } from './epubbutton.js';
import { openMirror, useLive, holdNewDoc } from '../mirror.js';
import { usePrefMap, flagsOf, setFlag, foldKey, FOLD_PREFIX } from '../mirror/prefs.js';
import { cachedTree, rememberTree, rosterFingerprint } from '../mirror/doccache.js';
import { useSearch } from '../search.js';
import { startDocDrag, SECTION_DRAG } from './crosslink.js';
import { rootTitleFor } from '../pure/naming.js';
import { kindHolds } from '../pure/doclist.js';
import {
    docsInsideOnly,
    dropIndex,
    filedDocIds,
    flatDocs,
    memberIn,
    parentsOf,
    pathToDoc,
    retitled,
    sectionIdsUnder,
    withMember,
    withoutMember,
} from '../pure/treewalk.js';
import { Icons, formatIcon } from '../icons.js';
import { pageStanding } from '../pure/books.js';
import { isTextDoc } from '../pure/feed.js';
import { PaneHead } from '../panes.js';
import { t } from '../i18n.js';
import { askText, askYes } from '../modal.js';
import { toast } from '../toasts.js';

const html = htm.bind(h);

// The bucket's tree root, found (mirror roster, lowest id wins a concurrent-mint tie) or minted.
// ONE module-level dedupe for everyone who might need the root - the tree pane and the list's
// list's new-thing button alike - so two writes racing on first touch share a single create.
const rootMints = new Map(); // `${root}:${bucket}` -> in-flight create promise
async function existingTreeRoot(root, bucket) {
    const rows = await openMirror(root).taxonomies.toArray();
    const match = rows
        .filter((t) => t.title === rootTitleFor(bucket))
        .sort((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1))[0];
    return match ? match.taxonomy_id : null;
}

/// File a document at the top of its notebook's tree (Curtis, 2026-09-30: a note copied into a notebook
/// "joins that bucket but it doesn't join that bucket's taxonomy"), as a new note is - when the
/// notebook has a tree. One that has none yet mints it on first opening, and its unfiled bin shows
/// whatever was there before.
export async function fileIntoTree(root, bucket, docId) {
    const rid = await existingTreeRoot(root, bucket);
    if (!rid) return;
    await api(`/api/identity/${root}/taxonomies/${rid}/members/${docId}`, {
        method: 'PUT',
        body: JSON.stringify({}),
    });
}

/// Take a document out of its notebook's tree, wherever in it it sits - the other half of a move
/// (doc/annotations.js), so the old notebook's tree doesn't go on showing a page it no longer holds.
export async function unfileFromTree(root, bucket, docId) {
    const rid = await existingTreeRoot(root, bucket);
    if (!rid) return;
    const tree = await api(`/api/identity/${root}/taxonomies/${rid}`);
    for (const pid of parentsOf(tree, docId)) {
        await api(`/api/identity/${root}/taxonomies/${pid}/members/${docId}`, { method: 'DELETE' });
    }
}

// The edits shown ahead of the node (Curtis, 2026-10-13: a new page sat in unfiled, and a drag
// did nothing, until the writes and a whole-tree read had gone round a busy server). Each edit
// changes what a pane shows at once - `apply`, tree => tree, idempotent (pure/treewalk.js) - and
// its writes follow, one edit after another. A pane shows the tree the node last sent with every
// edit that tree can't have seen applied on top, so a read that left before a drag landed doesn't
// undo it. Kept per notebook, here rather than in a pane: opening the page a pane just made is a
// new route, which mounts a new pane while the old one's writes are still out.
const notebookEdits = new Map(); // `${root}:${bucket}` -> the notebook's queue

function editsOf(key) {
    if (!notebookEdits.has(key)) {
        notebookEdits.set(key, {
            edits: [], // [{ id, apply }], oldest first
            seq: 0, // the last edit's id
            written: 0, // edits up to this id have their writes done (they run in order)
            writing: Promise.resolve(),
            panes: new Set(), // { edits, drained } for each pane showing the notebook
        });
    }
    return notebookEdits.get(key);
}

function changeEdits(key, change) {
    const q = editsOf(key);
    q.edits = change(q.edits);
    for (const pane of q.panes) pane.edits(q.edits);
}

/// An edit to a notebook's tree: `apply` shown now, `write` (async) once every edit before it is
/// written. A write that fails takes its edit back off the screen and says so (`fail`); once the
/// last write is done, the panes read the tree again to confirm the lot.
function showEdit(key, apply, write, fail) {
    const q = editsOf(key);
    const id = ++q.seq;
    changeEdits(key, (es) => [...es, { id, apply }]);
    q.writing = q.writing.then(async () => {
        try {
            await write();
        } catch (e) {
            changeEdits(key, (es) => es.filter((x) => x.id !== id));
            fail(e);
        } finally {
            q.written = id;
            if (q.seq === id) for (const pane of q.panes) pane.drained();
        }
    });
}

/// File a new page at the top of its notebook's tree, minting the tree if need be - shown there at
/// once in any pane on that notebook, never a beat in unfiled. The list's "new" (apps/notes.js).
export async function fileNewIntoTree(root, bucket, docId, summary) {
    const rid = await ensureTreeRoot(root, bucket);
    const placing = api(`/api/identity/${root}/taxonomies/${rid}/members/${docId}`, {
        method: 'PUT',
        body: JSON.stringify({}),
    });
    showEdit(
        `${root}:${bucket}`,
        (tr) => withMember(tr, rid, { doc_id: docId, doc: summary }),
        () => placing,
        () => {}, // the caller says so: it awaits the same write
    );
    await placing;
}

export async function ensureTreeRoot(root, bucket) {
    const found = await existingTreeRoot(root, bucket);
    if (found) return found;
    const key = `${root}:${bucket}`;
    if (!rootMints.has(key)) {
        rootMints.set(
            key,
            api(`/api/identity/${root}/taxonomies`, {
                method: 'POST',
                body: JSON.stringify({ title: rootTitleFor(bucket) }),
            }).then((r) => r.taxonomy_id),
        );
    }
    return rootMints.get(key);
}

/// A standing's icon colour (tree.css): published green, pending orange, hidden grey.
const STANDING_CLASS = {
    current: 'tree-row-icon tree-standing-current',
    changed: 'tree-row-icon tree-standing-pending',
    new: 'tree-row-icon tree-standing-pending',
    hidden: 'tree-row-icon tree-standing-hidden',
};

const HIDDEN = 'hidden';

/// What a page icon's colour says, in its tooltip.
const standingTitle = (standing) =>
    standing === 'hidden'
        ? t('doc.tree.hidden-from-the-book', 'hidden from the book')
        : standing === 'new'
          ? t('doc.tree.new-since-the-last-rollout', 'new since the last rollout')
          : standing === 'changed'
            ? t('doc.tree.changed-since-the-last-rollout', 'changed since the last rollout')
            : standing === 'current'
              ? t('doc.tree.in-the-book-as-published', 'in the book as published')
              : undefined;

// One page leaf. Title reads LIVE from the mirror row (so an editor rename re-titles the tree
// immediately); the tree snapshot's summary is the fallback. A search filters pages out of the
// tree; sections stay as scaffolding. Draggable: a page moves between sections and reorders
// within one; dropping on a page's top half inserts before it, bottom half after. `parent` is
// the containing node (null for unfiled rows, which are draggable but not drop targets).
const PageRow = ({ id, summary, depth, ops, parent }) => {
    const [hover, setHover] = useState(null); // 'before' | 'after' | null
    const [lifting, setLifting] = useState(false);
    // Bring the selected row on-screen when the selection arrives (or when the row itself
    // appears - an unfold revealing it mounts it selected). 'nearest' keeps an already-visible
    // row still; no jump unless one is needed.
    const rowRef = useRef(null);
    const isSelected = ops.docId === id;
    useEffect(() => {
        if (isSelected && rowRef.current) {
            rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }, [isSelected]);
    if (ops.hits !== null && !ops.hits.has(id)) return null;
    const live = ops.byId.get(id);
    // The kind dial filters pages exactly as search does - sections stay as scaffolding, so a
    // directory never vanishes, only empties. A page whose facts we don't hold (dangling or
    // not yet synced) passes: only a KNOWN wrong kind hides a row.
    const facts = live || summary;
    if (facts && !kindHolds(facts, ops.kind)) return null;
    // In a book, the page's standing against the last rollout colours its icon (Curtis, 2026-09-30):
    // green in the book as published, orange changed or new since, grey hidden from it. A picture
    // filed in the notebook is not a page, and a notebook that isn't a book wears nothing.
    const standing =
        ops.book && live && isTextDoc(live)
            ? pageStanding(live, ops.book.hiddenDocs, ops.book.hidden)
            : null;
    const title = (live && live.title) || (summary && summary.title) || 'untitled';
    // A pinned page wears the pin, and its title the accent (Curtis, 2026-10-13) - the mirror's
    // row first, which a pin or an unpin moves at once; the tree's summary while it's not here.
    const pinned = live ? !!live.pinned : !!(summary && summary.pinned);
    // Media pages wear their kind (image/video/audio); text pages keep the page glyph.
    const icon = pinned
        ? Icons.pin
        : formatIcon((live && live.format) || (summary && summary.format)) || Icons.page;
    const cls = [
        'tree-row jag-line-2',
        isSelected ? 'selected' : '',
        hover ? `drop-${hover}` : '',
        lifting ? 'lifting' : '',
    ]
        .filter(Boolean)
        .join(' ');
    return html`<div
        class=${cls}
        ref=${rowRef}
        style=${`padding-left: ${0.4 + depth * 0.9}rem`}
        data-settles
        onClick=${() => ops.select(id)}
        draggable=${true}
        onDragStart=${(e) => {
            // Two audiences at once: the tree's own drop targets read `ops.drag` (reorganize),
            // and an editor drop reads the link-markup payload (startDocDrag - the crosslink).
            startDocDrag(
                e,
                ops.root,
                live || { doc_id: id, title, format: summary && summary.format },
                ops.bucket,
            );
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
        <span class=${STANDING_CLASS[standing] || 'tree-row-icon'} title=${standingTitle(standing)}><${icon} /></span>
        <span class=${pinned ? 'tree-row-title pinned' : 'tree-row-title'}>${title}</span>
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
        return html`<div class="tree-row jag-line-2 tree-stub" style=${`padding-left: ${0.4 + depth * 0.9}rem`}>
            <${Icons.section} />
            <span class="tree-row-title">${node.title || t('doc.tree.untitled-section', '(untitled section)')} ↩</span>
        </div>`;
    }
    const open = !ops.folded.has(node.taxonomy_id);
    const cls = [
        'tree-row jag-line-2',
        'tree-row-section',
        hover ? `drop-${hover}` : '',
        lifting ? 'lifting' : '',
    ]
        .filter(Boolean)
        .join(' ');
    // A section hidden from the book goes grey (2026-09-30), as its pages do.
    const sectionHidden = !!ops.book && ops.book.hidden.has(`sec:${node.taxonomy_id}`);
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
                // Marked so an editor drop can refuse it - a section isn't insertable text.
                e.dataTransfer.setData(SECTION_DRAG, node.taxonomy_id);
                ops.drag.current = {
                    kind: 'section',
                    id: node.taxonomy_id,
                    parentId: parent.taxonomy_id,
                    // Its whole subtree rides along, for the client-side cycle guard.
                    taxIds: sectionIdsUnder(node),
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
            <span class=${open ? 'tree-caret open' : 'tree-caret'}><${Icons.forward} /></span>
            <span class=${sectionHidden ? STANDING_CLASS.hidden : 'tree-row-icon'} title=${sectionHidden ? standingTitle(HIDDEN) : undefined}
                ><${open ? Icons.sectionOpen : Icons.section}
            /></span>
            <span class="tree-row-title">${node.title || t('doc.tree.untitled-section-2', '(untitled section)')}</span>
            <span class="tree-row-actions" onClick=${(e) => e.stopPropagation()}>
                <button
                    class="tree-act"
                    title=${`a new ${ops.itemNoun} in this section`}
                    data-settles
                    onClick=${() => ops.newPage(node.taxonomy_id)}
                ><${Icons.pageNew} /></button>
                <button
                    class="tree-act"
                    title=${t('doc.tree.a-new-section-inside-this', 'a new section inside this one')}
                    onClick=${() => ops.newSection(node.taxonomy_id)}
                ><${Icons.sectionNew} /></button>
                <button
                    class="tree-act"
                    title=${t('doc.tree.rename-this-section', 'rename this section')}
                    onClick=${() => ops.renameSection(node.taxonomy_id, node.title)}
                ><${Icons.rename} /></button>
                <button
                    class="tree-act danger"
                    title=${`delete this section (nothing inside it is deleted)`}
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
const MemberList = ({ node, depth, ops }) =>
    html`${node.members.map((m) => {
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
        class=${over ? 'tree-unfiled drop-hover' : 'tree-unfiled'}
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
        <div class="tree-unfiled-title">${t('doc.tree.unfiled', 'unfiled')}</div>
        ${unfiled.map(
            (d) =>
                html`<${PageRow} key=${d.doc_id} id=${d.doc_id} summary=${d} depth=${0} ops=${ops} />`,
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
 * @param showUnfiled  the unfiled bin: the way back into the tree for a page that reached the bucket
 *                     some other way (the Writer shows it since 2026-09-30 - its list lists, but can't file)
 * @param onMinimize   when present, the toolbar grows a tuck-away button (collapsible column)
 * @param onOrder      called with the depth-first doc order (the "book order") after each fetch
 * @param itemNoun     what the hosting app calls one of its things ("page", "note") - the tree grows
 *                     notes in Writer, and says so
 * @param searchKind   the kind dial ('all' | 'docs' | 'media'): filters page rows like search
 *                     does, never sections
 */
export const WikiTree = ({
    root,
    bucket,
    selected,
    onSelect,
    searchQuery,
    searchKind = 'all',
    reloadKey = 0,
    showUnfiled = true,
    onMinimize,
    onOrder,
    itemNoun = 'page',
    book = null, // the notebook's book facts when it is one (apps/notes.js): colours the icons
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
    // nothing. The shared `ensureTreeRoot` dedupe means the list's new-thing button and the tree's
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
    // The tree as the node last sent it, and the edits shown ahead of it (Curtis, 2026-10-13: a
    // new page sat in unfiled, and a drag did nothing, until the writes and a whole-tree read had
    // gone round a busy server). Each edit changes what's on screen at once (`show`) and its writes
    // follow, one edit after another; what's shown is the fetched tree with every edit the fetch
    // can't have seen applied on top - so a read that left before a drag landed doesn't undo it.
    const [fetched, setFetched] = useState(null);
    const notebook = `${root}:${bucket}`;
    const [edits, setEdits] = useState(() => editsOf(notebook).edits);
    const tree = useMemo(
        () => (fetched ? edits.reduce((tr, e) => e.apply(tr), fetched) : null),
        [fetched, edits],
    );
    const [bump, setBump] = useState(0);
    const refetch = () => setBump((b) => b + 1);

    const show = (apply, write, fail) => showEdit(notebook, apply, write, fail);
    useEffect(() => {
        const q = editsOf(notebook);
        setEdits(q.edits);
        const pane = { edits: setEdits, drained: refetch };
        q.panes.add(pane);
        return () => q.panes.delete(pane);
    }, [notebook]);
    const rosterKey = rosterFingerprint(taxRows);
    // `bump`/`reloadKey` mark OUR OWN writes: the roster stamp hasn't ticked yet but the tree
    // has changed, so those runs must bypass the cache and go to the node.
    const lastForce = useRef('0:0');
    useEffect(() => {
        if (!rootId) {
            setFetched(null);
            return;
        }
        const forced = `${bump}:${reloadKey}` !== lastForce.current;
        lastForce.current = `${bump}:${reloadKey}`;
        let alive = true;
        // `seen`: the edits whose writes were done before this tree left the node - the ones it
        // holds, and so no longer shows ahead of it. A tree from the cache has seen none.
        const finish = (t, seen) => {
            if (!alive) return;
            setFetched(t);
            if (seen) changeEdits(notebook, (es) => es.filter((e) => e.id > seen));
        };
        const fetchTree = () => {
            const seen = editsOf(notebook).written;
            return api(`/api/identity/${root}/taxonomies/${rootId}`)
                .then((t) => {
                    if (!alive) return;
                    rememberTree(root, rootId, rosterKey, t);
                    finish(t, seen);
                })
                .catch(() => {});
        };
        // Cache-first (mirror/doccache.js): a tree the roster stamp still vouches for paints from
        // disk - no fetch, no flash; misses and forced runs go to the node.
        if (forced) fetchTree();
        else {
            cachedTree(root, rootId, rosterKey).then((hit) => {
                if (!alive) return;
                if (!hit) {
                    fetchTree();
                    return;
                }
                finish(hit, 0);
                // ...unless it shows a page the mirror no longer holds: deleting a note moves no
                // list's count, so the roster went on vouching for a tree that still had it
                // (Curtis, 2026-10-13: two deleted notes sat in a big notebook's tree, each
                // opening on "that isn't here"). A page too new for the mirror reads afresh too.
                const pages = flatDocs(hit);
                if (!pages.length) return;
                openMirror(root)
                    .docs.bulkGet(pages)
                    .then((rows) => {
                        if (alive && rows.some((r) => !r)) fetchTree();
                    })
                    .catch(() => {});
            });
        }
        return () => {
            alive = false;
        };
    }, [root, rootId, rosterKey, bump, reloadKey, notebook]);

    // The book order, of the tree as shown.
    useEffect(() => {
        onOrder && onOrder(tree ? flatDocs(tree) : []);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tree]);

    // Fold state is a local pref (mirror/prefs.js): per-section, durable in this browser, live across
    // tabs, never synced. The map form, not just the flag set, because the reveal pass below has
    // to know whether the prefs have LOADED yet.
    const foldPrefs = usePrefMap(root, FOLD_PREFIX);
    const folded = flagsOf(foldPrefs);
    const toggleFold = (taxId) => setFlag(root, foldKey(taxId), !folded.has(taxId));

    // Arriving somewhere you can't see isn't arriving: when the selection changes (prev/next
    // walking into a folded section, a deep link, a list click), unfold every ancestor of the
    // newly selected page. ONCE per arrival - the ref - so folding a section over the open page
    // afterwards sticks; the reveal only fires again when the selection actually moves. Waits
    // for both the tree and the fold prefs before judging, so a deep link's first paint still
    // reveals. A diamond-placed page reveals its first-occurrence path (the nav order's path).
    const revealed = useRef(null);
    useEffect(() => {
        if (!selected || !tree || foldPrefs === undefined) return;
        if (revealed.current === selected) return;
        revealed.current = selected;
        const trail = pathToDoc(tree, selected) || [];
        for (const { taxonomy_id: id } of trail) {
            if (folded.has(id)) setFlag(root, foldKey(id), false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected, tree, foldPrefs]);

    const newPage = async (parentTaxId) => {
        try {
            const pid = parentTaxId || (await ensureRoot());
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: 'untitled', body: '', format: 'marquee' }),
            });
            // Open it now, the row stated ahead of the stream (pure/optimistic.js), and in its
            // section ahead of the node.
            await holdNewDoc(root, made, { title: 'untitled', format: 'marquee', bucket });
            onSelect(made.doc_id);
            const member = { doc_id: made.doc_id, doc: { title: 'untitled', format: 'marquee' } };
            show(
                (tr) => withMember(tr, pid, member),
                async () => {
                    await api(
                        `/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(bucket)}`,
                        { method: 'PUT' },
                    );
                    await api(`/api/identity/${root}/taxonomies/${pid}/members/${made.doc_id}`, {
                        method: 'PUT',
                        body: JSON.stringify({}),
                    });
                },
                (e) =>
                    toast(
                        t(
                            'doc.tree.couldnt-start-the',
                            "couldn't start the {itemNoun}: {message}",
                            {
                                itemNoun,
                                message: e.message,
                            },
                        ),
                        { kind: 'error' },
                    ),
            );
        } catch (e) {
            toast(
                t('doc.tree.couldnt-start-the', "couldn't start the {itemNoun}: {message}", {
                    itemNoun,
                    message: e.message,
                }),
                { kind: 'error' },
            );
        }
    };

    const newSection = async (parentTaxId) => {
        const title =
            (await askText({
                title: t('doc.tree.new-section-title', 'a new section'),
                label: t('doc.tree.new-section-name', 'A name for the new section:'),
                ok: t('doc.tree.make-it', 'make it'),
            })) || '';
        if (!title) return;
        try {
            const pid = parentTaxId || (await ensureRoot());
            const made = await api(`/api/identity/${root}/taxonomies`, {
                method: 'POST',
                body: JSON.stringify({ title }),
            });
            const id = made.taxonomy_id;
            show(
                (tr) =>
                    withMember(tr, pid, {
                        doc_id: id,
                        taxonomy: { taxonomy_id: id, title, members: [] },
                    }),
                () =>
                    api(`/api/identity/${root}/taxonomies/${pid}/members/${id}`, {
                        method: 'PUT',
                        body: JSON.stringify({}),
                    }),
                (e) =>
                    toast(
                        t(
                            'doc.tree.couldnt-create-the-section',
                            "couldn't create the section: {message}",
                            {
                                message: e.message,
                            },
                        ),
                        { kind: 'error' },
                    ),
            );
        } catch (e) {
            toast(
                t('doc.tree.couldnt-create-the-section', "couldn't create the section: {message}", {
                    message: e.message,
                }),
                { kind: 'error' },
            );
        }
    };

    // Rename: a taxonomy's title is an ordinary annotation on its own id.
    const renameSection = async (taxId, currentTitle) => {
        const title =
            (await askText({
                title: t('doc.tree.rename-section-title', 'rename the section'),
                label: t('doc.tree.rename-section-name', 'Its new name:'),
                initial: currentTitle || '',
                ok: t('doc.tree.rename', 'rename'),
            })) || '';
        if (!title || title === currentTitle) return;
        show(
            (tr) => retitled(tr, taxId, title),
            () =>
                api(`/api/identity/${root}/docs/${taxId}/annotations/fields/title`, {
                    method: 'PUT',
                    body: JSON.stringify({ value: title }),
                }),
            (e) =>
                toast(
                    t('doc.tree.couldnt-rename-it', "couldn't rename it: {message}", {
                        message: e.message,
                    }),
                    { kind: 'error' },
                ),
        );
    };

    // Delete a section: unhook it from its parent, then delete it and every DESCENDANT section
    // (collected from the snapshot we're looking at). Pages are never deleted by this - with an
    // unfiled bin they land there (visible, re-fileable); WITHOUT one (a host that hides it)
    // they'd fall out of the tree with no way back in, so instead they're re-placed at the top
    // level FIRST, then the sections come down - place-before-remove, the
    // same ordering doctrine as a move, so a failure mid-way leaves visible duplicates, never a
    // page lost from the tree. A page that also lives in another section (a diamond) is left
    // alone - its other home keeps it in the tree already.
    const deleteSection = async (node, parentId) => {
        const descendants = sectionIdsUnder(node);
        const subs = descendants.length - 1;
        const name = node.title || t('doc.tree.untitled', '(untitled)');
        const whoa =
            subs === 0
                ? t('doc.tree.delete-section-whoa', 'Whoa there - delete the section “{name}”?', {
                      name,
                  })
                : subs === 1
                  ? t(
                        'doc.tree.delete-section-one-sub',
                        'Whoa there - delete the section “{name}”? Its 1 sub-section goes too.',
                        { name },
                    )
                  : t(
                        'doc.tree.delete-section-subs',
                        'Whoa there - delete the section “{name}”? Its {n} sub-sections go too.',
                        { name, n: subs },
                    );
        const kept = showUnfiled
            ? t(
                  'doc.tree.nothing-inside-unfiled',
                  'Nothing inside is deleted - it lands in unfiled.',
              )
            : t(
                  'doc.tree.nothing-inside-top',
                  'Nothing inside is deleted - it moves to the top level.',
              );
        if (
            !(await askYes({
                title: t('doc.tree.delete-section-title', 'delete the section'),
                body: `${whoa}\n\n${kept}`,
                yes: t('doc.tree.delete-it', 'delete it'),
                danger: true,
            }))
        )
            return;
        // Only the pages this delete would ORPHAN move to the root; one also filed elsewhere is
        // already kept in the tree by its other home.
        const orphans = !showUnfiled && tree ? [...docsInsideOnly(tree, descendants)] : [];
        show(
            (tr) =>
                withoutMember(
                    orphans.reduce(
                        (at, id) =>
                            withMember(at, at.taxonomy_id, { doc_id: id, doc: byId.get(id) || {} }),
                        tr,
                    ),
                    parentId,
                    node.taxonomy_id,
                ),
            async () => {
                if (orphans.length) {
                    const rid = await ensureRoot();
                    for (const id of orphans) {
                        await api(`/api/identity/${root}/taxonomies/${rid}/members/${id}`, {
                            method: 'PUT',
                            body: JSON.stringify({}),
                        });
                    }
                }
                await api(
                    `/api/identity/${root}/taxonomies/${parentId}/members/${node.taxonomy_id}`,
                    { method: 'DELETE' },
                );
                for (const id of descendants) {
                    await api(`/api/identity/${root}/taxonomies/${id}`, { method: 'DELETE' });
                }
            },
            (e) =>
                toast(
                    t('doc.tree.couldnt-delete-it', "couldn't delete it: {message}", {
                        message: e.message,
                    }),
                    { kind: 'error' },
                ),
        );
    };

    // The bucket's pages (live), the tree's filed doc ids, and the difference: unfiled.
    const pages = (docs || []).filter((d) => (d.buckets || []).includes(bucket));
    const byId = new Map(pages.map((d) => [d.doc_id, d]));
    const filed = filedDocIds(tree);
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
        const fail = (e) =>
            toast(
                t('doc.tree.couldnt-move-that', "couldn't move that: {message}", {
                    message: e.message,
                }),
                { kind: 'error' },
            );
        if (drop.unfile) {
            // Unfiling is pages-only: a section unhooked from every parent would be an
            // invisible orphan, so sections can't land here.
            if (drag.kind !== 'page' || !drag.parentId) return;
            show(
                (tr) => withoutMember(tr, drag.parentId, drag.id),
                () =>
                    api(`/api/identity/${root}/taxonomies/${drag.parentId}/members/${drag.id}`, {
                        method: 'DELETE',
                    }),
                fail,
            );
            return;
        }
        let destParent, index;
        if (drop.intoId) {
            destParent = drop.intoId; // append into a section (or the root)
            index = undefined;
        } else {
            if (drag.id === drop.refId) return; // dropped beside itself: nothing to do
            destParent = drop.parentNode.taxonomy_id;
            index = dropIndex(drop.parentNode.members, drag.id, drop.refId, drop.after);
        }
        if (drag.kind === 'section' && drag.taxIds && drag.taxIds.includes(destParent)) {
            return; // cycle: into itself or its own subtree (the server refuses these too)
        }
        // What lands is what was lifted: a section with its whole expansion, a page as its row
        // stood - or, from the unfiled bin, the page as the notebook's list holds it.
        const lifted = (drag.parentId && memberIn(tree, drag.parentId, drag.id)) || {
            doc_id: drag.id,
            doc: byId.get(drag.id) || {},
        };
        show(
            (tr) => {
                const moved = withMember(tr, destParent, lifted, index);
                return drag.parentId && drag.parentId !== destParent
                    ? withoutMember(moved, drag.parentId, drag.id)
                    : moved;
            },
            async () => {
                await api(`/api/identity/${root}/taxonomies/${destParent}/members/${drag.id}`, {
                    method: 'PUT',
                    body: JSON.stringify(index === undefined ? {} : { index }),
                });
                if (drag.parentId && drag.parentId !== destParent) {
                    await api(
                        `/api/identity/${root}/taxonomies/${drag.parentId}/members/${drag.id}`,
                        { method: 'DELETE' },
                    );
                }
            },
            fail,
        );
    };

    const ops = {
        docId: selected,
        select: onSelect,
        root,
        bucket,
        byId,
        hits,
        kind: searchKind,
        folded,
        toggleFold,
        newPage,
        newSection,
        renameSection,
        deleteSection,
        drag: dragRef,
        completeDrag,
        // The hosting app's word for one of its things, for row-level tooltips - SectionNode
        // reads it from here because the prop's scope ends at this component (field-found
        // 2026-07-30: a free `itemNoun` in SectionNode threw on the first section rendered,
        // and every subsequent render aborted mid-diff - orphaned panels piling up).
        itemNoun,
        book,
    };

    const empty = !tree || !(tree.members || []).length;

    return html`
        <aside
            class="tree-pane"
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
            ${onMinimize && html`<${PaneHead} icon=${Icons.tree} label=${t('doc.tree.tree', 'tree')} onTuck=${onMinimize} />`}
            <div class="tree-toolbar">
                <button class="tree-tool jag-line" data-settles onClick=${() => newPage(null)}>
                    <${Icons.pageNew} /> ${itemNoun}
                </button>
                <button class="tree-tool jag-line" onClick=${() => newSection(null)}>
                    <${Icons.sectionNew} /> ${t('doc.tree.section', 'section')}
                </button>
                <${EpubButton}
                    path=${`/api/identity/${root}/buckets/${encodeURIComponent(bucket)}/epub`}
                    fallback=${`${bucket}.epub`}
                />
            </div>
            ${tree && html`<${MemberList} node=${tree} depth=${0} ops=${ops} />`}
            ${
                empty &&
                !unfiled.length &&
                html`<p class="null-sub tree-empty">
                ${t('doc.tree.nothing-here-yet---start', 'nothing here yet - start a {itemNoun}, or a section to put them in.', { itemNoun })}
            </p>`
            }
            ${!!unfiled.length && html`<${UnfiledBin} unfiled=${unfiled} ops=${ops} />`}
        </aside>
    `;
};
