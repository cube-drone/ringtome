// The documents app: the surface Writer wears, and Lost & Found with it - up to four
// columns, each tuckable. Left to right: the tag
// cloud, the document list (newest-claimed-date first, straight off the live mirror, so another
// computer's save re-sorts it within seconds and nothing fetches), the tree, and the open
// document. Which columns appear is the app registry's `features` (pure/apps.js); the document
// machinery underneath is shared (doc/), so a new app style is a registry line.
//
// Everything reusable has moved below this file: the routing/resume/nav spine is doc/docapp.js, the
// open document is doc/reader.js, the tree is doc/tree.js, the columns are panes.js. What is left
// here is this app's own arrangement of them - the filters, the list rows, the tag cloud - which is
// what let Recipes and Wikibook wear the same skeleton before they were folded back into
// Writer (2026-08-08), and what lets Lost & Found wear it now without importing a line.
import { h } from 'preact';
import {
    useState,
    useEffect,
    useLayoutEffect,
    useContext,
    useRef,
    useCallback,
    useMemo,
} from 'preact/hooks';
import { memo } from 'preact/compat';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from '../net.js';
import { RightColumn } from '../doc/reader.js';
import { Snippet } from '../doc/snippet.js';
import { DownloadButton } from '../doc/download.js';
import { listViewKey, usePref } from '../mirror/prefs.js';
import { useDocApp, useDocNav } from '../doc/docapp.js';
import { useSearch } from '../search.js';
import { hasClaimedDate, formatClaimed, DISPLAY_DATE_FIELD } from '../pure/docdate.js';
import { featuresOf, itemNoun, itemPlural, bucketHolds, FILES_BUCKET } from '../pure/apps.js';
import { noteByTitle } from '../pure/bytitle.js';
import { browseFiles, UNFILED } from '../pure/filebrowse.js';
import { filesHides, orderDocs, shownTags, tagCounts } from '../pure/doclist.js';
import { WikiTree, fileNewIntoTree } from '../doc/tree.js';
import { useColWidths, useColTucks, useNarrow, PaneHead, Rail, TagColumn } from '../panes.js';
import { LinksColumn } from '../doc/linkcol.js';
import { BucketShelf, BucketSwitcher } from '../buckets.js';
import { startDocDrag } from '../doc/crosslink.js';
import { Icons, formatIcon } from '../icons.js';
import { DrawingThumb } from '../doc/drawing.js';
import { blankDrawing, writeBody } from '../pure/drawing.js';
import { t } from '../i18n.js';
import { holdNewDoc, openMirror, useLive } from '../mirror.js';
import { docStatus, isTextDoc } from '../pure/feed.js';
import { BookColumn, useBookFacts, useBookTree } from '../doc/bookcol.js';
import { isBookBucket, hiddenDocsOf, pageStanding, titlePageOf } from '../pure/books.js';
import { docHref } from '../links.js';
import { FacetRow, TagFacetRow, narrowTitle } from '../facets.js';
import { togglePick } from '../pure/facets.js';
import { useStorage } from '../storage.js';
import { useGatedFeatures } from '../unlocks.js';
import { sizeLabel } from '../pure/backups.js';
import { formatWhen } from '../pure/when.js';
import { toast } from '../toasts.js';
import { BulkPanel } from '../doc/bulk.js';
import { longPress } from '../longpress.js';
import { pruneSelection, selectAll, toggleSelection } from '../pure/bulk.js';

const html = htm.bind(h);

const when = (ms) => formatWhen(ms);

// The three status icons (PUBLISH.md ruling 6), on every row.
const StatusMark = ({ doc, book }) => {
    // Inside a book, a page's standing against the last rollout replaces its own publish
    // status (PROJECT_PLAN's Books, ruling 6): hidden, new, changed, current. A picture filed in the
    // notebook is not a page; it wears nothing here.
    if (book && !isTextDoc(doc)) return null;
    if (book) {
        const standing = pageStanding(doc, book.hiddenDocs, book.hidden);
        const icon =
            standing === 'hidden'
                ? Icons.hidden
                : standing === 'new'
                  ? Icons.pageNew
                  : standing === 'changed'
                    ? Icons.update
                    : Icons.docPublic;
        const title =
            standing === 'hidden'
                ? t('apps.notes.hidden-from-the-book', 'hidden from the book')
                : standing === 'new'
                  ? t('apps.notes.new-since-the-last-rollout', 'new since the last rollout')
                  : standing === 'changed'
                    ? t(
                          'apps.notes.changed-since-the-last-rollout',
                          'changed since the last rollout',
                      )
                    : t('apps.notes.in-the-book-as-published', 'in the book as published');
        const cls =
            standing === 'hidden'
                ? 'note-row-status note-row-status-hidden'
                : standing === 'current'
                  ? 'note-row-status note-row-status-public'
                  : 'note-row-status note-row-status-pending';
        return html`<span class=${cls} title=${title}><${icon} /></span> `;
    }
    const status = docStatus(doc);
    const icon =
        status === 'scheduled'
            ? Icons.scheduled
            : status === 'public'
              ? Icons.docPublic
              : Icons.docPrivate;
    const title =
        status === 'scheduled'
            ? t('apps.notes.scheduled-to-publish', 'scheduled to publish')
            : status === 'public'
              ? t('apps.notes.published', 'published')
              : t('apps.notes.private', 'private');
    // Spelled out, so the dead-CSS convention can see each class.
    const cls =
        status === 'scheduled'
            ? 'note-row-status note-row-status-scheduled'
            : status === 'public'
              ? 'note-row-status note-row-status-public'
              : 'note-row-status note-row-status-private';
    return html`<span class=${cls} title=${title}><${icon} /></span> `;
};

