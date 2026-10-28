/**
 * A followed feed where a post's card wears its author (plans/RSS.md, _Feed items are posts_): a
 * circle with the feed's logo - or its initial, when this node found none - then the feed's name,
 * which opens it in Horse's RSS, and its website's address, which opens the website.
 *
 * `feed`: the card's `item.feed` (feedreader.rs `FeedCard`): { id, url, site, logo, link, byline }.
 */
import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

/// A web address as a reader says it: the host, without the `www.`.
export const siteWords = (url) => {
    try {
        return new URL(url).host.replace(/^www\./, '');
    } catch {
        return url || '';
    }
};

export const FeedBanner = ({ feed, name, current, actions }) => {
    const site = feed.site || feed.url;
    const title = name || siteWords(site);
    const logo =
        feed.logo && current && current.root
            ? `/api/identity/${current.root}/rss/${feed.id}/logo`
            : null;
    return html`
        <div class="person-banner feed-banner">
            <a class="person-banner-face feed-banner-face" href=${`/ringtome/rss?feed=${feed.id}`} aria-label=${title}>
                ${
                    logo
                        ? html`<img class="feed-banner-logo" src=${logo} alt="" loading="lazy" />`
                        : html`<span class="feed-banner-initial">${[...title][0] || '?'}</span>`
                }
            </a>
            <span class="person-names">
                <a class="person-name-primary feed-banner-name" href=${`/ringtome/rss?feed=${feed.id}`}>${title}</a>
                <a class="person-name-others feed-banner-site" href=${site} target="_blank" rel="noopener noreferrer">${
                    feed.byline ? `${feed.byline} · ${siteWords(site)}` : siteWords(site)
                }</a>
            </span>
            ${actions && html`<span class="person-banner-actions">${actions}</span>`}
        </div>
    `;
};
