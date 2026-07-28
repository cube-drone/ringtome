// The wiki app: pages in a tree. The tree IS a taxonomy (PROJECT_PLAN, Taxonomies - trees are
// composition): one ROOT taxonomy per wiki bucket, associated by title convention
// (`wiki:<bucket>`), sections as child taxonomies placed inside their parent (titled, renameable
// - interior nodes are first-class), pages as document leaves. The left column renders the
// expanded tree straight off `GET /taxonomies/{root}` (refetched when the streamed roster
// ticks); the right is the shared Editor, same as Notes. Anything in the bucket but fallen out
// of the tree lands in an "unfiled" bin at the bottom - membership is honest, nothing is lost.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from './cache.js';
import { useSearch } from './search.js';
import { Editor } from './editor.js';
import { featuresOf } from './apps.js';
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

// The root taxonomy's title for a wiki bucket. The prefix keeps user-titled SECTIONS (also
// taxonomies, also on the roster) from ever colliding with a root lookup.
const rootTitleFor = (bucket) => `wiki:${bucket}`;

// The page you last had open, keyed `${root}:${app.id}` - the same session memory as Notes'
// last-open document (and the shell's last-open bucket). Forgotten on reload.
const lastPageMemory = new Map();

// One page leaf. Title reads LIVE from the mirror row (so an editor rename re-titles the tree
// immediately); the tree snapshot's summary is the fallback. A search filters pages out of the
// tree; sections stay as scaffolding.
const PageRow = ({ id, summary, depth, ops }) => {
    if (ops.hits !== null && !ops.hits.has(id)) return null;
    const live = ops.byId.get(id);
    const title = (live && live.title) || (summary && summary.title) || 'untitled';
    return html`<div
        class=${ops.docId === id ? 'wiki-row selected' : 'wiki-row'}
        style=${`padding-left: ${0.4 + depth * 0.9}rem`}
        onClick=${() => ops.select(id)}
    >
        <${Icons.page} />
        <span class="wiki-row-title">${title}</span>
    </div>`;
};

// One section (an interior taxonomy): a fold-toggling row with hover actions, then its members.
// `members: null` marks a stub - this section appears again elsewhere (a diamond's second
// parent, or a merge-minted cycle); its expansion lives at its first encounter, so render a
// marker, not a subtree.
const SectionNode = ({ node, parentId, depth, ops }) => {
    if (!node.members) {
        return html`<div class="wiki-row wiki-stub" style=${`padding-left: ${0.4 + depth * 0.9}rem`}>
            <${Icons.section} />
            <span class="wiki-row-title">${node.title || '(untitled section)'} ↩</span>
        </div>`;
    }
    const open = !ops.folded.has(node.taxonomy_id);
    return html`
        <div
            class="wiki-row wiki-row-section"
            style=${`padding-left: ${0.4 + depth * 0.9}rem`}
            onClick=${() => ops.toggleFold(node.taxonomy_id)}
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
                    title="delete this section (its pages land in unfiled)"
                    onClick=${() => ops.deleteSection(node, parentId)}
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
            parentId=${node.taxonomy_id}
            depth=${depth}
            ops=${ops}
        />`;
    }
    if (m.doc) {
        return html`<${PageRow} key=${m.doc_id} id=${m.doc_id} summary=${m.doc} depth=${depth} ops=${ops} />`;
    }
    return null;
})}`;

export const WikiApp = ({ app, current, docId, searchQuery, bucket }) => {
    const root = current.root;
    const loc = useLocation();
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const taxRows = useLive(() => openMirror(root).taxonomies.toArray(), [root]);
    const selected = docId || null;
    const select = (id) => loc.route(id ? `/home/${app.id}/${id}` : `/home/${app.id}`);

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

    // This wiki's root taxonomy, found on the streamed roster by the title convention. Ties
    // (two devices minting concurrently) resolve to the lowest id - the loser's root just goes
    // quietly unused.
    const rootRow = (taxRows || [])
        .filter((t) => t.title === rootTitleFor(bucket))
        .sort((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1))[0];
    // A root minted THIS session, before its roster row has streamed back.
    const [mintedRoot, setMintedRoot] = useState(null);
    const rootId = (rootRow && rootRow.taxonomy_id) || mintedRoot;

    // Mint the root lazily, on the first write that needs it - opening an empty wiki creates
    // nothing. The in-flight promise is the dedupe: rapid clicks share one create.
    const minting = useRef(null);
    useEffect(() => {
        minting.current = null;
        setMintedRoot(null);
    }, [root, bucket]);
    const ensureRoot = () => {
        if (rootId) return Promise.resolve(rootId);
        if (!minting.current) {
            minting.current = api(`/api/identity/${root}/taxonomies`, {
                method: 'POST',
                body: JSON.stringify({ title: rootTitleFor(bucket) }),
            }).then((r) => {
                setMintedRoot(r.taxonomy_id);
                return r.taxonomy_id;
            });
        }
        return minting.current;
    };

    // The expanded tree, fetched whole (a wiki is cozy-sized). Refetches when the roster
    // changes shape (any member count or title ticking over - the stream's whole-kind refresh
    // makes this cheap to detect) and after our own writes (`refetch`, no round-trip wait).
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
    }, [root, rootId, rosterKey, bump]);

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
            select(made.doc_id);
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
    // (collected from the snapshot we're looking at). Pages are never deleted by this - they
    // stay in the bucket and surface in the unfiled bin.
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
                    ` Pages are not deleted - they land in unfiled.`
            )
        )
            return;
        try {
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
    const unfiled = pages.filter((d) => !filed.has(d.doc_id));

    const hits = useSearch(root, searchQuery);

    const ops = {
        docId: selected,
        select,
        byId,
        hits,
        folded,
        toggleFold,
        newPage,
        newSection,
        renameSection,
        deleteSection,
    };

    const empty = !tree || !(tree.members || []).length;

    return html`
        <div class="wiki">
            <div class="wiki-columns">
                <aside class="wiki-tree">
                    <div class="wiki-toolbar">
                        <button class="wiki-tool" onClick=${() => newPage(null)}>
                            <${Icons.pageNew} /> page
                        </button>
                        <button class="wiki-tool" onClick=${() => newSection(null)}>
                            <${Icons.sectionNew} /> section
                        </button>
                    </div>
                    ${tree && html`<${MemberList} node=${tree} depth=${0} ops=${ops} />`}
                    ${empty &&
                    !unfiled.length &&
                    html`<p class="null-sub wiki-empty">
                        nothing here yet - start a page, or a section to put pages in.
                    </p>`}
                    ${!!unfiled.length &&
                    html`<div class="wiki-unfiled">
                        <div class="wiki-unfiled-title">unfiled</div>
                        ${unfiled.map(
                            (d) => html`<${PageRow}
                                key=${d.doc_id}
                                id=${d.doc_id}
                                summary=${d}
                                depth=${0}
                                ops=${ops}
                            />`
                        )}
                    </div>`}
                </aside>
                <div class="wiki-main">
                    ${selected
                        ? html`<${Editor}
                              root=${root}
                              docId=${selected}
                              key=${selected}
                              features=${featuresOf(app)}
                              onDeleted=${() => {
                                  select(null);
                                  refetch();
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