/// How tall a row will draw, in rem, before it ever has (`contain-intrinsic-size: auto` keeps its
/// real height after): its title line (a picture's thumb is taller than the words), then each line
/// under it the row will show - the description up to its two-line clamp, a search's snippet, the
/// date, the tags. The content box only: `contain-intrinsic-size` adds the padding.
const rowGuess = (doc, feat, hits) => {
    const pictured = doc.format === 'drawing' || (doc.media && doc.media.has_thumb);
    const desc = feat.description && doc.fields && doc.fields.description;
    return (
        (pictured ? 2 : 1.3) +
        (desc ? (desc.length > 40 ? 2.1 : 1.1) : 0) +
        (hits !== null ? 2.6 : 0) +
        (feat.date || doc.diverged ? 0.9 : 0) +
        ((doc.tags || []).length > 0 ? 1 : 0)
    );
};

// One row in the list: title, and whatever this app has asked to show beneath it. Everything
// conditional here is a `features` flag or a piece of the document's own filing - a row with no
// description, no date and no tags is one line tall. Memoized below (`NoteRow`).
/// Shift-click selects (plans/BULK.md) - and in a browser it also stretches a text selection from
/// the last click to this one, painting half the list blue. Kept from starting, on the press.
const noShiftSelect = (e) => {
    if (e.shiftKey) e.preventDefault();
};

const NoteRowBody = ({
    doc,
    root,
    bucket,
    selected,
    feat,
    searchQuery,
    hits,
    tagFilter,
    onSelect,
    onToggleTag,
    book,
    titlePage,
    picked,
    bulk,
}) => html`<button
    class=${(bulk ? picked : doc.doc_id === selected) ? 'note-row jag-line selected' : 'note-row jag-line'}
    style=${`contain-intrinsic-size: auto ${rowGuess(doc, feat, hits)}rem`}
    data-settles
    onMouseDown=${noShiftSelect}
    onClick=${(e) => onSelect(doc.doc_id, e)}
    ...${longPress(() => onSelect(doc.doc_id, { shiftKey: true }))}
    draggable=${true}
    onDragStart=${(e) => startDocDrag(e, root, doc, bucket)}
>
    <span class="note-row-title">
        ${
            /* The document's standing in public (PUBLISH.md ruling 6): detective for private,
            globe for public, clock for scheduled - each in its own colour. */ ''
        }
        <${StatusMark} doc=${doc} book=${book} />
        ${
            titlePage
                ? html`<span class="note-row-pin" title=${t('apps.notes.the-books-title-page', "the book's title page")}><${Icons.titlePage} /></span> `
                : doc.pinned &&
                  html`<span class="note-row-pin" title=${t('apps.notes.pinned', 'pinned')}><${Icons.pin} /></span> `
        }
        ${
            doc.format === 'drawing'
                ? html`<${DrawingThumb} root=${root} doc=${doc} />`
                : doc.media && doc.media.has_thumb
                  ? html`<img
                  class="note-row-thumb"
                  src="/api/identity/${root}/docs/${doc.doc_id}/thumb?v=${doc.head}"
                  alt=""
                  loading="lazy"
                  onError=${(e) => {
                      // has_thumb but the blob hasn't reached this node yet (404): hide
                      // rather than show the browser's broken-image glyph; the next mirror
                      // refresh re-renders and retries.
                      e.currentTarget.style.display = 'none';
                  }}
              /> `
                  : formatIcon(doc.format) &&
                    html`<span class="note-row-kind"><${formatIcon(doc.format)} /></span> `
        }
        <span class=${doc.pinned ? 'note-row-title-text pinned' : 'note-row-title-text'}>${doc.title || t('apps.notes.untitled', 'untitled')}</span>
    </span>
    ${
        feat.description &&
        doc.fields &&
        doc.fields.description &&
        html`<small class="note-row-desc">${doc.fields.description}</small>`
    }
    ${hits !== null && html`<${Snippet} root=${root} docId=${doc.doc_id} query=${searchQuery} />`}
    ${
        (feat.date || doc.diverged) &&
        html`<span class="note-row-when">
        ${
            feat.date &&
            (hasClaimedDate(doc)
                ? html`<span
                  class="note-row-claimed"
                  title=${t('apps.notes.a-date-you-set-for', 'a date you set for this document (its real last edit was {p0})', { p0: when(doc.updated_ms) })}
              >${formatClaimed(doc.fields[DISPLAY_DATE_FIELD])}</span>`
                : when(doc.updated_ms))
        }${
            doc.diverged
                ? (feat.date ? ' · ' : '') + t('apps.notes.two-versions', 'two versions')
                : ''
        }
    </span>`
    }
    ${
        shownTags(doc.tags, tagFilter).length > 0 &&
        html`<span class="note-row-tags">
        ${shownTags(doc.tags, tagFilter).map(
            (t) => html`<span
                class=${tagFilter.includes(t) ? 'note-row-tag jag-line active' : 'note-row-tag jag-line'}
                key=${t}
                role="button"
                data-stays
                onClick=${(e) => {
                    e.stopPropagation();
                    onToggleTag(t);
                }}
            >${t}</span>`,
        )}
    </span>`
    }
</button>`;

