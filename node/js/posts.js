// Someone's public posts, read the way they were written.
//
// This is the first surface in the console that renders somebody ELSE'S words. Everything up
// to now rendered documents out of your own mirror; these come from the public lane, by the
// same anonymous path a stranger would use (`/id/<root>/docs/<id>/body`), which is the point -
// a member reading a foreign persona's post and a stranger reading it are fetching the same
// bytes, and only the chrome around them differs. It works for a persona this node has never
// carried, because the profile fetch that named these posts also brought their bodies home.
//
// One body fetch per post and no mirror involved, deliberately: another person's public
// documents are not ours to keep in a local table (PROJECT_PLAN, Other People Live in Their
// Own Database). Pages of twenty are what keep that arithmetic honest - a visit fetches the
// twenty it shows, and reading further back is something the reader asks for.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { api, apiText } from './net.js';
import { recentPosts, mergePosts, postCursor } from './pure/feed.js';
import { MarqueeBody, bareSource } from './doc/marqueebody.js';
import { useTurbolinks } from './doc/turbolinks.js';

const html = htm.bind(h);

const PublicPost = ({ root, post }) => {
    // undefined: still fetching. null: the words didn't come - a header can outrun its body
    // across the network, so this is a normal state, not an error.
    const [body, setBody] = useState(undefined);
    useEffect(() => {
        let live = true;
        setBody(undefined);
        apiText(`/id/${root}/docs/${post.doc_id}/body`)
            .then((t) => live && setBody(t))
            .catch(() => live && setBody(null));
        return () => {
            live = false;
        };
    }, [root, post.doc_id]);
    const tlProfile = useTurbolinks(body || '', post.format);

    const when = post.published_ms
        ? new Date(post.published_ms).toLocaleString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
          })
        : '';
    return html`
        <article class="public-post">
            <header class="public-post-head">
                <span class="public-post-when">${when}</span>
                <a class="public-post-link" href=${`/id/${root}/docs/${post.doc_id}/body`}>
                    the public copy
                </a>
            </header>
            ${/* No title, no heading - the app doesn't get to name someone else's post. */ ''}
            ${!!post.title && html`<h3 class="public-post-title">${post.title}</h3>`}
            ${body === undefined && html`<p class="null-sub">…</p>`}
            ${body === null &&
            html`<p class="null-sub">
                <span class="waiting-dot"></span> these words haven't reached this computer.
            </p>`}
            ${!!body &&
            html`<div class="public-post-body">
                ${post.format === 'marquee'
                    ? html`<${MarqueeBody}
                          source=${body}
                          profile=${tlProfile}
                          onUnparsable=${bareSource}
                      />`
                    : html`<pre class="reader-plain">${body}</pre>`}
            </div>`}
        </article>
    `;
};

/// The stream on a person's page: what they have said in public, newest first, and as far
/// back as the reader cares to go. The profile brought the first page; each further one is
/// asked for by hand, because reading someone's whole history is a decision, not a default.
export const PublicPosts = ({ root, posts, more }) => {
    const [extra, setExtra] = useState([]);
    const [hasMore, setHasMore] = useState(!!more);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    // A different persona is a different shelf: drop what the last one's pages left behind.
    useEffect(() => {
        setExtra([]);
        setHasMore(!!more);
        setError(null);
    }, [root, more]);

    const list = mergePosts(recentPosts(posts), extra);

    const loadMore = async () => {
        setLoading(true);
        setError(null);
        try {
            const cursor = postCursor(list);
            const page = await api(
                `/api/id/${root}/posts?after_ms=${cursor.after_ms}&after_doc=${cursor.after_doc}`
            );
            setExtra((e) => mergePosts(e, page.posts));
            // Trust the server's own answer about whether the shelf goes further, rather than
            // inferring it from a short page - a page can be short for other reasons.
            setHasMore(!!page.more);
        } catch (e) {
            setError(e.message);
        }
        setLoading(false);
    };

    if (!list.length) return null; // nothing said in public yet - say nothing about it
    return html`
        <section class="public-posts">
            <h2 class="public-posts-head">recent posts</h2>
            ${list.map((p) => html`<${PublicPost} key=${p.doc_id} root=${root} post=${p} />`)}
            ${error && html`<p class="form-error">${error}</p>`}
            ${hasMore &&
            html`<button class="public-posts-more" disabled=${loading} onClick=${loadMore}>
                ${loading ? 'reading further back…' : 'load more'}
            </button>`}
        </section>
    `;
};
