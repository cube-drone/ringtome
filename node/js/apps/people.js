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
import { parseIdReference, parseSpeakable, speakable } from '../speakable.js';
import { PersonRow } from '../person.js';
import { api } from '../net.js';
import { PEOPLE_SORTS, PEOPLE_SHELF_SLICE, filterContacts, sortContacts, standingFacts } from '../pure/people.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/// People's answer to the search bar, riding the same header slot as every other app's -
/// one field, two jobs, told apart by the INPUT rather than a button (Curtis, 2026-08-24,
/// retiring the "look up" button as redundant): typing filters the shelf live (the query
/// is lifted to the shell, like every searchable app's), and pasting a complete address -
/// a shared URL, an /id/ path, a bare key - navigates immediately. The commitment moment
/// the button used to provide is now the STRICT parse: `parseIdReference` alone is loose
/// (anything hyphenated passes, so "sway-bro" mid-type would match), and only a segment
/// whose key actually decodes (`parseSpeakable`) is unambiguous enough to act on unasked.
/// A decodable key with LYING words still navigates - the /id lens owns that refusal and
/// says "did you mean" better than a search box could.
export const PeopleLookup = ({ query, onQuery }) => {
    const loc = useLocation();

    const take = (value) => {
        const ref = parseIdReference(value || '');
        if (ref && parseSpeakable(ref.seg)) {
            onQuery(''); // the address was a destination, never a filter to come back to
            loc.route(`/id/${ref.seg}${ref.via ? `?via=${encodeURIComponent(ref.via)}` : ''}`);
            return;
        }
        onQuery(value);
    };

    return html`
        <form class="app-header-search-box" onSubmit=${(e) => e.preventDefault()}>
            <input
                class="app-header-search"
                type="search"
                placeholder=${t('apps.people.filter-or-paste-an-address', 'filter, or paste an address…')}
                title=${t('apps.people.type-to-narrow-the-shelf', 'search or paste an address')}
                value=${query || ''}
                onInput=${(e) => take(e.currentTarget.value)}
            />
        </form>
    `;
};

