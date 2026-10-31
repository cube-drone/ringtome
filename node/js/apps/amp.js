// hrseAmp (plans/AUDIO.md, slices 1 and 2): music. A table of every sound you can see - your own,
// from the mirror, and the sound in your feed at the curiosity dial, from the node (`/amp/library`)
// - sortable, its columns resized and hidden as you like, its rows selected one, several or all; the
// file panel beside it for what's selected; and the player across the foot (player.js), which plays
// the table as it stands.
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { openMirror, optimisticDoc, useLive } from '../mirror.js';
import { usePref } from '../mirror/prefs.js';
import { appById } from '../pure/apps.js';
import {
    COLUMNS,
    COLUMN_MIN,
    SOUND_FIELDS,
    clickSelect,
    clock,
    feedRow,
    layerKey,
    ownRow,
    readLayer,
    readTableSettings,
    searched,
    sorted,
    wordTags,
} from '../pure/amp.js';
import { formatWhen } from '../pure/when.js';
import { speakable } from '../speakable.js';
import { SoundTags } from '../doc/soundtags.js';
import { BulkPanel } from '../doc/bulk.js';
import { usePlayer, PlayerBar, Cassette, Thumbs, SHUFFLE, songForPhone } from '../player.js';
import { spreadOrder } from '../pure/shuffle.js';
import { AMP_PINS, readPins, pinKey, pinnedLists, pinnedFirst } from '../pure/amppins.js';
import { postHref, appHref } from '../links.js';
import { noteThing, forgetThing, playlistThing } from '../mirror/recents.js';
import { useLocation } from 'preact-iso';
import { Icons } from '../icons.js';
import { toast } from '../toasts.js';
import { t } from '../i18n.js';
import { askText, askYes } from '../modal.js';
import { FacetRow } from '../facets.js';
import {
    AMP_STATIONS,
    StationRun,
    readStations,
    shares,
    sliceTrail,
    stationValue,
    wouldLoop,
} from '../pure/stations.js';
import {
    dropIndex,
    inMixtapeOrder,
    isMixtape,
    mixtapeTitle,
    mixtapesBySong,
    notYetIn,
    readMixtape,
} from '../pure/mixtapes.js';
import { Chip } from '../doc/chips.js';
import { useColWidths, useColTucks, useNarrow, PaneHead, Rail } from '../panes.js';
import { longPress, pressedLong } from '../longpress.js';
import { STOP_WORDS } from '../curiosity.js';
import { SELECTIVITY_STOPS, DEFAULT_STOP } from '../pure/selectivity.js';
import {
    AMP_FILTERS,
    FILTER_ROWS,
    LEFT_OUT,
    NO_AMP_PICKS,
    ampPickState,
    anyAmpPicks,
    anyRange,
    byDuplicateGroup,
    cycleDupes,
    dupeMode,
    duplicateGroups,
    readLength,
    cycleAmpPick,
    filterSettings,
    filterValue,
    narrowedSongs,
    readFilters,
    sameFilter,
    songFacets,
} from '../pure/ampfilters.js';

/// Each mixtape as last read, by `root:id`, with the roster entry it was read under.
const keptTapes = new Map();
const html = htm.bind(h);

/// The private register your layer on other people's songs lives in (ruling 6), and the device pref
/// the table's columns live in.
const LAYER = 'amp_layer';
const TABLE_PREF = 'amp-table';
/// A row's height, in pixels: the table draws only the rows in view, and this is how it knows which.
/// A phone's is a thumb's, with the artist under the title (Curtis, 2026-10-12, the mobile pass).
const ROW_HEIGHT = 30;
const ROW_HEIGHT_NARROW = 46;
/// Two taps on one row this close together, in milliseconds, are a double-tap: a phone's double-click.
const DOUBLE_TAP = 400;
const OVERSCAN = 12;

/// The columns' names, as the header says them.
const COLUMN_WORDS = {
    title: () => t('amp.col-title', 'title'),
    artist: () => t('amp.col-artist', 'artist'),
    album: () => t('amp.col-album', 'album'),
    number: () => t('amp.col-number', '#'),
    year: () => t('amp.col-year', 'year'),
    genre: () => t('amp.col-genre', 'genre'),
    length: () => t('amp.col-length', 'length'),
    tags: () => t('amp.col-tags', 'tags'),
    notebook: () => t('amp.col-notebook', 'notebook'),
    by: () => t('amp.col-by', 'posted by'),
    from: () => t('amp.col-from', 'via'),
    date: () => t('amp.col-date', 'date added'),
    score: () => t('amp.col-score', 'score'),
};

/// What the two people columns mean, in their headers' hover: they're easy to mix up.
const COLUMN_HINTS = {
    by: () => t('amp.col-by-hint', 'who posted the file'),
    from: () =>
        t('amp.col-from-hint', 'who it reached you through: you, who posted it, or who shared it'),
};

/// The sound fields' names, as the panel says them.
const FIELD_WORDS = {
    track: () => t('amp.field-track', 'title'),
    artist: () => t('amp.field-artist', 'artist'),
    album: () => t('amp.field-album', 'album'),
    'album artist': () => t('amp.field-album-artist', 'album artist'),
    composer: () => t('amp.field-composer', 'composer'),
    genre: () => t('amp.field-genre', 'genre'),
    year: () => t('amp.field-year', 'year'),
    'track number': () => t('amp.field-track-number', 'track number'),
};

/// A cell's class: numbers line up on the right, and the title wears the playing song's colour.
const NUMERIC = new Set(['length', 'number']);
const cellClass = (key) =>
    key === 'title' ? 'amp-td amp-td-title' : NUMERIC.has(key) ? 'amp-td amp-td-numeric' : 'amp-td';

/// A person's name for the By and From columns: theirs as the node knows it, else their words.
const nameOf = (names, root) =>
    names[root] || (root ? speakable(root).split('-').slice(0, 2).join('-') : '');

function cell(row, key, names) {
    switch (key) {
        case 'length':
            return clock(row.lengthMs);
        case 'tags':
            return wordTags(row.tags).join(', ');
        case 'by':
            return nameOf(names, row.author);
        case 'from':
            return nameOf(names, row.from);
        case 'date':
            return row.dateMs ? formatWhen(row.dateMs, Date.now(), { time: false }) : '';
        case 'score':
            return (row.reactions || []).map(([emoji, n]) => `${emoji} ${n}`).join('  ');
        case 'number':
            return row.number == null ? '' : String(row.number);
        default:
            return row[key] || '';
    }
}

/// The cells drawn as more than words (Curtis, 2026-10-12): tags as bubbles, and the reactions a
/// song has collected, each with how many said it. Anything else, its words (`cell`).
/// What the player may play: a song this server carries (rights.rs, the fence).
const playable = (rows) => rows.filter((r) => r.carried !== false);

function richCell(row, key) {
    if (key === 'title' && row.carried === false)
        return html`${row.title}<span class="amp-uncarried" title=${t('rights.not-carried', "this song isn't carried on this server - its operator's choice")}>${t('amp.not-carried-here', 'not carried here')}</span>`;
    if (key === 'tags')
        return wordTags(row.tags).map(
            (tag) => html`<span key=${tag} class="amp-tag">${tag}</span>`,
        );
    if (key === 'score')
        return (row.reactions || []).map(
            ([emoji, n]) =>
                html`<span key=${emoji} class="amp-reacted">${emoji}<span class="amp-reacted-count">${n}</span></span>`,
        );
    return null;
}

/// Your layer of fields on someone else's song (ruling 6): each of theirs beside a box for yours,
/// saved as you leave the box. An emptied box is yours no longer, and theirs shows again.
const LayerFields = ({ root, rows, layer, onLayer }) => {
    const one = rows.length === 1 ? rows[0] : null;
    const save = async (field, value) => {
        const v = value.trim();
        try {
            for (const r of rows) {
                await api(
                    `/api/identity/${root}/private/kv/${LAYER}/${encodeURIComponent(layerKey(r.author, r.doc, field))}`,
                    {
                        method: 'PUT',
                        body: JSON.stringify({ value: v }),
                    },
                );
            }
            onLayer(rows, field, v);
        } catch (e) {
            toast(t('amp.couldnt-save', "couldn't save that: {message}", { message: e.message }), {
                kind: 'error',
            });
        }
    };
    return html`<dl class="amp-layer">
        ${SOUND_FIELDS.map((field) => {
            const theirs = one ? one.fields[field] || '' : '';
            const mine = one ? (layer[one.key] || {})[field] || '' : '';
            return html`<div class="amp-layer-row" key=${field}>
                <dt>${FIELD_WORDS[field]()}</dt>
                <dd>
                    ${one && html`<span class="amp-layer-theirs" title=${t('amp.theirs', 'theirs')}>${theirs || '—'}</span>`}
                    <input
                        class="jag-field amp-layer-input"
                        key=${`${one ? one.key : 'many'}:${field}`}
                        placeholder=${one ? t('amp.yours', 'yours') : t('amp.set-for-all', 'set for all of them')}
                        defaultValue=${mine}
                        onBlur=${(e) => {
                            if (e.currentTarget.value.trim() !== mine)
                                save(field, e.currentTarget.value);
                        }}
                    />
                </dd>
            </div>`;
        })}
    </dl>`;
};

/// Your thumbs on a song - 'up', 'down', or '' taken back - kept in your layer: the score of a
/// sound of yours (ruling 3), and for any song, how often the shuffle brings it round
/// (pure/shuffle.js `rated`).
async function rate(root, row, value, onLayer) {
    await api(
        `/api/identity/${root}/private/kv/${LAYER}/${encodeURIComponent(layerKey(row.author, row.doc, 'reaction'))}`,
        {
            method: 'PUT',
            body: JSON.stringify({ value }),
        },
    ).catch(() => {});
    onLayer([row], 'reaction', value);
}

/// A like or a dislike of your own sound (ruling 3): its score, which only you can give a sound
/// nobody else can see. Kept in your layer.
const Reaction = ({ root, row, onLayer }) => {
    const now = (row.layer && row.layer.reaction) || '';
    const set = (value) => rate(root, row, now === value ? '' : value, onLayer);
    return html`<span class="amp-reaction">
        <button class=${now === 'up' ? 'chip chip-button chip-open' : 'chip chip-button'} onClick=${() => set('up')} title=${t('amp.like', 'like')}>👍</button>
        <button class=${now === 'down' ? 'chip chip-button chip-open' : 'chip chip-button'} onClick=${() => set('down')} title=${t('amp.dislike', 'dislike')}>👎</button>
    </span>`;
};

/// Delete your own songs among `rows` (Curtis, 2026-10-12: one or many, from the panel's head): out
/// of every list at once, and back if the node refuses, as hrseFiles deletes. Someone else's songs
/// aren't yours to delete, and the ones that came with the app stay.
async function deleteSongs(root, rows, onDeleted) {
    const own = rows.filter((r) => r.own && !r.builtin);
    if (!own.length) return;
    const sure = await askYes({
        title:
            own.length === 1
                ? t('amp.delete-song-title', 'delete the song')
                : t('amp.delete-songs-title', 'delete {n} songs', { n: own.length }),
        body:
            own.length === 1
                ? t('amp.delete-one', 'Delete "{title}"? It leaves every list right away.', {
                      title: own[0].title,
                  })
                : t('amp.delete-many', 'Delete your {n} songs? They leave every list right away.', {
                      n: own.length,
                  }),
        yes:
            own.length === 1
                ? t('amp.delete-it', 'delete it')
                : t('amp.delete-them', 'delete them'),
        danger: true,
    });
    if (!sure) return;
    let failed = 0;
    for (const r of own) {
        try {
            await optimisticDoc(
                root,
                r.doc,
                () => null,
                (d) => !d,
                () => api(`/api/identity/${root}/docs/${r.doc}`, { method: 'DELETE' }),
            );
        } catch {
            failed += 1;
        }
    }
    if (failed) {
        toast(t('amp.n-not-deleted', "{n} couldn't be deleted", { n: failed }), { kind: 'error' });
    } else {
        toast(t('amp.deleted-n', 'deleted {n}', { n: own.length }));
    }
    onDeleted();
}

