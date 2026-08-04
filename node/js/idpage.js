// The /id lens page: what a logged-in member sees at /id/<address> (the anonymous visitor
// never reaches this code - the server hands them the static face instead; idface.rs). The
// same shapes as the face, dressed for the console: a mangled address refuses with "did you
// mean", a hosted persona renders its profile - plus the two things only a member can be
// told: whether this persona is *them*, and a FOREIGN persona fetched at request time
// through the address's own ?via= hints (idface.rs does the reaching; the page just passes
// the hints through). Only when nothing answers does the warm tombstone show.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { openMirror, useLive } from './mirror.js';
import { parseSpeakable, speakable } from './speakable.js';
import { personaHue } from './pure/person.js';
import { PersonCard } from './person.js';
import { PublicPosts } from './posts.js';

const html = htm.bind(h);

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

    // The whole person, in the widget family's largest shape, and then what they have said in
    // public. The profile rides down as a prop: this page had to fetch it to tell reachable
    // from unreachable, and neither the card nor the posts must fetch it twice.
    return html`<${Card}>
        <${PersonCard} root=${root} current=${current} profile=${profile}>
            ${profile.foreign &&
            html`<p class="id-words">reached across the network - not carried on this node</p>`}
        <//>
        <${PublicPosts} root=${root} posts=${profile.posts} more=${profile.posts_more} />
    <//>`;
};
