// The post permalink: one post, at its own address (2026-08-25 - "do posts have their own
// location within the UI? ... oh no did we forget to build that").
//
// `/id/{who}/post/{doc}` sits inside the persona's namespace because a post is something a
// PERSON said - the page is their byline over one entry, not a new surface. The entry itself
// is `PostEntry`, unchanged ("one component for 'a post, shown' everywhere a post is shown"),
// so the permalink renders exactly what the feed and the person page render - same body
// fetch, same emphasis, same words.
//
// This is the address everything else points AT: the share notification's "see the post",
// eventually the suggested shelf and anything a person pastes to a friend. The header read
// comes from `/api/id/{who}/posts/{doc}` (the shelf rule: hosted personas anonymously, and
// for members whatever this node already reached), which answers one honest 404 for
// never-was, private, and taken-down alike.
import { h } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { FEED_STYLE, REPLY_SORTS, replySortParams } from './pure/feed.js';
import { useRef } from 'preact/hooks';
import { parseSpeakable } from './speakable.js';
import { PostEntry, MiniPost, Composer, BakeModal } from './postentry.js';
import { publishTo } from './doc/publish.js';
import { PersonRow } from './person.js';

/// The copy chain (Curtis, 2026-09-08): the other authors this post descends from - the
/// author's own `provenance` statements, oldest first - as person cards, under the replies
/// and nowhere else: not a label, not a chip, a credit.
const CopyChain = ({ author, annotations }) => {
    const roots = [];
    for (const a of annotations || []) {
        if (a.key === 'provenance' && a.annotator === author && !roots.includes(a.value))
            roots.push(a.value);
    }
    if (roots.length === 0) return null;
    return html`<section class="copy-chain">
        <h2 class="copy-chain-head">${t('postpage.other-authors-in-the-copy-chain', 'Other Authors in the Copy Chain')}</h2>
        ${roots.map((r) => html`<${PersonRow} key=${r} root=${r} />`)}
    </section>`;
};
import { speakable } from './speakable.js';
import { t } from './i18n.js';
import { BookReader } from './doc/bookreader.js';
import { groupPostHref, postHref, postLink, useSlugOf } from './links.js';
import { OpenInApp } from './qr.js';
import { useUnlocked } from './unlocks.js';
import { useShowsAPost } from './postshowing.js';

const html = htm.bind(h);

/// A thread's orders (pure/feed.js keeps the keys), in words.
const REPLY_WORDS = {
    old: () => t('postpage.reply-order-old', 'oldest first'),
    hot: () => t('postpage.reply-order-hot', 'hot'),
    best: () => t('postpage.reply-order-best', 'best'),
};