/// The panel's head (Curtis, 2026-10-12): what's selected, as a heading ruled off underneath, and
/// under it the actions - delete first, in the danger colour (the house's order for a row of
/// actions), then whatever else the panel adds.
const PanelHead = ({ root, rows, title, onDeleted, children = null }) => {
    const own = rows.filter((r) => r.own && !r.builtin);
    const del =
        own.length > 0 &&
        html`<button
            class="chip chip-button amp-delete"
            title=${rows.length === 1 ? t('amp.delete-this-song', 'delete this song') : t('amp.delete-your-n', 'delete your {n} of these', { n: own.length })}
            aria-label=${t('amp.delete', 'delete')}
            onClick=${() => deleteSongs(root, rows, onDeleted)}
        ><${Icons.trash} /></button>`;
    return html`<h2 class="amp-panel-title">${title}</h2>
        ${(del || children) && html`<div class="amp-panel-actions">${del}${children}</div>`}`;
};

/// What's selected, in the file column: one of your sounds, its own panel; one of someone else's, its
/// fields beside yours; several, the bulk panel for yours and your layer for theirs.
const FilePanel = ({ root, rows, docRows, layer, onLayer, onClear, onDeleted, mixtapes }) => {
    const own = rows.filter((r) => r.own && !r.builtin);
    const theirs = rows.filter((r) => !r.own);
    const files = appById('lost-found');
    if (rows.length === 1) {
        const r = rows[0];
        return html`<div class="amp-panel-body">
            <${PanelHead} root=${root} rows=${rows} title=${r.title} onDeleted=${onDeleted}>
                <${MixtapeActions} rows=${rows} ...${mixtapes} />
            <//>
            ${r.own && !r.builtin && html`<${SoundTags} root=${root} docId=${r.doc} score=${html`<${Reaction} root=${root} row=${r} onLayer=${onLayer} />`} />`}
            ${r.builtin && html`<${SoundTags} root=${root} docId=${r.doc} readOnly=${true} />`}
            ${
                !r.own &&
                html`<p class="null-sub">
                    ${t('amp.theirs-yours-beside', 'Their fields, and yours beside them: yours are only yours, and win in your table.')}
                    ${r.post && html` <a href=${postHref(r.author, r.post)}>${t('amp.the-post', 'the post it came in')}</a>`}
                </p>
                <${LayerFields} root=${root} rows=${[r]} layer=${layer} onLayer=${onLayer} />`
            }
        </div>`;
    }
    return html`<div class="amp-panel-body">
        <${PanelHead} root=${root} rows=${rows} title=${t('amp.n-selected', '{n} selected', { n: rows.length })} onDeleted=${onDeleted}>
            <button class="chip chip-button" onClick=${onClear}>${t('amp.clear', 'clear')}</button>
            <${MixtapeActions} rows=${rows} ...${mixtapes} />
        <//>
        ${
            own.length > 0 &&
            html`<${BulkPanel}
                root=${root}
                app=${files}
                bucket=""
                docs=${own.map((r) => docRows.get(r.doc)).filter(Boolean)}
                onClear=${onClear}
                onDeleted=${onDeleted}
                onMoved=${() => {}}
                moves=${false}
                deletes=${false}
                head=${false}
                ruled=${true}
            />`
        }
        ${
            theirs.length > 0 &&
            html`<h3 class="amp-panel-sub">${t('amp.n-of-other-peoples', "{n} of other people's: your fields", { n: theirs.length })}</h3>
            <${LayerFields} root=${root} rows=${theirs} layer=${layer} onLayer=${onLayer} />`
        }
    </div>`;
};

/// The strip's rows, in words.
const ROW_WORDS = {
    from: () => t('amp.row-from', 'via'),
    artists: () => t('amp.row-artists', 'artist'),
    genres: () => t('amp.row-genres', 'genre'),
    mixtapes: () => t('amp.row-mixtapes', 'mixtape'),
    tags: () => t('amp.row-tags', 'tags'),
};

const CHIP_CLASS = { only: 'facet-chip facet-chip-on', out: 'facet-chip facet-chip-out' };

/// The picks this tab keeps (as the feed's are kept: a refresh finds them picked), per persona.
const PICKS_KEY = (root) => `amp-picks:${root}`;
const readPicks = (root) => {
    try {
        const p = JSON.parse(sessionStorage.getItem(PICKS_KEY(root)) || 'null');
        return p && typeof p === 'object' ? { ...NO_AMP_PICKS, ...p } : NO_AMP_PICKS;
    } catch {
        return NO_AMP_PICKS;
    }
};
const writePicks = (root, picks) => {
    try {
        if (anyAmpPicks(picks)) sessionStorage.setItem(PICKS_KEY(root), JSON.stringify(picks));
        else sessionStorage.removeItem(PICKS_KEY(root));
    } catch {
        /* no storage: the picks live for the page */
    }
};

/// "Probable duplicates", three-state as a tag's chip (Curtis, 2026-10-12): a press shows only the
/// songs with a probable copy, each set together; another leaves the copies out, one of each
/// staying; a third shows everything again.
const DupesChip = ({ picks, onPicks }) => {
    const mode = dupeMode(picks);
    const title =
        mode === 'only'
            ? t(
                  'amp.dupes-only-title',
                  'showing only probable duplicates - click to keep one of each instead',
              )
            : mode === 'out'
              ? t(
                    'amp.dupes-out-title',
                    'one of each: probable copies left out, your own copy kept first - click to show everything again',
                )
              : t(
                    'amp.dupes-title',
                    'songs that look like copies of one another - the same title, the same artist where both say one, and within five seconds. Click to show only them; click again to keep one of each',
                );
    return html`<button
        class=${mode === 'only' ? 'facet-chip facet-chip-on' : mode === 'out' ? 'facet-chip facet-chip-out' : 'facet-chip'}
        title=${title}
        onClick=${() => onPicks(cycleDupes(picks))}
    >${t('amp.dupes-chip', 'probable duplicates')}</button>`;
};

/// The ranges' boxes (Curtis, 2026-10-12): a year from and to, and a length from and to - typed as
/// "3:30" or a number of minutes. Each takes effect as it's left, or on Enter.
const RangeBoxes = ({ picks, onPicks }) => {
    const set = (key, value) => onPicks({ ...picks, [key]: value });
    // Enter takes it, as leaving the box does.
    const enter = (e) => e.key === 'Enter' && e.currentTarget.blur();
    const year = (key, placeholder) => html`<input
        class="jag-field amp-range-box"
        type="number"
        inputmode="numeric"
        placeholder=${placeholder}
        key=${`${key}:${picks[key] ?? ''}`}
        defaultValue=${picks[key] ?? ''}
        onKeyDown=${enter}
        onBlur=${(e) => {
            const v = parseInt(e.currentTarget.value, 10);
            const next = Number.isFinite(v) ? v : null;
            if (next !== (picks[key] ?? null)) set(key, next);
        }}
    />`;
    const length = (key, placeholder) => html`<input
        class="jag-field amp-range-box"
        placeholder=${placeholder}
        key=${`${key}:${picks[key] ?? ''}`}
        defaultValue=${picks[key] != null ? clock(picks[key] * 1000) : ''}
        title=${t('amp.length-title', 'minutes and seconds, as 3:30 - or just minutes')}
        onKeyDown=${enter}
        onBlur=${(e) => {
            const next = readLength(e.currentTarget.value);
            if (next !== (picks[key] ?? null)) set(key, next);
        }}
    />`;
    // A row of the stack each, as the chip rows are (Curtis, 2026-10-12).
    return html`<div class="facet-row amp-range-row">
            <span class="facet-row-label">${t('amp.year', 'year')}</span>
            ${year('yearMin', t('amp.from', 'from'))}–${year('yearMax', t('amp.to', 'to'))}
        </div>
        <div class="facet-row amp-range-row">
            <span class="facet-row-label">${t('amp.length', 'length')}</span>
            ${length('lengthMin', t('amp.at-least', 'at least'))}–${length('lengthMax', t('amp.at-most', 'at most'))}
        </div>`;
};

/// The ranges in words, for the folded strip: "year 1990–1999", "length 2:00–", or nothing.
const rangeWords = (picks) => {
    const span = (a, b) => `${a ?? ''}–${b ?? ''}`;
    const out = [];
    if (picks.yearMin != null || picks.yearMax != null)
        out.push(
            t('amp.year-range', 'year {range}', { range: span(picks.yearMin, picks.yearMax) }),
        );
    if (picks.lengthMin != null || picks.lengthMax != null)
        out.push(
            t('amp.length-range', 'length {range}', {
                range: span(
                    picks.lengthMin != null ? clock(picks.lengthMin * 1000) : null,
                    picks.lengthMax != null ? clock(picks.lengthMax * 1000) : null,
                ),
            }),
        );
    return out;
};

