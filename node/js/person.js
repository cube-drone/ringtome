// The Person widget family: one persona, rendered at four sizes.
//
// The architecture question this file answers (settled 2026-08-03): one flexible component
// with a `mode` prop, or several components? SEVERAL - but over ONE hook. Everything
// upstream of rendering is identical at every size (resolve the three names, the avatar, the
// hue, your relationship facts, is-this-you, where clicking goes), so that lives once, in
// `usePerson`. The DOM shapes below are genuinely unlike each other - a mini hexagon is one
// element with a hover label; the full card carries an address row and the relationship
// panel - and a single component switching between them would be four disjoint branches
// sharing a props union where half the props are inert in each mode. The one place a prop IS
// right: mini and small are the SAME shape at different sizes (size varies continuously,
// shape does not), so the chip takes a `size`.
//
//   PersonChip   - a hexagon of their picture, their name on hover. Studs lists and prose.
//   PersonBanner - the inline header: hexagon + names + address, filling a row.
//   PersonCard   - everything: picture, names, address, bio, and your relationship.
//
// Data depth, not display mode, is the hook's one option: `profile` (already fetched by the
// caller) and the mirror answer for people you know keep a fifty-row list at zero fetches.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { openMirror, useLive } from './mirror.js';
import { speakable, toBase58 } from './speakable.js';
import { identityAddress, viaHints } from './pure/portable.js';
import { personaHue, displayNames, signalLevel } from './pure/person.js';
import { identiconUri } from './pure/identicon.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';
import {
    TRUST_STOPS,
    INTEREST_STOPS,
    contactCollection,
    nearestStop,
} from './pure/contact.js';

const html = htm.bind(h);

/**
 * Everything any Person widget needs about one persona, from the cheapest source that can
 * answer it. Never fetches for someone your ledger already knows (their name and avatar ride
 * the contacts stream), never fetches for yourself (your own mirror holds it), and never
 * fetches when the caller already has the profile in hand.
 *
 * @param root     their root pubkey, hex
 * @param current  your open persona ({ root }), or null
 * @param profile  their already-fetched profile response, when the caller has one
 */
export function usePerson(root, { current, profile: given } = {}) {
    const myRoot = current && current.root;
    const isYou = !!(myRoot && myRoot === root);

    // Your ledger's facts about them (nickname, trust, interest, blocked) - live.
    const contactRow = useLive(
        () => (myRoot && root && !isYou ? openMirror(myRoot).contacts.get(root) : null),
        [myRoot, root, isYou]
    );
    // Your own self-claims, when the person IS you - live off your profile table.
    const myName = useLive(
        () => (isYou ? openMirror(myRoot).profile.get('name') : null),
        [isYou, myRoot]
    );
    const myAvatar = useLive(
        () => (isYou ? openMirror(myRoot).profile.get('avatar') : null),
        [isYou, myRoot]
    );
    const myBio = useLive(() => (isYou ? openMirror(myRoot).profile.get('bio') : null), [
        isYou,
        myRoot,
    ]);

    // The last resort: a stranger, no ledger row, no profile handed down. One fetch.
    const [fetched, setFetched] = useState(null);
    const needsFetch = !!root && !isYou && !given && !contactRow;
    useEffect(() => {
        if (!needsFetch) return;
        let live = true;
        api(`/api/id/${root}/profile`)
            .then((p) => live && setFetched(p))
            .catch(() => live && setFetched(null));
        return () => {
            live = false;
        };
    }, [needsFetch, root]);

    const fromProfile = (fields, key) => {
        const f = (fields || []).find((x) => x.field === key);
        return f ? f.value : '';
    };
    const source = given || fetched;
    const facts = (contactRow && contactRow.facts) || {};
    const words = root ? speakable(root).split('-').slice(0, 2).join('-') : '';

    const name = isYou
        ? (myName && myName.value) || ''
        : fromProfile(source && source.fields, 'name') || (contactRow && contactRow.name) || '';
    const avatar = isYou
        ? (myAvatar && myAvatar.value) || ''
        : fromProfile(source && source.fields, 'avatar') || (contactRow && contactRow.avatar) || '';
    const bio = isYou ? (myBio && myBio.value) || '' : fromProfile(source && source.fields, 'bio');

    // How to reach them, as the node knows it (idface.rs computes it honestly: a persona it
    // hosts hints itself and their peers; a foreign one hints whatever actually reached
    // them, never this node). `hosted` also decides whether a minted address may wear this
    // node's origin - promising a stranger a node that would tombstone them is worse than
    // handing over the origin-free path.
    const blocked = facts.blocked === 'yes';
    const hosted = source ? !!source.hosted : isYou;
    const via = (source && source.via) || null;

    const names = displayNames({ nickname: facts.nickname, name, words });
    return {
        root,
        isYou,
        hosted,
        via,
        facts,
        blocked,
        knownToYou: !!contactRow,
        // The persona's picture, or '' - a doc_id on their public lane.
        avatar,
        // BLOCKED hides their picture everywhere at once (this is the only place any widget
        // asks): you stop seeing what they chose to show you, and their identicon - derived
        // from the key, chosen by nobody - stands in, so the row stays recognizable enough
        // to unblock.
        avatarUrl: avatar && !blocked ? `/id/${root}/docs/${avatar}/thumb` : '',
        bio,
        hue: personaHue(root),
        words,
        names,
        primary: names[0] || '',
        others: names.slice(1),
        // Where clicking any widget goes: their page, in the speakable spelling.
        href: root ? `/id/${speakable(root)}` : '',
    };
}