/// A row re-renders only when something it shows moved (2026-10-08, from a Firefox profile of slow
/// typing: a shell re-render re-rendered every row, half a second of a 0.9 s freeze). Every prop by
/// identity - the list keeps them stable (`select` and `toggleTag` callbacks, `feat` and `book`
/// memoized) - but two:
///   - `doc`, by content: the mirror's live query hands back fresh row objects whenever the docs
///     table moves, which an autosave does every few seconds while you type;
///   - `selected`, the open document's id, which every row is handed: a row cares only whether
///     it is the one selected.
/// (`picked` and `bulk`, the bulk selection's, are booleans, so identity is enough for them.)
const sameRow = (a, b) => {
    for (const k of Object.keys(b)) {
        if (k === 'selected' || k === 'doc') continue;
        if (a[k] !== b[k]) return false;
    }
    if (a.doc !== b.doc) {
        // The mirror stamps each row as it is written (mirror.js): the same stamp is the same
        // row, a new one a changed one - no comparing every row's words on every save. A row
        // with no stamp (a mirror from before them) is compared as it was.
        const stamps = a.doc._v !== undefined && b.doc._v !== undefined;
        if (stamps ? a.doc._v !== b.doc._v : JSON.stringify(a.doc) !== JSON.stringify(b.doc))
            return false;
    }
    return (a.selected === a.doc.doc_id) === (b.selected === b.doc.doc_id);
};
const NoteRow = memo(NoteRowBody, sameRow);

// hrseFiles™ laid out as the picture picker is (Curtis, 2026-09-29): the notebooks, then the tags,
// then every file as a square tile - a picture or a drawing as itself, words as their icon and
// title. The same chips as the picker, so the two read as one design.
const FileTile = ({ doc, root, bucket, bytes, selected, onSelect, onFollowHome, picked, bulk }) => {
    const picture = doc.format === 'drawing' || (doc.media && doc.media.has_thumb);
    const Kind = formatIcon(doc.format) || Icons.page;
    return html`<li class="files-tile-slot">
        <button
            class=${(bulk ? picked : doc.doc_id === selected) ? 'files-tile selected' : 'files-tile'}
            title=${bytes > 0 ? `${doc.title || t('apps.notes.untitled', 'untitled')} — ${sizeLabel(bytes)}` : doc.title || ''}
            data-settles
            onMouseDown=${noShiftSelect}
            onClick=${(e) => onSelect(doc.doc_id, e)}
            ...${longPress(() => onSelect(doc.doc_id, { shiftKey: true }))}
            draggable=${true}
            onDragStart=${(e) => startDocDrag(e, root, doc, bucket)}
        >
            <span class=${picture ? 'files-tile-face drawing-floor' : 'files-tile-face'}>
                ${
                    doc.format === 'drawing'
                        ? html`<${DrawingThumb} root=${root} doc=${doc} big=${true} />`
                        : picture
                          ? html`<img
                            src="/api/identity/${root}/docs/${doc.doc_id}/thumb?v=${doc.head}"
                            alt=""
                            loading="lazy"
                            onError=${(e) => {
                                // has_thumb, but the blob is not on this node yet
                                e.currentTarget.style.display = 'none';
                            }}
                        />`
                          : html`<span class="files-tile-kind"><${Kind} /></span>`
                }
                ${doc.pinned && html`<span class="files-tile-pin" title=${t('apps.notes.pinned', 'pinned')}><${Icons.pin} /></span>`}
            </span>
            <span class="files-tile-title">
                <${StatusMark} doc=${doc} />
                <span class="files-tile-title-text">${doc.title || t('apps.notes.untitled', 'untitled')}</span>
            </span>
        </button>
        <button
            class="files-tile-home"
            data-settles
            title=${t('apps.notes.follow-me-home-open-this', 'follow me home — open this in its own app')}
            onClick=${() => onFollowHome(doc)}
        ><${Icons.path} /></button>
    </li>`;
};

/// The kind row's words (pure/filebrowse.js `FILE_KINDS`).
const FILE_KIND_NAMES = {
    post: () => t('apps.notes.kind-posts', 'posts'),
    drawing: () => t('apps.notes.kind-drawings', 'drawings'),
    image: () => t('apps.notes.kind-images', 'images'),
    audio: () => t('apps.notes.kind-audio', 'audio'),
    video: () => t('apps.notes.kind-videos', 'videos'),
};

