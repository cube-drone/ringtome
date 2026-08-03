// People: the rolodex. Two halves, both thin: a lookup box that dissects any pasted
// reference (a full shared URL, an /id/ path, a bare address) and routes to the /id lens -
// that page owns the grammar, the fetching, and the relationship panel - and the shelf of
// everyone your ledger holds a relationship with, straight off the mirror's `contacts` kind
// (The Browser Is a View: a dial turned on any of your computers re-sorts this list live).
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from '../mirror.js';
import { speakable, parseIdReference } from '../speakable.js';
import { personaHue } from '../persona.js';
import { PEOPLE_SORTS, sortContacts } from '../pure/people.js';
import { TRUST_STOPS, INTEREST_STOPS, nearestStop } from '../pure/contact.js';

const html = htm.bind(h);

const stopLabel = (stops, value) =>
    stops.find((s) => s.value === nearestStop(stops, value)).label;

const PersonRow = ({ row, onOpen }) => {
    const words = speakable(row.root).split('-').slice(0, 2).join('-');
    const facts = row.facts || {};
    const blocked = facts.blocked === 'yes';
    return html`
        <button class=${blocked ? 'person-row person-blocked' : 'person-row'} onClick=${onOpen}>
            <span class="persona-chip" style="background: hsl(${personaHue(row.root)}, 60%, 55%)"></span>
            <span class="person-words">${words}</span>
            <span class="person-facts">
                ${blocked
                    ? 'blocked'
                    : `${stopLabel(TRUST_STOPS, facts.trust)} · ${stopLabel(INTEREST_STOPS, facts.interest)}`}
            </span>
        </button>
    `;
};

export const PeopleApp = ({ current }) => {
    const loc = useLocation();
    const root = current && current.root;
    const [lookup, setLookup] = useState('');
    const [lookupErr, setLookupErr] = useState(false);
    const [sortBy, setSortBy] = useState('trust');
    const rows = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    const sorted = sortContacts(rows || [], sortBy);

    const go = (e) => {
        e.preventDefault();
        const ref = parseIdReference(lookup);
        if (!ref) {
            setLookupErr(true);
            return;
        }
        setLookupErr(false);
        loc.route(`/id/${ref.seg}${ref.via ? `?via=${encodeURIComponent(ref.via)}` : ''}`);
    };

    return html`
        <div class="people-inner">
            <form class="people-lookup" onSubmit=${go}>
                <input
                    class="people-lookup-input"
                    type="text"
                    placeholder="find a persona - paste an address or a link"
                    value=${lookup}
                    onInput=${(e) => {
                        setLookup(e.currentTarget.value);
                        setLookupErr(false);
                    }}
                />
                <button class="people-lookup-go" type="submit">look up</button>
            </form>
            ${lookupErr &&
            html`<p class="people-err">
                that doesn't look like a persona's address - it should have two words and a
                key, like <code>sway-broke-AwTy…</code>
            </p>`}
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
                    (row) => html`<${PersonRow}
                        key=${row.root}
                        row=${row}
                        onOpen=${() => loc.route(`/id/${row.root}`)}
                    />`
                )}
            </div>
        </div>
    `;
};