// The suggested shelf: friends-of-friends whose chains the speculative pass has actually
// landed (DISCOVERY slice 1; NEXT_STEPS "surface implicit edges in the UI"). Fetched once per
// visit for the same reason as the directory below - the demand rollup moves on the fold's
// beat, not the browser's - and each row carries its best introducer for the "via" byline.
const useSuggested = (root) => {
    const [rows, setRows] = useState(null);
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        api(`/api/identity/${root}/suggested`)
            .then((r) => live && setRows((r && r.suggestions) || []))
            .catch(() => live && setRows([]));
        return () => {
            live = false;
        };
    }, [root]);
    return rows;
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
    const allRows = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    // Standing first, spelling second, both once per LEDGER change (the memo keys on the
    // live rows, so neither runs per keystroke). Standing (standingFacts): a set-then-
    // cleared relationship leaves empty registers behind - the ledger is append-only, ""
    // is a clear - and those rows belong to the mirror (name resolution for once-known
    // people) but not to the shelf, and not to the dedup below, so a fully-cleared person
    // is discoverable again.
    const { standing: rows, cleared } = useMemo(() => {
        const standing = [];
        const cleared = [];
        for (const r of allRows || []) {
            const w = { ...r, words: speakable(r.root) };
            (standingFacts(r.facts) ? standing : cleared).push(w);
        }
        return { standing, cleared };
    }, [allRows]);
    const sorted = sortContacts(filterContacts(rows, filter), sortBy);
    const visible = sorted.slice(0, shown);

    // People you might know: the trust graph's suggestions, between your own shelf and the
    // node's directory because that is exactly where they sit - closer than strangers, not
    // yet relationships. Rows arrive server-filtered to the pair of facts that make a
    // suggestion honest (a friend's vouch admits them AND their chains are actually held,
    // so the row renders a real face); anyone already on your shelf is excluded here, since
    // the rollup excludes explicit dials a beat behind the dial itself.
    const suggestedRaw = useSuggested(root);
    const onShelf = new Set((rows || []).map((r) => r.root));
    const suggested = filterContacts(
        (suggestedRaw || [])
            .filter((s) => s.root !== root && !onShelf.has(s.root))
            .map((s) => ({ ...s, words: s.speakable })),
        filter
    ).slice(0, PEOPLE_SHELF_SLICE);

    // Known around here, minus everyone already on your shelf above (and minus you): the
    // discovery half of the page, for the day this network stops feeling like a closed room.
    // The filter narrows it too, and it wears the same slice - the server already caps what
    // it serves, but a bound this page relies on belongs to this page.
    const directory = useDirectory();
    // A persona both suggested and known-around-here shows on the suggested shelf alone:
    // "a friend vouches for them" is the stronger claim than "this node has met them".
    const suggestedRoots = new Set(suggested.map((s) => s.root));
    const known = filterContacts(
        (directory || [])
            .filter((d) => d.root !== root && !onShelf.has(d.root) && !suggestedRoots.has(d.root))
            // Directory rows already carry their speakable spelling from the server.
            .map((d) => ({ ...d, words: d.speakable })),
        filter
    ).slice(0, PEOPLE_SHELF_SLICE);

    // The bottom of the page: people you USED to know - a relationship created and then
    // cleared. The ledger remembers them (append-only registers, "" is a clear), and
    // burying them below every current shelf is the design (Curtis, 2026-08-24): you have
    // to go looking, so idle browsing never walks you past your unfollows, but a lost
    // pointer is one scroll away instead of gone. Deduped against every shelf above - a
    // cleared person who is now vouched-for or node-known shows THERE, under the stronger
    // present-tense claim.
    const knownRoots = new Set(known.map((d) => d.root));
    const usedToKnow = filterContacts(
        cleared.filter(
            (c) => c.root !== root && !suggestedRoots.has(c.root) && !knownRoots.has(c.root)
        ),
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
            ${suggested.length > 0 &&
            html`<div class="people-known">
                <div class="people-shelf-head">
                    <span class="people-shelf-title">${t('apps.people.people-you-might-know', 'people you might know')}</span>
                    <span class="people-known-note">
                        ${t('apps.people.vouched-for-by-people-you', 'vouched for by people you trust')}
                    </span>
                </div>
                <div class="people-list">
                    ${suggested.map(
                        (s) => html`<${PersonRow}
                            key=${s.root}
                            root=${s.root}
                            current=${current}
                            profile=${/* the suggestion row IS the profile the widget needs -
                                same zero-fetch argument as the directory below. `foreign` is
                                always true here: a suggested persona is by definition not
                                hosted, or the ordinary machinery would already own them. */ {
                                fields: [
                                    s.name && { field: 'name', value: s.name },
                                    s.avatar && { field: 'avatar', value: s.avatar },
                                ].filter(Boolean),
                                hosted: false,
                                foreign: true,
                                via: [],
                            }}
                            aside=${s.introducer_name
                                ? t('apps.people.via-name', 'via {name}', { name: s.introducer_name })
                                : t('apps.people.via-a-friend', 'via a friend')}
                        />`
                    )}
                </div>
            </div>`}
            ${known.length > 0 &&
            html`<div class="people-known">
                <div class="people-shelf-head">
                    <span class="people-shelf-title">${t('apps.people.known-around-here', 'known around here')}</span>
                    <span class="people-known-note">
                        ${t('apps.people.personas-this-node-hosts-or', 'personas this node hosts or has reached')}
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
            ${usedToKnow.length > 0 &&
            html`<div class="people-known">
                <div class="people-shelf-head">
                    <span class="people-shelf-title">${t('apps.people.you-used-to-know', 'you used to know')}</span>
                    <span class="people-known-note">
                        ${t('apps.people.relationships-you-set-and-later', 'relationships you set and later cleared')}
                    </span>
                </div>
                <div class="people-list">
                    ${usedToKnow.map(
                        (c) => html`<${PersonRow}
                            key=${c.root}
                            root=${c.root}
                            current=${current}
                            aside=${t('apps.people.cleared', 'cleared')}
                        />`
                    )}
                </div>
            </div>`}
        </div>
    `;
};