const FileBrowser = ({
    root,
    bucket,
    browse,
    sizes,
    notebook,
    onNotebook,
    kinds,
    onToggleKind,
    tags,
    onToggleTag,
    selected,
    onSelect,
    onFollowHome,
    empty,
    pickedSet,
    onSelectAll,
    showPicked,
}) => html`<div
    class="files-browser"
>
    ${
        /* What kind of file, above everything (Curtis, 2026-10-02: "just get me images"): either of
        those picked. Only where there is a choice - files all of one kind offer none. */ ''
    }
    ${
        (browse.kinds.length > 1 || kinds.length > 0) &&
        html`<${FacetRow}
        label=${t('apps.notes.show', 'show')}
        items=${browse.kinds}
        picked=${kinds}
        out=${[]}
        onToggle=${onToggleKind}
        names=${FILE_KIND_NAMES}
        titleOf=${narrowTitle}
    />`
    }
    <div class="imagepick-buckets" role="group" aria-label=${t('doc.imagepick.notebook', 'notebook')}>
        <button class=${notebook ? 'imagepick-bucket' : 'imagepick-bucket active'} onClick=${() => onNotebook('')}>
            <${Icons.notebook} /> ${t('doc.imagepick.every-notebook', 'every notebook')}
        </button>
        ${browse.notebooks.map(
            (b) => html`<button
                key=${b}
                class=${notebook === b ? 'imagepick-bucket active' : 'imagepick-bucket'}
                onClick=${() => onNotebook(notebook === b ? '' : b)}
            ><${b === FILES_BUCKET ? Icons.filesBucket : Icons.notebook} /> ${b}</button>`,
        )}
        ${
            browse.unfiled &&
            html`<button
            class=${notebook === UNFILED ? 'imagepick-bucket active' : 'imagepick-bucket'}
            onClick=${() => onNotebook(notebook === UNFILED ? '' : UNFILED)}
        ><${Icons.lostFound} /> ${t('apps.notes.unfiled', 'unfiled')}</button>`
        }
    </div>
    ${
        /* The feed's facet row (Curtis, 2026-10-02: every tag at once took the whole browser once an
        import brought some 250): one line of the commonest, then "more" - in place for a few
        lines' worth, a search box past that. These tags only narrow, so a chip is on or off. */ ''
    }
    ${
        browse.cloud.length > 0 &&
        html`<${TagFacetRow}
        label=${t('apps.notes.tagged', 'tagged')}
        items=${[
            ...browse.cloud.map(([value, count]) => ({ value, count })),
            // A picked tag stays on the row whatever it counts here (2026-10-10): one no file
            // carries any more dropped off it, and the filter it made couldn't be taken back.
            ...tags
                .filter((tag) => !browse.cloud.some(([value]) => value === tag))
                .map((value) => ({ value, count: 0 })),
        ]}
        picked=${tags}
        out=${[]}
        onToggle=${onToggleTag}
        titleOf=${narrowTitle}
    />`
    }
    ${
        browse.files.length > 0 &&
        html`<p class="notes-count">
            ${t('apps.notes.files-count', '{n} files', { n: browse.files.length })}
            ${' · '}<button class="notes-select-all" onClick=${onSelectAll}>${t('apps.notes.select-all', 'select all')}</button>
            ${showPicked}
        </p>`
    }
    ${
        browse.files.length > 0
            ? html`<ul class="files-grid">
              ${browse.files.map(
                  (d) => html`<${FileTile}
                      key=${d.doc_id}
                      doc=${d}
                      root=${root}
                      bucket=${bucket}
                      bytes=${sizes && sizes[d.doc_id]}
                      selected=${selected}
                      onSelect=${onSelect}
                      onFollowHome=${onFollowHome}
                      picked=${pickedSet.has(d.doc_id)}
                      bulk=${pickedSet.size > 0}
                  />`,
              )}
          </ul>`
            : html`<p class="null-sub notes-empty">${empty}</p>`
    }
</div>`;

// The documents app - the shared surface a "documents" application (Writer, Lost & Found)
// currently renders. `app` is its registry entry (id, name, icon, style); the document
// machinery is the same, so a new app style is a registry line plus, later, its own layout.
// `searchQuery`, not `query` - preact-iso's Router injects its OWN `query` prop (parsed URL search
// params, an object), which would shadow a prop of that name and break the string search.
/// The list's own view of things - its tag filters, hrseFiles's notebook and kind picks, how far it
/// is scrolled - per persona and app, kept outside the app (Curtis, 2026-10-10: deleting a note
/// "forced what felt like a page refresh", clearing the tags and the list's scroll). A note at its
/// own address and the notebook's list are drawn under different routes (index.js `DocRoute`,
/// `AppRoute`), so going from one to the other - a delete, opening the first note - mounts a fresh
/// app; this is what it finds again. Per tab, like the last note open (doc/docapp.js).
const listViews = new Map();

