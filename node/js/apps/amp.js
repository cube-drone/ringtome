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
import { usePlayer, PlayerBar, Cassette } from '../player.js';
import { postHref } from '../links.js';
import { Icons } from '../icons.js';
import { toast } from '../toasts.js';
import { t } from '../i18n.js';
import { askText } from '../modal.js';
import { FacetRow } from '../facets.js';
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
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
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

const html = htm.bind(h);

/// The private register your layer on other people's songs lives in (ruling 6), and the device pref
/// the table's columns live in.
const LAYER = 'amp_layer';
const TABLE_PREF = 'amp-table';
/// A row's height, in pixels: the table draws only the rows in view, and this is how it knows which.
const ROW_HEIGHT = 30;
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
function richCell(row, key) {
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

/// A like or a dislike of your own sound (ruling 3): its score, which only you can give a sound
/// nobody else can see. Kept in your layer.
const Reaction = ({ root, row, onLayer }) => {
    const now = (row.layer && row.layer.reaction) || '';
    const set = async (value) => {
        const next = now === value ? '' : value;
        await api(
            `/api/identity/${root}/private/kv/${LAYER}/${encodeURIComponent(layerKey(row.author, row.doc, 'reaction'))}`,
            {
                method: 'PUT',
                body: JSON.stringify({ value: next }),
            },
        ).catch(() => {});
        onLayer([row], 'reaction', next);
    };
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
    const sure =
        own.length === 1
            ? confirm(
                  t('amp.delete-one', 'Delete "{title}"? It leaves every list right away.', {
                      title: own[0].title,
                  }),
              )
            : confirm(
                  t('amp.delete-many', 'Delete your {n} songs? They leave every list right away.', {
                      n: own.length,
                  }),
              );
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
/// while it is what the table shows - and the mixtapes (section 5). Radio stations join it in their
/// slice.
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
}) => html`<aside class="amp-playlists">
    <${PaneHead} icon=${Icons.music} label=${t('amp.playlists', 'playlists')} onTuck=${onTuck} />
    <p class="amp-playlists-group">${t('amp.filters', 'filters')}</p>
    <div class=${now && !anyAmpPicks(now.picks) && !now.q ? 'feed-saved-row active' : 'feed-saved-row'}>
        <span class="feed-saved-forget feed-saved-spacer" aria-hidden="true"><${Icons.trash} /></span>
        <button
            class="feed-saved-name"
            title=${t('amp.all-title', 'every song you can see - every chip back to unpicked')}
            onClick=${onAll}
        >${t('apps.feed.all', 'all')}</button>
    </div>
    ${filters.map(
        (
            f,
        ) => html`<div key=${f.id} class=${sameFilter(f, now) ? 'feed-saved-row active' : 'feed-saved-row'}>
            <button
                class="feed-saved-forget"
                title=${t('amp.forget-this-filter', 'forget this filter')}
                aria-label=${t('amp.forget-this-filter', 'forget this filter')}
                onClick=${() => onForget(f)}
            ><${Icons.trash} /></button>
            <button class="feed-saved-name" onClick=${() => onPick(f)}>${f.name}</button>
        </div>`,
    )}
    ${/* Mixtapes (section 5): each a name and an order, opened into the table in that order. */ ''}
    ${tapes.length > 0 && html`<p class="amp-playlists-group">${t('amp.mixtapes', 'mixtapes')}</p>`}
    ${tapes.map(
        (
            tape,
        ) => html`<div key=${tape.id} class=${openTape === tape.id ? 'feed-saved-row active' : 'feed-saved-row'}>
            <button
                class="feed-saved-forget"
                title=${t('amp.forget-this-mixtape', 'forget this mixtape - its songs stay where they are')}
                aria-label=${t('amp.forget-this-mixtape', 'forget this mixtape - its songs stay where they are')}
                onClick=${() => onForgetTape(tape)}
            ><${Icons.trash} /></button>
            <button class="feed-saved-name" onClick=${() => onOpenTape(tape)}>${tape.name}</button>
        </div>`,
    )}
</aside>`;

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
        .map((x) => `${x.taxonomy_id}:${x.members ?? ''}`)
        .sort()
        .join(',');
    const [tapes, setTapes] = useState([]);
    const [tapesAt, setTapesAt] = useState(0);
    const reloadTapes = () => setTapesAt(Date.now());
    const [openTape, setOpenTape] = useState(null);
    useEffect(() => {
        if (!root) return;
        const ids = tapeIds ? tapeIds.split(',').map((x) => x.split(':')[0]) : [];
        Promise.all(
            ids.map((id) =>
                api(`/api/identity/${root}/taxonomies/${id}`)
                    .then(readMixtape)
                    .catch(() => null),
            ),
        ).then((list) =>
            setTapes(list.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))),
        );
    }, [root, tapeIds, tapesAt]);
    const tape = tapes.find((x) => x.id === openTape) || null;
    // A drag in an open mixtape: the song lifted, and where it would land.
    const dragKey = useRef(null);
    const [dropAt, setDropAt] = useState(null); // { key, after }
    const { tucked, toggleTuck, tab, settle } = useColTucks(root, 'amp');
    // The Playlists column and the file column, each as wide as it was dragged (panes.js).
    const { resizer, colStyle } = useColWidths(root, 'amp', ['playlists', 'file'], { file: 260 });

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
        if (!confirm(t('amp.forget-filter', 'Forget the filter "{name}"?', { name: f.name })))
            return;
        try {
            // A register emptied is one deleted (pure/ampfilters.js).
            await api(`/api/identity/${root}/private/kv/${AMP_FILTERS}/${f.id}`, {
                method: 'PUT',
                body: JSON.stringify({ value: '' }),
            });
            setFilters((have) => have.filter((x) => x.id !== f.id));
            if (loadedId === f.id) setLoadedId(null);
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
        } catch (e) {
            failed(e);
        }
        reloadTapes();
    };
    const forgetTape = async (x) => {
        if (
            !confirm(
                t(
                    'amp.forget-mixtape',
                    'Forget the mixtape "{name}"? Its songs stay where they are.',
                    { name: x.name },
                ),
            )
        )
            return;
        try {
            await api(`/api/identity/${root}/taxonomies/${x.id}`, { method: 'DELETE' });
            if (openTape === x.id) setOpenTape(null);
            setTapes((have) => have.filter((y) => y.id !== x.id));
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
        const y = (e.clientY - rowsEl.getBoundingClientRect().top) / ROW_HEIGHT;
        if (y < 0) return { key: shown[0].key, after: false };
        if (y >= shown.length) return { key: shown[shown.length - 1].key, after: true };
        const i = Math.floor(y);
        return { key: shown[i].key, after: y - i >= 0.5 };
    };
    const keys = useMemo(() => shown.map((r) => r.key), [shown]);

    // The player carries on through the table as it now stands.
    useEffect(() => {
        if (player && player.current) player.relist(shown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shown]);

    // A row that left the table leaves the selection.
    useEffect(() => {
        const here = new Set(keys);
        if ([...picked].some((k) => !here.has(k)))
            setPicked(new Set([...picked].filter((k) => here.has(k))));
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

    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(shown.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    const playingKey = player && player.current ? player.current.key : null;

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

    return html`<div class=${player && player.expanded ? 'amp-app amp-expanded' : 'amp-app'}>
        ${
            player && player.expanded
                ? html`<${Cassette} />`
                : html`<div class="amp-main panes" style=${colStyle}>
            ${
                tucked.has('playlists')
                    ? html`<${Rail} icon=${Icons.music} label=${t('amp.playlists', 'playlists')} onClick=${() => toggleTuck('playlists')} />`
                    : html`${tab('playlists', Icons.music, t('amp.playlists', 'playlists'))}<${Playlists}
                          filters=${filters}
                          now=${tape ? null : settingsNow}
                          onAll=${() => applyFilter(null)}
                          onPick=${applyFilter}
                          onForget=${forgetFilter}
                          onTuck=${() => toggleTuck('playlists')}
                          tapes=${tapes}
                          openTape=${openTape}
                          onOpenTape=${openMixtape}
                          onForgetTape=${forgetTape}
                      />${resizer('playlists')}`
            }
            ${
                /* What's selected, in a column of its own left of the table (Curtis, 2026-10-12),
                as wide as it's dragged - there while something is. */ ''
            }
            ${fileColumn}
            <div class="amp-list">
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
                    <div class="amp-rows" style=${`height: ${shown.length * ROW_HEIGHT}px`}>
                        ${shown.slice(first, last).map(
                            (r, i) => html`<div
                                key=${r.key}
                                class=${[
                                    'amp-row',
                                    picked.has(r.key) ? 'amp-row-picked' : '',
                                    playingKey === r.key ? 'amp-row-playing' : '',
                                    dropAt && dropAt.key === r.key
                                        ? dropAt.after
                                            ? 'amp-row-drop-after'
                                            : 'amp-row-drop-before'
                                        : '',
                                ].join(' ')}
                                style=${`top: ${(first + i) * ROW_HEIGHT}px; grid-template-columns: 2rem ${template}`}
                                onClick=${(e) => select(r, e)}
                                onDblClick=${() => player && player.play(shown, r)}
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
                                <span class="amp-td-lead">${playingKey === r.key ? html`<${Icons.speaker} />` : tape && html`<span class="amp-drag-handle" title=${t('amp.drag-to-reorder', 'drag to move it in the mixtape')}><${Icons.dragHandle} /></span>`}</span>
                                ${columns.map((c) => {
                                    const v = cell(r, c.key, names);
                                    return html`<span key=${c.key} class=${cellClass(c.key)} title=${v}>${richCell(r, c.key) || v}</span>`;
                                })}
                            </div>`,
                        )}
                    </div>
                    ${!loading && shown.length === 0 && html`<p class="null-sub amp-empty">${tape && !searchQuery && !anyAmpPicks(picks) ? t('amp.empty-mixtape', 'nothing on this mixtape yet - add songs from the file column.') : searchQuery || anyAmpPicks(picks) ? t('amp.nothing-matches', 'nothing matches that.') : t('amp.no-music-yet', 'no music yet - upload some sounds in hrseFiles, or follow someone who posts theirs.')}</p>`}
                </div>
            </div>
        </div>`
        }
        <${PlayerBar} list=${shown} />
    </div>`;
};