// The hexagon itself: their picture clipped to six sides, ringed in their colour (a
// clip-path can't take a border, so the ring is the parent's background showing through its
// padding). A persona who hasn't chosen a picture wears their IDENTICON - derived from the
// root, drawn identically by the anonymous face (pure/identicon.js and its Rust twin), so
// the same key is the same face wherever you meet it.
const HEX_SIZES = {
    mini: 'person-hex-mini',
    small: 'person-hex-small',
    card: 'person-hex-card',
};

export const PersonHex = ({ person, size = 'small' }) => html`
    <span
        class="person-hex ${HEX_SIZES[size] || HEX_SIZES.small}"
        style="background: hsl(${person.hue}, 60%, 55%)"
    >
        <img class="person-hex-img" src=${person.avatarUrl || identiconUri(person.root)} alt="" />
    </span>
`;

/// The smallest shape: a hexagon that says who it is when you point at it, and takes you to
/// them when you click. `size` is mini (inline, sits in a line of text) or small.
export const PersonChip = ({ root, current, size = 'small', profile }) => {
    const person = usePerson(root, { current, profile });
    if (!root) return null;
    return html`
        <a
            class="person-chip"
            href=${person.href}
            aria-label=${person.primary}
            data-blocked=${person.blocked ? 'yes' : null}
        >
            <${PersonHex} person=${person} size=${size} />
            <span class="person-chip-label">
                <strong>${person.primary}</strong>
                ${person.others.length > 0 && html`<small>${person.others.join(' · ')}</small>`}
            </span>
        </a>
    `;
};

// Their names, stacked: the one you call them by, then the others they also answer to.
// Shared by every shape wider than a hexagon, so a persona reads the same in a header and
// in a list.
const PersonNames = ({ person }) => html`
    <span class="person-names">
        <span class="person-name-primary">${person.primary}</span>
        ${person.others.length > 0 &&
        html`<span class="person-name-others">${person.others.join(' · ')}</span>`}
    </span>
`;

/// The inline header: the hexagon plus their names, filling the width it's given. What a
/// page wears at the top when the page is *about* this person.
export const PersonBanner = ({ root, current, profile, actions }) => {
    const person = usePerson(root, { current, profile });
    if (!root) return null;
    return html`
        <div class="person-banner">
            <a class="person-banner-face" href=${person.href} aria-label=${person.primary}>
                <${PersonHex} person=${person} size="small" />
            </a>
            <${PersonNames} person=${person} />
            ${actions && html`<span class="person-banner-actions">${actions}</span>`}
        </div>
    `;
};

/// The banner's roster form: the same face and names, plus your relationship at a glance,
/// and the WHOLE row is the link (a list is a place you click, not a place you aim). What
/// People is made of - one component instead of a table's worth of columns.
export const PersonRow = ({ root, current, profile }) => {
    const person = usePerson(root, { current, profile });
    if (!root) return null;
    return html`
        <a
            class=${person.blocked ? 'person-row person-row-blocked' : 'person-row'}
            href=${person.href}
        >
            <${PersonHex} person=${person} size="small" />
            <${PersonNames} person=${person} />
            <${RelationshipGlance} facts=${person.facts} />
        </a>
    `;
};

