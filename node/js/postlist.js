// A list of posts as every post surface draws it (2026-10-18): the feed, a person's page, a public
// group's feed and a group's private posts. One place says "searching…" while the header's search
// is asked, the surface's own words when it finds nothing, and what an empty listing says; it
// draws the cards with the words they were found by marked (postentry.js `found`), and reads
// further back - the listing's next page, or the search's. The pinned strip above, and any lines
// of the surface's own, stay the surface's.
import { h } from 'preact';
import htm from 'htm';

import { t } from './i18n.js';
import { postCursor } from './pure/feed.js';

const html = htm.bind(h);

/// `items`: the cards' items in order - the search's results while it is active. `card(item,
/// found)`: one card, `found` the search's words or null. `search`: postsearch.js `useSearch`'s
/// answer, and `query` its words. `nothingFound`: the words for a search that found nothing;
/// `empty`: what the listing says with nothing in it. `more`/`loading`/`onMore`: the listing's
/// paging; a search pages by its own `more`, by the shelf's cursor. `children` follow the cards.
export const PostList = ({
    items,
    card,
    search = null,
    query = '',
    nothingFound = null,
    empty = null,
    more = false,
    loading = false,
    onMore = null,
    error = null,
    children = null,
}) => {
    const active = !!(search && search.active);
    const loadMoreFound = () => {
        const cursor = postCursor(search.results);
        if (cursor) search.loadMore(`after_ms=${cursor.after_ms}&after_doc=${cursor.after_doc}`);
    };
    const paging = active ? !!search.more : !!(more && onMore);
    const busy = active ? search.loading : loading;
    return html`
        ${
            active &&
            search.searching &&
            html`<p class="null-sub"><span class="waiting-dot"></span> ${t('posts.searching', 'searching…')}</p>`
        }
        ${
            active &&
            !search.searching &&
            items.length === 0 &&
            html`<p class="null-sub">${search.error || nothingFound || t('facets.none-match', 'nothing matches')}</p>`
        }
        ${!active && items.length === 0 && empty}
        ${items.map((item) => card(item, active ? query : null))}
        ${children}
        ${error && html`<p class="form-error">${error}</p>`}
        ${
            paging &&
            html`<button
                class="public-posts-more"
                disabled=${busy}
                onClick=${active ? loadMoreFound : onMore}
            >
                ${busy ? t('posts.reading-further-back', 'reading further back…') : t('posts.load-more', 'load more')}
            </button>`
        }
    `;
};
