// hrseRSS™ (plans/RSS.md, slice 1): the feeds this persona follows, and what they say. Following
// is a fact of the persona's private chain - one register per feed, kept by the node's doors
// (feedreader.rs) - and the items are the node's cache of each feed, fetched once however many
// people here follow it. How far each feed has been read is one watermark per feed (Curtis,
// 2026-10-27), the `rss_seen` register, written here as the rooms' `rooms_seen` is.
//
// Slice 1 is the bare list: an item's title links to where it was published. The reading pane,
// with the item's words translated into Marquee and its pictures made by the node, is slice 3.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api, whileVisible } from '../net.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { PaneHead, Rail, TagColumn, useColTucks, useColWidths } from '../panes.js';
import { TagField } from '../doc/annotations.js';
import { agoUnit, agoWords } from '../pure/ago.js';

const html = htm.bind(h);

const APP_ID = 'rss';
/// The register collection of how far each feed has been read (feedreader.rs `SEEN`).
const SEEN = 'rss_seen';

const whenWords = (ms) => {
    const ago = agoUnit(ms, Date.now());
    return ago ? agoWords(ago.value, ago.unit) : t('apps.rss.just-now', 'just now');
};

/// The tags the followed feeds wear, most-used first, as the tag column draws them.
const feedTagCounts = (feeds) => {
    const counts = new Map();
    for (const f of feeds || [])
        for (const tag of f.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

/// The feeds column: following a new one at the top, then everything together, then each feed
/// with how many items it has that this persona hasn't seen.
const FeedsColumn = ({ root, feeds, max, selected, onSelect, onFollowed, onTuck, filtered }) => {
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const follow = async (e) => {
        e.preventDefault();
        if (!url.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
            const page = await api(`/api/identity/${root}/rss`, {
                method: 'POST',
                body: JSON.stringify({ url: url.trim() }),
            });
            setUrl('');
            onFollowed(page);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };
    const unread = (feeds || []).reduce((n, f) => n + (f.unread || 0), 0);
    const row = (f) => html`<li
        key=${f.id}
        class=${[
            'rss-feed-row',
            selected === f.id && 'rss-feed-row-selected',
            f.unread > 0 && 'rss-feed-row-unread',
        ]
            .filter(Boolean)
            .join(' ')}
        data-settles
        onClick=${() => onSelect(f.id)}
    >
        <span class="rss-feed-name" title=${f.url}>
            ${(f.error || f.quiet) && html`<${Icons.warn} />`} ${f.title || f.url}
        </span>
        ${f.unread > 0 && html`<span class="rss-feed-count">${f.unread}</span>`}
    </li>`;
    return html`<aside class="rss-feeds">
        <${PaneHead} icon=${Icons.rss} label=${t('apps.rss.feeds', 'feeds')} onTuck=${onTuck} />
        <form class="rss-follow" onSubmit=${follow}>
            <input
                class="rss-follow-input"
                type="url"
                inputmode="url"
                placeholder=${t('apps.rss.follow-placeholder', "a feed's address, or its site's")}
                value=${url}
                disabled=${busy}
                onInput=${(e) => setUrl(e.currentTarget.value)}
            />
            <button class="rss-follow-btn" type="submit" disabled=${busy || !url.trim() || (feeds || []).length >= max}>
                ${busy ? t('apps.rss.fetching', 'fetching…') : t('apps.rss.follow', '+ follow')}
            </button>
        </form>
        ${error && html`<p class="form-error">${error}</p>`}
        <ul class="rss-feed-list">
            <li
                class=${[
                    'rss-feed-row',
                    'rss-feed-row-all',
                    selected === null && 'rss-feed-row-selected',
                    unread > 0 && 'rss-feed-row-unread',
                ]
                    .filter(Boolean)
                    .join(' ')}
                data-settles
                onClick=${() => onSelect(null)}
            >
                <span class="rss-feed-name">${filtered ? t('apps.rss.all-tagged', 'all of these') : t('apps.rss.all-feeds', 'all feeds')}</span>
                ${unread > 0 && html`<span class="rss-feed-count">${unread}</span>`}
            </li>
            ${(feeds || []).map(row)}
        </ul>
        ${
            feeds &&
            feeds.length === 0 &&
            html`<p class="rss-empty">${
                filtered
                    ? t('apps.rss.no-feeds-wear-those-tags', 'no feeds wear those tags')
                    : t('apps.rss.no-feeds-yet', 'no feeds yet - paste a feed or a blog above')
            }</p>`
        }
    </aside>`;
};

/// One followed feed's own header over its items: its name (to its site), its tags, asking it
/// again now, and letting it go.
const FeedHead = ({ root, feed, onPage }) => {
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const act = async (path, init) => {
        setBusy(true);
        setError(null);
        try {
            onPage(await api(`/api/identity/${root}/rss/${feed.id}${path}`, init));
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };
    const retag = (tags) => act('', { method: 'PUT', body: JSON.stringify({ tags }) });
    return html`<header class="rss-head">
        <div class="rss-head-row">
            <h2 class="rss-head-title">
                ${feed.site ? html`<a href=${feed.site} target="_blank" rel="noopener noreferrer">${feed.title || feed.url}</a>` : feed.title || feed.url}
            </h2>
            <button
                class="rss-head-btn jag-line"
                type="button"
                disabled=${busy}
                title=${t('apps.rss.unfollow-title', 'stop following this feed')}
                onClick=${() => act('', { method: 'DELETE' })}
            >
                <${Icons.trash} /> ${t('apps.rss.unfollow', 'unfollow')}
            </button>
            <button
                class="rss-head-btn jag-line"
                type="button"
                disabled=${busy}
                title=${t('apps.rss.refresh-title', 'ask the feed for anything new, now')}
                onClick=${() => act('/refresh', { method: 'POST' })}
            >
                <${Icons.syncNow} /> ${t('apps.rss.refresh', 'refresh')}
            </button>
        </div>
        <${TagField}
            tags=${feed.tags || []}
            editable=${!busy}
            draft=${draft}
            onDraft=${setDraft}
            onAdd=${(tag) => {
                setDraft('');
                if (tag.trim()) retag([...(feed.tags || []), tag]);
            }}
            onRemove=${(tag) => retag((feed.tags || []).filter((x) => x !== tag))}
        />
        <p class="rss-head-status">
            ${
                feed.fetched_ms
                    ? t('apps.rss.fetched', 'fetched {when}', { when: whenWords(feed.fetched_ms) })
                    : t('apps.rss.not-fetched', 'not fetched yet')
            }
            ${feed.quiet && html` · ${t('apps.rss.quiet', 'quiet: it has failed for a month, so it is asked weekly')}`}
        </p>
        ${feed.error && html`<p class="form-error">${feed.error}</p>`}
        ${error && html`<p class="form-error">${error}</p>`}
    </header>`;
};

/// One item: its title, out to where it was published; its feed, date and author; its summary.
/// Marked while it is newer than how far its feed had been read when the list was opened.
const ItemRow = ({
    item,
    feed,
    showFeed,
    seen,
}) => html`<article class=${item.dated_ms > seen ? 'rss-item rss-item-new' : 'rss-item'}>
    <a class="rss-item-title" href=${item.link} target="_blank" rel="noopener noreferrer">
        ${item.title || t('apps.rss.untitled', '(untitled)')}
    </a>
    <p class="rss-item-meta">
        ${showFeed && feed && html`<span class="rss-item-feed">${feed.title || feed.url}</span>`}
        <span title=${new Date(item.dated_ms).toLocaleString()}>${whenWords(item.dated_ms)}</span>
        ${item.author && html`<span>${item.author}</span>`}
    </p>
    ${item.summary && html`<p class="rss-item-summary">${item.summary}</p>`}
</article>`;

export const RssApp = ({ current }) => {
    const root = current && current.root;
    const [page, setPage] = useState(null); // { feeds, max } - null until the first load
    const [selected, setSelected] = useState(null); // a feed's id, or null for every feed
    const [items, setItems] = useState(null);
    const [more, setMore] = useState(false);
    // How far each feed had been read when its items were shown: what's newer is marked, even
    // after the watermark moves past it.
    const [seenAt, setSeenAt] = useState({});
    const [tagFilter, setTagFilter] = useState([]);
    // In a narrow window the feeds are the tab it opens on until a feed is chosen, as chat's rooms are.
    const { tucked, toggleTuck, settle, tab } = useColTucks(root, APP_ID, ['tags'], {
        lead: selected ? null : 'feeds',
    });
    const { resizer, colStyle } = useColWidths(root, APP_ID, ['feeds', 'tags'], {
        feeds: 180,
        tags: 150,
    });
    const loadFeeds = () => {
        if (!root) return;
        api(`/api/identity/${root}/rss`)
            .then(setPage)
            .catch(() => {});
    };
    useEffect(loadFeeds, [root]);
    useEffect(() => {
        const interval = setInterval(whileVisible(loadFeeds), 5 * 60_000);
        window.addEventListener('focus', loadFeeds);
        return () => {
            clearInterval(interval);
            window.removeEventListener('focus', loadFeeds);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root]);
    const feeds = page && page.feeds;
    const feedById = new Map((feeds || []).map((f) => [f.id, f]));
    const itemsUrl = (before) => {
        const q = new URLSearchParams();
        if (selected) q.set('feed', selected);
        if (before) q.set('before', String(before));
        const s = q.toString();
        return `/api/identity/${root}/rss/items${s ? `?${s}` : ''}`;
    };
    // A feed's items, or everyone's; and opening a feed reads it to its newest item.
    useEffect(() => {
        if (!root || !page) return;
        let live = true;
        api(itemsUrl())
            .then((got) => {
                if (!live) return;
                setItems(got.items);
                setMore(got.more);
                setSeenAt(
                    Object.fromEntries((page.feeds || []).map((f) => [f.id, f.seen_ms || 0])),
                );
                const feed = selected && feedById.get(selected);
                const newest = got.items.length > 0 ? got.items[0].dated_ms : 0;
                if (feed && newest > (feed.seen_ms || 0)) {
                    api(`/api/identity/${root}/private/kv/${SEEN}/${selected}`, {
                        method: 'PUT',
                        body: JSON.stringify({ value: String(newest) }),
                    })
                        .then(loadFeeds)
                        .catch(() => {});
                }
            })
            .catch(() => live && setItems([]));
        return () => {
            live = false;
        };
        // `page` is read for the watermarks, but a new page (a count moving) is no reason to
        // fetch the items again; following or letting go of a feed changes `feeds.length`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, selected, !!page, feeds && feeds.length]);
    if (!root) return null;
    const cloud = feedTagCounts(feeds);
    const shownFeeds =
        feeds && tagFilter.length > 0
            ? feeds.filter((f) => tagFilter.every((tag) => (f.tags || []).includes(tag)))
            : feeds;
    const shownIds = new Set((shownFeeds || []).map((f) => f.id));
    const shownItems = (items || []).filter(
        (i) => selected || tagFilter.length === 0 || shownIds.has(i.feed),
    );
    const feed = selected && feedById.get(selected);
    const loadMore = () => {
        const last = items && items[items.length - 1];
        if (!last) return;
        api(itemsUrl(last.dated_ms))
            .then((got) => {
                setItems([...items, ...got.items]);
                setMore(got.more);
            })
            .catch(() => {});
    };
    const select = (id) => {
        setSelected(id);
        setItems(null);
        settle();
    };
    return html`<div class="rss">
        <div class="rss-columns panes" style=${colStyle}>
            ${
                tucked.has('tags')
                    ? html`<${Rail} icon=${Icons.tag} label=${t('apps.rss.tags', 'tags')} onClick=${() => toggleTuck('tags')} />`
                    : html`${tab('tags', Icons.tag, t('apps.rss.tags', 'tags'))}<${TagColumn}
                          cloud=${cloud}
                          active=${tagFilter}
                          label=${t('apps.rss.tags', 'tags')}
                          onToggleTag=${(tag) => setTagFilter((have) => (have.includes(tag) ? have.filter((x) => x !== tag) : [...have, tag]))}
                          onTuck=${() => toggleTuck('tags')}
                      />${resizer('tags')}`
            }
            ${
                tucked.has('feeds')
                    ? html`<${Rail} icon=${Icons.rss} label=${t('apps.rss.feeds', 'feeds')} onClick=${() => toggleTuck('feeds')} />`
                    : html`${tab('feeds', Icons.rss, t('apps.rss.feeds', 'feeds'))}<${FeedsColumn}
                          root=${root}
                          feeds=${shownFeeds}
                          max=${(page && page.max) || 0}
                          selected=${selected}
                          filtered=${tagFilter.length > 0}
                          onSelect=${select}
                          onFollowed=${(next) => {
                              setPage(next);
                              select(next.followed || null);
                          }}
                          onTuck=${() => toggleTuck('feeds')}
                      />${resizer('feeds')}`
            }
            <section class="rss-main">
                ${
                    feed &&
                    html`<${FeedHead}
                        key=${feed.id}
                        root=${root}
                        feed=${feed}
                        onPage=${(next) => {
                            setPage(next);
                            if (!next.feeds.some((f) => f.id === selected)) select(null);
                        }}
                    />`
                }
                ${
                    items === null
                        ? html`<p class="rss-empty">${t('apps.rss.loading', 'loading…')}</p>`
                        : shownItems.length === 0
                          ? html`<p class="rss-empty">${
                                feeds && feeds.length === 0
                                    ? t(
                                          'apps.rss.nothing-followed',
                                          'follow a feed, and what it says shows up here',
                                      )
                                    : t('apps.rss.no-items', 'nothing here yet')
                            }</p>`
                          : html`<div class="rss-items">
                                ${shownItems.map(
                                    (i) => html`<${ItemRow}
                                        key=${`${i.feed}/${i.id}`}
                                        item=${i}
                                        feed=${feedById.get(i.feed)}
                                        showFeed=${!selected}
                                        seen=${seenAt[i.feed] || 0}
                                    />`,
                                )}
                                ${more && html`<button class="rss-more" type="button" onClick=${loadMore}>${t('apps.rss.more', 'older')}</button>`}
                            </div>`
                }
            </section>
        </div>
    </div>`;
};