/// The thread's order (slice 3): oldest first until the reader picks another, kept beside the
/// feed's order in the same private register so it follows them to their other devices.
const useReplyOrder = (reader) => {
    const [replyOrder, setReplyOrder] = useState('old');
    useEffect(() => {
        if (!reader) return undefined;
        let live = true;
        api(`/api/identity/${reader}/private/kv/feed_selectivity`)
            .then((r) => {
                const saved = ((r && r.values) || []).find((v) => v.key === 'reply_sort');
                if (live && saved && REPLY_SORTS.includes(saved.value)) setReplyOrder(saved.value);
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [reader]);
    const moveReplyOrder = (key) => {
        setReplyOrder(key);
        if (!reader) return;
        api(`/api/identity/${reader}/private/kv/feed_selectivity/reply_sort`, {
            method: 'PUT',
            body: JSON.stringify({ value: key }),
        }).catch(() => {});
    };
    return [replyOrder, moveReplyOrder];
};

/// The thread's order, as a select: for a signed-in reader, whose scores order hot and best.
const ReplyOrderSelect = ({ order, onOrder }) => html`<select
    class="thread-order"
    title=${t('postpage.reply-order-title', 'how each level of replies is ordered - hot and best by what the people you trust and follow liked')}
    value=${order}
    onChange=${(e) => onOrder(e.currentTarget.value)}
>
    ${REPLY_SORTS.map((key) => html`<option value=${key} key=${key}>${REPLY_WORDS[key]()}</option>`)}
</select>`;

/// Where a thread lives: a public post's doors, or a group's (plans/GROUPS.md, section 7) - the
/// same thread, cards and reply box over another set of routes.
/// - `level(author, doc, query)`: one level of replies, the public door's answer.
/// - `entry(author, doc, viewer)`: one reply as a card's item (no byline, which the level carries).
/// - `href(author, doc)`: a post's own page.
/// - `post(root, draft, onBaking, parent, sealed)`: publish a draft as a reply; answers its doc id.
const PUBLIC_ROAD = {
    level: (author, doc, query) => api(`/api/id/${author}/posts/${doc}/replies${query}`),
    entry: async (author, doc, viewer) => {
        const post = await api(`/api/id/${author}/posts/${doc}${viewer ? `?as=${viewer}` : ''}`);
        return {
            author,
            doc_id: post.doc_id,
            title: post.title,
            format: post.format,
            published_ms: post.published_ms,
            // The stamps the card reads for its marks: "written {date}" on a backdated post, "edited {date}"
            // when its words changed after it went out (2026-10-02 - the page dropped both).
            dated_ms: post.dated_ms,
            minted_ms: post.minted_ms,
            updated_ms: post.updated_ms,
            replies: post.replies,
            annotations: post.annotations,
        };
    },
    href: (author, doc) => postHref(author, doc),
    post: async (root, draft, onBaking, parent, sealed) =>
        (
            await publishTo(
                root,
                draft,
                { words: true },
                {
                    choice: sealed ? 'trusted' : null,
                    reply_to: { author: parent.author, doc_id: parent.doc_id },
                    onBaking,
                },
            )
        ).post_id,
    note: () => t('postpage.replying-is-public-and-shares', 'replies are public'),
    // A reply is publication, and publishing is Social's (plans/UNLOCKS.md).
    unlocked: false,
};

/// A group's thread: its members' replies, on their lanes for the group, read and posted through
/// the group's own routes - never a public door. Any member may answer, as any member may post.
const groupRoad = (root, group) => ({
    level: (author, doc, query) =>
        api(`/api/identity/${root}/groups/${group}/posts/${doc}/replies${query}`),
    entry: async (author, doc) =>
        (await api(`/api/identity/${root}/groups/${group}/posts/${doc}`)).item,
    href: (author, doc) => groupPostHref(group, doc),
    post: async (root, draft, onBaking, parent) =>
        (
            await publishTo(
                root,
                draft,
                { words: true },
                {
                    choice: `group:${group}`,
                    reply_to: { author: parent.author, doc_id: parent.doc_id },
                },
            )
        ).post_id,
    note: () => t('postpage.replies-stay-in-the-group', "replies are for the group's members"),
    unlocked: true,
});

/// A group post's conversation, under its card on the group post page (groups.js): the public
/// post page's thread section over the group's road - its order, its thread, its reply box. No
/// held replies and nothing to ask again: every member's node holds every reply.
export const GroupThread = ({ group, item, current }) => {
    const root = current && current.root;
    const [said, setSaid] = useState([]);
    const [replyOrder, moveReplyOrder] = useReplyOrder(root);
    const road = useMemo(() => groupRoad(root, group), [root, group]);
    if (!root || !item) return null;
    if (item.settled) {
        return html`<p class="thread-settled">
            ${t('postpage.the-author-settled-this', 'the author turned off comments for this post')}
        </p>`;
    }
    if (item.format === 'room') return null;
    return html`<section class="thread">
        <h2 class="thread-head">
            ${t('postpage.replies', 'replies')}
            <${ReplyOrderSelect} order=${replyOrder} onOrder=${moveReplyOrder} />
        </h2>
        <${Thread}
            author=${item.author}
            doc=${item.doc_id}
            current=${current}
            depth=${0}
            extra=${said}
            refreshKey=${0}
            order=${replyOrder}
            road=${road}
        />
        <${ReplyBox}
            current=${current}
            parent=${{ author: item.author, doc_id: item.doc_id }}
            onReplied=${(mint) => setSaid((have) => [...have, mint])}
            road=${road}
        />
    </section>`;
};

export const PostPage = ({ seg, doc, page, current, onTitle }) => {
    const loc = useLocation();
    useShowsAPost(); // the header's search has nothing to narrow here (postshowing.js)
    const parsed = parseSpeakable(decodeURIComponent(seg || ''));
    const root = parsed && parsed.ok ? parsed.root : null;
    // The address's reachability hints ride through, the person page's idiom: a permalink
    // pasted across the network should resolve the same way the person's own page does.
    const via = (loc.query && loc.query.via) || '';
    // undefined = loading, null = not held here, object = the post
    const [post, setPost] = useState(undefined);
    // The author's profile, from the visit that warms the node anyway: the card's face (2026-10-03).
    const [authorProfile, setAuthorProfile] = useState(null);
    // Replies said from THIS page, ahead of the fold: the memo notes a fresh reply on the
    // fold lane's next pass, so the thread read may not list it yet - the view runs ahead
    // of the stream without disagreeing with it (the feed's own overlay idiom).
    const [said, setSaid] = useState([]);
    // The refresh affordance's counter: bumping it re-mounts the thread's read with
    // refresh=1, the deliberate re-ask past the door's cooldown.
    const [refreshKey, setRefreshKey] = useState(0);
    const [replyOrder, moveReplyOrder] = useReplyOrder(current ? current.root : null);

    // `?as=`: the viewing persona, so the labels a sealed post shows are the ones its
    // holder admits THIS reader to (ruling 7; Curtis, 2026-09-14: the post page read
    // "trusted only" where the feed read "only the people mentioned").
    const viewer = current ? current.root : null;
    useEffect(() => {
        if (!root || !doc) return;
        let live = true;
        setAuthorProfile(null); // another post's author is not this one's
        // The profile visit first, hints attached: it is what teaches this node the persona
        // when the permalink arrives cold (stale-while-revalidate behind it), and the post
        // read is then a shelf read. A held persona answers both immediately.
        const url = `/api/id/${root}/profile${via ? `?via=${encodeURIComponent(via)}` : ''}`;
        api(url)
            .then((p) => live && setAuthorProfile(p))
            .catch(() => {}) // the shelf read below gives the honest answer either way
            .then(() => api(`/api/id/${root}/posts/${doc}${viewer ? `?as=${viewer}` : ''}`))
            .then((p) => live && setPost(p))
            .catch(() => live && setPost(null));
        return () => {
            live = false;
        };
    }, [root, doc, via, viewer]);

    const slug = useSlugOf(root);
    // Its web address in the address bar (plans/WEB_ADDRESSES.md): reached by its id, or by its path
    // under the author's real address, a post says the shortest form instead - its path under the
    // author's @name when this node gave them one, else under their real address; and a post with
    // no path, its id under the @name (2026-10-18) - so the address a reader copies is the readable
    // one. Only the address changes; a page of a book is the reader's to say (bookreader.js).
    useEffect(() => {
        if (!post || page) return;
        // The @name only where the node has a public URL (`slugOf` says none otherwise).
        if (slug === undefined) return;
        const named = (post.annotations || []).find(
            (a) => a.annotator === root && a.key === 'path',
        );
        const shortest = postLink(root, doc, { path: named ? named.value : null, slug });
        const longer = [
            `/ringtome/user/${seg}/post/${doc}`,
            named && `/ringtome/user/${seg}/${named.value}`,
            named && slug && `/@${slug}/post/${doc}`,
        ].filter(Boolean);
        const here = decodeURIComponent(window.location.pathname);
        if (here === shortest || !longer.includes(here)) return;
        try {
            history.replaceState(history.state, '', `${shortest}${window.location.search}`);
        } catch {
            /* an address the browser won't take: the longer one stands */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [post, slug]);

    useEffect(() => {
        if (onTitle) onTitle(post && post.title ? post.title : t('postpage.a-post', 'a post'));
    }, [post, onTitle]);

    if (!root) {
        return html`<p class="postpage-missing">
            ${t('postpage.that-isnt-an-address', "that isn't an address this app knows how to read")}
        </p>`;
    }

    // A book, or a page of one: the reader (PROJECT_PLAN's Books, slice 4) rather than the card.
    const isBook = !!post && post.format === 'book';
    // A room takes no replies (Curtis, 2026-09-18): no thread section, no reply box.
    const isRoom = !!post && post.format === 'room';
    const partOf = (post && post.part_of) || null;
    // A book's comments live in one place (Curtis, 2026-09-04: a per-page thread is "a place
    // for comments to get very lost"): a page's page threads and replies on the BOOK.
    const threadDoc = partOf || doc;
    const authorField = (key) => {
        const f = ((authorProfile && authorProfile.fields) || []).find((x) => x.field === key);
        return f && f.value ? f.value : undefined;
    };
    const item = post && {
        author: root,
        // Who said it, as a feed row names them - the card asks for nothing it is handed.
        author_name: authorField('name'),
        author_avatar: authorField('avatar'),
        doc_id: post.doc_id,
        title: post.title,
        format: post.format,
        published_ms: post.published_ms,
        // The stamps the card reads for its marks: "written {date}" on a backdated post, "edited {date}"
        // when its words changed after it went out (2026-10-02 - the page dropped both).
        dated_ms: post.dated_ms,
        minted_ms: post.minted_ms,
        updated_ms: post.updated_ms,
        replies: post.replies,
        annotations: post.annotations,
        settled: !!post.settled,
        trusted_only: !!post.trusted_only,
        onward: !!post.onward,
        mine: !!(current && current.root === root),
    };

    return html`
        <div class="postpage">
            ${/* On an Android phone's browser: into the app instead (plans/QR.md). */ ''}
            ${root && html`<${OpenInApp} appPath=${postHref(root, doc)} />`}
            ${
                /* No separate byline at all: the entry below carries the author's clickable
                profile, exactly as it does in the feed - the page is the post, alone. */ ''
            }
            ${
                post === undefined &&
                html`<p class="postpage-loading">${t('postpage.looking-for-the-post', 'looking for the post…')}</p>`
            }
            ${
                post === null &&
                html`<p class="postpage-missing">
                ${t(
                    'postpage.no-such-post-is-held',
                    'no such post is held here - it may be private, taken down, or its author unreachable',
                )}
            </p>`
            }
            ${
                /* The parent, when this post is itself a reply: the conversation it belongs
                to, one hop up (PROJECT_PLAN's Replies slice 3 - "parent context above, replies
                below"). The card degrades to a bare "link" when the parent's header is not
                readable here - the hollow case, honestly. */ ''
            }
            ${
                /* The thread's root FIRST when this reply sits deeper than depth one
                (Curtis, 2026-08-28) - the conversation's subject, then the words these
                answer, then the reply: reading downward like the thread itself. */ ''
            }
            ${post && html`<${ParentContexts} post=${post} />`}
            ${
                /* A book opens as its reader (PROJECT_PLAN's Books, slice 4), and so does a page of one:
                the book's tree beside the page, since a page is a place in a book first. */ ''
            }
            ${
                item &&
                isBook &&
                html`<${BookReader} root=${root} book=${post.doc_id} page=${page || null} title=${post.title} />`
            }
            ${
                item &&
                !isBook &&
                partOf &&
                html`<${BookReader} root=${root} book=${partOf} page=${post.doc_id} />`
            }
            ${
                item &&
                !isBook &&
                !partOf &&
                html`<${PostEntry} key=${item.doc_id} item=${item} current=${current} editing=${null} quote=${false} standalone=${true} />`
            }
            ${
                /* The author's wish (PROJECT_PLAN's Post visibility): a settled post has no thread section and
                no reply box - just the honest word for why. */ ''
            }
            ${
                item &&
                item.settled &&
                html`<p class="thread-settled">
                ${t('postpage.the-author-settled-this', 'the author turned off comments for this post')}
            </p>`
            }
            ${
                /* A room takes no replies (Curtis, 2026-09-18): the conversation is inside it,
                and the card's tail shows it moving. */ ''
            }
            ${
                item &&
                !item.settled &&
                !isRoom &&
                html`<section class="thread">
                <h2 class="thread-head">
                    ${t('postpage.replies-known-here', 'replies known here')}
                    ${
                        current &&
                        current.root &&
                        html`<${ReplyOrderSelect} order=${replyOrder} onOrder=${moveReplyOrder} />`
                    }
                    ${
                        !item.mine &&
                        html`<button
                        class="thread-refresh"
                        title=${t('postpage.ask-the-author-again', 'check for new replies')}
                        onClick=${() => setRefreshKey((k) => k + 1)}
                    >${t('postpage.refresh', 'refresh')}</button>`
                    }
                </h2>
                ${
                    item.mine &&
                    html`<${HeldReplies}
                    root=${root}
                    doc=${threadDoc}
                    onNod=${() => setRefreshKey((k) => k + 1)}
                />`
                }
                <${Thread}
                    author=${root}
                    doc=${threadDoc}
                    current=${current}
                    depth=${0}
                    extra=${said}
                    refreshKey=${refreshKey}
                    order=${replyOrder}
                />
                ${
                    /* The reply box comes AFTER the conversation (Curtis, 2026-08-28): you
                    read what was said, then say something - the transcript's own order,
                    the same reason the thread reads oldest-first. */ ''
                }
                ${
                    current &&
                    current.root &&
                    html`<${ReplyBox}
                    current=${current}
                    parent=${{ author: root, doc_id: threadDoc }}
                    onReplied=${(mint) => setSaid((have) => [...have, mint])}
                    sealed=${!!item.trusted_only}
                />`
                }
            </section>`
            }
            ${item && !isBook && html`<${CopyChain} author=${root} annotations=${post.annotations} />`}
            ${item && html`<${PostDossier} author=${root} doc=${threadDoc} reader=${viewer} />`}
        </div>
    `;
};

/// The post's forensic ledger, folded at the very bottom (Curtis, 2026-08-31): everything
/// this node knows about the post, dense over pretty - each reply and label with the ROAD
/// it arrived by ('chain', 'fragment', 'envelope', 'door', 'relay:<endpoint>'), so a
/// reader who feels harassed can reverse-engineer the peer rubber-stamping the traffic in.
/// Fetched lazily on first unfold; a log, not a page.
const PostDossier = ({ author, doc, reader }) => {
    const [data, setData] = useState(null);
    const [open, setOpen] = useState(false);
    // The popularity (PROJECT_PLAN's Scores and sort orders): how the signed-in reader's node
    // scores this post, every step shown - from its own door, which answers only for a persona
    // the session owns, since it is a readout of that persona's dials.
    const [pop, setPop] = useState(null);
    useEffect(() => {
        if (!open || data !== null) return;
        let live = true;
        api(`/api/id/${author}/posts/${doc}/dossier`)
            .then((d) => live && setData(d))
            .catch(() => live && setData(false));
        return () => {
            live = false;
        };
    }, [open, data, author, doc]);
    useEffect(() => {
        if (!open || !reader || pop !== null) return;
        let live = true;
        api(`/api/identity/${reader}/popularity/${author}/${doc}`)
            .then((p) => live && setPop(p))
            .catch(() => live && setPop(false));
        return () => {
            live = false;
        };
    }, [open, pop, reader, author, doc]);
    const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '?');
    const who = (root_, name) => `${name ? `${name} ` : ''}${speakable(root_)}`;
    return html`<details class="post-dossier" onToggle=${(e) => setOpen(e.currentTarget.open)}>
        <summary>${t('postpage.history-and-popularity', 'history & popularity')}</summary>
        ${data === null && open && html`<p>${t('postpage.reading-the-ledger', 'loading…')}</p>`}
        ${data === false && html`<p>${t('postpage.no-ledger-readable-here', 'no history here')}</p>`}
        ${
            data &&
            html`<pre class="post-dossier-log">${[
                `post ${doc} by ${speakable(author)}`,
                data.post &&
                    `  published ${iso(data.post.published_ms)} updated ${iso(data.post.updated_ms)} format ${data.post.format || '?'}`,
                `annotations known here: ${(data.annotations || []).length}`,
                ...(data.annotations || []).map(
                    (a) =>
                        `  ${a.key} ${JSON.stringify(a.value)} by ${who(a.annotator, a.annotator_name)}` +
                        ` noted ${iso(a.noted_ms)} via ${a.learned_via}${a.proof_kept ? ' [relaying onward]' : ''}`,
                ),
                `replies known here: ${(data.replies || []).length}`,
                ...(data.replies || []).map(
                    (r) =>
                        `  ${r.direct ? 'reply' : 'in-tree'} ${r.doc_id} by ${who(r.author, (data.reply_names || {})[r.author])}` +
                        ` claimed ${iso(r.claimed_ms)} noted ${iso(r.noted_ms)} via ${r.learned_via}` +
                        (r.served === true
                            ? ' [served]'
                            : r.served === false
                              ? ' [held/suppressed]'
                              : ''),
                ),
                ...popularityLines(pop, who),
            ]
                .filter(Boolean)
                .join('\n')}</pre>`
        }
    </details>`;
};

/// The popularity readout, as the dossier's lines: each reaction with who said it, how the
/// reader's dial on them weighed it, and what it added; then the interest factor and the score.
/// Nothing for a reader signed out, or a readout that did not come.
const popularityLines = (pop, who) => {
    if (!pop) return [];
    const signed = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
    const standing = (s) =>
        s === 'you'
            ? 'you'
            : s && s.trusted
              ? `trusted ${s.trusted}`
              : s === 'followed'
                ? 'followed'
                : s === 'blocked'
                  ? 'blocked'
                  : 'no edge';
    const names = pop.names || {};
    return [
        `popularity, as this node reckons it for you: ${(pop.parts || []).length} reaction${(pop.parts || []).length === 1 ? '' : 's'}`,
        ...(pop.parts || []).map(
            (p) =>
                `  ${p.value} ${p.tone > 0 ? '+1' : '-1'} by ${who(p.annotator, names[p.annotator])}` +
                ` - ${standing(p.standing)} x${p.weight.toFixed(2)} = ${signed(p.tone * p.weight)}`,
        ),
        `  interest in the author: ${pop.interest || 'unset'} x${pop.interest_factor.toFixed(2)}`,
        `  score ${signed(pop.score)}`,
    ];
};

/// One hop up: the post this page's post replies to, as a mini-card. The title comes from
/// the parent's own held header when this node can read it; a parent not held here still
/// gets its link - "in reply to: link" is the honest hollow rendering.
/// The thread's root, when it isn't the parent, then the parent: a reply's context above it. A
/// group's post carries its links dressed by the group's node (`group`), so nothing is fetched and
/// the cards open the group's posts; a public one's are read from their authors' doors.
export const ParentContexts = ({ post, group }) => html`
    ${
        post.thread_root &&
        post.reply_to &&
        (post.thread_root.author !== post.reply_to.author ||
            post.thread_root.doc_id !== post.reply_to.doc_id) &&
        html`<${ParentContext} link=${post.thread_root} root=${true} group=${group} />`
    }
    ${post.reply_to && html`<${ParentContext} link=${post.reply_to} group=${group} />`}
`;

const ParentContext = ({ link, root, group }) => {
    const [fetched, setHead] = useState(null);
    const [gone, setGone] = useState(false);
    useEffect(() => {
        if (group) return undefined;
        let live = true;
        api(`/api/id/${link.author}/posts/${link.doc_id}`)
            .then((p) => live && setHead(p))
            .catch(() => live && setGone(true));
        return () => {
            live = false;
        };
    }, [link.author, link.doc_id, group]);
    const head = group ? link : fetched;
    return html`<p class="postpage-parent">
        ${
            root
                ? gone
                    ? t('postpage.thread-unreadable', 'thread (no longer readable here)')
                    : t('postpage.thread', 'thread')
                : gone
                  ? t(
                        'postpage.in-reply-to-unreadable',
                        'in reply to a post that is no longer readable here',
                    )
                  : t('postpage.in-reply-to', 'in reply to')
        }
        <${MiniPost}
            author=${link.author}
            doc_id=${link.doc_id}
            title=${head && head.title}
            published_ms=${head && head.published_ms}
            href=${group && groupPostHref(group, link.doc_id)}
        />
    </p>`;
};

/// The author's curation surface (PROJECT_PLAN's Replies slice 6): strangers' replies this node holds
/// for the nod. Curation is the same bit as display - "approve comment" makes the reply
/// join the visible conversation here AND start being served from the author's door;
/// "keep quiet" suppresses it. The honest limit, on the surface that exercises it:
/// suppression mutes YOUR amplification, never the reply's existence on its own author's
/// chain.
const HeldReplies = ({ root, doc, onNod }) => {
    const [rows, setRows] = useState(null);
    const [gen, setGen] = useState(0);
    useEffect(() => {
        let live = true;
        api(`/api/identity/${root}/posts/${doc}/replies`)
            .then((p) => live && setRows((p.replies || []).filter((r) => !r.served && !r.verdict)))
            .catch(() => live && setRows([]));
        return () => {
            live = false;
        };
    }, [root, doc, gen]);
    const nod = async (r, verdict) => {
        await api(`/api/identity/${root}/private/kv/comments/${r.author}:${r.doc_id}`, {
            method: 'PUT',
            body: JSON.stringify({ value: verdict }),
        }).catch(() => {});
        setGen((g) => g + 1);
        // The PUT's 200 means the fold agreed and the door speaks the new bit - so the
        // thread below must look again NOW, or an approved reply leaves this list and
        // appears nowhere until a reload (Curtis, 2026-08-28: "dooming that comment to
        // the shadow dimension" - it was only ever waiting on a refetch).
        if (onNod) onNod();
    };
    if (!rows || !rows.length) return null;
    return html`<div class="held-replies">
        <p class="held-replies-head">
            ${t('postpage.held-for-your-nod', 'replies waiting for your approval')}
        </p>
        ${rows.map(
            (r) => html`<div class="held-reply" key=${`${r.author}:${r.doc_id}`}>
                <${HeldReplyBody} author=${r.author} doc=${r.doc_id} />
                <div class="held-reply-acts">
                    <button class="held-approve" onClick=${() => nod(r, 'approved')}>
                        ${t('postpage.approve-comment', 'approve comment')}
                    </button>
                    <button class="held-suppress" onClick=${() => nod(r, 'suppressed')}>
                        ${t('postpage.keep-quiet', 'keep quiet')}
                    </button>
                </div>
            </div>`,
        )}
    </div>`;
};

/// The held reply itself, when its words are readable here - the evidence names the post,
/// and the fragment fetch may still be in flight, so a bare byline is the honest fallback.
const HeldReplyBody = ({ author, doc }) => {
    const [post, setPost] = useState(undefined);
    useEffect(() => {
        let live = true;
        api(`/api/id/${author}/posts/${doc}`)
            .then((p) => live && setPost(p))
            .catch(() => live && setPost(null));
        return () => {
            live = false;
        };
    }, [author, doc]);
    if (post === undefined) return html`<p class="null-sub">…</p>`;
    if (post === null)
        return html`<p class="held-reply-hollow">
            ${t('postpage.a-reply-whose-words-havent', "a reply whose words haven't reached this computer yet")}
        </p>`;
    const item = {
        author,
        doc_id: post.doc_id,
        title: post.title,
        format: post.format,
        published_ms: post.published_ms,
        // The stamps the card reads for its marks: "written {date}" on a backdated post, "edited {date}"
        // when its words changed after it went out (2026-10-02 - the page dropped both).
        dated_ms: post.dated_ms,
        minted_ms: post.minted_ms,
        updated_ms: post.updated_ms,
        mine: false,
    };
    return html`<${PostEntry} key=${post.doc_id} item=${item} current=${null} editing=${null} quote=${false} />`;
};

/// The reply box (PROJECT_PLAN's Replies slice 3; grown to the FULL authoring surface 2026-08-27):
/// your words under the post they answer, in the same editor every other surface uses -
/// marquee, media embeds, the bake and all - because a reply is an ordinary post and
/// deserves the ordinary pen. The box opens INERT ("write a reply") and the first click
/// mints the draft - the feed app's hard-won mint discipline: a composer mounted on every
/// permalink visit would mint an empty document per view, and a mint behind a click is
/// ref-guarded so a double-click cannot mint two. An abandoned draft lands in the feed
/// app's own "older drafts" stack, editable like any other.
/// A public reply is publication, and publishing is Social's (plans/UNLOCKS.md); a group's road
/// needs no unlock, as posting to the group needs none.
const ReplyBox = (props) => {
    const road = props.road || PUBLIC_ROAD;
    const unlocked = useUnlocked(props.current.root, 'social');
    return unlocked || road.unlocked ? html`<${ReplyBoxOpen} ...${props} road=${road} />` : null;
};

const ReplyBoxOpen = ({ current, parent, onReplied, sealed = false, road }) => {
    const [draftId, setDraftId] = useState(null);
    const [posting, setPosting] = useState(false);
    const [baking, setBaking] = useState(null);
    const [error, setError] = useState(null);
    const minting = useRef(false);
    const root = current.root;

    const openBox = async () => {
        if (minting.current || draftId) return;
        minting.current = true;
        setError(null);
        try {
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: '', body: '', format: 'marquee' }),
            });
            await api(
                `/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(FEED_STYLE)}`,
                { method: 'PUT' },
            );
            setDraftId(made.doc_id);
        } catch (e) {
            setError(e.message);
            minting.current = false; // a failed mint may be retried; a successful one never
        }
    };

    const say = async () => {
        if (posting || !draftId) return;
        setPosting(true);
        setError(null);
        try {
            const posted = await road.post(root, draftId, setBaking, parent, sealed);
            onReplied({ author: root, doc_id: posted });
            // Said: the box returns to rest, ready to mint a fresh page for the next
            // thought - the posted document is done and lives with your other posts.
            setDraftId(null);
            minting.current = false;
        } catch (e) {
            // The words stay in the editor - a refused reply is a draft, not a loss.
            setError(e.message);
        }
        setPosting(false);
    };

    return html`<div class="replybox">
        ${
            /* A reply to a sealed post wears the author's seal (PROJECT_PLAN's Replies under
            the author's seal): only people the author trusts will read it, and the seal
            is not the commenter's to choose - so no toggle, just the word. */ ''
        }
        ${
            sealed &&
            html`<p class="replybox-note">
            ${t('postpage.this-reply-will-wear-the-authors-seal', 'only people the author trusts will see this')}
        </p>`
        }
        <${BakeModal} items=${baking} />
        ${
            draftId &&
            html`<p class="replybox-note">
            ${road.note()}
        </p>`
        }
        ${
            draftId
                ? html`<${Composer}
                  root=${root}
                  docId=${draftId}
                  published=${false}
                  onPost=${say}
                  posting=${posting}
                  onDeleted=${() => {
                      setDraftId(null);
                      minting.current = false;
                  }}
              />`
                : html`<button class="replybox-open" onClick=${openBox}>
                  ${t('postpage.write-a-reply', 'write a reply…')}
              </button>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

/// The visible tree below one post: this node's replies memo, one level per fetch, the
/// UI recursing with a depth cap (PROJECT_PLAN's Replies slice 2 - "replies known here", honest and
/// partial by ruling; slice 6's author door widens the well, not this shape). The feed
/// never assembles a tree - this page is the only place one forms.
const THREAD_DEPTH_CAP = 6;

const Thread = ({
    author,
    doc,
    current,
    depth,
    extra,
    refreshKey,
    order = 'old',
    road = PUBLIC_ROAD,
}) => {
    const [page, setPage] = useState(null);
    const viewer = current ? current.root : null;
    useEffect(() => {
        let live = true;
        // refreshKey > 0 is the human's deliberate re-ask: it rides `refresh=1` past the
        // node's cooldown so the door actually gets dialed again. The level's order rides along
        // (slice 3), asked as the viewer whose scores order it.
        const params = [
            depth === 0 && refreshKey > 0 ? 'refresh=1' : '',
            replySortParams(order, viewer),
        ]
            .filter(Boolean)
            .join('&');
        const force = params ? `?${params}` : '';
        const look = () =>
            road
                .level(author, doc, force)
                .then((p) => {
                    if (!live) return;
                    setPage(p);
                    // "Looking for more of the conversation": the node said it is asking
                    // the author's door behind this render (slice 6's SWR) - look once
                    // more after the ask has had a moment, then rest until refreshed.
                    if (depth === 0 && p.seeking) {
                        setTimeout(() => {
                            if (!live) return;
                            road.level(
                                author,
                                doc,
                                replySortParams(order, viewer)
                                    ? `?${replySortParams(order, viewer)}`
                                    : '',
                            )
                                .then((p2) => live && setPage({ ...p2, seeking: false }))
                                .catch(() => {});
                        }, 2500);
                    }
                })
                .catch(() => live && setPage({ replies: [] }));
        look();
        return () => {
            live = false;
        };
    }, [author, doc, depth, refreshKey, order, viewer, road]);
    const fetched = (page && page.replies) || [];
    const have = new Set(fetched.map((r) => `${r.author}:${r.doc_id}`));
    const replies = [
        ...fetched,
        ...(extra || []).filter((r) => !have.has(`${r.author}:${r.doc_id}`)),
    ];
    const seekingLine =
        depth === 0 &&
        page &&
        page.seeking &&
        html`<p class="thread-seeking">
            <span class="waiting-dot"></span>
            ${t('postpage.looking-for-more', 'looking for more of the conversation…')}
        </p>`;
    if (!replies.length) {
        return depth === 0 && page
            ? html`${
                  seekingLine ||
                  html`<p class="thread-empty">
                  ${t('postpage.none-known-yet', 'none known here yet')}
              </p>`
              }`
            : null;
    }
    return html`<div class="thread-level">
        ${seekingLine}
        ${replies.map(
            (r) => html`<${ThreadReply}
                key=${`${r.author}:${r.doc_id}`}
                author=${r.author}
                doc=${r.doc_id}
                byline=${((page && page.bylines) || {})[r.author]}
                current=${current}
                depth=${depth}
                order=${order}
                road=${road}
            />`,
        )}
    </div>`;
};

const ThreadReply = ({ author, doc, byline, current, depth, order, road }) => {
    // undefined = loading, null = not readable here (the memo knew it, the shelf moved -
    // a takedown between fold and render), object = the reply's header.
    const [post, setPost] = useState(undefined);
    const viewer = current ? current.root : null;
    useEffect(() => {
        let live = true;
        road.entry(author, doc, viewer)
            .then((p) => live && setPost(p || null))
            .catch(() => live && setPost(null));
        return () => {
            live = false;
        };
    }, [author, doc, viewer, road]);
    if (post === undefined) return null;
    if (post === null) {
        // The memo knows the claim; the shelf cannot answer for it right now - deleted
        // between fold and render, or a door-learned reply whose words are still in
        // flight. The hollow row is the honest render: the thread's shape stands, the
        // words degrade (PROJECT_PLAN's Replies - "in reply to a retracted post" composes).
        return html`<div class="thread-reply">
            <p class="thread-hollow">
                ${t('postpage.a-reply-that-isnt-readable', "a reply that isn't readable here - deleted, or its words still on their way")}
            </p>
        </div>`;
    }
    const item = {
        ...post,
        // The door's byline for the replier: what this node knows of them, whoever the
        // reader follows (the page's mirror knows only those).
        author_name: (byline && byline.name) || post.author_name,
        author_avatar: (byline && byline.avatar) || post.author_avatar,
        mine: !!(current && current.root === author),
    };
    return html`<div class="thread-reply">
        <${PostEntry} key=${post.doc_id} item=${item} current=${current} editing=${null} quote=${false} />
        ${
            depth + 1 < THREAD_DEPTH_CAP &&
            html`<${Thread} author=${author} doc=${doc} current=${current} depth=${depth + 1} order=${order} road=${road} />`
        }
        ${
            depth + 1 >= THREAD_DEPTH_CAP &&
            html`<p class="thread-deeper">
            <a href=${road.href(author, doc)}>
                ${t('postpage.continue-this-thread', 'continue this thread')}
            </a>
        </p>`
        }
    </div>`;
};
