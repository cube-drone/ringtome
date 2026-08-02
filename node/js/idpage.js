// The /id lens page: what a logged-in member sees at /id/<address> (the anonymous visitor
// never reaches this code - the server hands them the static face instead; idface.rs). The
// same three shapes as the face, dressed for the console: a mangled address refuses with
// "did you mean", a hosted persona renders its profile, an unreachable one gets the warm
// tombstone - plus the one thing only a member can be told: whether this persona is *them*.
// The fetch-and-serve behavior for off-shelf roots arrives with the resolution ladder; the
// tombstone says so honestly.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { parseSpeakable, speakable } from './speakable.js';
import { personaHue } from './persona.js';

const html = htm.bind(h);

// The card every shape renders into - the persona-page look, reused.
const Card = ({ children }) => html`<div class="persona-page id-page">${children}</div>`;

export const IdPage = ({ seg, current, onTitle }) => {
    const parsed = parseSpeakable(decodeURIComponent(seg || ''));
    // profile: undefined = loading, null = not served here, object = the shelf answered
    const [profile, setProfile] = useState(undefined);
    const root = parsed && parsed.ok ? parsed.root : null;

    useEffect(() => {
        if (!root) return;
        let live = true;
        api(`/api/id/${root}/profile`)
            .then((p) => live && setProfile(p))
            .catch(() => live && setProfile(null));
        return () => {
            live = false;
        };
    }, [root]);

    // The shell's header band shows whose page this is: the words immediately (always
    // derivable), the display name the moment the shelf answers. Cleared on the way out so
    // the next tenant of the band never inherits a stale name.
    useEffect(() => {
        if (!onTitle) return;
        if (!root) {
            onTitle('');
            return () => onTitle(null);
        }
        const words = speakable(root).split('-').slice(0, 2).join('-');
        const name =
            profile && (profile.fields || []).find((f) => f.field === 'name');
        onTitle((name && name.value) || words);
        return () => onTitle(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, profile]);

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
            <p>This persona isn't served from your node. Reaching across the network for
            strangers is on its way - for now, an address resolves here only when someone on
            this node carries it.</p>
            <p class="id-address"><code>/id/${speak}</code></p>
        <//>`;
    }

    const field = (name) => {
        const f = (profile.fields || []).find((f) => f.field === name);
        return f ? f.value : '';
    };
    const name = field('name') || words;

    return html`<${Card}>
        <h1 class="persona-page-title">
            <span class="persona-chip" style="background: hsl(${personaHue(root)}, 60%, 55%)"></span>
            ${name}
        </h1>
        <p class="id-words">${words}${isYou ? ' - this is you' : ''}</p>
        ${field('bio') && html`<p class="id-bio">${field('bio')}</p>`}
        <p class="id-address"><code>${speak}</code></p>
        ${isYou &&
        html`<p class="id-quiet">
            <a href="/home/persona">your persona's home</a> has the shareable form of this
            address, hints and all.
        </p>`}
    <//>`;
};
