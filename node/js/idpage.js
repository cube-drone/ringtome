// The /id lens page: what a logged-in member sees at /id/<address> (the anonymous visitor
// never reaches this code - the server hands them the static face instead; idface.rs). The
// same shapes as the face, dressed for the console: a mangled address refuses with "did you
// mean", a hosted persona renders its profile - plus the two things only a member can be
// told: whether this persona is *them*, and a FOREIGN persona fetched at request time
// through the address's own ?via= hints (idface.rs does the reaching; the page just passes
// the hints through). Only when nothing answers does the warm tombstone show.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { openMirror, useLive } from './mirror.js';
import { parseSpeakable, speakable } from './speakable.js';
import { personaHue, AddressRow } from './persona.js';
import {
    TRUST_STOPS,
    INTEREST_STOPS,
    contactCollection,
    nearestStop,
} from './pure/contact.js';

const html = htm.bind(h);

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

// The contact ledger: what YOU privately record about another persona - trust (edge inputs
// to the trust layer, never the flow math itself), interest, rebroadcast interest, a block.
// Every fact is a private-chain LWW register on YOUR identity (`contact:<their-root>`),
// synced to your own computers and nobody else's; the trust-visibility dial marks consent to
// share the trust edge when the graph's publication machinery exists (today it changes only
// the stored flag - honest small print, not a live broadcast). The block is likewise the
// RECORD of the decision; the Inbound Gate learns to read it when inbound acts arrive.
const ContactLedger = ({ myRoot, theirRoot }) => {
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

    return html`
        <div class="contact-ledger">
            <div class="ledger-head">
                <span class="ledger-title">your relationship</span>
                <button
                    class=${blocked ? 'ledger-block ledger-blocked' : 'ledger-block'}
                    onClick=${() => put('blocked', blocked ? 'no' : 'yes')}
                >${blocked ? 'unblock this persona' : 'block this persona'}</button>
            </div>
            ${blocked &&
            html`<p class="ledger-note">
                blocked - nothing of theirs will be shown to you, and nothing of theirs gets
                through to you.
            </p>`}
            <label class="ledger-dial">
                <span class="ledger-label">
                    your nickname for them
                    <small>only you ever see this - it's how they'll appear in your People</small>
                </span>
                <input
                    class="ledger-nick"
                    type="text"
                    placeholder="a name of your choosing"
                    value=${nickDraft !== null ? nickDraft : facts.nickname || ''}
                    onInput=${(e) => setNickDraft(e.currentTarget.value)}
                    onBlur=${commitNick}
                    onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
            </label>
            <${Dial}
                label="trust"
                hint="not how much you like them - whether you believe they're real"
                stops=${TRUST_STOPS}
                value=${facts.trust}
                onPick=${(v) => put('trust', v)}
            />
            <label class="ledger-dial">
                <span class="ledger-label">
                    who can see my trust
                    <small>sharing your trust information helps the network grow, but gives
                    up some of your privacy!</small>
                </span>
                <select
                    class="ledger-select"
                    value=${trustPublic ? 'yes' : 'no'}
                    onChange=${(e) => put('trust_public', e.currentTarget.value)}
                >
                    <option value="no">private - just my computers</option>
                    <option value="yes">public - shared with the network</option>
                </select>
            </label>
            <${Dial}
                label="interest"
                hint="how much of theirs you want to see"
                stops=${INTEREST_STOPS}
                value=${facts.interest}
                onPick=${(v) => put('interest', v)}
            />
            <${Dial}
                label="their rebroadcasts"
                hint="things they pass along from others"
                stops=${INTEREST_STOPS}
                value=${facts.interest_rebroadcasts}
                onPick=${(v) => put('interest_rebroadcasts', v)}
            />
        </div>
    `;
};

// The card every shape renders into - the persona-page look, reused.
const Card = ({ children }) => html`<div class="persona-page id-page">${children}</div>`;

