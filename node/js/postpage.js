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
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { FEED_STYLE } from './pure/feed.js';
import { useRef } from 'preact/hooks';
import { parseSpeakable } from './speakable.js';
import { PostEntry, MiniPost, Composer, publishWithBaking, BakeModal } from './postentry.js';
import { speakable } from './speakable.js';
import { t } from './i18n.js';

const html = htm.bind(h);

export const PostPage = ({ seg, doc, current, onTitle }) => {
    const loc = useLocation();
    const parsed = parseSpeakable(decodeURIComponent(seg || ''));
    const root = parsed && parsed.ok ? parsed.root : null;
    // The address's reachability hints ride through, the person page's idiom: a permalink
    // pasted across the network should resolve the same way the person's own page does.
    const via = (loc.query && loc.query.via) || '';
    // undefined = loading, null = not held here, object = the post
    const [post, setPost] = useState(undefined);
    // Replies said from THIS page, ahead of the fold: the memo notes a fresh reply on the
    // fold lane's next pass, so the thread read may not list it yet - the view runs ahead
    // of the stream without disagreeing with it (the feed's own overlay idiom).
    const [said, setSaid] = useState([]);
    // The refresh affordance's counter: bumping it re-mounts the thread's read with
    // refresh=1, the deliberate re-ask past the door's cooldown.
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        if (!root || !doc) return;
        let live = true;
        // The profile visit first, hints attached: it is what teaches this node the persona
        // when the permalink arrives cold (stale-while-revalidate behind it), and the post
        // read is then a shelf read. A held persona answers both immediately.
        const url = `/api/id/${root}/profile${via ? `?via=${encodeURIComponent(via)}` : ''}`;
        api(url)
            .catch(() => {}) // the shelf read below gives the honest answer either way
            .then(() => api(`/api/id/${root}/posts/${doc}`))
            .then((p) => live && setPost(p))
            .catch(() => live && setPost(null));
        return () => {
            live = false;
        };
    }, [root, doc, via]);

    useEffect(() => {
        if (onTitle) onTitle(post && post.title ? post.title : t('postpage.a-post', 'a post'));
    }, [post, onTitle]);

    if (!root) {
        return html`<p class="postpage-missing">
            ${t('postpage.that-isnt-an-address', "that isn't an address this app knows how to read")}
        </p>`;
    }

    const item = post && {
        author: root,
        doc_id: post.doc_id,
        title: post.title,
        format: post.format,
        published_ms: post.published_ms,
        replies: post.replies,
        annotations: post.annotations,
        mine: !!(current && current.root === root),
    };

    return html`
        <div class="postpage">
            ${/* No separate byline at all: the entry below carries the author's clickable
                profile, exactly as it does in the feed - the page is the post, alone. */ ''}
            ${post === undefined &&
            html`<p class="postpage-loading">${t('postpage.looking-for-the-post', 'looking for the post…')}</p>`}
            ${post === null &&
            html`<p class="postpage-missing">
                ${t(
                    'postpage.no-such-post-is-held',
                    'no such post is held here - it may be private, taken down, or its author unreachable'
                )}
            </p>`}
            ${/* The parent, when this post is itself a reply: the conversation it belongs
                to, one hop up (PROJECT_PLAN's Replies slice 3 - "parent context above, replies
                below"). The card degrades to a bare "link" when the parent's header is not
                readable here - the hollow case, honestly. */ ''}
            ${/* The thread's root FIRST when this reply sits deeper than depth one
                (Curtis, 2026-08-28) - the conversation's subject, then the words these
                answer, then the reply: reading downward like the thread itself. */ ''}
            ${post &&
            post.thread_root &&
            post.reply_to &&
            (post.thread_root.author !== post.reply_to.author ||
                post.thread_root.doc_id !== post.reply_to.doc_id) &&
            html`<${ParentContext} link=${post.thread_root} root=${true} />`}
            ${post && post.reply_to && html`<${ParentContext} link=${post.reply_to} />`}
            ${item &&
            html`<${PostEntry} key=${item.doc_id} item=${item} current=${current} editing=${null} quote=${false} />`}
            ${item &&
            html`<section class="thread">
                <h2 class="thread-head">
                    ${t('postpage.replies-known-here', 'replies known here')}
                    ${!item.mine &&
                    html`<button
                        class="thread-refresh"
                        title=${t('postpage.ask-the-author-again', "ask the author's computer again - a hot thread is worth a second glance")}
                        onClick=${() => setRefreshKey((k) => k + 1)}
                    >${t('postpage.refresh', 'refresh')}</button>`}
                </h2>
                ${item.mine &&
                html`<${HeldReplies}
                    root=${root}
                    doc=${doc}
                    onNod=${() => setRefreshKey((k) => k + 1)}
                />`}
                <${Thread}
                    author=${root}
                    doc=${doc}
                    current=${current}
                    depth=${0}
                    extra=${said}
                    refreshKey=${refreshKey}
                />
                ${/* The reply box comes AFTER the conversation (Curtis, 2026-08-28): you
                    read what was said, then say something - the transcript's own order,
                    the same reason the thread reads oldest-first. */ ''}
                ${current &&
                current.root &&
                html`<${ReplyBox}
                    current=${current}
                    parent=${{ author: root, doc_id: doc }}
                    onReplied=${(mint) => setSaid((have) => [...have, mint])}
                />`}
            </section>`}
        </div>
    `;
};