/// The filter strip (plans/AUDIO.md, section 3): folded, a line of what is picked, each chip still
/// cycling; open, the curiosity dial, whose tags count, "clear all" and "save filter", then a row
/// of chips each for who it came through, artist, genre and tags. `wordOf(row, value)` says a value;
/// `iconOf(row, value)` names its icon, if any.
const FilterStrip = ({
    songs,
    picks,
    onPicks,
    stop,
    onStop,
    scope,
    onScope,
    onSave,
    loaded,
    now,
    wordOf,
    iconOf,
    me,
}) => {
    const [open, setOpen] = useState(false);
    const facets = useMemo(() => songFacets(songs, picks, scope), [songs, picks, scope]);
    const narrowed = anyAmpPicks(picks);
    const glyph = (row, v) => {
        const role = iconOf(row, v);
        return role && Icons[role] ? html`<${Icons[role]} />` : null;
    };
    const picked = FILTER_ROWS.flatMap((row) =>
        [...(picks[row] || []), ...(picks[LEFT_OUT[row]] || [])].map((v) => [row, v]),
    );
    const words = [
        html`<span key="stop" class="facets-picked-word">${t('apps.feed.feed-curiosity', 'feed curiosity:')} ${STOP_WORDS[stop] ? STOP_WORDS[stop]() : ''}</span>`,
        scope === 'ours' &&
            html`<span key="scope" class="facets-picked-word">${t('amp.scope-ours', "only the author's tags and yours")}</span>`,
    ].filter(Boolean);
    return html`<div class="amp-filters">
        <div class="amp-filters-head">
            <${Chip}
                title=${t('amp.filters', 'filters')}
                on=${open}
                modifier=${narrowed ? 'feed-options-chip feed-options-narrowed' : 'feed-options-chip'}
                onClick=${() => setOpen((o) => !o)}
            ><${Icons.filter} /><span>${t('amp.filters', 'filters')}</span><//>
            ${
                !open &&
                html`<div class="facets-picked">
                ${words}
                ${
                    anyRange(picks) &&
                    html`<button
                        class="facet-chip facet-chip-on"
                        title=${t('amp.clear-ranges', 'clear the year and length ranges')}
                        onClick=${() => onPicks({ ...picks, yearMin: null, yearMax: null, lengthMin: null, lengthMax: null })}
                    >${rangeWords(picks).join(', ')} ×</button>`
                }
                ${dupeMode(picks) && html`<${DupesChip} picks=${picks} onPicks=${onPicks} />`}
                ${picked.map(
                    ([row, v]) => html`<button
                        key=${`${row}:${v}`}
                        class=${CHIP_CLASS[ampPickState(picks, row, v)]}
                        onClick=${() => onPicks(cycleAmpPick(picks, row, v))}
                    >${glyph(row, v)}${wordOf(row, v)}</button>`,
                )}
            </div>`
            }
        </div>
        ${
            open &&
            html`<div class="feed-options jag-line">
            <div class="feed-top">
                <label class="feed-selectivity" title=${t('apps.feed.how-far-past-the-people', 'how far past the people you chose this feed may reach')}>
                    <span class="feed-selectivity-name">${t('apps.feed.feed-curiosity', 'feed curiosity:')}</span>
                    <input
                        type="range"
                        min="0"
                        max=${SELECTIVITY_STOPS.length - 1}
                        value=${SELECTIVITY_STOPS.findIndex((s) => s.key === stop)}
                        onInput=${(e) => onStop(SELECTIVITY_STOPS[Number(e.currentTarget.value)].key)}
                    />
                    <span class="feed-selectivity-label">${STOP_WORDS[stop] ? STOP_WORDS[stop]() : ''}</span>
                </label>
                <button
                    class=${scope === 'ours' ? 'facet-chip facet-chip-on' : 'facet-chip'}
                    title=${t('amp.scope-title', "count only the tags the song's author put on it, and your own - not everyone's you can see")}
                    onClick=${() => onScope(scope === 'ours' ? 'all' : 'ours')}
                >${t('amp.scope-ours-chip', "author's and mine")}</button>
                <${DupesChip} picks=${picks} onPicks=${onPicks} />
                <button
                    class="facet-more feed-clear"
                    disabled=${!narrowed}
                    title=${t('amp.clear-all-title', 'show every song again - every chip back to unpicked')}
                    onClick=${() => onPicks(NO_AMP_PICKS)}
                >${t('apps.feed.clear-all', 'clear all')}</button>
                ${
                    loaded &&
                    !sameFilter(loaded, now) &&
                    html`<button
                        class="facet-more feed-save"
                        title=${t('amp.save-into-title', 'keep these settings in "{name}", in place of what it held', { name: loaded.name })}
                        onClick=${() => onSave(false)}
                    >${t('apps.feed.save-into', 'save to "{name}"', { name: loaded.name })}</button>`
                }
                <button
                    class="facet-more feed-save"
                    title=${t('amp.save-filter-title', 'keep these settings as a filter of their own, in the Playlists column')}
                    onClick=${() => onSave(true)}
                >${loaded ? t('apps.feed.save-as-new', 'save as new') : t('apps.feed.save-filter', 'save filter')}</button>
            </div>
            <div class="facets">
                ${FILTER_ROWS.map((row) => {
                    // "me" leads the via row, as it leads the feed's "by" (ruling 8: "only mine").
                    const items =
                        row === 'from'
                            ? [
                                  ...facets.from.filter((f) => f.value === me),
                                  ...facets.from.filter((f) => f.value !== me),
                              ]
                            : facets[row];
                    const chosen = [...(picks[row] || []), ...(picks[LEFT_OUT[row]] || [])];
                    if (!items.length && !chosen.length) return null;
                    const names = {};
                    for (const f of items) names[f.value] = () => wordOf(row, f.value);
                    for (const v of chosen) names[v] = () => wordOf(row, v);
                    return html`<${FacetRow}
                        key=${row}
                        label=${ROW_WORDS[row]()}
                        items=${items}
                        picked=${picks[row]}
                        out=${picks[LEFT_OUT[row]]}
                        onToggle=${(v) => onPicks(cycleAmpPick(picks, row, v))}
                        names=${names}
                        icons=${(v) => iconOf(row, v)}
                    />`;
                })}
                <${RangeBoxes} picks=${picks} onPicks=${onPicks} />
            </div>
        </div>`
        }
    </div>`;
};

/// The Playlists column (section 3): filters - "all" first, always there, then each saved one, lit
/// while it is what the table shows - the mixtapes (section 5) and the radio stations (section 6).
/// Above them all, what's pinned (pure/amppins.js), each wearing its kind's glyph, since a pinned
/// filter and a pinned mixtape can share a name.
const Playlists = ({
    filters,
    now,
    onAll,
    onPick,
    onForget,
    onTuck,
    tapes,
    openTape,
    onOpenTape,
    onForgetTape,
    stations,
    openStation,
    playingStation,
    onOpenStation,
    onForgetStation,
    onNewStation,
    pins,
    onPin,
}) => {
    const isPinned = (kind, x) => pins.has(pinKey(kind, x.id));
    const pin = (kind, x) => {
        const on = isPinned(kind, x);
        const label = on
            ? t('amp.unpin', 'unpin it from the top of playlists')
            : t('amp.pin', 'pin it to the top of playlists');
        return html`<button
            class=${on ? 'amp-pin amp-pin-on' : 'amp-pin'}
            title=${label}
            aria-label=${label}
            aria-pressed=${on}
            onClick=${() => onPin(kind, x)}
        ><${Icons.pin} /></button>`;
    };
    const kindGlyph = (icon, shown) =>
        shown && html`<span class="amp-pinned-kind"><${icon} /></span>`;
    const filterRow = (f, pinnedRow) => html`<div
        key=${pinKey('filter', f.id)}
        class=${sameFilter(f, now) ? 'feed-saved-row active' : 'feed-saved-row'}
    >
        <button
            class="feed-saved-forget"
            title=${t('amp.forget-this-filter', 'forget this filter')}
            aria-label=${t('amp.forget-this-filter', 'forget this filter')}
            onClick=${() => onForget(f)}
        ><${Icons.trash} /></button>
        <button class="feed-saved-name" onClick=${() => onPick(f)}>${kindGlyph(Icons.filter, pinnedRow)}${f.name}</button>
        ${pin('filter', f)}
    </div>`;
    const tapeRow = (tape, pinnedRow) => html`<div
        key=${pinKey('mixtape', tape.id)}
        class=${openTape === tape.id ? 'feed-saved-row active' : 'feed-saved-row'}
    >
        <button
            class="feed-saved-forget"
            title=${t('amp.forget-this-mixtape', 'forget this mixtape - its songs stay where they are')}
            aria-label=${t('amp.forget-this-mixtape', 'forget this mixtape - its songs stay where they are')}
            onClick=${() => onForgetTape(tape)}
        ><${Icons.trash} /></button>
        <button class="feed-saved-name" onClick=${() => onOpenTape(tape)}>${kindGlyph(Icons.cassette, pinnedRow)}${tape.name}</button>
        ${pin('mixtape', tape)}
    </div>`;
    const stationRow = (st, pinnedRow) => html`<div
        key=${pinKey('station', st.id)}
        class=${openStation === st.id ? 'feed-saved-row active' : 'feed-saved-row'}
    >
        <button
            class="feed-saved-forget"
            title=${t('amp.forget-this-station', 'forget this station')}
            aria-label=${t('amp.forget-this-station', 'forget this station')}
            onClick=${() => onForgetStation(st)}
        ><${Icons.trash} /></button>
        <button class="feed-saved-name" onClick=${() => onOpenStation(st)}>
            ${
                playingStation === st.id
                    ? html`<span class="amp-on-air" title=${t('amp.on-air', 'playing now')}><${Icons.radio} /></span>`
                    : kindGlyph(Icons.radio, pinnedRow)
            }
            ${st.name}
        </button>
        ${pin('station', st)}
    </div>`;
    const ROWS = { filter: filterRow, mixtape: tapeRow, station: stationRow };
    const pinned = pinnedLists(pins, { filters, tapes, stations });
    const restTapes = tapes.filter((x) => !isPinned('mixtape', x));
    return html`<aside class="amp-playlists">
        <${PaneHead} icon=${Icons.music} label=${t('amp.playlists', 'playlists')} onTuck=${onTuck} />
        ${pinned.length > 0 && html`<p class="amp-playlists-group">${t('amp.pinned', 'pinned')}</p>`}
        ${pinned.map((l) => ROWS[l.kind](l.item, true))}
        <p class="amp-playlists-group">${t('amp.filters', 'filters')}</p>
        <div class=${now && !anyAmpPicks(now.picks) && !now.q ? 'feed-saved-row active' : 'feed-saved-row'}>
            <span class="feed-saved-forget feed-saved-spacer" aria-hidden="true"><${Icons.trash} /></span>
            <button
                class="feed-saved-name"
                title=${t('amp.all-title', 'every song you can see - every chip back to unpicked')}
                onClick=${onAll}
            >${t('apps.feed.all', 'all')}</button>
        </div>
        ${filters.filter((f) => !isPinned('filter', f)).map((f) => filterRow(f, false))}
        ${/* Mixtapes (section 5): each a name and an order, opened into the table in that order. */ ''}
        ${restTapes.length > 0 && html`<p class="amp-playlists-group">${t('amp.mixtapes', 'mixtapes')}</p>`}
        ${restTapes.map((x) => tapeRow(x, false))}
        ${
            /* Radio stations (section 6): each a pie of filters, mixtapes and stations, opened to edit
            and play. */ ''
        }
        <p class="amp-playlists-group amp-playlists-group-new">
            ${t('amp.radio-stations', 'radio stations')}
            <button class="amp-playlists-new" title=${t('amp.new-station', 'a new radio station')} aria-label=${t('amp.new-station', 'a new radio station')} onClick=${onNewStation}><${Icons.plus} /></button>
        </p>
        ${stations.filter((st) => !isPinned('station', st)).map((st) => stationRow(st, false))}
    </aside>`;
};

/// A slice's colour, the pie's and its swatch's alike (apps/amp.css), by its place in the station.
const SLICE_CLASSES = [
    'amp-slice-0',
    'amp-slice-1',
    'amp-slice-2',
    'amp-slice-3',
    'amp-slice-4',
    'amp-slice-5',
    'amp-slice-6',
    'amp-slice-7',
];
const sliceClass = (i) => SLICE_CLASSES[i % SLICE_CLASSES.length];

/// A slice's name: everything, or the filter, mixtape or station it is.
const sliceName = (sl, { filters, tapes, stations }) => {
    if (sl.kind === 'all') return t('amp.everything', 'everything');
    const found =
        sl.kind === 'filter'
            ? filters.find((f) => f.id === sl.id)
            : sl.kind === 'mixtape'
              ? tapes.find((x) => x.id === sl.id)
              : stations.find((x) => x.id === sl.id);
    return found ? found.name : t('amp.slice-gone', '(gone)');
};

/// What a slice is, as an icon.
const KIND_ICON = {
    all: Icons.music,
    filter: Icons.filter,
    filtered: Icons.filter,
    mixtape: Icons.cassette,
    station: Icons.radio,
    file: Icons.fileAudio,
};

/// How many songs a slice holds, in words (Curtis, 2026-10-13: "see the count of songs in each
/// bin").
const songCount = (n) => t('amp.n-songs', '{n} songs', { n });