/// The whole person: picture, names, the shareable address, their bio, and - for anyone who
/// isn't you - your relationship with them.
export const PersonCard = ({ root, current, profile, children }) => {
    const person = usePerson(root, { current, profile });
    if (!root) return null;
    return html`
        <div class="person-card">
            <${PersonHex} person=${person} size="card" />
            <h1 class="person-card-name">${person.primary}</h1>
            ${person.others.length > 0 &&
            html`<p class="person-card-others">${person.others.join(' · ')}</p>`}
            ${person.isYou && html`<p class="person-card-others"><a href="/home/persona">${t('person.this-is-you', 'this is you')}</a></p>`}
            ${children}
            <${AddressRow} root=${root} via=${person.via} hosted=${person.hosted} />
            ${/* Your relationship sits above their bio: how you stand with someone is the
                first thing you want when you arrive on their page, and the bio is what you
                read once you have it. */ ''}
            ${!person.isYou && current &&
            html`<${ContactLedger} myRoot=${current.root} theirRoot=${root} />`}
            ${person.bio && html`<p class="person-card-bio">${person.bio}</p>`}
        </div>
    `;
};

// ---------------------------------------------------------------------------------------------
// The address row - where this persona lives, ready to hand to someone.

// The persona's shareable identity address (PROJECT_PLAN, Addressing): minted from the
// operator's declared public URL (`/api/config`) - or the origin-free path form when there
// isn't one - with `?via=` hints: this node's endpoint key first (`/api/node` - provably
// alive, it served this page), then the persona's liveliest known peers, capped by
// `viaHints`. All fetched once per mount; none change underneath a session.
function useIdentityAddress(root, { via: givenVia, hosted = true } = {}) {
    const [address, setAddress] = useState(null);
    const viaKey = givenVia ? givenVia.join(',') : null;
    useEffect(() => {
        let live = true;
        // Hints the caller already learned (the node's honest answer for this persona) win
        // outright. Without them - your own persona home, where no profile was fetched -
        // ask the node: its own endpoint first, then this persona's liveliest peers.
        const hints = viaKey !== null
            ? Promise.resolve(viaKey ? viaKey.split(',') : [])
            : Promise.all([
                  api('/api/node'),
                  // Peers are gravy: a persona on one computer has none, and a failed
                  // fetch must not cost the address row its self-hint.
                  api(`/api/identity/${root}/peers`).catch(() => ({ peers: [] })),
              ]).then(([node, { peers }]) =>
                  viaHints(node.endpoint_id, peers).map((k) => toBase58(k))
              );
        Promise.all([api('/api/config'), hints])
            .then(([config, via]) => {
                if (!live) return;
                // The root travels in its speakable form (speakable.js): the checksum words
                // are the human anchor, the base58 tail is the key, and hex stays a valid
                // spelling everywhere addresses are parsed. Node keys wear base58 too - ten
                // hints fit where five used to. The ORIGIN goes on only for a persona this
                // node serves; otherwise the path form, which re-homes wherever it lands.
                setAddress(
                    identityAddress({
                        publicUrl: hosted ? config.public_url : '',
                        root: speakable(root),
                        via,
                    })
                );
            })
            .catch(() => {
                // No address row is better than a wrong one; the page stands on its own.
            });
        return () => {
            live = false;
        };
    }, [root, viaKey, hosted]);
    return address;
}

// The row explains nothing - the whole string, a quiet "address" tag, a copy button. The
// link IS the displayed address, whole (what you see is what you click is what you copy);
// the /id surface simply ignores the query it doesn't need.
export const AddressRow = ({ root, via, hosted }) => {
    const address = useIdentityAddress(root, { via, hosted });
    const [copied, setCopied] = useState(false);
    if (!address) return null;
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard refused (permissions): the text stays selectable by hand */
        }
    };
    return html`
        <div class="persona-address">
            <span class="persona-address-label">${t('person.address', 'address')}</span>
            <a class="persona-address-value" href=${address} title=${t('person.see-this-personas-page', "see this persona's page")}>
                <code>${address}</code>
            </a>
            <button class="persona-address-copy" onClick=${copy}>
                ${copied ? t('person.copied', 'copied!') : t('person.copy', 'copy')}
            </button>
        </div>
    `;
};

// ---------------------------------------------------------------------------------------------
// The relationship panel - what YOU privately record about another persona.

/// A stop's words, for the tooltips: what the icon would say if it could talk.
export const stopLabel = (stops, value) =>
    stops.find((s) => s.value === nearestStop(stops, value)).label;

// The dial vocabulary, shared by every surface that shows a relationship (the People shelf's
// columns and the card's closed summary): signal bars climbing a colour ramp, the words in
// the tooltip. Spelled out as literal tables, not interpolated, so the dead-CSS check can
// see the classes.
const SIG_ICONS = [Icons.signal0, Icons.signal1, Icons.signal2, Icons.signal3, Icons.signal4];
const SIG_CLASSES = ['sig-0', 'sig-1', 'sig-2', 'sig-3', 'sig-4'];

