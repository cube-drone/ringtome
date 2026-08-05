// People: the rolodex. Two halves, both thin: a lookup box that dissects any pasted
// reference (a full shared URL, an /id/ path, a bare address) and routes to the /id lens -
// that page owns the grammar, the fetching, and the relationship panel - and the shelf of
// everyone your ledger holds a relationship with, straight off the mirror's `contacts` kind
// (The Browser Is a View: a dial turned on any of your computers re-sorts this list live).
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from '../mirror.js';
import { parseIdReference } from '../speakable.js';
import { PersonRow } from '../person.js';
import { api } from '../net.js';
import { PEOPLE_SORTS, sortContacts } from '../pure/people.js';

const html = htm.bind(h);

/// People's answer to the search bar, and it rides the same slot in the app header (the
/// shell renders it for the app whose registry entry asks). Not a filter over what's on
/// screen like every other app's search - a LOOKUP: paste an address in any dress (a shared
/// URL, an /id/ path, a bare address) and go there. Hence the button: the act completes
/// somewhere else, so it needs a moment of commitment rather than filtering as you type.
export const PeopleLookup = () => {
    const loc = useLocation();
    const [lookup, setLookup] = useState('');
    const [bad, setBad] = useState(false);

    const go = (e) => {
        e.preventDefault();
        const ref = parseIdReference(lookup);
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
                type="text"
                placeholder="paste an address…"
                title=${bad
                    ? "that doesn't look like a persona's address - it should have two words and a key, like sway-broke-AwTy…"
                    : 'find a persona by their address'}
                value=${lookup}
                onInput=${(e) => {
                    setLookup(e.currentTarget.value);
                    setBad(false);
                }}
            />
            <button class="people-lookup-go" type="submit" title="go to this persona">
                look up
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

export const PeopleApp = ({ current }) => {
    const root = current && current.root;
    const [sortBy, setSortBy] = useState('trust');
    const rows = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    const sorted = sortContacts(rows || [], sortBy);

    // Known around here, minus everyone already on your shelf above (and minus you): the
    // discovery half of the page, for the day this network stops feeling like a closed room.
    const directory = useDirectory();
    const onShelf = new Set((rows || []).map((r) => r.root));
    const known = (directory || []).filter((d) => d.root !== root && !onShelf.has(d.root));

    return html`
        <div class="people-inner">
            <div class="people-shelf-head">
                <span class="people-shelf-title">everyone you know</span>
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
                nobody yet - open someone's page and set your relationship, and they'll
                appear here.
            </p>`}
            <div class="people-list">
                ${sorted.map(
                    (row) => html`<${PersonRow} key=${row.root} root=${row.root} current=${current} />`
                )}
            </div>
            ${known.length > 0 &&
            html`<div class="people-known">
                <div class="people-shelf-head">
                    <span class="people-shelf-title">known around here</span>
                    <span class="people-known-note">
                        personas this node hosts or has reached - open one to say how you know them
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