export const IdPage = ({ seg, current, onTitle }) => {
    const loc = useLocation();
    const parsed = parseSpeakable(decodeURIComponent(seg || ''));
    // profile: undefined = loading, null = unreachable, object = served (local or fetched)
    const [profile, setProfile] = useState(undefined);
    const root = parsed && parsed.ok ? parsed.root : null;
    // The address's own reachability hints ride through to the node, which uses them to
    // fetch an off-shelf persona at request time (idface.rs) - the URL carries exactly the
    // keys the fetch wants.
    const via = (loc.query && loc.query.via) || '';

    useEffect(() => {
        if (!root) return;
        let live = true;
        api(`/api/id/${root}/profile${via ? `?via=${encodeURIComponent(via)}` : ''}`)
            .then((p) => live && setProfile(p))
            .catch(() => live && setProfile(null));
        return () => {
            live = false;
        };
    }, [root, via]);

    // Your nickname for them, live off the contacts mirror - first of the three names a
    // person wears (nickname / self-name / speakable words).
    const ledgerRow = useLive(
        () => (current && root ? openMirror(current.root).contacts.get(root) : null),
        [current && current.root, root]
    );
    const nickname = (ledgerRow && ledgerRow.facts && ledgerRow.facts.nickname) || '';

    // The shell's header band shows whose page this is: the words immediately (always
    // derivable), the better names the moment the mirror and shelf answer. Cleared on the
    // way out so the next tenant of the band never inherits a stale name.
    useEffect(() => {
        if (!onTitle) return;
        if (!root) {
            onTitle('');
            return () => onTitle(null);
        }
        const words = speakable(root).split('-').slice(0, 2).join('-');
        const name =
            profile && (profile.fields || []).find((f) => f.field === 'name');
        onTitle(nickname || (name && name.value) || words);
        return () => onTitle(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, profile, nickname]);

    if (!parsed) {
        return html`<${Card}>
            <h1 class="persona-page-title">that's not an address</h1>
            <p>The path after <code>/id/</code> should be a persona's address - two words and
            a key, like <code>sway-broke-AwTy…</code></p>
        <//>`;
    }

    if (!parsed.ok) {
        const key = seg.split('-').pop();
        return html`<${Card}>
            <h1 class="persona-page-title">this address arrived mangled</h1>
            <p>The words on this address don't match its key, so something got mixed up in
            transit.</p>
            <p>Did you mean${' '}
                <a href="/id/${parsed.expected}-${key}"><code>${parsed.expected}-${key.slice(0, 8)}…</code></a>?
            </p>
        <//>`;
    }

    const speak = speakable(root);
    const words = speak.split('-').slice(0, 2).join('-');
    const isYou = !!(current && current.root === root);

    if (profile === undefined) {
        return html`<${Card}><p class="id-quiet">looking around…</p><//>`;
    }

    if (profile === null) {
        return html`<${Card}>
            <h1 class="persona-page-title">
                <span class="persona-chip" style="background: hsl(${personaHue(root)}, 60%, 55%)"></span>
                ${words}
            </h1>
            <p>Couldn't reach this persona just now - it isn't carried on your node, and
            ${via
                ? "none of the computers its address points at answered."
                : 'its address carries no hints about where to find it.'}</p>
            <p class="id-address"><code>/id/${speak}</code></p>
        <//>`;
    }

    const field = (name) => {
        const f = (profile.fields || []).find((f) => f.field === name);
        return f ? f.value : '';
    };
    const names = [nickname, field('name'), words].filter(Boolean);
    const name = names[0];
    const otherNames = names.slice(1);

    // No separate fingerprint line: the words are already the address's own prefix, one row
    // down. The address row is the SAME shareable/copyable form the persona home mints -
    // origin, hints and all - because a hosted persona's page is exactly where you'd reach
    // for its link.
    const avatarDoc = field('avatar');
    return html`<${Card}>
        ${avatarDoc &&
        html`<img class="id-avatar" src="/id/${root}/docs/${avatarDoc}/thumb" alt="" />`}
        <h1 class="persona-page-title">
            <span class="persona-chip" style="background: hsl(${personaHue(root)}, 60%, 55%)"></span>
            ${name}
        </h1>
        ${otherNames.length > 0 && html`<p class="id-words">${otherNames.join(' · ')}</p>`}
        ${isYou && html`<p class="id-words"><a href="/home/persona">this is you</a></p>`}
        ${profile.foreign &&
        html`<p class="id-words">reached across the network - not carried on this node</p>`}
        ${profile.foreign ? html`<p class="id-address"><code>/id/${speak}</code></p>` : html`<${AddressRow} root=${root} />`}
        ${field('bio') && html`<p class="id-bio">${field('bio')}</p>`}
        ${!isYou && current && html`<${ContactLedger} myRoot=${current.root} theirRoot=${root} />`}
    <//>`;
};
