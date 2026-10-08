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
import { agoUnit, agoWords } from './pure/ago.js';
import { Icons } from './icons.js';
import { PersonCard, PersonChip } from './person.js';
import { usePageColorway } from './colorway.js';
import { PersonaMenu, bannerStyle } from './persona.js';
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
const SyncLine = ({ syncedMs, refreshing, peek }) => {
    // Re-render on a slow beat so "a minute ago" doesn't sit there being wrong for an hour.
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 30_000);
        return () => clearInterval(t);
    }, []);

    const ago = agoUnit(syncedMs, Date.now());
    // The reader's machine turns the count into their language; we only chose the unit.
    const when = !syncedMs ? null : ago ? agoWords(ago.value, ago.unit) : 'just now';
    if (!when && !refreshing) return null;
    return html`<p class="id-sync">
        ${when && html`<span title=${new Date(syncedMs).toLocaleString()}>${t('idpage.synced', 'synced {when}', { when })}</span>`}
        ${
            refreshing &&
            html`<span class="id-sync-now">
            <span class="status-spin"><${Icons.spinner} /></span> ${
                peek
                    ? t('idpage.fetching-their-newest-posts', 'fetching their newest posts…')
                    : t('idpage.checking-for-anything-newer', 'checking for anything newer')
            }
        </span>`
        }
    </p>`;
};

/// Your own reach, on your own page (2026-09-28, Curtis: "how many users do I know (or think) are
/// publicly subscribed to me"): a pill beside your picture - public follows / fetches - each number
/// saying on hover what it is. Yours alone; nobody else is shown them.
const ReachPill = ({ root }) => {
    const [n, setN] = useState(null);
    useEffect(() => {
        let live = true;
        api(`/api/identity/${root}/followers`)
            .then((r) => live && setN(r))
            .catch(() => live && setN(null));
        return () => {
            live = false;
        };
    }, [root]);
    if (!n) return null;
    const follows = n.follow_you + n.told_you;
    return html`<span class="person-reach" title=${t('idpage.reach-title', 'only you see this')}>
        <${Icons.stats} />
        <span
            class="person-reach-n"
            title=${t(
                'idpage.reach-follows-title',
                '{n} public follows: {exact} from people this computer keeps up with ({known} of them people you know), and about {told} more who told you they follow you - an unfollow from those never reaches you',
                {
                    n: follows,
                    exact: n.follow_you,
                    known: n.you_know,
                    told: n.told_you,
                },
            )}
        >${follows}</span>
        /
        <span
            class="person-reach-n"
            title=${t('idpage.reach-fetches-title', '{n} computers fetched your posts this week, your own devices left out - private followers among them, since a private follow leaves no other trace', { n: n.computers })}
        >${n.computers}</span>
    </span>`;
};

/// Someone else's page (2026-09-28): who among the people YOU know trusts them, and who follows them
/// without trusting - small user widgets, never a count of strangers, so a crowd of bots adds
/// nothing. Trust is said first, as the weightier claim; nothing at all when you know none of them.
const KnownBy = ({ viewer, subject, current }) => {
    const [known, setKnown] = useState(null);
    useEffect(() => {
        let live = true;
        api(`/api/identity/${viewer}/known-followers/${subject}`)
            .then((r) => live && setKnown(r))
            .catch(() => live && setKnown(null));
        return () => {
            live = false;
        };
    }, [viewer, subject]);
    if (!known) return null;
    const row = (group, words, more) =>
        group && group.count > 0
            ? html`<p class="person-known-by">
                  <span class="person-known-by-words">${words}</span>
                  ${group.people.map((root) => html`<${PersonChip} key=${root} root=${root} current=${current} size="small" />`)}
                  ${
                      group.count > group.people.length &&
                      html`<span class="person-known-by-more">${more(group.count - group.people.length)}</span>`
                  }
              </p>`
            : null;
    return html`${row(known.trusted, t('idpage.trusted-by', 'trusted by'), (n) => t('idpage.and-n-more-you-know', 'and {n} more you know', { n }))}
    ${row(known.followed, t('idpage.followed-by', 'followed by'), (n) => t('idpage.and-n-more-you-know', 'and {n} more you know', { n }))}`;
};