export const SignalCell = ({ stops, value, what }) => {
    const level = signalLevel(value);
    const Icon = SIG_ICONS[level];
    return html`<span class="person-cell ${SIG_CLASSES[level]}" title="${what}: ${stopLabel(stops, value)}">
        <${Icon} weight="bold" />
    </span>`;
};

/// One dial as a PAIR: the column's own icon saying which dial this is, then its level in
/// signal bars. The kind stays neutral (it's a label); the bars carry the colour, so a
/// glance reads "what, and how much" without a legend.
const GlancePair = ({ kind, stops, value, what }) => {
    const level = signalLevel(value);
    const Bars = SIG_ICONS[level];
    return html`<span class="glance-pair" title="${what}: ${stopLabel(stops, value)}">
        <${kind} />
        <span class="glance-bars ${SIG_CLASSES[level]}"><${Bars} weight="bold" /></span>
    </span>`;
};

/// The relationship at a glance: three pairs - trust, interest, their rebroadcasts. A
/// BLOCKED persona gets none of it: just a red lock, because the only fact about a blocked
/// relationship that matters is that it's shut.
export const RelationshipGlance = ({ facts }) => {
    if (facts.blocked === 'yes') {
        return html`<span class="ledger-glance ledger-glance-blocked" title=${t('person.blocked', 'blocked')}>
            <${Icons.trustPrivate} weight="fill" />
        </span>`;
    }
    if (!facts.trust && !facts.interest && !facts.interest_rebroadcasts) {
        return html`<span class="ledger-glance ledger-glance-empty">${t('person.nothing-recorded-yet', 'nothing recorded yet')}</span>`;
    }
    return html`<span class="ledger-glance">
        <${GlancePair} kind=${Icons.colTrust} stops=${TRUST_STOPS} value=${facts.trust} what="trust" />
        <${GlancePair}
            kind=${Icons.colInterest}
            stops=${INTEREST_STOPS}
            value=${facts.interest}
            what="interest"
        />
        <${GlancePair}
            kind=${Icons.colRebroadcast}
            stops=${INTEREST_STOPS}
            value=${facts.interest_rebroadcasts}
            what="rebroadcasts"
        />
    </span>`;
};

// One dial of the ledger: a labeled select over the stops, saving on change (a dropdown
// pick is a committed act - one private record per deliberate click, unlike keystrokes).
const Dial = ({ label, hint, stops, value, onPick }) => html`
    <label class="ledger-dial">
        <span class="ledger-label">${label}${hint && html`<small>${hint}</small>`}</span>
        <select
            class="ledger-select"
            value=${String(nearestStop(stops, value))}
            onChange=${(e) => onPick(e.currentTarget.value)}
        >
            ${stops.map((s) => html`<option key=${s.value} value=${String(s.value)}>${s.label}</option>`)}
        </select>
    </label>
`;

