// Someone's public posts, on their page - the SAME card the feed renders (postentry.js).
//
// One component for "a post, shown" everywhere a post is shown (Curtis's ruling, 2026-08-06):
// the banner rides on every entry even on the persona's own page (redundant, and accepted),
// and when the page is YOURS the unlock-and-edit ceremony works right here, exactly as it
// does in the feed. This file is just the persona page's data adapter: the profile's post
// list and its keyset paging, mapped into the entry's item shape.
//
// Bodies still arrive by the same anonymous path a stranger reads, and there is still no
// mirror table for another person's documents (Other People Live in Their Own Database).
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { recentPosts, mergePosts, postCursor } from './pure/feed.js';
import { PostEntry, useOwnPostEditing } from './postentry.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// The stream on a person's page: what they have said in public, newest first, and as far
/// back as the reader cares to go. The profile brought the first page; each further one is
/// asked for by hand, because reading someone's whole history is a decision, not a default.
export const PublicPosts = ({ root, posts, more, current }) => {
    const [extra, setExtra] = useState([]);
    const [hasMore, setHasMore] = useState(!!more);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const mine = !!(current && current.root === root);
    const editingFor = useOwnPostEditing(current);

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

    // The profile's post rows, dressed as the shared entry's item shape.
    const items = list.map((p) => ({
        author: root,
        doc_id: p.doc_id,
        title: p.title,
        format: p.format,
        published_ms: p.published_ms,
        replies: p.replies,
        annotations: p.annotations,
        mine,
    }));

    return html`
        <section class="public-posts">
            <h2 class="public-posts-head">${t('posts.recent-posts', 'recent posts')}</h2>
            ${items.map(
                (item) => html`<${PostEntry}
                    key=${item.doc_id}
                    item=${item}
                    current=${current}
                    editing=${mine ? editingFor(item.doc_id) : null}
                />`
            )}
            ${error && html`<p class="form-error">${error}</p>`}
            ${hasMore &&
            html`<button class="public-posts-more" disabled=${loading} onClick=${loadMore}>
                ${loading ? t('posts.reading-further-back', 'reading further back…') : t('posts.load-more', 'load more')}
            </button>`}
        </section>
    `;
};