/// One hop up: the post this page's post replies to, as a mini-card. The title comes from
/// the parent's own held header when this node can read it; a parent not held here still
/// gets its link - "in reply to: link" is the honest hollow rendering.
const ParentContext = ({ link, root }) => {
    const [head, setHead] = useState(null);
    const [gone, setGone] = useState(false);
    useEffect(() => {
        let live = true;
        api(`/api/id/${link.author}/posts/${link.doc_id}`)
            .then((p) => live && setHead(p))
            .catch(() => live && setGone(true));
        return () => {
            live = false;
        };
    }, [link.author, link.doc_id]);
    return html`<p class="postpage-parent">
        ${root
            ? gone
                ? t('postpage.thread-unreadable', 'thread (no longer readable here)')
                : t('postpage.thread', 'thread')
            : gone
              ? t('postpage.in-reply-to-unreadable', 'in reply to a post that is no longer readable here')
              : t('postpage.in-reply-to', 'in reply to')}
        <${MiniPost}
            author=${link.author}
            doc_id=${link.doc_id}
            title=${head && head.title}
            published_ms=${head && head.published_ms}
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
            ${t('postpage.held-for-your-nod', 'replies from people you don’t follow, held for your nod')}
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
            </div>`
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
const ReplyBox = ({ current, parent, onReplied }) => {
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
                { method: 'PUT' }
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
            const made = await publishWithBaking(root, draftId, setBaking, {
                reply_to: { author: parent.author, doc_id: parent.doc_id },
            });
            onReplied({ author: root, doc_id: made.post_id });
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
        <${BakeModal} items=${baking} />
        ${draftId &&
        html`<p class="replybox-note">
            ${t('postpage.replying-is-public-and-shares', 'replying is public - and shares this post with your own followers')}
        </p>`}
        ${draftId
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
              </button>`}
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

/// The visible tree below one post: this node's replies memo, one level per fetch, the
/// UI recursing with a depth cap (PROJECT_PLAN's Replies slice 2 - "replies known here", honest and
/// partial by ruling; slice 6's author door widens the well, not this shape). The feed
/// never assembles a tree - this page is the only place one forms.
const THREAD_DEPTH_CAP = 6;

const Thread = ({ author, doc, current, depth, extra, refreshKey }) => {
    const [page, setPage] = useState(null);
    useEffect(() => {
        let live = true;
        // refreshKey > 0 is the human's deliberate re-ask: it rides `refresh=1` past the
        // node's cooldown so the door actually gets dialed again.
        const force = depth === 0 && refreshKey > 0 ? '?refresh=1' : '';
        const look = () =>
            api(`/api/id/${author}/posts/${doc}/replies${force}`)
                .then((p) => {
                    if (!live) return;
                    setPage(p);
                    // "Looking for more of the conversation": the node said it is asking
                    // the author's door behind this render (slice 6's SWR) - look once
                    // more after the ask has had a moment, then rest until refreshed.
                    if (depth === 0 && p.seeking) {
                        setTimeout(() => {
                            if (!live) return;
                            api(`/api/id/${author}/posts/${doc}/replies`)
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
    }, [author, doc, depth, refreshKey]);
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
            ? html`${seekingLine ||
              html`<p class="thread-empty">
                  ${t('postpage.none-known-yet', 'none known here yet')}
              </p>`}`
            : null;
    }
    return html`<div class="thread-level">
        ${seekingLine}
        ${replies.map(
            (r) => html`<${ThreadReply}
                key=${`${r.author}:${r.doc_id}`}
                author=${r.author}
                doc=${r.doc_id}
                current=${current}
                depth=${depth}
            />`
        )}
    </div>`;
};

const ThreadReply = ({ author, doc, current, depth }) => {
    // undefined = loading, null = not readable here (the memo knew it, the shelf moved -
    // a takedown between fold and render), object = the reply's header.
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
        author,
        doc_id: post.doc_id,
        title: post.title,
        format: post.format,
        published_ms: post.published_ms,
        replies: post.replies,
        annotations: post.annotations,
        mine: !!(current && current.root === author),
    };
    return html`<div class="thread-reply">
        <${PostEntry} key=${post.doc_id} item=${item} current=${current} editing=${null} quote=${false} />
        ${depth + 1 < THREAD_DEPTH_CAP &&
        html`<${Thread} author=${author} doc=${doc} current=${current} depth=${depth + 1} />`}
        ${depth + 1 >= THREAD_DEPTH_CAP &&
        html`<p class="thread-deeper">
            <a href=${`/id/${speakable(author)}/post/${doc}`}>
                ${t('postpage.continue-this-thread', 'continue this thread')}
            </a>
        </p>`}
    </div>`;
};