/// The station as a pie (section 6): each slice its share of the circle, and its name and how many
/// songs it holds under the pointer. `labels[i]` says slice i.
const Pie = ({ slices, labels = [] }) => {
    const parts = shares(slices);
    const c = 50;
    const r = 46;
    const at = (turn) => [
        c + r * Math.cos(2 * Math.PI * turn - Math.PI / 2),
        c + r * Math.sin(2 * Math.PI * turn - Math.PI / 2),
    ];
    let turn = 0;
    const drawn = parts.map((p, i) => {
        if (!p) return null;
        const said = labels[i] && html`<title>${labels[i]}</title>`;
        if (p >= 100)
            return html`<circle key=${i} class=${sliceClass(i)} cx=${c} cy=${c} r=${r}>${said}</circle>`;
        const [x1, y1] = at(turn);
        turn += p / 100;
        const [x2, y2] = at(turn);
        return html`<path key=${i} class=${sliceClass(i)} d=${`M${c} ${c} L${x1} ${y1} A${r} ${r} 0 ${p > 50 ? 1 : 0} 1 ${x2} ${y2} Z`}>${said}</path>`;
    });
    return html`<svg class="amp-pie" viewBox="0 0 100 100" role="img" aria-label=${t('amp.station-pie', 'the station, as a pie')}>
        ${parts.some((p) => p > 0) ? drawn : html`<circle class="amp-pie-empty" cx=${c} cy=${c} r=${r} />`}
    </svg>`;
};

/// A radio station, opened (section 6): the pie; a slider per slice, its share beside it, and its
/// trash first; a slice to add - everything, a saved filter, a mixtape, or another station that
/// wouldn't hold this one - and the button that plays it, with what it played lately, each song
/// with the slice that picked it. `countOf(slice)` is how many songs a slice holds; `sourceOf(path)`
/// names the slices a pick came down through; `onShow(key)` shows a song's file.
const StationView = ({
    station,
    stations,
    filters,
    tapes,
    playing,
    history,
    countOf,
    sourceOf,
    onShow,
    onChange,
    onPlay,
}) => {
    const parts = shares(station.slices);
    const nameOf = (sl) => sliceName(sl, { filters, tapes, stations });
    const counts = station.slices.map(countOf);
    const setSlices = (slices, now = false) => onChange({ ...station, slices }, now);
    const add = (value) => {
        const [kind, id] = value.split(':');
        if (kind === 'station' && wouldLoop(stations, station.id, id)) {
            toast(t('amp.station-loop', "a station can't hold itself, even further down"), {
                kind: 'error',
            });
            return;
        }
        setSlices([...station.slices, { kind, id: id || '', weight: 50 }], true);
    };
    const others = stations.filter(
        (x) => x.id !== station.id && !wouldLoop(stations, station.id, x.id),
    );
    return html`<div class="amp-station">
        <h2 class="amp-panel-title">${station.name}</h2>
        <div class="amp-panel-actions">
            <button class=${playing ? 'bulk-button jag-line amp-station-play amp-station-playing' : 'bulk-button jag-line amp-station-play'} onClick=${onPlay}>
                <${Icons.radio} /> ${playing ? t('amp.station-on-air', 'on the air - start again') : t('amp.play-station', 'play the station')}
            </button>
        </div>
        <div class="amp-station-body">
            <${Pie} slices=${station.slices} labels=${station.slices.map((sl, i) => `${nameOf(sl)}: ${songCount(counts[i])}`)} />
            <div class="amp-station-slices">
                ${station.slices.map(
                    (sl, i) => html`<div class="amp-slice-row" key=${`${i}:${sl.kind}:${sl.id}`}>
                        <button
                            class="feed-saved-forget"
                            title=${t('amp.remove-slice', 'take this slice out')}
                            aria-label=${t('amp.remove-slice', 'take this slice out')}
                            onClick=${() =>
                                setSlices(
                                    station.slices.filter((_, k) => k !== i),
                                    true,
                                )}
                        ><${Icons.trash} /></button>
                        <span class=${`amp-slice-swatch ${sliceClass(i)}`}></span>
                        <span class="amp-slice-name"><${KIND_ICON[sl.kind]} /> ${nameOf(sl)} <span class="amp-slice-count">${songCount(counts[i])}</span></span>
                        <input
                            class="amp-slice-weight"
                            type="range"
                            min="0"
                            max="100"
                            value=${sl.weight}
                            title=${t('amp.slice-weight', 'how often this slice comes up')}
                            onInput=${(e) =>
                                setSlices(
                                    station.slices.map((x, k) =>
                                        k === i
                                            ? { ...x, weight: Number(e.currentTarget.value) }
                                            : x,
                                    ),
                                )}
                        />
                        <span class="amp-slice-share">${parts[i]}%</span>
                    </div>`,
                )}
                <select
                    class="jag-field amp-slice-add"
                    value=""
                    onChange=${(e) => {
                        const v = e.currentTarget.value;
                        e.currentTarget.value = '';
                        if (v) add(v);
                    }}
                >
                    <option value="">${t('amp.add-slice', 'add a slice…')}</option>
                    <option value="all:">${t('amp.everything', 'everything')}</option>
                    ${filters.length > 0 && html`<optgroup label=${t('amp.filters', 'filters')}>${filters.map((f) => html`<option key=${f.id} value=${`filter:${f.id}`}>${f.name}</option>`)}</optgroup>`}
                    ${tapes.length > 0 && html`<optgroup label=${t('amp.mixtapes', 'mixtapes')}>${tapes.map((x) => html`<option key=${x.id} value=${`mixtape:${x.id}`}>${x.name}</option>`)}</optgroup>`}
                    ${others.length > 0 && html`<optgroup label=${t('amp.radio-stations', 'radio stations')}>${others.map((x) => html`<option key=${x.id} value=${`station:${x.id}`}>${x.name}</option>`)}</optgroup>`}
                </select>
            </div>
        </div>
        ${
            history.length > 0 &&
            html`<h3 class="amp-panel-sub">${t('amp.lately', 'lately on the air')}</h3>
            <ol class="amp-station-lately">
                ${history.map(
                    ({ row: r, from }, i) => html`<li
                        key=${`${i}:${r.key}`}
                        title=${t('amp.show-file', 'show its file')}
                        onClick=${() => onShow(r.key)}
                        onContextMenu=${(e) => {
                            e.preventDefault();
                            onShow(r.key);
                        }}
                    >${r.title}${r.artist ? html` <span class="amp-station-artist">${r.artist}</span>` : ''}${from && html`<span class="amp-station-source">${sourceOf(from)}</span>`}</li>`,
                )}
            </ol>`
        }
    </div>`;
};

/// How many songs the now-playing column shows either side of the one playing.
const QUEUE_REACH = 5;

/// What's playing (pure/amp.js `readContext`), in words.
const contextWords = (c, { tapes, filters, stations }) => {
    if (!c) return '';
    const named = (list) => {
        const found = list.find((x) => x.id === c.id);
        return found ? found.name : c.name;
    };
    switch (c.kind) {
        case 'all':
            return t('amp.from-everything', 'everything');
        case 'filtered':
            return t('amp.from-the-table', 'the table, narrowed');
        case 'filter':
            return named(filters);
        case 'mixtape':
            return named(tapes);
        case 'station':
            return named(stations);
        case 'file':
            return t('amp.from-a-file', 'a file, from hrseFiles');
        default:
            return '';
    }
};

/// The now-playing column (Curtis, 2026-10-13): what's playing from at its head, then the few songs
/// that played, the one playing with its thumbs, and the few to come - a station's each with the
/// slice that picked it. A song pressed shows its file; double-clicked, it plays.
const NowPlaying = ({ player, from, lists, sourceOf, nowFrom, rating, onRate, onShow, onTuck }) => {
    const { past, ahead } = player.around(QUEUE_REACH);
    const now = player.current;
    const line = (row, by, source, extra = null) => html`<li
        key=${by}
        class=${by === 0 ? 'amp-now-row amp-now-playing' : by < 0 ? 'amp-now-row amp-now-past' : 'amp-now-row'}
        title=${by ? t('amp.now-jump', 'double-click to play it now') : undefined}
        onClick=${() => onShow(row.key)}
        onDblClick=${() => by && player.jump(by)}
        onContextMenu=${(e) => {
            e.preventDefault();
            onShow(row.key);
        }}
    >
        <span class="amp-now-title">${by === 0 && html`<${Icons.speaker} /> `}${row.title}</span>
        <span class="amp-now-artist">${row.artist}${source && html`<span class="player-source">${row.artist ? ' · ' : ''}${source}</span>`}</span>
        ${extra}
    </li>`;
    const words = from && contextWords(from, lists);
    return html`<aside class="amp-now">
        <${PaneHead} icon=${Icons.nowPlaying} label=${t('amp.now-playing', 'now playing')} onTuck=${onTuck} />
        ${
            words &&
            html`<p class="amp-now-from" title=${t('amp.now-from-title', 'what this is playing from')}>
                ${KIND_ICON[from.kind] && html`<${KIND_ICON[from.kind]} />`} ${words}
            </p>`
        }
        <ol class="amp-now-queue">
            ${past.map((p, i) => line(p.row, i - past.length, sourceOf(p.from)))}
            ${line(now, 0, sourceOf(nowFrom), onRate && html`<${Thumbs} rating=${rating} onRate=${onRate} className="player-rate amp-now-rate" />`)}
            ${ahead.map((p, i) => line(p.row, i + 1, sourceOf(p.from)))}
        </ol>
        ${!ahead.length && html`<p class="null-sub amp-now-end">${t('amp.now-the-end', 'and then the end of the list')}</p>`}
    </aside>`;
};

/// "Add to mixtape" (section 5), and inside an open one "take out of" it: for one song or many, in
/// the file panel's actions. Adding appends, and a song already in the mixtape keeps its place.
const MixtapeActions = ({ rows, tapes, openTape, onAdd, onRemove }) => {
    const open = tapes.find((x) => x.id === openTape) || null;
    return html`<select
            class="jag-field amp-mixtape-select"
            title=${t('amp.add-to-mixtape-title', 'put these at the end of a mixtape')}
            value=""
            onChange=${(e) => {
                const v = e.currentTarget.value;
                e.currentTarget.value = '';
                if (v === 'new') onAdd(null, rows);
                else if (v)
                    onAdd(
                        tapes.find((x) => x.id === v),
                        rows,
                    );
            }}
        >
            <option value="">${t('amp.add-to-mixtape', 'add to mixtape…')}</option>
            ${tapes.map((tape) => html`<option key=${tape.id} value=${tape.id}>${tape.name}</option>`)}
            <option value="new">${t('amp.new-mixtape', 'new mixtape…')}</option>
        </select>
        ${
            open &&
            html`<button
                class="bulk-button jag-line amp-take-out"
                title=${t('amp.take-out-title', 'take these out of "{name}" - they stay in your library', { name: open.name })}
                onClick=${() => onRemove(rows)}
            >${t('amp.take-out-of', 'out of "{name}"', { name: open.name })}</button>`
        }`;
};

/// The key of the song playing, or null.
const playingKeyOf = (player) => (player && player.current ? player.current.key : null);