export const IdPage = ({ seg, current, persona, session, onTitle, searchQuery }) => {
    const loc = useLocation();
    const parsed = parseSpeakable(decodeURIComponent(seg || ''));
    // profile: undefined = loading, null = unreachable, object = served (local or fetched)
    const [profile, setProfile] = useState(undefined);
    const root = parsed && parsed.ok ? parsed.root : null;
    // The address's own reachability hints ride through to the node, which uses them to
    // fetch an off-shelf persona at request time (idface.rs) - the URL carries exactly the
    // keys the fetch wants.
    const via = (loc.query && loc.query.via) || '';
    const viewer = current ? current.root : '';

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
        // `as`: the viewing persona, for the sealed-post rule (a trusted-only post its author
        // does not open for you is not listed, as in the feed).
        const params = [via && `via=${encodeURIComponent(via)}`, viewer && `as=${viewer}`].filter(
            Boolean,
        );
        const url = `/api/id/${root}/profile${params.length ? `?${params.join('&')}` : ''}`;
        // Bounded: a peer that never answers must not leave a page polling forever.
        const look = (tries) => {
            api(url)
                .then((p) => {
                    if (!live) return;
                    setProfile(p);
                    // A peek's posts land behind the answer (PROJECT_PLAN's Peeks, ruling 9): keep asking
                    // while the node says they are still arriving, a little longer than a
                    // plain revalidation warrants.
                    if (p.refreshing && tries > 0)
                        timer = setTimeout(() => look(tries - 1), p.peek ? 1000 : 1500);
                })
                .catch(() => live && setProfile(null));
        };
        look(12);
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
        };
    }, [root, via, viewer]);

    // Their page wears their colourway (Curtis, 2026-09-30), a public field of their profile - and
    // until it arrives, whatever their page's head already put on (colorway.js).
    const theirColorway = ((profile && profile.fields) || []).find((f) => f.field === 'colorway');
    usePageColorway(profile ? (theirColorway ? theirColorway.value : null) : undefined);

    // Your nickname for them, live off the contacts mirror - first of the three names a
    // person wears (nickname / self-name / speakable words).
    const ledgerRow = useLive(
        () => (current && root ? openMirror(current.root).contacts.get(root) : null),
        [current && current.root, root],
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
        const name = profile && (profile.fields || []).find((f) => f.field === 'name');
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
                    { path: html`<code>/ringtome/user/</code>`, example: html`<code>AwTy…</code>` },
                )}
            </p>
        <//>`;
    }

    if (!parsed.ok) {
        const key = seg.split('-').pop();
        return html`<${Card}>
            <h1 class="persona-page-title">${t('idpage.this-address-arrived-mangled', 'this address arrived mangled')}</h1>
            <p>${t('idpage.the-words-on-this-address', 'This address is damaged.')}</p>
            <p>
                ${tNodes('idpage.did-you-mean', 'Did you mean {suggestion}?', {
                    suggestion: html`<a href="/ringtome/user/${parsed.expected}-${key}"
                        ><code>${parsed.expected}-${key.slice(0, 8)}…</code></a
                    >`,
                })}
            </p>
        <//>`;
    }

    const speak = speakable(root);
    const words = speak.split('-').slice(0, 2).join('-');

    if (profile === undefined) {
        return html`<${Card}><p class="id-quiet id-sync-now"><span class="status-spin"><${Icons.spinner} /></span> ${t('idpage.looking-around', 'looking around…')}</p><//>`;
    }

    if (profile === null) {
        return html`<${Card}>
            <h1 class="persona-page-title">
                <span class="persona-chip" style="background: hsl(${personaHue(root)}, 60%, 55%)"></span>
                ${words}
            </h1>
            <p>${t('idpage.couldnt-reach-this-persona-just', "Couldn't reach this persona just now - it isn't carried on your node, and")}
            ${
                via
                    ? t(
                          'idpage.none-of-the-computers-its',
                          'none of the computers its address points at answered.',
                      )
                    : t(
                          'idpage.its-address-carries-no-hints',
                          'its address carries no hints about where to find it.',
                      )
            }</p>
            <p class="id-address"><code>/ringtome/user/${speak}</code></p>
        <//>`;
    }

    // The whole person, in the widget family's largest shape, and then what they have said in
    // public. The profile rides down as a prop: this page had to fetch it to tell reachable
    // from unreachable, and neither the card nor the posts must fetch it twice.
    // The banner across the top (2026-09-28): theirs, or their identicon tiled until they choose one.
    const banner = ((profile.fields || []).find((f) => f.field === 'banner') || {}).value || '';
    return html`<${Card}>
        <${PersonCard}
            root=${root}
            banner=${bannerStyle(root, banner)}
            current=${current}
            profile=${profile}
            you=${persona && session && html`<${PersonaMenu} persona=${persona} session=${session} />`}
            beside=${viewer && viewer === root ? html`<${ReachPill} root=${root} />` : null}
            after=${viewer && viewer !== root ? html`<${KnownBy} viewer=${viewer} subject=${root} current=${current} />` : null}
        >
            ${
                profile.foreign &&
                !profile.peek &&
                html`<p class="id-words">${t('idpage.reached-across-the-network--', 'found elsewhere')}</p>`
            }
            ${
                profile.peek &&
                !profile.peek_full &&
                html`<p class="id-words">${t('idpage.a-look-at-their-newest', 'a look at their newest posts - follow them to keep up')}</p>`
            }
            ${
                profile.peek_full &&
                html`<p class="id-words">${t('idpage.this-look-is-full', 'this look is full - follow them to keep everything')}</p>`
            }
            ${
                profile.foreign &&
                html`<${SyncLine} syncedMs=${profile.synced_ms} refreshing=${profile.refreshing} peek=${profile.peek} />`
            }
        <//>
        ${
            /* A rule between the person - their card, settings and address - and what they
            said (Curtis, 2026-09-08). */ ''
        }
        <hr class="id-rule" />
        <${PublicPosts}
            root=${root}
            posts=${profile.posts}
            pinned=${profile.pinned}
            fields=${profile.fields}
            more=${profile.posts_more}
            current=${current}
            searchQuery=${searchQuery}
        />
    <//>`;
};