// Trust (edge inputs to the trust layer, never the flow math itself), interest, rebroadcast
// interest, a nickname, a block. Every fact is a private-chain LWW register on YOUR identity
// (`contact:<their-root>`), synced to your own computers and nobody else's; the
// trust-visibility dial marks consent to share the trust edge when the graph's publication
// machinery exists (PROJECT_PLAN, The Vouch Dissolved into the Ledger - a vouch IS a
// positive trust edge its author chose to publish). The block is likewise the RECORD of the
// decision; the Inbound Gate learns to read it when inbound acts arrive.
export const ContactLedger = ({ myRoot, theirRoot }) => {
    // The mirror is the truth (The Browser Is a View - contact facts stream like docs do,
    // so a dial turned on another computer lands here live); a pending overlay covers the
    // echo gap, clearing per-key the moment the mirror agrees (the tags pattern).
    const row = useLive(() => openMirror(myRoot).contacts.get(theirRoot), [myRoot, theirRoot]);
    const mirrorFacts = (row && row.facts) || {};
    const [pending, setPending] = useState({});
    const collection = contactCollection(theirRoot);
    // Writes still queue behind one another: the facts share a single-writer private chain,
    // and two dials picked in quick succession would otherwise race the append and silently
    // lose one (field-found by the harness, 2026-08-02).
    const writeQueue = useRef(Promise.resolve());

    const mirrorKey = JSON.stringify(mirrorFacts);
    useEffect(() => {
        setPending((p) => {
            const next = Object.fromEntries(
                Object.entries(p).filter(([k, v]) => mirrorFacts[k] !== v)
            );
            return Object.keys(next).length === Object.keys(p).length ? p : next;
        });
        // Keyed on the joined value: the mirror hands back fresh object identities per poll.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mirrorKey]);

    const facts = { ...mirrorFacts, ...pending };

    // The nickname types like a text field, so it commits like one: draft while focused,
    // written on blur/Enter - one private record per chosen name, never per keystroke.
    const [nickDraft, setNickDraft] = useState(null);
    const commitNick = () => {
        if (nickDraft !== null && nickDraft.trim() !== (facts.nickname || '')) {
            put('nickname', nickDraft.trim());
        }
        setNickDraft(null);
    };

    const put = (key, value) => {
        setPending((p) => ({ ...p, [key]: value }));
        writeQueue.current = writeQueue.current.then(() =>
            api(`/api/identity/${myRoot}/private/kv/${encodeURIComponent(collection)}/${key}`, {
                method: 'PUT',
                body: JSON.stringify({ value }),
            }).catch(() =>
                // The write didn't take: drop the hope and let the mirror show the truth.
                setPending((p) => {
                    const { [key]: _, ...rest } = p;
                    return rest;
                })
            )
        );
    };

    const blocked = facts.blocked === 'yes';
    const trustPublic = facts.trust_public === 'yes';

    // A disclosure, not a permanent wall of controls: closed, it SAYS the relationship in the
    // shelf's own icons; open, it lets you change it. `<details>` rather than hand-rolled
    // state - the platform's own widget comes with the keyboard and the semantics.
    return html`
        <details class="contact-ledger">
            <summary class="ledger-head">
                <span class="ledger-title">${t('person.your-relationship', 'your relationship')}</span>
                <${RelationshipGlance} facts=${facts} />
            </summary>
            ${blocked &&
            html`<p class="ledger-note">
                ${t('person.blocked---nothing-of-theirs', 'blocked - nothing of theirs will be shown to you, and nothing of theirs gets through to you.')}
            </p>`}
            <label class="ledger-dial">
                <span class="ledger-label">
                    ${t('person.your-nickname-for-them', 'your nickname for them')}
                    <small>${t('person.only-you-ever-see-this', "only you ever see this - it's how they'll appear in your People")}</small>
                </span>
                <input
                    class="ledger-nick"
                    type="text"
                    placeholder=${t('person.a-name-of-your-choosing', 'a name of your choosing')}
                    value=${nickDraft !== null ? nickDraft : facts.nickname || ''}
                    onInput=${(e) => setNickDraft(e.currentTarget.value)}
                    onBlur=${commitNick}
                    onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
            </label>
            <${Dial}
                label=${t('person.trust', 'trust')}
                hint="not how much you like them - whether you believe they're real"
                stops=${TRUST_STOPS}
                value=${facts.trust}
                onPick=${(v) => put('trust', v)}
            />
            <label class="ledger-dial">
                <span class="ledger-label">
                    ${t('person.who-can-see-my-trust', 'who can see my trust')}
                    <small>${t('person.sharing-your-trust-information-helps', 'sharing your trust information helps the network grow, but gives up some of your privacy!')}</small>
                </span>
                <select
                    class="ledger-select"
                    value=${trustPublic ? 'yes' : 'no'}
                    onChange=${(e) => put('trust_public', e.currentTarget.value)}
                >
                    <option value="no">${t('person.private---just-my-computers', 'private - just my computers')}</option>
                    <option value="yes">${t('person.public---shared-with-the', 'public - shared with the network')}</option>
                </select>
            </label>
            <${Dial}
                label=${t('person.interest', 'interest')}
                hint="how much of theirs you want to see"
                stops=${INTEREST_STOPS}
                value=${facts.interest}
                onPick=${(v) => put('interest', v)}
            />
            <${Dial}
                label=${t('person.their-rebroadcasts', 'their rebroadcasts')}
                hint="things they pass along from others"
                stops=${INTEREST_STOPS}
                value=${facts.interest_rebroadcasts}
                onPick=${(v) => put('interest_rebroadcasts', v)}
            />
            ${/* The block lives INSIDE: a button in the summary would toggle the disclosure
                instead of blocking anyone, and blocking is an edit like the rest. */ ''}
            <button
                class=${blocked ? 'ledger-block ledger-blocked' : 'ledger-block'}
                onClick=${() => put('blocked', blocked ? 'no' : 'yes')}
            >${blocked ? t('person.unblock-this-persona', 'unblock this persona') : t('person.block-this-persona', 'block this persona')}</button>
        </details>
    `;
};
