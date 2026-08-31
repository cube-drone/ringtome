// Notifications: one bell, both roads (PROJECT_PLAN, Arrival and Attention). Derived rows
// are facts folded from chains this node already syncs because you follow their author;
// delivered rows arrived at your door by envelope (the inbox path, gates and all) and wear
// the stranger mark. Two kinds today: someone published their relationship with you (a
// public-edge statement), and someone shared one of your posts (a rebroadcast - a murmur,
// which is why it reads quietly).
//
// The rows come from the node's notifications memo over HTTP (the memo collapses one row per
// (author, kind), so this list is your social circle, not your history). Seen-state is a
// single watermark on YOUR private chain - "mark all read" is one write that reaches your
// other computers by sync, per "seen is a user fact that travels".
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { PersonChip, SignalCell, trustStops, interestStops } from '../person.js';
import { MiniPost } from '../postentry.js';
import { agoUnit } from '../pure/ago.js';
import { speakable } from '../speakable.js';

const html = htm.bind(h);

/// The row's words, from what the statement actually publishes. The vouch reading is reserved
/// for the max band because that stop IS the vouch (The Vouch Dissolved into the Ledger).
/// Who the row is about, said out loud.
///
/// Both kinds get a visible name; only the provenance differs, and the quote marks carry it. A
/// followed persona's name came off their own chain when we synced them, so it stands unadorned
/// in the subject position. A stranger's came out of the envelope they sent, so it is quoted -
/// their words about themselves, next to an identicon that is not theirs to choose.
///
/// When neither exists, the speakable form of their key: derived, unforgeable, and the same
/// words the chip shows on hover, so the row and the face agree.
const Subject = ({ row }) => {
    if (row.stranger && row.claimed_name) {
        return html`<q
            class="notif-claimed"
            title=${t('apps.notifications.what-they-call-themselves-unverified', 'what they call themselves - an unverified claim, not a name this computer has checked')}
            >${row.claimed_name}</q
        >`;
    }
    const known = !row.stranger && row.author_name;
    return html`<strong class="notif-subject">${known || speakable(row.author)}</strong>`;
};

const sentence = (r) => {
    // The share kind first: it carries no bands, and the public-edge ladder below would
    // otherwise dress it as "publishes their trust in you" - the exact miscopy that hid
    // share notifications in plain sight (2026-08-25: the row rendered, wearing the wrong
    // words). Derived rows name the document; a delivered murmur cannot (the pool
    // collapses per sender), and the words stay honest about that difference.
    // A comment is conversation, first-class by ruling (PROJECT_PLAN's Replies slice 4): the verb,
    // and the mini-card - YOUR post, whose permalink is where the thread assembles - as
    // the object. Same sentence shape as the share, different weight by tier.
    // A label on your post (ANNOTATIONS.md slice 4): a murmur, the verb and the card.
    if (r.kind === 'tagged') {
        return r.doc_id
            ? t('apps.notifications.labelled', 'labelled')
            : t('apps.notifications.labelled-one-of-your-posts', 'labelled one of your posts');
    }
    if (r.kind === 'comment') {
        return r.doc_id
            ? t('apps.notifications.replied-on', 'replied on')
            : t('apps.notifications.replied-to-one-of-your', 'replied to one of your posts');
    }
    if (r.kind === 'rebroadcast') {
        // With the mini-card right there, "one of your posts" restated the card - the
        // sentence is just the verb, and the card is the object. The wordier form
        // survives only for a row that names no post to show.
        return r.doc_id
            ? t('apps.notifications.shared', 'shared')
            : t(
                  'apps.notifications.shared-something-of-yours',
                  'shared something of yours'
              );
    }
    const follows = !!r.interest;
    const vouches = r.trust === 'max';
    if (follows && vouches)
        return t(
            'apps.notifications.follows-you-publicly-and-vouches',
            'follows you publicly, and vouches for you - they say you two have met'
        );
    if (follows && r.trust)
        return t(
            'apps.notifications.follows-you-publicly-and-publishes',
            'follows you publicly, and publishes their trust in you'
        );
    if (follows) return t('apps.notifications.follows-you-publicly', 'follows you, publicly');
    if (vouches)
        return t(
            'apps.notifications.vouches-for-you-publicly',
            'vouches for you, publicly - they say you two have met'
        );
    return t('apps.notifications.publishes-their-trust-in', 'publishes their trust in you');
};

const whenWords = (ms) => {
    const ago = agoUnit(ms, Date.now());
    return ago
        ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(ago.value, ago.unit)
        : t('apps.notifications.just-now', 'just now');
};

