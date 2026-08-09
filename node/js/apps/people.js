// People: the rolodex. Two halves, both thin: a lookup box that dissects any pasted
// reference (a full shared URL, an /id/ path, a bare address) and routes to the /id lens -
// that page owns the grammar, the fetching, and the relationship panel - and the shelf of
// everyone your ledger holds a relationship with, straight off the mirror's `contacts` kind
// (The Browser Is a View: a dial turned on any of your computers re-sorts this list live).
import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from '../mirror.js';
import { parseIdReference, speakable } from '../speakable.js';
import { PersonRow } from '../person.js';
import { api } from '../net.js';
import { PEOPLE_SORTS, PEOPLE_SHELF_SLICE, filterContacts, sortContacts } from '../pure/people.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/// People's answer to the search bar, riding the same header slot as every other app's -
/// and since 2026-08-08 it does both of the bar's jobs at once: TYPING filters the shelf
/// live (the query is lifted to the shell, like every searchable app's), and SUBMIT is the
/// lookup - paste an address in any dress (a shared URL, an /id/ path, a bare address), hit
/// the button, and go there. The button keeps its moment of commitment because the lookup
/// completes somewhere else; the filter needs no commitment at all. A submit that doesn't
/// parse flags red - it means "that's not an address", never "that's a bad filter": the
/// filter is already applied, and the flag clears on the next keystroke.
export const PeopleLookup = ({ query, onQuery }) => {
    const loc = useLocation();
    const [bad, setBad] = useState(false);

    const go = (e) => {
        e.preventDefault();
        const ref = parseIdReference(query || '');
        if (!ref) {
            setBad(true); // the input says so itself; the header band has no room for a line
            return;
        }
        setBad(false);
        loc.route(`/id/${ref.seg}${ref.via ? `?via=${encodeURIComponent(ref.via)}` : ''}`);
    };

    return html`
        <form class="app-header-search-box" onSubmit=${go}>
            <input
                class=${bad ? 'app-header-search people-lookup-bad' : 'app-header-search'}
                type="search"
                placeholder=${t('apps.people.filter-or-paste-an-address', 'filter, or paste an address…')}
                title=${bad
                    ? t('apps.people.that-doesnt-look-like-a', "that doesn't look like a persona's address - it should have two words and a key, like sway-broke-AwTy…")
                    : t('apps.people.type-to-narrow-the-shelf', 'search or paste an address')}
                value=${query || ''}
                onInput=${(e) => {
                    onQuery(e.currentTarget.value);
                    setBad(false);
                }}
            />
            <button class="people-lookup-go" type="submit" title=${t('apps.people.go-to-this-persona', 'go to this persona')}>
                ${t('apps.people.look-up', 'look up')}
            </button>
        </form>
    `;
};

// The node's directory: everyone known around here, fetched once per visit. Not the mirror -
// this is the NODE's acquaintance (served neighbors + personas members have reached), not the
// persona's own ledger, so it doesn't stream; a visit's snapshot is the right freshness.
const useDirectory = () => {
    const [rows, setRows] = useState(null);
    useEffect(() => {
        let live = true;
        api('/api/directory')
            .then((r) => live && setRows(r))
            .catch(() => live && setRows([]));
        return () => {
            live = false;
        };
    }, []);
    return rows;
};

export const PeopleApp = ({ current, searchQuery }) => {
    const root = current && current.root;
    const [sortBy, setSortBy] = useState('trust');
    // Search-first (settled 2026-08-08): the header bar's query filters the shelf, and the
    // shelf shows a SLICE. The DOM holds at most PEOPLE_SHELF_SLICE rows however many
    // thousands the ledger does - which is what keeps a popular persona's rolodex a page
    // and not a dead tab. A new query rewinds the slice: "show more" answered the OLD list.
    const filter = searchQuery || '';
    const [shown, setShown] = useState(PEOPLE_SHELF_SLICE);
    useEffect(() => setShown(PEOPLE_SHELF_SLICE), [filter]);
    const rows = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    // The speakable spelling, derived once per list change (filterContacts is pure and
    // matches `words` only when a row wears them) - never per keystroke.
    const worded = useMemo(
        () => (rows || []).map((r) => ({ ...r, words: speakable(r.root) })),
        [rows]
    );
    const sorted = sortContacts(filterContacts(worded, filter), sortBy);
    const visible = sorted.slice(0, shown);

    // Known around here, minus everyone already on your shelf above (and minus you): the
    // discovery half of the page, for the day this network stops feeling like a closed room.
    // The filter narrows it too, and it wears the same slice - the server already caps what
    // it serves, but a bound this page relies on belongs to this page.
    const directory = useDirectory();
    const onShelf = new Set((rows || []).map((r) => r.root));
    const known = filterContacts(
        (directory || [])
            .filter((d) => d.root !== root && !onShelf.has(d.root))
            // Directory rows already carry their speakable spelling from the server.
            .map((d) => ({ ...d, words: d.speakable })),
        filter
    ).slice(0, PEOPLE_SHELF_SLICE);

    return html`
        <div class="people-inner">
            <div class="people-shelf-head">
                <span class="people-shelf-title">${t('apps.people.everyone-you-know', 'everyone you know')}</span>
                <span class="people-sorts">
                    ${PEOPLE_SORTS.map(
                        (s) => html`<button
                            key=${s.key}
                            class=${sortBy === s.key ? 'people-sort people-sort-on' : 'people-sort'}
                            onClick=${() => setSortBy(s.key)}
                        >${s.label}</button>`
                    )}
                </span>
            </div>
            ${sorted.length === 0 &&
            html`<p class="people-empty">
                ${filter
                    ? html`${t('apps.people.nobody-matches---try-fewer', 'nobody matches "{filter}" - try fewer letters, or their address words.', { filter })}`
                    : html`${t('apps.people.nobody-yet---open-someones', "nobody yet - open someone's page and set your relationship, and they'll appear here.")}`}
            </p>`}
            <div class="people-list">
                ${visible.map(
                    (row) => html`<${PersonRow} key=${row.root} root=${row.root} current=${current} />`
                )}
            </div>
            ${sorted.length > visible.length &&
            html`<button
                class="people-more"
                onClick=${() => setShown(shown + PEOPLE_SHELF_SLICE)}
            >
                ${t('apps.people.show-more-of', 'show more ({length} of {p1})', { length: visible.length, p1: sorted.length })}
            </button>`}
            ${known.length > 0 &&
            html`<div class="people-known">
                <div class="people-shelf-head">
                    <span class="people-shelf-title">${t('apps.people.known-around-here', 'known around here')}</span>
                    <span class="people-known-note">
                        ${t('apps.people.personas-this-node-hosts-or', 'personas this node hosts or has reached - open one to say how you know them')}
                    </span>
                </div>
                <div class="people-list">
                    ${known.map(
                        (d) => html`<${PersonRow}
                            key=${d.root}
                            root=${d.root}
                            current=${current}
                            profile=${/* the directory row IS the profile the widget needs -
                                handing it down keeps this list from fetching (and the server
                                from opening) one profile per face */ {
                                fields: [
                                    d.name && { field: 'name', value: d.name },
                                    d.avatar && { field: 'avatar', value: d.avatar },
                                ].filter(Boolean),
                                hosted: d.hosted,
                                foreign: !d.hosted,
                                via: [],
                            }}
                        />`
                    )}
                </div>
            </div>`}
        </div>
    `;
};
