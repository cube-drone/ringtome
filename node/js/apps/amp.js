// hrseAmp (plans/AUDIO.md, slices 1 and 2): music. A table of every sound you can see - your own,
// from the mirror, and the sound in your feed at the curiosity dial, from the node (`/amp/library`)
// - sortable, its columns resized and hidden as you like, its rows selected one, several or all; the
// file panel beside it for what's selected; and the player across the foot (player.js), which plays
// the table as it stands.
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
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
    by: () => t('amp.col-by', 'by'),
    from: () => t('amp.col-from', 'from'),
    date: () => t('amp.col-date', 'date'),
    score: () => t('amp.col-score', 'score'),
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
const NUMERIC = new Set(['length', 'score', 'number']);
const cellClass = (key) =>
    key === 'title' ? 'amp-td amp-td-title' : NUMERIC.has(key) ? 'amp-td amp-td-numeric' : 'amp-td';

/// A person's name for the By and From columns: theirs as the node knows it, else their words.
const nameOf = (names, root) =>
    names[root] || (root ? speakable(root).split('-').slice(0, 2).join('-') : '');

/// A score in whole likes, as the feed reckons it (score.rs's thousandths).
const likes = (milli) => {
    const n = (milli || 0) / 1000;
    return n === 0 ? '' : Number.isInteger(n) ? String(n) : n.toFixed(1);
};

function cell(row, key, names) {
    switch (key) {
        case 'length':
            return clock(row.lengthMs);
        case 'tags':
            return row.tags.join(', ');
        case 'by':
            return nameOf(names, row.author);
        case 'from':
            return nameOf(names, row.from);
        case 'date':
            return row.dateMs ? formatWhen(row.dateMs, Date.now(), { time: false }) : '';
        case 'score':
            return likes(row.score);
        case 'number':
            return row.number == null ? '' : String(row.number);
        default:
            return row[key] || '';
    }
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
    return html`<p class="amp-reaction">
        <button class=${now === 'up' ? 'chip chip-button chip-on' : 'chip chip-button'} onClick=${() => set('up')} title=${t('amp.like', 'like')}>👍</button>
        <button class=${now === 'down' ? 'chip chip-button chip-on' : 'chip chip-button'} onClick=${() => set('down')} title=${t('amp.dislike', 'dislike')}>👎</button>
    </p>`;
};

/// What's selected, beside the table: one of your sounds, its own panel; one of someone else's, its
/// fields beside yours; several, the bulk panel for yours and your layer for theirs.
const FilePanel = ({ root, rows, docRows, layer, onLayer, onClear, onDeleted }) => {
    const own = rows.filter((r) => r.own && !r.builtin);
    const theirs = rows.filter((r) => !r.own);
    const files = appById('lost-found');
    if (rows.length === 1) {
        const r = rows[0];
        return html`<aside class="amp-panel">
            <h2 class="amp-panel-title">${r.title}</h2>
            ${r.own && !r.builtin && html`<${Reaction} root=${root} row=${r} onLayer=${onLayer} /><${SoundTags} root=${root} docId=${r.doc} />`}
            ${r.builtin && html`<${SoundTags} root=${root} docId=${r.doc} readOnly=${true} />`}
            ${
                !r.own &&
                html`<p class="null-sub">
                    ${t('amp.theirs-yours-beside', 'Their fields, and yours beside them: yours are only yours, and win in your table.')}
                    ${r.post && html` <a href=${postHref(r.author, r.post)}>${t('amp.the-post', 'the post it came in')}</a>`}
                </p>
                <${LayerFields} root=${root} rows=${[r]} layer=${layer} onLayer=${onLayer} />`
            }
        </aside>`;
    }
    return html`<aside class="amp-panel">
        <h2 class="amp-panel-title">${t('amp.n-selected', '{n} selected', { n: rows.length })}</h2>
        <p><button class="chip chip-button" onClick=${onClear}>${t('amp.clear', 'clear')}</button></p>
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
            />`
        }
        ${
            theirs.length > 0 &&
            html`<h3 class="amp-panel-sub">${t('amp.n-of-other-peoples', "{n} of other people's: your fields", { n: theirs.length })}</h3>
            <${LayerFields} root=${root} rows=${theirs} layer=${layer} onLayer=${onLayer} />`
        }
    </aside>`;
};

/// The column menu: every column, ticked if shown.
const ColumnMenu = ({ hidden, onToggle }) => {
    const [open, setOpen] = useState(false);
    return html`<span class="amp-columns">
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