/// The column menu: every column, ticked if shown.
const ColumnMenu = ({ hidden, onToggle }) => {
    const [open, setOpen] = useState(false);
    const box = useRef(null);
    // A press anywhere else closes it (Curtis, 2026-10-12).
    useEffect(() => {
        if (!open) return undefined;
        const away = (e) => {
            if (box.current && !box.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', away);
        return () => document.removeEventListener('pointerdown', away);
    }, [open]);
    return html`<span class="amp-columns" ref=${box}>
        <button class="amp-columns-button" title=${t('amp.columns', 'columns')} onClick=${() => setOpen(!open)}><${Icons.menu} /></button>
        ${
            open &&
            html`<div class="amp-columns-menu">
                ${COLUMNS.map(
                    (c) => html`<label key=${c.key}>
                        <input type="checkbox" checked=${!hidden.includes(c.key)} onChange=${() => onToggle(c.key)} />
                        ${COLUMN_WORDS[c.key]()}
                    </label>`,
                )}
            </div>`
        }
    </span>`;
};

export const AmpApp = ({ current, searchQuery, onSearch }) => {
    const root = current && current.root;
    const player = usePlayer();
    const docs = useLive(() => (root ? openMirror(root).docs.toArray() : []), [root]);
    const [layerRows, setLayerRows] = useState([]);
    const [feed, setFeed] = useState({ sounds: [], names: {} });
    const [loading, setLoading] = useState(true);
    const [rawSettings, setRawSettings] = usePref(root, TABLE_PREF, '');
    const settings = useMemo(() => readTableSettings(rawSettings), [rawSettings]);
    const [widths, setWidths] = useState(settings.widths);
    useEffect(() => setWidths(settings.widths), [rawSettings]); // eslint-disable-line react-hooks/exhaustive-deps
    const [picked, setPicked] = useState(new Set());
    const [anchor, setAnchor] = useState(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(600);
    const body = useRef(null);
    const narrow = useNarrow();
    const rowHeight = narrow ? ROW_HEIGHT_NARROW : ROW_HEIGHT;
    // A phone has no double-click to play a row by (Chrome's double-tap doesn't reliably send one):
    // two taps on the same row are counted here, and a double-click that follows them is the same
    // gesture said twice, so it's let go.
    const lastTap = useRef({ key: null, at: 0 });
    const tappedPlay = useRef(0);
    // When a column's edge was last let go: the click that ends a drag isn't a sort.
    const resizedAt = useRef(0);
    // The strip (section 3): the curiosity dial's stop - hrseAmp's own, starting from the feed's -
    // whose tags count, and the picks.
    const [stop, setStop] = useState(null);
    const [scope, setScope] = useState('all');
    const [picks, setPicksState] = useState(NO_AMP_PICKS);
    const setPicks = (next) => {
        setPicksState(next);
        writePicks(root, next);
    };
    const [filters, setFilters] = useState([]);
    // The filter last chosen in the Playlists column, by id: "save" puts the strip back into it.
    const [loadedId, setLoadedId] = useState(null);
    // Mixtapes (section 5): each read whole from its taxonomy when the roster moves, or after our own
    // edits; and the one open in the table, if any.
    const taxRows = useLive(() => (root ? openMirror(root).taxonomies.toArray() : []), [root]);
    const tapeIds = (taxRows || [])
        .filter((x) => isMixtape(x.title))
        .map((x) => `${x.taxonomy_id}:${x.members ?? ''}:${encodeURIComponent(x.title)}`)
        .sort()
        .join(',');
    const [tapes, setTapes] = useState([]);
    const [tapesAt, setTapesAt] = useState(0);
    const reloadTapes = () => setTapesAt(Date.now());
    const [openTape, setOpenTape] = useState(null);
    // Each tape is read again only when its own roster entry moved (plans/CACHE.md, Stage 9: one song
    // added read every tape again, and every visit read them all) - or when our own edit asked
    // (`reloadTapes`: a reorder moves no count).
    const tapesForced = useRef(0);
    useEffect(() => {
        if (!root) return;
        const forced = tapesForced.current !== tapesAt;
        tapesForced.current = tapesAt;
        const entries = tapeIds ? tapeIds.split(',') : [];
        Promise.all(
            entries.map((entry) => {
                const id = entry.split(':')[0];
                const key = `${root}:${id}`;
                const kept = keptTapes.get(key);
                if (!forced && kept && kept.entry === entry) return kept.tape;
                return api(`/api/identity/${root}/taxonomies/${id}`)
                    .then(readMixtape)
                    .then((tape) => {
                        keptTapes.set(key, { entry, tape });
                        return tape;
                    })
                    .catch(() => null);
            }),
        ).then((list) =>
            setTapes(list.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))),
        );
    }, [root, tapeIds, tapesAt]);
    const tape = tapes.find((x) => x.id === openTape) || null;
    // Radio stations (section 6): read from their registers, the one open to edit, and the saving
    // of a slider's move a moment after it settles.
    const [stations, setStations] = useState([]);
    const [stationsRead, setStationsRead] = useState(false);
    const [openStation, setOpenStation] = useState(null);
    const openStationObj = stations.find((x) => x.id === openStation) || null;
    const stationSave = useRef(null);
    useEffect(() => {
        if (!root) return;
        setStations([]);
        setStationsRead(false);
        api(`/api/identity/${root}/private/kv/${AMP_STATIONS}`)
            .then((r) => setStations(readStations(r && r.values)))
            .catch(() => {})
            .finally(() => setStationsRead(true));
    }, [root]);
    // What's pinned to the top of Playlists (pure/amppins.js), per persona.
    const [pins, setPins] = useState(() => new Map());
    useEffect(() => {
        if (!root) return;
        setPins(new Map());
        api(`/api/identity/${root}/private/kv/${AMP_PINS}`)
            .then((r) => setPins(readPins(r && r.values)))
            .catch(() => {});
    }, [root]);
    // A pin made or taken out: on screen at once, put back if the node refused it.
    const setPin = async (kind, id, on) => {
        const key = pinKey(kind, id);
        const at = Date.now();
        const swap = (pinIt) =>
            setPins((have) => {
                const next = new Map(have);
                if (pinIt) next.set(key, at);
                else next.delete(key);
                return next;
            });
        swap(on);
        try {
            await api(`/api/identity/${root}/private/kv/${AMP_PINS}/${encodeURIComponent(key)}`, {
                method: 'PUT',
                body: JSON.stringify({ value: on ? String(at) : '' }),
            });
        } catch (e) {
            swap(!on);
            toast(
                t('amp.couldnt-pin', "couldn't change the pin: {message}", {
                    message: e.message,
                }),
                { kind: 'error' },
            );
        }
    };
    const togglePin = (kind, x) => setPin(kind, x.id, !pins.has(pinKey(kind, x.id)));
    // A list forgotten takes its pin with it.
    const unpinGone = (kind, id) => {
        if (pins.has(pinKey(kind, id))) setPin(kind, id, false);
    };
    // A drag in an open mixtape: the song lifted, and where it would land.
    const dragKey = useRef(null);
    const [dropAt, setDropAt] = useState(null); // { key, after }
    const { tucked, toggleTuck, tab, settle } = useColTucks(root, 'amp');
    // The Playlists column, the now-playing column and the file column, each as wide as it was
    // dragged (panes.js).
    const { resizer, colStyle } = useColWidths(root, 'amp', ['playlists', 'now', 'file'], {
        file: 260,
        now: 200,
    });

    const loadFilters = () =>
        root &&
        api(`/api/identity/${root}/private/kv/${AMP_FILTERS}`)
            .then((r) => setFilters(readFilters(r && r.values)))
            .catch(() => {});
    // The layer, the filters and the dial's stop, once per persona: hrseAmp's stop if it has one,
    // else the feed's.
    useEffect(() => {
        if (!root) return;
        setPicksState(readPicks(root));
        setFilters([]);
        loadFilters();
        Promise.all([
            api(`/api/identity/${root}/private/kv/${LAYER}`).catch(() => ({ values: [] })),
            api(`/api/identity/${root}/private/kv/amp_selectivity`).catch(() => ({ values: [] })),
            api(`/api/identity/${root}/private/kv/feed_selectivity`).catch(() => ({ values: [] })),
        ]).then(([layerAnswer, own, feedDial]) => {
            setLayerRows(layerAnswer.values || []);
            const stopOf = (a) => ((a.values || []).find((v) => v.key === 'stop') || {}).value;
            const key = stopOf(own) || stopOf(feedDial);
            setStop(SELECTIVITY_STOPS.some((s) => s.key === key) ? key : DEFAULT_STOP);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root]);
    const load = async () => {
        if (!root || !stop) return;
        setLoading(true);
        const answer = await api(
            `/api/identity/${root}/amp/library?stop=${encodeURIComponent(stop)}`,
        ).catch(() => ({ sounds: [], names: {} }));
        setFeed({ sounds: answer.sounds || [], names: answer.names || {} });
        setLoading(false);
    };
    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, stop]);
    const moveStop = (key) => {
        setStop(key);
        api(`/api/identity/${root}/private/kv/amp_selectivity/stop`, {
            method: 'PUT',
            body: JSON.stringify({ value: key }),
        }).catch(() => {});
    };

    const layer = useMemo(() => readLayer(layerRows), [layerRows]);
    const docRows = useMemo(() => new Map((docs || []).map((d) => [d.doc_id, d])), [docs]);
    const rows = useMemo(() => {
        const mine = (docs || [])
            .filter((d) => d.format === 'opus')
            .map((d) => ({ ...ownRow(d, root, layer), builtin: !!d.builtin }));
        // Each knows the mixtapes it's in, by name - the strip's "mixtape" row.
        const byTape = mixtapesBySong(tapes);
        return [...mine, ...feed.sounds.map((s) => feedRow(s, layer))].map((r) => ({
            ...r,
            mixtapes: byTape.get(r.key) || [],
        }));
    }, [docs, feed, layer, root, tapes]);
    const names = useMemo(
        () => ({ ...feed.names, [root]: t('amp.you', 'you') }),
        [feed.names, root],
    );
    const shown = useMemo(() => {
        const narrowed = searched(narrowedSongs(rows, picks, scope), searchQuery);
        // An open mixtape is its own order: the strip and the search narrow it, nothing sorts it.
        if (tape) return inMixtapeOrder(narrowed, tape);
        const list = sorted(narrowed, settings.sort, names);
        // Probable duplicates: each set of copies together, where its first stands in the order.
        return dupeMode(picks) === 'only' ? byDuplicateGroup(list, duplicateGroups(list)) : list;
    }, [rows, picks, scope, searchQuery, settings.sort, names, tape]);
    const settingsNow = filterSettings(picks, stop, scope, searchQuery);

    // A value on the strip, in words: "me", a person's name, or the value itself.
    const wordOf = (row, v) =>
        row === 'from' ? (v === root ? t('facets.me', 'me') : nameOf(names, v)) : v;
    const iconOf = (row, v) => (row === 'from' && v === root ? 'me' : null);
    // Save filter: the strip as it stands, by a name, into the Playlists column.
    // Save filter: the strip as it stands - into the filter last chosen (Curtis, 2026-10-12: saving
    // an adjusted filter "just wants to create a new filter"), or as a new one, by a name.
    const loaded = filters.find((f) => f.id === loadedId) || null;
    const saveFilter = async (asNew) => {
        const into = asNew ? null : loaded;
        const name = into
            ? into.name
            : (await askText({
                  title: t('amp.save-filter-title-modal', 'save the filter'),
                  label: t('amp.save-filter-name', 'A name for this filter:'),
                  ok: t('amp.save', 'save'),
              })) || '';
        if (!name) return;
        let id = into && into.id;
        if (!id) {
            const bytes = new Uint8Array(8);
            crypto.getRandomValues(bytes);
            id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        }
        try {
            await api(`/api/identity/${root}/private/kv/${AMP_FILTERS}/${id}`, {
                method: 'PUT',
                body: JSON.stringify({ value: filterValue(name, settingsNow) }),
            });
            setLoadedId(id);
            notePlaylist('filter', id, name);
            await loadFilters();
            toast(t('apps.feed.saved-as', 'saved as "{name}"', { name }));
        } catch (e) {
            toast(
                t('apps.feed.couldnt-save-it', "couldn't save it: {message}", {
                    message: e.message,
                }),
                { kind: 'error' },
            );
        }
    };
    const forgetFilter = async (f) => {
        if (
            !(await askYes({
                title: t('amp.forget-filter-title', 'forget the filter'),
                body: t('amp.forget-filter', 'Forget the filter "{name}"?', { name: f.name }),
                yes: t('amp.forget-it', 'forget it'),
                danger: true,
            }))
        )
            return;
        try {
            // A register emptied is one deleted (pure/ampfilters.js).
            await api(`/api/identity/${root}/private/kv/${AMP_FILTERS}/${f.id}`, {
                method: 'PUT',
                body: JSON.stringify({ value: '' }),
            });
            setFilters((have) => have.filter((x) => x.id !== f.id));
            if (loadedId === f.id) setLoadedId(null);
            unpinGone('filter', f.id);
            forgetThing(root, playlistThing('filter', f.id));
        } catch (e) {
            toast(
                t('amp.couldnt-forget-it', "couldn't forget it: {message}", {
                    message: e.message,
                }),
                { kind: 'error' },
            );
        }
    };
    // A filter chosen: its picks, its whose-tags, its curiosity and its search words, at once.
    // "all" clears the picks and the words and leaves the rest, as the feed's does.
    const applyFilter = (f) => {
        settle();
        setLoadedId(f ? f.id : null);
        setOpenTape(null);
        setOpenStation(null);
        if (!f) {
            setPicks(NO_AMP_PICKS);
            if (onSearch) onSearch('');
            return;
        }
        setPicks({ ...NO_AMP_PICKS, ...f.picks });
        setScope(f.scope || 'all');
        if (onSearch) onSearch(f.q || '');
        if (f.stop && f.stop !== stop && SELECTIVITY_STOPS.some((s) => s.key === f.stop))
            moveStop(f.stop);
    };
    // A mixtape opened from Playlists: the table in its order, the strip and the search cleared.
    const openMixtape = (x) => {
        settle();
        setOpenStation(null);
        setLoadedId(null);
        setPicks(NO_AMP_PICKS);
        if (onSearch) onSearch('');
        setOpenTape(x.id);
    };
    const failed = (e) =>
        toast(
            t('amp.couldnt-change-mixtape', "couldn't change the mixtape: {message}", {
                message: e.message,
            }),
            {
                kind: 'error',
            },
        );
    const memberUrl = (tid, r) => `/api/identity/${root}/taxonomies/${tid}/members/${r.doc}`;
    // Add to a mixtape, or to a new one: at the end, a song already in it left where it is.
    const addToTape = async (target, songs) => {
        let id = target && target.id;
        let name = target && target.name;
        try {
            if (!target) {
                name =
                    (await askText({
                        title: t('amp.new-mixtape-title', 'a new mixtape'),
                        label: t('amp.new-mixtape-name', 'A name for the new mixtape:'),
                        ok: t('amp.make-it', 'make it'),
                    })) || '';
                if (!name) return;
                id = (
                    await api(`/api/identity/${root}/taxonomies`, {
                        method: 'POST',
                        body: JSON.stringify({ title: mixtapeTitle(name) }),
                    })
                ).taxonomy_id;
            }
            const adding = notYetIn(target, songs);
            for (const r of adding) {
                await api(memberUrl(id, r), {
                    method: 'PUT',
                    body: JSON.stringify({ member_root: r.author }),
                });
            }
            notePlaylist('mixtape', id, name);
            toast(t('amp.added-to-mixtape', 'added {n} to "{name}"', { n: adding.length, name }));
        } catch (e) {
            failed(e);
        }
        reloadTapes();
    };
    // Out of the open mixtape: off the list only - the songs stay in the library.
    const removeFromTape = async (songs) => {
        if (!tape) return;
        try {
            for (const r of songs) {
                await api(`${memberUrl(tape.id, r)}?member_root=${r.author}`, { method: 'DELETE' });
            }
            notePlaylist('mixtape', tape.id, tape.name);
        } catch (e) {
            failed(e);
        }
        reloadTapes();
    };
    const forgetTape = async (x) => {
        if (
            !(await askYes({
                title: t('amp.forget-mixtape-title', 'forget the mixtape'),
                body: t(
                    'amp.forget-mixtape',
                    'Forget the mixtape "{name}"? Its songs stay where they are.',
                    { name: x.name },
                ),
                yes: t('amp.forget-it', 'forget it'),
                danger: true,
            }))
        )
            return;
        try {
            await api(`/api/identity/${root}/taxonomies/${x.id}`, { method: 'DELETE' });
            if (openTape === x.id) setOpenTape(null);
            setTapes((have) => have.filter((y) => y.id !== x.id));
            unpinGone('mixtape', x.id);
            forgetThing(root, playlistThing('mixtape', x.id));
        } catch (e) {
            failed(e);
        }
    };
    // A song dragged to a new place in the open mixtape: moved there at once, then said.
    const moveInTape = async (key, index) => {
        const r = rows.find((x) => x.key === key);
        if (!tape || !r) return;
        const order = tape.members.filter((k) => k !== key);
        order.splice(index, 0, key);
        setTapes((have) => have.map((x) => (x.id === tape.id ? { ...x, members: order } : x)));
        try {
            await api(memberUrl(tape.id, r), {
                method: 'PUT',
                body: JSON.stringify({ index, member_root: r.author }),
            });
            notePlaylist('mixtape', tape.id, tape.name);
        } catch (e) {
            failed(e);
        }
        reloadTapes();
    };
    // Where a drag over the table would land (Curtis, 2026-10-12: the ends wanted "Exactly the
    // bottom"): the whole table takes it, and the pointer's height picks the gap - anywhere below
    // the last song is after it, anywhere above the first (the header too) before it.
    const dropTarget = (e) => {
        const rowsEl = e.currentTarget.querySelector('.amp-rows');
        if (!rowsEl || !shown.length) return null;
        const y = (e.clientY - rowsEl.getBoundingClientRect().top) / rowHeight;
        if (y < 0) return { key: shown[0].key, after: false };
        if (y >= shown.length) return { key: shown[shown.length - 1].key, after: true };
        const i = Math.floor(y);
        return { key: shown[i].key, after: y - i >= 0.5 };
    };
    // --- radio stations ---
    // A slice's songs, as they stand: everything, a mixtape's, or a saved filter's - its picks,
    // whose tags and its words, over the library as this page has it.
    // Only what this server carries: a song refused here (rights.rs, the fence) is never picked.
    const songsOf = (sl) => {
        if (sl.kind === 'all') return playable(rows);
        if (sl.kind === 'mixtape') {
            const x = tapes.find((y) => y.id === sl.id);
            return x ? playable(inMixtapeOrder(rows, x)) : [];
        }
        if (sl.kind === 'filter') {
            const f = filters.find((y) => y.id === sl.id);
            return f ? playable(searched(narrowedSongs(rows, f.picks, f.scope), f.q)) : [];
        }
        return [];
    };
    const runFor = (st) =>
        new StationRun(st, {
            stations,
            songsOf,
            ...SHUFFLE,
            random: Math.random,
        });
    // How many songs a slice holds - a station's, every song under it once - for the pie
    // (Curtis, 2026-10-13).
    const countOf = useMemo(() => {
        const kept = new Map();
        const under = (sl, seen) => {
            if (sl.kind !== 'station') return songsOf(sl).map((r) => r.key);
            const st = stations.find((x) => x.id === sl.id);
            if (!st || seen.has(st.id)) return [];
            const deeper = new Set([...seen, st.id]);
            return st.slices.filter((x) => x.weight > 0).flatMap((x) => under(x, deeper));
        };
        return (sl) => {
            const k = `${sl.kind}:${sl.id}`;
            if (!kept.has(k)) kept.set(k, new Set(under(sl, new Set())).size);
            return kept.get(k);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, filters, tapes, stations]);
    // The slices a station's pick came down through, by name: "evenings › that mixtape".
    const lists = { filters, tapes, stations };
    const sourceOf = (path) =>
        sliceTrail(stations, path)
            .map((sl) => sliceName(sl, lists))
            .join(' › ');
    // Android Auto's lists (plans/AUDIO.md, section 10): on a phone, hrseAmp hands the phone's player
    // what the car may browse - everything, shuffled; each mixtape in its order; each saved filter;
    // each station as a long run of its picks, the pinned ones first (pure/amppins.js) - a few
    // seconds after the library settles, so the car has the last set even once the page is gone.
    // Only what this server carries.
    useEffect(() => {
        const phone = typeof window !== 'undefined' && window.__ringtomePlayer;
        if (!phone || loading || !root || !stationsRead) return undefined;
        const timer = setTimeout(() => {
            const order = {
                artistOf: (r) => r.artist,
                albumOf: (r) => r.album,
                random: Math.random,
            };
            const items = (songs) => songs.map((r) => songForPhone(r, root));
            const lists = pinnedFirst(
                [
                    {
                        id: 'all',
                        title: t('amp.everything-shuffled', 'everything, shuffled'),
                        items: items(spreadOrder(playable(rows), order).slice(0, 2000)),
                    },
                    ...tapes.map((x) => ({
                        id: `mixtape:${x.id}`,
                        title: x.name,
                        items: items(playable(inMixtapeOrder(rows, x))),
                    })),
                    ...filters.map((f) => ({
                        id: `filter:${f.id}`,
                        title: f.name,
                        items: items(spreadOrder(songsOf({ kind: 'filter', id: f.id }), order)),
                    })),
                    ...stations.map((st) => {
                        const station = runFor(st);
                        station.next();
                        return {
                            id: `station:${st.id}`,
                            title: st.name,
                            items: items(
                                [station.current(), ...station.ahead(150)].filter(Boolean),
                            ),
                        };
                    }),
                ].filter((l) => l.items.length),
                pins,
            );
            try {
                phone.library(JSON.stringify({ lists }));
            } catch {
                /* the car keeps the last set it was given */
            }
        }, 3000);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, tapes, filters, stations, stationsRead, loading, root, pins]);
    const playStation = (st) => {
        if (!player) return;
        const run = runFor(st);
        if (!run.leaves().some((l) => (run.leafSongs.get(l.path) || []).length)) {
            toast(t('amp.station-silent', 'nothing to play - its slices hold no songs yet'));
            return;
        }
        player.playStation(st.id, run, st.name);
        notePlaylist('station', st.id, st.name);
    };
    // The station playing hears when the library, a filter, a mixtape or a station changes; one
    // that came back from a refresh as its history alone is rebuilt here, once the library's in.
    useEffect(() => {
        if (!player || !player.station || !stationsRead) return;
        const st = stations.find((x) => x.id === player.station);
        if (!st) return;
        const live = player.stationRun();
        if (live) {
            live.station = st;
            live.opts = { ...live.opts, stations, songsOf };
            // New songs come up soon (pure/stations.js); a phone holding picks made before they
            // arrived is handed the picks again.
            if (live.refresh()) player.stationAhead();
            return;
        }
        const waiting = player.pendingStation();
        if (!waiting || loading) return;
        const run = runFor(st);
        const byKey = new Map(rows.map((r) => [r.key, r]));
        run.history = waiting.rows.map((r) => byKey.get(r.key) || r);
        run.from = run.history.map((_, i) => (waiting.from && waiting.from[i]) || null);
        run.pos = Math.min(waiting.pos, run.history.length - 1);
        player.resumeStation(run);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, filters, tapes, stations, stationsRead, loading, player && player.station]);
    const putStation = (st) =>
        api(`/api/identity/${root}/private/kv/${AMP_STATIONS}/${st.id}`, {
            method: 'PUT',
            body: JSON.stringify({ value: stationValue(st.name, st.slices) }),
        })
            .then(() => notePlaylist('station', st.id, st.name))
            .catch((e) =>
                toast(
                    t('amp.couldnt-save-station', "couldn't save the station: {message}", {
                        message: e.message,
                    }),
                    {
                        kind: 'error',
                    },
                ),
            );
    // A change to a station: on screen at once; kept a moment after a slider settles, or now.
    const changeStation = (st, now = false) => {
        setStations((have) => have.map((x) => (x.id === st.id ? st : x)));
        clearTimeout(stationSave.current);
        if (now) putStation(st);
        else stationSave.current = setTimeout(() => putStation(st), 600);
    };
    const newStation = async () => {
        const name = await askText({
            title: t('amp.new-station-title', 'a new radio station'),
            label: t('amp.new-station-name', 'A name for the new station:'),
            ok: t('amp.make-it', 'make it'),
        });
        if (!name) return;
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        // It starts as everything at half: something to hear while its slices are chosen.
        const st = { id, name, slices: [{ kind: 'all', id: '', weight: 50 }] };
        setStations((have) => [...have, st].sort((a, b) => a.name.localeCompare(b.name)));
        await putStation(st);
        openStationView(st);
    };
    const forgetStation = async (st) => {
        if (
            !(await askYes({
                title: t('amp.forget-station-title', 'forget the station'),
                body: t('amp.forget-station', 'Forget the station "{name}"?', { name: st.name }),
                yes: t('amp.forget-it', 'forget it'),
                danger: true,
            }))
        )
            return;
        try {
            await api(`/api/identity/${root}/private/kv/${AMP_STATIONS}/${st.id}`, {
                method: 'PUT',
                body: JSON.stringify({ value: '' }),
            });
            setStations((have) => have.filter((x) => x.id !== st.id));
            if (openStation === st.id) setOpenStation(null);
            unpinGone('station', st.id);
            forgetThing(root, playlistThing('station', st.id));
        } catch (e) {
            failed(e);
        }
    };
    function openStationView(st) {
        settle();
        setOpenTape(null);
        setOpenStation(st.id);
    }
    // A playlist's own address (plans/RECENTS.md: its recent tile opens it): `?mixtape=`, `?station=`
    // or `?filter=` opens that one once it has been read, and the address goes back to hrseAmp's own.
    const loc = useLocation();
    const asked = loc.query || {};
    useEffect(() => {
        const tapeAsked = asked.mixtape && tapes.find((x) => x.id === asked.mixtape);
        const stationAsked = asked.station && stations.find((x) => x.id === asked.station);
        const filterAsked = asked.filter && filters.find((x) => x.id === asked.filter);
        if (tapeAsked) openMixtape(tapeAsked);
        else if (stationAsked) openStationView(stationAsked);
        else if (filterAsked) applyFilter(filterAsked);
        else return;
        loc.route(appHref('amp'), true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [asked.mixtape, asked.station, asked.filter, tapes, stations, filters]);
    // What the open station played lately, newest first - while it's the one on the air.
    const liveRun =
        player && player.station && openStation === player.station ? player.stationRun() : null;
    const lately = liveRun
        ? liveRun.history
              .slice(0, liveRun.pos + 1)
              .map((row, i) => ({ row, from: liveRun.from[i] }))
              .slice(-10)
              .reverse()
        : [];
    // What the table plays from, said as the player keeps it (pure/amp.js `readContext`).
    // A playlist saved, changed, or played from (plans/RECENTS.md) heads the dock: a filter, a
    // mixtape or a station, at the address that opens it again (`?mixtape=<id>`, below).
    const notePlaylist = (kind, id, name) =>
        id &&
        noteThing(root, {
            key: playlistThing(kind, id),
            app: 'amp',
            href: `${appHref('amp')}?${kind}=${id}`,
            title: name || '',
        });
    const playingFrom = tape
        ? { kind: 'mixtape', id: tape.id, name: tape.name }
        : loaded && sameFilter(loaded, settingsNow)
          ? { kind: 'filter', id: loaded.id, name: loaded.name }
          : anyAmpPicks(picks) || searchQuery
            ? { kind: 'filtered' }
            : { kind: 'all' };
    // Played from a saved filter or a mixtape: that playlist is a recent thing ("all" isn't one).
    const notePlayedFrom = (from) =>
        (from.kind === 'mixtape' || from.kind === 'filter') &&
        notePlaylist(from.kind, from.id, from.name);
    const keys = useMemo(() => shown.map((r) => r.key), [shown]);

    // The player carries on through the table as it now stands.
    useEffect(() => {
        if (player && player.current) player.relist(playable(shown), playingFrom);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shown]);

    // A song shown in the file column from the player or the queue, which the table (filtered, or a
    // station open) may not hold: it stays selected all the same.
    const [revealedKey, setRevealedKey] = useState(null);
    // A row that left the table leaves the selection.
    useEffect(() => {
        const here = new Set(keys);
        const stays = (k) => here.has(k) || k === revealedKey;
        if ([...picked].some((k) => !stays(k))) setPicked(new Set([...picked].filter(stays)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keys]);

    // The table's height, watched - and again whenever the table comes back: the cassette takes its
    // place while it shows, and the table it returns to is a new element, scrolled to the top
    // (Curtis, 2026-10-12: songs went missing after the cassette, the rows still drawn for the old
    // scroll). It goes back to where it was.
    const expanded = !!(player && player.expanded);
    useEffect(() => {
        const el = body.current;
        if (!el) return undefined;
        el.scrollTop = scrollTop;
        setScrollTop(el.scrollTop);
        setHeight(el.clientHeight);
        if (typeof ResizeObserver === 'undefined') return undefined;
        const watch = new ResizeObserver(() => setHeight(el.clientHeight));
        watch.observe(el);
        return () => watch.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded]);

    const save = (next) =>
        setRawSettings(
            JSON.stringify({ hidden: settings.hidden, widths, sort: settings.sort, ...next }),
        );
    const columns = COLUMNS.filter((c) => !settings.hidden.includes(c.key));
    const template = columns.map((c) => `${widths[c.key]}px`).join(' ');
    const sortBy = (c) => {
        if (tape || !c.sortable || Date.now() - resizedAt.current < 300) return;
        const down =
            settings.sort.column === c.key
                ? !settings.sort.down
                : c.key === 'date' || c.key === 'score';
        save({ sort: { column: c.key, down } });
    };
    // A header edge, dragged: that column wider or narrower, kept on letting go.
    const resize = (key) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = widths[key];
        const strip = e.currentTarget;
        strip.setPointerCapture(e.pointerId);
        let w = startW;
        const move = (ev) => {
            w = Math.max(COLUMN_MIN, Math.round(startW + ev.clientX - startX));
            setWidths((all) => ({ ...all, [key]: w }));
        };
        const up = () => {
            resizedAt.current = Date.now();
            strip.removeEventListener('pointermove', move);
            strip.removeEventListener('pointerup', up);
            save({ widths: { ...widths, [key]: w } });
        };
        strip.addEventListener('pointermove', move);
        strip.addEventListener('pointerup', up);
    };
    const toggleColumn = (key) => {
        const hidden = settings.hidden.includes(key)
            ? settings.hidden.filter((k) => k !== key)
            : [...settings.hidden, key];
        save({ hidden });
    };

    const onLayer = (changed, field, value) => {
        setLayerRows((have) => {
            const out = have.filter(
                (r) => !changed.some((c) => r.key === layerKey(c.author, c.doc, field)),
            );
            if (value)
                for (const c of changed) out.push({ key: layerKey(c.author, c.doc, field), value });
            return out;
        });
    };

    const select = (row, e) => {
        setPicked(
            clickSelect(picked, row.key, keys, anchor, {
                shift: e.shiftKey,
                toggle: e.metaKey || e.ctrlKey,
            }),
        );
        if (!e.shiftKey) setAnchor(row.key);
    };
    const selectedRows = shown.filter((r) => picked.has(r.key));
    if (
        revealedKey &&
        picked.has(revealedKey) &&
        !selectedRows.some((r) => r.key === revealedKey)
    ) {
        const r = rows.find((x) => x.key === revealedKey);
        if (r) selectedRows.push(r);
    }
    // The file column, brought out if it's tucked away.
    const openFile = () => {
        if (tucked.has('file')) toggleTuck('file');
    };
    // A song's file, in the file column (Curtis, 2026-10-13: the cover pressed, a queue's song, a
    // right-click): it alone selected, its row scrolled into view where the table holds it.
    const showFile = (key) => {
        if (player && player.expanded) player.setExpanded(false);
        setPicked(new Set([key]));
        setAnchor(key);
        setRevealedKey(key);
        openFile();
        const i = shown.findIndex((r) => r.key === key);
        const el = body.current;
        if (el && i >= 0) {
            const top = i * rowHeight;
            if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight)
                el.scrollTop = Math.max(0, top - el.clientHeight / 2);
        }
    };
    // The cover pressed, here or in the compact player elsewhere: once the library's in.
    const revealing = player && player.revealing;
    useEffect(() => {
        if (!revealing || loading) return;
        player.revealed();
        showFile(revealing);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [revealing, loading]);
    // Right-click a song, or some (Curtis, 2026-10-13): its file - the selection's, if it's in it.
    const rowMenu = (r) => (e) => {
        if (pressedLong()) return;
        e.preventDefault();
        if (!picked.has(r.key)) {
            setPicked(new Set([r.key]));
            setAnchor(r.key);
        }
        openFile();
    };
    // The keys, while hrseAmp is open (Curtis, 2026-10-13 - elsewhere other tools want them): space
    // plays and pauses, the arrows go back and on a song. Not while typing, nor under a modal.
    const keyed = useRef(null);
    keyed.current = { player, list: playable(shown), from: playingFrom, noted: notePlayedFrom };
    useEffect(() => {
        const press = (e) => {
            const { player: p, list, from, noted } = keyed.current;
            if (!p || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
            const el = e.target;
            if (el && el.closest && el.closest('input, textarea, select, [contenteditable]'))
                return;
            if (document.querySelector('.modal-scrim')) return;
            if (e.key === ' ') {
                e.preventDefault();
                if (p.current) p.toggle();
                else if (list.length) {
                    p.play(list, null, from);
                    noted(from);
                }
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                p.prev();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                p.next();
            }
        };
        document.addEventListener('keydown', press);
        return () => document.removeEventListener('keydown', press);
    }, []);
    // The song playing: its row as the table has it, for its thumbs and its source.
    const nowRow = playingKeyOf(player) ? rows.find((r) => r.key === playingKeyOf(player)) : null;
    const nowRating = (nowRow && nowRow.layer && nowRow.layer.reaction) || '';
    const rateNow = nowRow ? (value) => rate(root, nowRow, value, onLayer) : null;
    const onAir = player && player.station ? player.stationRun() : null;
    const nowFrom = onAir ? onAir.from[onAir.pos] || null : null;
    const nowSource =
        (nowFrom && sourceOf(nowFrom)) || (player && contextWords(player.context, lists));

    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
    const last = Math.min(shown.length, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);
    const playingKey = playingKeyOf(player);
    const playRow = (r) => {
        if (!player || r.carried === false) return;
        player.play(playable(shown), r, playingFrom);
        notePlayedFrom(playingFrom);
    };
    // A long press is a phone's Ctrl-click: that row into the selection, or out of it.
    const held = (r) => () => {
        setPicked((p) => clickSelect(p, r.key, keys, anchor, { toggle: true }));
        setAnchor(r.key);
    };
    const tapped = (r) => (e) => {
        if (e.pointerType !== 'touch' || pressedLong()) return;
        const now = performance.now();
        if (lastTap.current.key === r.key && now - lastTap.current.at < DOUBLE_TAP) {
            lastTap.current = { key: null, at: 0 };
            tappedPlay.current = now;
            playRow(r);
        } else lastTap.current = { key: r.key, at: now };
    };
    // An open mixtape's rows, moved by a finger (Curtis, 2026-10-12): a phone has no drag and drop,
    // so the handle follows the pointer itself, the table scrolling under it near either edge, and
    // the gap it's over is where the song lands - the mouse's drop, by hand.
    const fingerDrag = (r) => (e) => {
        if (!tape || e.pointerType === 'mouse') return;
        e.preventDefault();
        e.stopPropagation();
        const table = body.current;
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        dragKey.current = r.key;
        const over = (ev) => dropTarget({ clientY: ev.clientY, currentTarget: table });
        const move = (ev) => {
            const box = table.getBoundingClientRect();
            if (ev.clientY < box.top + rowHeight) table.scrollTop -= rowHeight / 3;
            else if (ev.clientY > box.bottom - rowHeight) table.scrollTop += rowHeight / 3;
            setDropAt(over(ev));
        };
        const end = (ev) => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
            const at = ev.type === 'pointerup' ? over(ev) : null;
            dragKey.current = null;
            setDropAt(null);
            const index = at ? dropIndex(tape.members, r.key, at.key, at.after) : null;
            if (index !== null) moveInTape(r.key, index);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    };

    // The file column (Curtis, 2026-10-12): the house's kind, as Playlists is - tucked to a rail by
    // its head, a tab in a narrow window - there while something is selected.
    const fileOpen = !tucked.has('file');
    const fileColumn =
        selectedRows.length === 0
            ? null
            : fileOpen
              ? html`${tab('file', Icons.fileAudio, t('amp.file', 'file'))}<aside class="amp-panel">
                    <${PaneHead} icon=${Icons.fileAudio} label=${t('amp.file', 'file')} onTuck=${() => toggleTuck('file')} />
                    <${FilePanel}
                        root=${root}
                        rows=${selectedRows}
                        docRows=${docRows}
                        layer=${layer}
                        onLayer=${onLayer}
                        onClear=${() => setPicked(new Set())}
                        onDeleted=${() => setPicked(new Set())}
                        mixtapes=${{ tapes, openTape, onAdd: addToTape, onRemove: removeFromTape }}
                    />
                </aside>${resizer('file')}`
              : html`<${Rail} icon=${Icons.fileAudio} label=${t('amp.file', 'file')} onClick=${() => toggleTuck('file')} />`;
    // The now-playing column (Curtis, 2026-10-13): there while a song is.
    const nowColumn =
        !player || !player.current
            ? null
            : !tucked.has('now')
              ? html`${tab('now', Icons.nowPlaying, t('amp.now-playing', 'now playing'))}<${NowPlaying}
                    player=${player}
                    from=${player.context}
                    lists=${lists}
                    sourceOf=${sourceOf}
                    nowFrom=${nowFrom}
                    rating=${nowRating}
                    onRate=${rateNow}
                    onShow=${showFile}
                    onTuck=${() => toggleTuck('now')}
                />${resizer('now')}`
              : html`<${Rail} icon=${Icons.nowPlaying} label=${t('amp.now-playing', 'now playing')} onClick=${() => toggleTuck('now')} />`;

    return html`<div class=${player && player.expanded ? 'amp-app amp-expanded' : 'amp-app'}>
        ${
            player && player.expanded
                ? html`<${Cassette} rating=${nowRating} onRate=${rateNow} />`
                : html`<div class="amp-main panes" style=${colStyle}>
            ${
                tucked.has('playlists')
                    ? html`<${Rail} icon=${Icons.music} label=${t('amp.playlists', 'playlists')} onClick=${() => toggleTuck('playlists')} />`
                    : html`${tab('playlists', Icons.music, t('amp.playlists', 'playlists'))}<${Playlists}
                          filters=${filters}
                          now=${tape || openStation ? null : settingsNow}
                          onAll=${() => applyFilter(null)}
                          onPick=${applyFilter}
                          onForget=${forgetFilter}
                          onTuck=${() => toggleTuck('playlists')}
                          tapes=${tapes}
                          openTape=${openTape}
                          onOpenTape=${openMixtape}
                          onForgetTape=${forgetTape}
                          stations=${stations}
                          openStation=${openStation}
                          playingStation=${player ? player.station : null}
                          onOpenStation=${openStationView}
                          onForgetStation=${forgetStation}
                          onNewStation=${newStation}
                          pins=${pins}
                          onPin=${togglePin}
                      />${resizer('playlists')}`
            }
            ${nowColumn}
            ${
                /* What's selected, in a column of its own left of the table (Curtis, 2026-10-12),
                as wide as it's dragged - there while something is. */ ''
            }
            ${fileColumn}
            <div class="amp-list">
                ${
                    openStationObj
                        ? html`<${StationView}
                              station=${openStationObj}
                              stations=${stations}
                              filters=${filters}
                              tapes=${tapes}
                              playing=${!!player && player.station === openStationObj.id}
                              history=${lately}
                              countOf=${countOf}
                              sourceOf=${sourceOf}
                              onShow=${showFile}
                              onChange=${changeStation}
                              onPlay=${() => playStation(openStationObj)}
                          />`
                        : html`
                ${
                    stop &&
                    html`<${FilterStrip}
                    songs=${rows}
                    picks=${picks}
                    onPicks=${setPicks}
                    stop=${stop}
                    onStop=${moveStop}
                    scope=${scope}
                    onScope=${setScope}
                    onSave=${saveFilter}
                    loaded=${loaded}
                    now=${settingsNow}
                    wordOf=${wordOf}
                    iconOf=${iconOf}
                    me=${root}
                />`
                }
                <p class="amp-count">
                    ${loading ? t('amp.looking', 'looking for music…') : t('amp.n-songs', '{n} songs', { n: shown.length })}
                    ${' · '}
                    <button class="facet-more" onClick=${() => setPicked(new Set(keys))} disabled=${!shown.length}>${t('amp.select-all', 'select all')}</button>
                    ${picked.size > 0 && html`${' · '}<button class="facet-more" onClick=${() => setPicked(new Set())}>${t('amp.clear', 'clear')}</button>`}
                    ${' · '}
                    <button class="facet-more" onClick=${load}>${t('amp.refresh', 'refresh')}</button>
                </p>
                <div
                    class="amp-table"
                    ref=${body}
                    onScroll=${(e) => setScrollTop(e.currentTarget.scrollTop)}
                    onDragOver=${(e) => {
                        if (!tape || !dragKey.current) return;
                        e.preventDefault();
                        const at = dropTarget(e);
                        if (at && (!dropAt || dropAt.key !== at.key || dropAt.after !== at.after))
                            setDropAt(at);
                    }}
                    onDrop=${(e) => {
                        if (!tape || !dragKey.current) return;
                        e.preventDefault();
                        const at = dropTarget(e);
                        const moved = dragKey.current;
                        dragKey.current = null;
                        setDropAt(null);
                        const index = at ? dropIndex(tape.members, moved, at.key, at.after) : null;
                        if (index !== null) moveInTape(moved, index);
                    }}
                >
                    <div class="amp-head" style=${`grid-template-columns: 2rem ${template}`}>
                        <${ColumnMenu} hidden=${settings.hidden} onToggle=${toggleColumn} />
                        ${columns.map(
                            (c) => html`<div
                                key=${c.key}
                                class=${c.sortable ? 'amp-th amp-th-sorts' : 'amp-th'}
                                title=${COLUMN_HINTS[c.key] ? COLUMN_HINTS[c.key]() : undefined}
                                onClick=${() => sortBy(c)}
                            >
                                <span class="amp-th-word">${COLUMN_WORDS[c.key]()}</span>
                                ${!tape && settings.sort.column === c.key && html`<span class="amp-th-dir">${settings.sort.down ? '▾' : '▴'}</span>`}
                                <span class="amp-th-edge" onPointerDown=${resize(c.key)} onClick=${(e) => e.stopPropagation()}></span>
                            </div>`,
                        )}
                    </div>
                    <div class="amp-rows" style=${`height: ${shown.length * rowHeight}px`}>
                        ${shown.slice(first, last).map(
                            (r, i) => html`<div
                                key=${r.key}
                                class=${[
                                    'amp-row',
                                    picked.has(r.key) ? 'amp-row-picked' : '',
                                    playingKey === r.key ? 'amp-row-playing' : '',
                                    r.carried === false ? 'amp-row-uncarried' : '',
                                    dropAt && dropAt.key === r.key
                                        ? dropAt.after
                                            ? 'amp-row-drop-after'
                                            : 'amp-row-drop-before'
                                        : '',
                                ].join(' ')}
                                style=${`top: ${(first + i) * rowHeight}px; height: ${rowHeight}px; grid-template-columns: 2rem ${template}`}
                                onClick=${(e) => select(r, e)}
                                onContextMenu=${rowMenu(r)}
                                ...${longPress(held(r), { onUp: tapped(r) })}
                                onDblClick=${() => performance.now() - tappedPlay.current > 600 && playRow(r)}
                                draggable=${!!tape}
                                onDragStart=${(e) => {
                                    if (!tape) return;
                                    dragKey.current = r.key;
                                    e.dataTransfer.effectAllowed = 'move';
                                    e.dataTransfer.setData('text/plain', r.key);
                                }}
                                onDragEnd=${() => {
                                    dragKey.current = null;
                                    setDropAt(null);
                                }}
                            >
                                <span class="amp-td-lead">${playingKey === r.key ? html`<${Icons.speaker} />` : tape && html`<span class="amp-drag-handle" title=${t('amp.drag-to-reorder', 'drag to move it in the mixtape')} onPointerDown=${fingerDrag(r)}><${Icons.dragHandle} /></span>`}</span>
                                ${columns.map((c) => {
                                    const v = cell(r, c.key, names);
                                    const said = richCell(r, c.key) || v;
                                    // On a phone the title carries the artist under it: the
                                    // columns past the first are a sideways scroll away.
                                    return narrow && c.key === 'title'
                                        ? html`<span key=${c.key} class="amp-td amp-td-title amp-td-two" title=${v}>
                                              <span class="amp-td-line">${said}</span>
                                              <span class="amp-td-sub">${cell(r, 'artist', names)}</span>
                                          </span>`
                                        : html`<span key=${c.key} class=${cellClass(c.key)} title=${v}>${said}</span>`;
                                })}
                            </div>`,
                        )}
                    </div>
                    ${!loading && shown.length === 0 && html`<p class="null-sub amp-empty">${tape && !searchQuery && !anyAmpPicks(picks) ? t('amp.empty-mixtape', 'nothing on this mixtape yet - add songs from the file column.') : searchQuery || anyAmpPicks(picks) ? t('amp.nothing-matches', 'nothing matches that.') : t('amp.no-music-yet', 'no music yet - upload some sounds in hrseFiles, or follow someone who posts theirs.')}</p>`}
                </div>
`
                }
            </div>
        </div>`
        }
        <${PlayerBar}
            list=${playable(shown)}
            from=${playingFrom}
            source=${nowSource}
            rating=${nowRating}
            onRate=${rateNow}
            onStarted=${notePlayedFrom}
        />
    </div>`;
};
