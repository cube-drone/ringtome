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
import { Icons } from '../icons.js';
import { PEOPLE_SORTS, sortContacts, displayNames, signalLevel } from '../pure/people.js';
import { TRUST_STOPS, INTEREST_STOPS, nearestStop } from '../pure/contact.js';

const html = htm.bind(h);

const stopLabel = (stops, value) =>
    stops.find((s) => s.value === nearestStop(stops, value)).label;

// One graded dial as its signal bars, colored by level, the words in the tooltip. The
// level tables are spelled out (not interpolated) so the dead-CSS check can see them.
const SIG_ICONS = [Icons.signal0, Icons.signal1, Icons.signal2, Icons.signal3, Icons.signal4];
const SIG_CLASSES = ['sig-0', 'sig-1', 'sig-2', 'sig-3', 'sig-4'];
const SignalCell = ({ stops, value, what }) => {
    const level = signalLevel(value);
    const Icon = SIG_ICONS[level];
    return html`<span class="person-cell ${SIG_CLASSES[level]}" title="${what}: ${stopLabel(stops, value)}">
        <${Icon} weight="bold" />
    </span>`;
};

const PersonRow = ({ row, onOpen }) => {
    const words = speakable(row.root).split('-').slice(0, 2).join('-');
    const facts = row.facts || {};
    const blocked = facts.blocked === 'yes';
    const trustPublic = facts.trust_public === 'yes';
    const [primary, ...others] = displayNames({ nickname: facts.nickname, name: row.name, words });
    return html`
        <button class=${blocked ? 'person-row person-blocked' : 'person-row'} onClick=${onOpen}>
            <span class="person-name-cell">
                ${row.avatar
                    ? html`<img class="person-avatar" src="/id/${row.root}/docs/${row.avatar}/thumb" alt="" />`
                    : html`<span class="persona-chip" style="background: hsl(${personaHue(row.root)}, 60%, 55%)"></span>`}
                <span class="person-words">${primary}</span>
                ${others.length > 0 && html`<span class="person-others">${others.join(' · ')}</span>`}
                ${blocked &&
                html`<span class="person-cell person-blocked-mark" title="blocked">
                    <${Icons.blockedSpeaker} weight="bold" />
                </span>`}
            </span>
            <span class="person-cell person-privacy" title=${trustPublic
                ? 'their trust from you is public - shared with the network'
                : 'their trust from you is private - just your computers'}>
                <${trustPublic ? Icons.trustPublic : Icons.trustPrivate} />
            </span>
            <${SignalCell} stops=${TRUST_STOPS} value=${facts.trust} what="trust" />
            <${SignalCell} stops=${INTEREST_STOPS} value=${facts.interest} what="interest" />
            <${SignalCell} stops=${INTEREST_STOPS} value=${facts.interest_rebroadcasts} what="rebroadcasts" />
        </button>
    `;
};

// The column headers: one icon each, meanings in the tooltips.
const PeopleHead = () => html`
    <div class="person-row person-head" aria-hidden="true">
        <span class="person-name-cell"></span>
        <span class="person-cell" title="whether your trust is shared"></span>
        <span class="person-cell" title="trust - do you believe they're real"><${Icons.colTrust} /></span>
        <span class="person-cell" title="interest - how much of theirs you see"><${Icons.colInterest} /></span>
        <span class="person-cell" title="rebroadcasts - what they pass along"><${Icons.colRebroadcast} /></span>
    </div>
`;

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
            ${sorted.length > 0 && html`<${PeopleHead} />`}
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