export const NotificationsApp = ({ current }) => {
    const root = current && current.root;
    const [page, setPage] = useState(null); // { items, watermark } - null until first load

    const load = () => {
        if (!root) return;
        api(`/api/identity/${root}/notifications`)
            .then(setPage)
            .catch(() => {}); // a failed poll keeps the last page; the next one retries
    };
    useEffect(load, [root]);
    useEffect(() => {
        const interval = setInterval(load, 30_000);
        window.addEventListener('focus', load);
        return () => {
            clearInterval(interval);
            window.removeEventListener('focus', load);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root]);

    const items = (page && page.items) || [];
    const unseen = items.filter((i) => !i.seen).length;

    // The watermark is the newest row's stamp: everything on screen becomes seen, and rows
    // arriving later sit above it. One private register - it syncs to your other computers.
    const markAllRead = async () => {
        const top = Math.max(0, ...items.map((i) => i.updated_ms));
        try {
            await api(`/api/identity/${root}/private/kv/notifications_seen/watermark`, {
                method: 'PUT',
                body: JSON.stringify({ value: String(top) }),
            });
        } catch {
            return; // the button stays; the next click retries
        }
        setPage((p) => p && { ...p, items: p.items.map((i) => ({ ...i, seen: true })) });
    };

    return html`
        <div class="notif-app">
            ${unseen > 0 &&
            html`<div class="notif-bar">
                <button class="notif-mark-read" onClick=${markAllRead}>
                    ${t('apps.notifications.mark-all-read', 'mark all read')}
                </button>
            </div>`}
            ${page && items.length === 0
                ? html`<p class="notif-empty">
                      <${Icons.notifications} />
                      ${t(
                          'apps.notifications.nothing-yet-when-someone-you',
                          'nothing yet - when someone you follow makes their relationship with you public, it lands here'
                      )}
                  </p>`
                : html`<div class="notif-list">
                      ${items.map(
                          (r) => html`
                              <div
                                  class=${r.seen ? 'notif-row' : 'notif-row notif-unseen'}
                                  key=${`${r.stranger ? 'x' : 'd'}:${r.author}:${r.kind}`}
                              >
                                  ${/* Passing a profile - even an EMPTY one, which is what a
                                      stranger's row carries - is what stops usePerson fetching
                                      their page. That rule is about FAN-OUT and stays: a flood
                                      of stranger notices must not become a flood of syncs.
                                      Follow them and they become a derived row with a byline.

                                      What the rule is NOT is an impersonation defence, and
                                      pretending otherwise cost clarity for nothing (2026-08-11):
                                      hiding the name never stopped anyone from BEING "Bank
                                      Support", it only made honest strangers unreadable. So the
                                      claim is shown - beside the identicon and speakable words
                                      derived from their root, which nobody can choose, and
                                      never in the identity's place. */ ''}
                                  <${PersonChip}
                                      root=${r.author}
                                      current=${current}
                                      profile=${{
                                          fields: [
                                              r.author_name && { field: 'name', value: r.author_name },
                                              r.author_avatar && { field: 'avatar', value: r.author_avatar },
                                          ].filter(Boolean),
                                          via: [],
                                      }}
                                  />
                                  <span class="notif-text">
                                      ${/* Every row names its subject. The chip is a FACE - its
                                          label is a hover tooltip - so a row without this reads
                                          "follows you, publicly" with nobody doing it. Adding a
                                          visible name to strangers only (2026-08-11) made the
                                          unverified claim MORE prominent than a real name, which
                                          is the exact inversion this design is trying to avoid. */ ''}
                                      <${Subject} row=${r} />
                                      ${sentence(r)}
                                      ${/* The mini-card: the referenced post as a dressed
                                          link to its own page - title joined server-side
                                          (the reader's own post), degrading to a bare
                                          "link" when the post has left the shelf. */ ''}
                                      ${(r.kind === 'rebroadcast' || r.kind === 'comment' || r.kind === 'tagged') &&
                                      r.doc_id &&
                                      html`<${MiniPost}
                                          author=${root}
                                          doc_id=${r.doc_id}
                                          title=${r.doc_title}
                                          published_ms=${r.doc_published_ms}
                                      />`}
                                      ${r.stranger &&
                                      html`<span
                                          class="notif-stranger"
                                          title=${t('apps.notifications.you-dont-follow-them-so', "you don't follow them, so this arrived at your door - their name and picture stay unfetched until you answer")}
                                      >${t('apps.notifications.a-stranger', 'a stranger')}</span>`}
                                  </span>
                                  <span class="notif-cells">
                                      ${r.trust &&
                                      html`<${SignalCell}
                                          stops=${trustStops()}
                                          value=${r.trust}
                                          label=${t('apps.notifications.dial-trust', 'trust')}
                                      />`}
                                      ${r.interest &&
                                      html`<${SignalCell}
                                          stops=${interestStops()}
                                          value=${r.interest}
                                          label=${t('apps.notifications.dial-interest', 'interest')}
                                      />`}
                                  </span>
                                  <span class="notif-when" title=${new Date(r.updated_ms).toLocaleString()}>
                                      ${whenWords(r.updated_ms)}
                                      ${!r.seen &&
                                      html`<span
                                          class="notif-new"
                                          title=${t('apps.notifications.you-havent-seen-this-yet', "you haven't seen this yet")}
                                      ></span>`}
                                  </span>
                              </div>
                          `
                      )}
                  </div>`}
        </div>
    `;
};
