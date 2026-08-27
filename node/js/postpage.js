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
import { parseSpeakable } from './speakable.js';
import { PostEntry } from './postentry.js';
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
            ${item && html`<${PostEntry} key=${item.doc_id} item=${item} current=${current} editing=${null} />`}
            ${item &&
            html`<section class="thread">
                <h2 class="thread-head">
                    ${t('postpage.replies-known-here', 'replies known here')}
                </h2>
                <${Thread} author=${root} doc=${doc} current=${current} depth=${0} />
            </section>`}
        </div>
    `;
};

/// The visible tree below one post: this node's replies memo, one level per fetch, the
/// UI recursing with a depth cap (COMMENTS.md slice 2 - "replies known here", honest and
/// partial by ruling; slice 6's author door widens the well, not this shape). The feed
/// never assembles a tree - this page is the only place one forms.
const THREAD_DEPTH_CAP = 6;

const Thread = ({ author, doc, current, depth }) => {
    const [page, setPage] = useState(null);
    useEffect(() => {
        let live = true;
        api(`/api/id/${author}/posts/${doc}/replies`)
            .then((p) => live && setPage(p))
            .catch(() => live && setPage({ replies: [] }));
        return () => {
            live = false;
        };
    }, [author, doc]);
    const replies = (page && page.replies) || [];
    if (!replies.length) {
        return depth === 0 && page
            ? html`<p class="thread-empty">
                  ${t('postpage.none-known-yet', 'none known here yet')}
              </p>`
            : null;
    }
    return html`<div class="thread-level">
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
    if (post === undefined || post === null) return null;
    const item = {
        author,
        doc_id: post.doc_id,
        title: post.title,
        format: post.format,
        published_ms: post.published_ms,
        mine: !!(current && current.root === author),
    };
    return html`<div class="thread-reply">
        <${PostEntry} key=${post.doc_id} item=${item} current=${current} editing=${null} />
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