export const DocsApp = ({
    app,
    current,
    docId,
    searchQuery,
    searchKind,
    bucket,
    missing = false,
}) => {
    const root = current.root;
    const feat = useGatedFeatures(root, featuresOf(app));
    const noun = itemNoun(app); // what this app calls one of its things, and many of them
    const nouns = itemPlural(app);
    const [busy, setBusy] = useState(false);
    const viewKey = `${root}:${app.id}`;
    const kept = listViews.get(viewKey) || {};
    const [tagFilter, setTagFilter] = useState(() => kept.tags || []); // active tag filters, stacked (AND)
    const [notebook, setNotebook] = useState(() => kept.notebook || ''); // hrseFiles's notebook pick: '' is every one
    const [kindFilter, setKindFilter] = useState(() => kept.kinds || []); // hrseFiles's kind picks: either of them
    useEffect(() => {
        listViews.set(viewKey, {
            ...listViews.get(viewKey),
            tags: tagFilter,
            notebook,
            kinds: kindFilter,
        });
    }, [viewKey, tagFilter, notebook, kindFilter]);
    // The list's scroll: noted as it moves, and put back once a fresh mount has rows to scroll.
    const listRef = useRef(null);
    const scrollBack = useRef(kept.scroll || 0);
    const noteScroll = (e) => {
        listViews.set(viewKey, { ...listViews.get(viewKey), scroll: e.currentTarget.scrollTop });
    };

    // The shared documents-app spine (doc/docapp.js): the live documents, the open document and how
    // to change it (it lives in the URL, so back/forward and deep links just work), the resume-where
    // -you-left-off jump, and the tree-reload bump a delete needs.
    const { docs, selected, select, forget, treeReload, bumpTree } = useDocApp(
        root,
        app,
        docId,
        bucket,
        { resume: !missing },
    );
    // The bulk selection (plans/BULK.md): Shift-click (a long press, on a phone) and "select all" fill it, and while it holds
    // anything the bulk panel stands where the open document would. The list's own, never the
    // address's - gone with a reload, as a file manager's is.
    const [picked, setPicked] = useState([]);
    const pickedSet = useMemo(() => new Set(picked), [picked]);
    // The row's click, stable for the memoized rows (`NoteRow`): Shift adds or takes away, the open
    // document along with the first; a plain click clears the selection and opens the one clicked
    // (Curtis, 2026-10-11).
    const openNow = useRef(selected);
    openNow.current = selected;
    const choose = useCallback(
        (id, e) => {
            if (e && e.shiftKey) {
                setPicked((p) => toggleSelection(p, id, openNow.current));
                return;
            }
            setPicked([]);
            select(id);
        },
        [select],
    );
    // Escape lets go, unless a modal is up - its own Escape is closing it.
    useEffect(() => {
        if (!picked.length) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape' && !document.querySelector('.modal-scrim')) setPicked([]);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [picked.length]);
    // A tag filter for a tag no document carries any more goes (Curtis, 2026-10-10: deleting the
    // last note with a tag left it picked - kept, now, across the remount - over a list showing
    // nothing). Judged once the mirror holds the documents, never on the empty first read.
    useEffect(() => {
        if (!docs || !docs.length || !tagFilter.length) return;
        const carried = new Set(docs.flatMap((d) => d.tags || []));
        if (tagFilter.every((tag) => carried.has(tag))) return;
        setTagFilter((f) => f.filter((tag) => carried.has(tag)));
    }, [docs, tagFilter]);
    // The notebook switcher heads the list column (2026-09-30; it was in the app header). A switcher
    // over one notebook offers a choice that isn't one.
    const shelf = useContext(BucketShelf);
    const switcher =
        shelf && app.style && !app.soleBucket
            ? html`<${BucketSwitcher} root=${root} app=${app} roster=${shelf.roster} bucket=${bucket} onSwitch=${shelf.onSwitch} />`
            : null;

    // The list: this app's scope, then the search hits, then every active tag, newest-claimed-date
    // first with pinned documents floating (pure/doclist.js holds the rules and their vectors).
    const hits = useSearch(root, searchQuery);
    // hrseFiles browses as the picture picker does (2026-09-29): its notebook pick and tags narrow
    // after the search, and the tiles are the list prev/next walks.
    // A notebook published as a book (PROJECT_PLAN's Books): the switch and the hidden marks, and the
    // tree that says which pages sit beneath a hidden section - read once here, worn by
    // the rows, the editor's bar, and the Publish column alike.
    const bookFacts = useBookFacts(root);
    const bookTree = useBookTree(root, bucket, treeReload);
    const bookOn = feat.bookColumn && isBookBucket(bookFacts.modes, bucket);
    const book = useMemo(
        () =>
            bookOn
                ? {
                      bucket,
                      hidden: bookFacts.hidden,
                      hiddenDocs: hiddenDocsOf(bookTree, bookFacts.hidden),
                      mark: bookFacts.mark,
                  }
                : null,
        [bookOn, bucket, bookFacts.hidden, bookFacts.mark, bookTree],
    );
    // Its title page is pinned implicitly, above every pin (Curtis, 2026-10-02): the page the book is
    // named by, and whose tags, description and date it wears, heads the list.
    const titlePage = bookOn
        ? titlePageOf(
              bookTree,
              (docs || []).filter((d) => bucketHolds(d, app, bucket) && isTextDoc(d)),
              bookFacts.hidden,
          )
        : null;

    // hrseFiles leaves out published feed posts and empty untitled text (pure/doclist.js
    // `filesHides`) - never the one open, so a new note made here doesn't vanish as it's made. The
    // empty ones come off the mirror's search bags, as one string, so the list re-renders only
    // when that set changes rather than on every save.
    const emptyBagIds = useLive(
        () =>
            app.everything
                ? openMirror(root)
                      .search.toArray()
                      .then((rows) =>
                          rows
                              .filter((r) => !(r.tokens || '').trim())
                              .map((r) => r.doc_id)
                              .sort()
                              .join(' '),
                      )
                : '',
        [root, app.everything],
    );
    const emptyBags = useMemo(
        () => (emptyBagIds ? new Set(emptyBagIds.split(' ')) : null),
        [emptyBagIds],
    );
    const listed = app.everything
        ? (docs || []).filter((d) => d.doc_id === selected || !filesHides(d, emptyBags))
        : docs;

    const ordered = orderDocs(listed, {
        app,
        bucket,
        hits,
        tags: app.everything ? [] : tagFilter,
        kind: searchKind,
        first: titlePage,
    });
    const browse = app.everything
        ? browseFiles(ordered, { notebook, tags: tagFilter, kinds: kindFilter })
        : null;
    // How many the notebook holds, unfiltered - the count under "+ new" (Curtis, 2026-10-10), which
    // says "12 of 120" while a search or a tag narrows the list.
    const holding = useMemo(
        () =>
            app.everything ? 0 : orderDocs(listed, { app, bucket, hits: null, tags: [] }).length,
        [listed, app, bucket],
    );
    // What the files take (storage.js): asked only in the browser, and again when the documents move.
    const storage = useStorage(
        app.everything ? root : null,
        docs
            ? `${docs.length}:${docs.reduce((m, d) => Math.max(m, d.updated_ms || 0), 0)}`
            : undefined,
    );
    const list = browse ? browse.files : ordered;
    // What leaves the list leaves the selection: deleted, moved out of the notebook in view, or
    // narrowed away by a search or a tag (pure/bulk.js `pruneSelection`).
    const listIds = list.map((d) => d.doc_id).join(' ');
    useEffect(() => {
        setPicked((p) => pruneSelection(p, listIds ? listIds.split(' ') : []));
    }, [listIds]);
    // Back to where the list was scrolled, once there are rows to scroll (`listViews`, above): before
    // paint, so it never shows from the top first.
    useLayoutEffect(() => {
        const el = listRef.current;
        if (!el || !scrollBack.current || !list.length) return;
        el.scrollTop = scrollBack.current;
        scrollBack.current = 0;
    }, [list.length]);

    // Lost & Found's follow-me-home: the document's own address, which opens it in its first
    // notebook's app (pure/naming.js `docPlacement`; the unbucketed stay here).
    const loc = useLocation();
    const followHome = (d) => loc.route(docHref(root, d.doc_id));

    const toggleTag = useCallback(
        (tag) => setTagFilter((f) => (f.includes(tag) ? f.filter((t) => t !== tag) : [...f, tag])),
        [],
    );

    // Counted over the SEARCH results (query + kind dial) rather than the tag-filtered list, so
    // the cloud narrows with a search but still shows every tag you could add.
    const tagCloud = feat.tagColumn
        ? tagCounts(orderDocs(listed, { app, bucket, hits, kind: searchKind }))
        : [];

    // Which columns are tucked away to a rail - column chrome, so panes.js owns it alongside the
    // widths. `startsTucked` is the app's own opening posture (Writer begins as a plain list,
    // its tag column and tree waiting as rails); a stored preference always wins over it.
    // In a narrow window (panes.js) the list is the tab it opens on while no note is chosen, and
    // choosing one closes the tab to show it.
    const { tucked, toggleTuck, settle, tab } = useColTucks(root, app.id, app.startsTucked, {
        lead: selected ? null : 'list',
    });
    useEffect(() => {
        if (selected) settle();
    }, [selected, settle]);
    // "select all": what the list shows now. A narrow window then shows the panel, as choosing one
    // shows the document.
    const pickAll = () => {
        setPicked(selectAll(list));
        settle();
    };
    // On a phone the list covers the bulk panel, and a long press (longpress.js) keeps it open to
    // pick more: the way through to what was picked, beside "select all".
    const narrow = useNarrow();
    const showPicked =
        narrow && picked.length > 0
            ? html`${' · '}<button class="notes-select-all" onClick=${settle}>${t('apps.notes.show-n-selected', 'show {n} selected', { n: picked.length })}</button>`
            : null;
    const tagsTucked = tucked.has('tags');
    // The list column's two orders, as tabs (Curtis, 2026-10-22: the notes column and the tree
    // column "both provide the same functionality, kind of, in different ways"): chronological,
    // or the notebook's tree - whichever this notebook was last read by. Only where the tree is
    // unlocked; everywhere else the column is the plain list it always was.
    const [listView, setListView] = usePref(root, listViewKey(app.id, bucket), 'list');
    const treeTab = !!feat.tree && !app.everything && listView === 'tree';
    // The tree's own new-section (and new-page) actions, reached from the column's toolbar.
    const treeTools = useRef(null);
    const publishTucked = tucked.has('publish');
    const linksTucked = tucked.has('links');

    // The tree's depth-first doc order (the "book order"), reported by the tree pane.
    const [treeOrder, setTreeOrder] = useState(null);

    // Column widths: each column left of the editor drags at its right edge (panes.js - the
    // shared resizer strips + `colw:` prefs + CSS-var plumbing).
    // The leftmost column has no ceiling in hrseFiles (Curtis, 2026-09-29): a grid of tiles earns
    // whatever room it is given.
    const { resizer, colStyle } = useColWidths(
        root,
        app.id,
        ['list', 'tags', 'links', 'publish'],
        {},
        app.everything ? ['list'] : [],
    );

    // Which order prev/next walks depends on what's showing: with the tree column open they read
    // it as a book (depth-first, and the tree wins when both columns are open); with it tucked or
    // absent they walk the list's time order, where NEXT goes back in time (the list reads
    // newest-first, so next is simply "down the list" - a tucked tree always walks this way). A document
    // missing from the tree (unfiled) falls back to the list rather than stranding the arrows.
    const listOrder = list.map((d) => d.doc_id);
    const treeShowing = treeTab;
    const bookish = treeShowing && treeOrder && selected && treeOrder.includes(selected);
    const nav = useDocNav(bookish ? treeOrder : listOrder, selected, select, {
        prev: bookish ? 'Previous — back up the tree' : 'Previous — newer',
        next: bookish ? 'Next — down the tree' : 'Next — older',
    });

    // `title`: what to call it (vim's `:e`, below); anything else - the button's click, a bare
    // `:enew` - makes it 'untitled'.
    const createNew = async (title) => {
        const named = typeof title === 'string' && title.trim() ? title.trim() : 'untitled';
        setPicked([]); // the new one opens, which the bulk panel would stand in front of
        setBusy(true);
        try {
            // New items are Marquee by default - the interactive editor is the front door;
            // the format chip converts to plaintext for anyone who wants a plain page. An app
            // with its own format says so (`newFormat`): the Drawing app makes a blank drawing.
            const format = app.newFormat || 'marquee';
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({
                    title: named,
                    body: format === 'drawing' ? writeBody(blankDrawing()) : '',
                    format,
                }),
            });
            // Open it now (2026-10-01: "that isn't here" until the stream brought the row): the
            // row is stated ahead of the stream, filed where it's going, and the filing follows.
            await holdNewDoc(root, made, { title: named, format, bucket });
            select(made.doc_id);
            // File it into the CURRENT bucket - the notebook you're looking at is the notebook
            // a new page lands in.
            await api(
                `/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(bucket)}`,
                { method: 'PUT' },
            );
            // Where there is a tree, a new document also takes its place in it - first in its top
            // level (2026-10-22), so a tree nobody has arranged reads newest first, as the list
            // does; visible and draggable into shape, rather than invisibly unfiled.
            // The tree pane shows it there at once, and reads the tree again once it's filed.
            if (feat.tree) {
                await fileNewIntoTree(root, bucket, made.doc_id, { title: named, format });
            }
        } catch (e) {
            toast(
                t('apps.notes.couldnt-make-a-new-one', "couldn't make a new one: {message}", {
                    message: e.message,
                }),
                { kind: 'error' },
            );
        } finally {
            setBusy(false);
        }
    };

    return html`
        <div class="notes">
            <div class="notes-columns panes" style=${colStyle}>
                ${
                    /* The list comes LAST of the columns, beside the editor (Curtis, 2026-10-23:
                    the rails between them fanned open every time the pointer crossed from a note
                    to its words - "distracting"). It stood leftmost until then, the filters
                    after it (2026-10-04). */ ''
                }
                ${
                    feat.tagColumn &&
                    (tagsTucked
                        ? html`<${Rail} icon=${Icons.tag} label=${t('apps.notes.tags', 'tags')} onClick=${() => toggleTuck('tags')} />`
                        : html`${tab('tags', Icons.tag, t('apps.notes.tags', 'tags'))}<${TagColumn}
                          cloud=${tagCloud}
                          active=${tagFilter}
                          onToggleTag=${toggleTag}
                          onTuck=${() => toggleTuck('tags')}
                      />${resizer('tags')}`)
                }
                ${/* What links to the open note, and what it links to (2026-09-30). */ ''}
                ${
                    feat.linkColumn &&
                    (linksTucked
                        ? html`<${Rail} icon=${Icons.link} label=${t('apps.notes.links', 'links')} onClick=${() => toggleTuck('links')} />`
                        : html`${tab('links', Icons.link, t('apps.notes.links', 'links'))}<${LinksColumn} root=${root} docId=${selected} docs=${docs} onTuck=${() => toggleTuck('links')} />${resizer('links')}`)
                }
                ${
                    feat.bookColumn &&
                    (publishTucked
                        ? html`<${Rail} icon=${Icons.book} label=${t('apps.notes.publish', 'publish')} onClick=${() => toggleTuck('publish')} />`
                        : html`${tab('publish', Icons.book, t('apps.notes.publish', 'publish'))}<${BookColumn}
                          root=${root}
                          bucket=${bucket}
                          docs=${(docs || []).filter((d) => bucketHolds(d, app, bucket))}
                          facts=${bookFacts}
                          tree=${bookTree}
                          onTuck=${() => toggleTuck('publish')}
                          onSelect=${choose}
                      />${resizer('publish')}`)
                }
                ${
                    tucked.has('list')
                        ? html`<${Rail} icon=${Icons.list} label=${nouns} onClick=${() => toggleTuck('list')} />`
                        : app.everything
                          ? html`${tab('list', Icons.list, nouns)}<aside class="notes-list notes-list-browser" ref=${listRef} onScroll=${noteScroll}>
                    <${PaneHead} icon=${Icons.list} label=${nouns} onTuck=${() => toggleTuck('list')} />
                    ${switcher}
                    <${FileBrowser}
                        root=${root}
                        bucket=${bucket}
                        browse=${browse}
                        sizes=${storage && storage.docs}
                        notebook=${notebook}
                        onNotebook=${setNotebook}
                        kinds=${kindFilter}
                        onToggleKind=${(k) => setKindFilter(togglePick(kindFilter, k))}
                        tags=${tagFilter}
                        onToggleTag=${toggleTag}
                        selected=${selected}
                        onSelect=${choose}
                        onFollowHome=${followHome}
                        pickedSet=${pickedSet}
                        onSelectAll=${pickAll}
                        showPicked=${showPicked}
                        empty=${!docs ? '' : hits === null ? t('apps.notes.nothing-here-yet', 'nothing here yet.') : t('apps.notes.nothing-matches', 'nothing matches.')}
                    />
                    ${/* The persona in all, held at the column's foot (Curtis, 2026-10-02). */ ''}
                    ${
                        storage &&
                        html`<p
                        class="files-foot"
                        title=${t('apps.notes.storage-foot-title', 'what moving this persona to another computer carries: every file, each version, and its own records')}
                    >${t('apps.notes.storage-foot', '{size} in all', { size: sizeLabel(storage.move_bytes) })}</p>`
                    }
                </aside>${resizer('list')}`
                          : html`${tab('list', Icons.list, nouns)}<aside class="notes-list" ref=${listRef} onScroll=${noteScroll}>
                    <${PaneHead} icon=${Icons.list} label=${nouns} onTuck=${() => toggleTuck('list')} />
                    ${switcher}
                    ${
                        /* The everything-view is for finding, not making - new things are born
                        in their own apps, where they land in a real notebook. */ ''
                    }
                    ${
                        feat.tree &&
                        html`<div class="notes-views" role="tablist">
                        <button
                            role="tab"
                            aria-selected=${!treeTab}
                            class=${treeTab ? 'tab jag-line-top' : 'tab jag-line-top active'}
                            onClick=${() => setListView('list')}
                        ><${Icons.list} /> ${t('apps.notes.view-chronological', 'chronological')}</button>
                        <button
                            role="tab"
                            aria-selected=${treeTab}
                            class=${treeTab ? 'tab jag-line-top active' : 'tab jag-line-top'}
                            onClick=${() => setListView('tree')}
                        ><${Icons.tree} /> ${t('apps.notes.view-tree', 'tree')}</button>
                    </div>`
                    }
                    ${
                        /* One toolbar for both tabs, in one style: a new note (into the tree's
                        root, which the tree tab then shows), a new section where there is a tree
                        to put it in, and the notebook as an ePub - in the order of the tab it was
                        asked from (Curtis, 2026-10-22). */ ''
                    }
                    <div class="notes-tools">
                        <button class="notes-tool jag-line" data-settles disabled=${busy} onClick=${() => createNew()}>
                            <${Icons.pageNew} /> ${busy ? '…' : t('apps.notes.new-thing', '+ {thing}', { thing: noun })}
                        </button>
                        ${
                            treeTab &&
                            html`<button class="notes-tool jag-line" onClick=${() => treeTools.current && treeTools.current.newSection(null)}>
                            <${Icons.sectionNew} /> ${t('apps.notes.new-section', '+ section')}
                        </button>`
                        }
                        ${
                            feat.tree &&
                            html`<${DownloadButton}
                            className="notes-tool jag-line"
                            base=${`/api/identity/${root}/buckets/${encodeURIComponent(bucket)}/download`}
                            query=${`?${treeTab ? '' : 'order=chronological&'}tz=${new Date().getTimezoneOffset()}`}
                            stem=${bucket}
                        />`
                        }
                    </div>
                    ${
                        docs &&
                        html`<p class="notes-count">
                            ${
                                list.length === holding
                                    ? t('apps.notes.count', '{n} {things}', {
                                          n: holding,
                                          things: holding === 1 ? noun : nouns,
                                      })
                                    : t('apps.notes.count-of', '{shown} of {n} {things}', {
                                          shown: list.length,
                                          n: holding,
                                          things: holding === 1 ? noun : nouns,
                                      })
                            }
                            ${
                                list.length > 0 &&
                                html`${' · '}<button class="notes-select-all" onClick=${pickAll}>${t('apps.notes.select-all', 'select all')}</button>`
                            }
                            ${showPicked}
                        </p>`
                    }
                    ${
                        tagFilter.length > 0 &&
                        html`<div class="notes-tagfilter">
                        ${
                            /* `tag`, never `t`: a parameter named `t` shadows the i18n t(), and the
                            title below then called a TAG STRING as a function - the first chip
                            threw, the render died, and every tag click looked like nothing
                            (2026-10-02; doc/annotations.js carries the same scar from 2026-08-29). */ ''
                        }
                        ${tagFilter.map(
                            (tag) => html`<button
                                class="annot-tag annot-tag-active jag-line"
                                key=${tag}
                                title=${t('apps.notes.remove-filter', 'remove filter')}
                                onClick=${() => toggleTag(tag)}
                            >${tag} ×</button>`,
                        )}
                    </div>`
                    }
                    ${
                        treeTab &&
                        html`${
                            /* The unfiled bin shows (Curtis, 2026-09-30: a note copied in
                            "doesn't join that bucket's taxonomy… it's forever lost"): the list
                            lists every note but can't file one, so a note that reached the
                            notebook any way but "+ new" waits in the bin, and drags from there
                            into place. The bin shows only while something's in it. */ ''
                        }<${WikiTree}
                            embedded=${true}
                            toolsRef=${treeTools}
                            root=${root}
                            bucket=${bucket}
                            selected=${selected}
                            onSelect=${choose}
                            searchQuery=${searchQuery}
                            searchKind=${searchKind}
                            tags=${tagFilter}
                            onToggleTag=${toggleTag}
                            picked=${pickedSet}
                            reloadKey=${treeReload}
                            showUnfiled=${true}
                            book=${book}
                            onOrder=${setTreeOrder}
                            itemNoun=${noun}
                        />`
                    }
                    ${(treeTab ? [] : list).map(
                        (d) => html`<${NoteRow}
                                  book=${book}
                            titlePage=${d.doc_id === titlePage}
                            key=${d.doc_id}
                            doc=${d}
                            root=${root}
                            bucket=${bucket}
                            selected=${selected}
                            feat=${feat}
                            searchQuery=${searchQuery}
                            hits=${hits}
                            tagFilter=${tagFilter}
                            onSelect=${choose}
                            onToggleTag=${toggleTag}
                            picked=${pickedSet.has(d.doc_id)}
                            bulk=${picked.length > 0}
                        />`,
                    )}
                    ${
                        !treeTab &&
                        docs &&
                        list.length === 0 &&
                        html`<p class="null-sub notes-empty">
                        ${hits === null ? t('apps.notes.nothing-here-yet', 'nothing here yet.') : t('apps.notes.nothing-matches', 'nothing matches.')}
                    </p>`
                    }
                </aside>${resizer('list')}`
                }
                ${
                    picked.length > 0
                        ? html`<${BulkPanel}
                    root=${root}
                    app=${app}
                    bucket=${app.everything ? '' : bucket}
                    docs=${picked.map((id) => (docs || []).find((d) => d.doc_id === id)).filter(Boolean)}
                    onClear=${() => setPicked([])}
                    onDeleted=${(ids) => {
                        ids.forEach(forget);
                        if (ids.includes(selected)) select(null);
                        bumpTree();
                    }}
                    onMoved=${bumpTree}
                />`
                        : html`<${RightColumn}
                    root=${root}
                    docId=${selected}
                    missing=${missing && !selected}
                    dropper=${!!app.everything}
                    onSelect=${select}
                    docs=${docs}
                    nav=${nav}
                    bucket=${bucket}
                    book=${book}
                    features=${feat}
                    onNew=${() => createNew()}
                    onOpen=${(title) => {
                        // `:e Title` (pure/bytitle.js): the note of that name in this notebook,
                        // or a new one by that name.
                        const found = noteByTitle(
                            (docs || []).filter((d) => bucketHolds(d, app, bucket)),
                            title,
                        );
                        if (found) select(found);
                        else createNew(title);
                    }}
                    onDeleted=${() => {
                        forget(selected);
                        select(null);
                        bumpTree();
                    }}
                />`
                }
            </div>
        </div>
    `;
};
