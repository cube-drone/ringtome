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
import { agoUnit } from './pure/ago.js';
import { Icons } from './icons.js';
import { PersonCard } from './person.js';
import { PersonaMenu } from './persona.js';
import { PublicPosts } from './posts.js';
import { t, tNodes } from './i18n.js';

const html = htm.bind(h);

// The card every shape renders into - the persona-page look, reused.
const Card = ({ children }) => html`<div class="persona-page id-page">${children}</div>`;

// Where this page's words came from, and whether newer ones are on the way.
//
// Only for a persona this node does NOT host: one it hosts has no "last synced" - its words are
// written here, and a timestamp would be answering a question nobody asked. For a foreign one it
// is the honest caption on everything above it, because what is shown is what this node holds,
// which is what it last managed to fetch.
const SyncLine = ({ syncedMs, refreshing }) => {
    // Re-render on a slow beat so "a minute ago" doesn't sit there being wrong for an hour.
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 30_000);
        return () => clearInterval(t);
    }, []);

    const ago = agoUnit(syncedMs, Date.now());
    // The reader's machine turns the count into their language; we only chose the unit.
    const when = !syncedMs
        ? null
        : ago
          ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(ago.value, ago.unit)
          : 'just now';
    if (!when && !refreshing) return null;
    return html`<p class="id-sync">
        ${when && html`<span title=${new Date(syncedMs).toLocaleString()}>${t('idpage.synced', 'synced {when}', { when })}</span>`}
        ${refreshing &&
        html`<span class="id-sync-now">
            <span class="status-spin"><${Icons.spinner} /></span> ${t('idpage.checking-for-anything-newer', 'checking for anything newer')}
        </span>`}
    </p>`;
};

export const IdPage = ({ seg, current, persona, session, onTitle }) => {
    const loc = useLocation();
    const parsed = parseSpeakable(decodeURIComponent(seg || ''));
    // profile: undefined = loading, null = unreachable, object = served (local or fetched)
    const [profile, setProfile] = useState(undefined);
    const root = parsed && parsed.ok ? parsed.root : null;
    // The address's own reachability hints ride through to the node, which uses them to
    // fetch an off-shelf persona at request time (idface.rs) - the URL carries exactly the
    // keys the fetch wants.
    const via = (loc.query && loc.query.via) || '';

    // The profile, and then the profile again if the node is still fetching it.
    //
    // A foreign persona is served from what this node already holds, with a re-sync running
    // BEHIND the answer (idface.rs's stale-while-revalidate): a visit is the demand signal the
    // pull model runs on, but the reader shouldn't wait on a stranger's node to find out their
    // name changed. So `refreshing` means "what you're reading may be a moment old" - ask
    // again shortly and the answer is either newer or honestly the same.
    useEffect(() => {
        if (!root) return;
        let live = true;
        let timer = null;
        const url = `/api/id/${root}/profile${via ? `?via=${encodeURIComponent(via)}` : ''}`;
        // Bounded: a peer that never answers must not leave a page polling forever.
        const look = (tries) => {
            api(url)
                .then((p) => {
                    if (!live) return;
                    setProfile(p);
                    if (p.refreshing && tries > 0) timer = setTimeout(() => look(tries - 1), 1500);
                })
                .catch(() => live && setProfile(null));
        };
        look(4);
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
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
            <h1 class="persona-page-title">${t('idpage.thats-not-an-address', "that's not an address")}</h1>
            <p>
                ${tNodes(
                    'idpage.the-path-after-should-be',
                    "The path after {path} should be a persona's address - two words and a key, like {example}",
                    { path: html`<code>/id/</code>`, example: html`<code>sway-broke-AwTy…</code>` },
                )}
            </p>
        <//>`;
    }

    if (!parsed.ok) {
        const key = seg.split('-').pop();
        return html`<${Card}>
            <h1 class="persona-page-title">${t('idpage.this-address-arrived-mangled', 'this address arrived mangled')}</h1>
            <p>${t('idpage.the-words-on-this-address', "The words on this address don't match its key, so something got mixed up in transit.")}</p>
            <p>
                ${tNodes('idpage.did-you-mean', 'Did you mean {suggestion}?', {
                    suggestion: html`<a href="/id/${parsed.expected}-${key}"
                        ><code>${parsed.expected}-${key.slice(0, 8)}…</code></a
                    >`,
                })}
            </p>
        <//>`;
    }

    const speak = speakable(root);
    const words = speak.split('-').slice(0, 2).join('-');

    if (profile === undefined) {
        return html`<${Card}><p class="id-quiet">${t('idpage.looking-around', 'looking around…')}</p><//>`;
    }

    if (profile === null) {
        return html`<${Card}>
            <h1 class="persona-page-title">
                <span class="persona-chip" style="background: hsl(${personaHue(root)}, 60%, 55%)"></span>
                ${words}
            </h1>
            <p>${t('idpage.couldnt-reach-this-persona-just', "Couldn't reach this persona just now - it isn't carried on your node, and")}
            ${via
                ? t('idpage.none-of-the-computers-its', 'none of the computers its address points at answered.')
                : t('idpage.its-address-carries-no-hints', 'its address carries no hints about where to find it.')}</p>
            <p class="id-address"><code>/id/${speak}</code></p>
        <//>`;
    }

    // The whole person, in the widget family's largest shape, and then what they have said in
    // public. The profile rides down as a prop: this page had to fetch it to tell reachable
    // from unreachable, and neither the card nor the posts must fetch it twice.
    return html`<${Card}>
        <${PersonCard}
            root=${root}
            current=${current}
            profile=${profile}
            you=${persona && session && html`<${PersonaMenu} persona=${persona} session=${session} />`}
        >
            ${profile.foreign && !profile.peek &&
            html`<p class="id-words">${t('idpage.reached-across-the-network--', 'reached across the network - not carried on this node')}</p>`}
            ${profile.peek &&
            html`<p class="id-words">${t('idpage.a-look-at-their-newest', 'a look at their newest posts - follow them to keep up')}</p>`}
            ${profile.foreign &&
            html`<${SyncLine} syncedMs=${profile.synced_ms} refreshing=${profile.refreshing} />`}
        <//>
        <${PublicPosts}
            root=${root}
            posts=${profile.posts}
            more=${profile.posts_more}
            current=${current}
        />
    <//>`;
};