export const AmpApp = ({ current, searchQuery }) => {
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

    const load = async () => {
        if (!root) return;
        setLoading(true);
        const [layerAnswer, dial] = await Promise.all([
            api(`/api/identity/${root}/private/kv/${LAYER}`).catch(() => ({ values: [] })),
            api(`/api/identity/${root}/private/kv/feed_selectivity`).catch(() => ({ values: [] })),
        ]);
        setLayerRows(layerAnswer.values || []);
        const stop = ((dial.values || []).find((v) => v.key === 'stop') || {}).value;
        const answer = await api(
            `/api/identity/${root}/amp/library${stop ? `?stop=${encodeURIComponent(stop)}` : ''}`,
        ).catch(() => ({ sounds: [], names: {} }));
        setFeed({ sounds: answer.sounds || [], names: answer.names || {} });
        setLoading(false);
    };
    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root]);

    const layer = useMemo(() => readLayer(layerRows), [layerRows]);
    const docRows = useMemo(() => new Map((docs || []).map((d) => [d.doc_id, d])), [docs]);
    const rows = useMemo(() => {
        const mine = (docs || [])
            .filter((d) => d.format === 'opus')
            .map((d) => ({ ...ownRow(d, root, layer), builtin: !!d.builtin }));
        return [...mine, ...feed.sounds.map((s) => feedRow(s, layer))];
    }, [docs, feed, layer, root]);
    const names = useMemo(
        () => ({ ...feed.names, [root]: t('amp.you', 'you') }),
        [feed.names, root],
    );
    const shown = useMemo(
        () => sorted(searched(rows, searchQuery), settings.sort, names),
        [rows, searchQuery, settings.sort, names],
    );
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

    useEffect(() => {
        const el = body.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const watch = new ResizeObserver(() => setHeight(el.clientHeight));
        watch.observe(el);
        setHeight(el.clientHeight);
        return () => watch.disconnect();
    }, []);

    const save = (next) =>
        setRawSettings(
            JSON.stringify({ hidden: settings.hidden, widths, sort: settings.sort, ...next }),
        );
    const columns = COLUMNS.filter((c) => !settings.hidden.includes(c.key));
    const template = columns.map((c) => `${widths[c.key]}px`).join(' ');
    const sortBy = (c) => {
        if (!c.sortable) return;
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

    return html`<div class=${player && player.expanded ? 'amp-app amp-expanded' : 'amp-app'}>
        ${
            player && player.expanded
                ? html`<${Cassette} />`
                : html`<div class="amp-main">
            <div class="amp-list">
                <p class="amp-count">
                    ${loading ? t('amp.looking', 'looking for music…') : t('amp.n-songs', '{n} songs', { n: shown.length })}
                    ${' · '}
                    <button class="facet-more" onClick=${() => setPicked(new Set(keys))} disabled=${!shown.length}>${t('amp.select-all', 'select all')}</button>
                    ${picked.size > 0 && html`${' · '}<button class="facet-more" onClick=${() => setPicked(new Set())}>${t('amp.clear', 'clear')}</button>`}
                    ${' · '}
                    <button class="facet-more" onClick=${load}>${t('amp.refresh', 'refresh')}</button>
                </p>
                <div class="amp-table" ref=${body} onScroll=${(e) => setScrollTop(e.currentTarget.scrollTop)}>
                    <div class="amp-head" style=${`grid-template-columns: ${template} 2rem`}>
                        ${columns.map(
                            (c) => html`<div
                                key=${c.key}
                                class=${c.sortable ? 'amp-th amp-th-sorts' : 'amp-th'}
                                onClick=${() => sortBy(c)}
                            >
                                <span class="amp-th-word">${COLUMN_WORDS[c.key]()}</span>
                                ${settings.sort.column === c.key && html`<span class="amp-th-dir">${settings.sort.down ? '▾' : '▴'}</span>`}
                                <span class="amp-th-edge" onPointerDown=${resize(c.key)}></span>
                            </div>`,
                        )}
                        <${ColumnMenu} hidden=${settings.hidden} onToggle=${toggleColumn} />
                    </div>
                    <div class="amp-rows" style=${`height: ${shown.length * ROW_HEIGHT}px`}>
                        ${shown.slice(first, last).map(
                            (r, i) => html`<div
                                key=${r.key}
                                class=${['amp-row', picked.has(r.key) ? 'amp-row-picked' : '', playingKey === r.key ? 'amp-row-playing' : ''].join(' ')}
                                style=${`top: ${(first + i) * ROW_HEIGHT}px; grid-template-columns: ${template} 2rem`}
                                onClick=${(e) => select(r, e)}
                                onDblClick=${() => player && player.play(shown, r)}
                            >
                                ${columns.map((c) => {
                                    const v = cell(r, c.key, names);
                                    return html`<span key=${c.key} class=${cellClass(c.key)} title=${v}>${v}</span>`;
                                })}
                            </div>`,
                        )}
                    </div>
                    ${!loading && shown.length === 0 && html`<p class="null-sub amp-empty">${searchQuery ? t('amp.nothing-matches', 'nothing matches that.') : t('amp.no-music-yet', 'no music yet - upload some sounds in hrseFiles, or follow someone who posts theirs.')}</p>`}
                </div>
            </div>
            ${
                selectedRows.length > 0 &&
                html`<${FilePanel}
                    root=${root}
                    rows=${selectedRows}
                    docRows=${docRows}
                    layer=${layer}
                    onLayer=${onLayer}
                    onClear=${() => setPicked(new Set())}
                    onDeleted=${() => setPicked(new Set())}
                />`
            }
        </div>`
        }
        <${PlayerBar} list=${shown} />
    </div>`;
};
