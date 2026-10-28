// Horse's RSS (plans/RSS.md): the feeds this persona follows, and what they say. Following is a
// fact of the persona's private chain - one register per feed, kept by the node's doors
// (feedreader.rs) - and the items are the node's cache of each feed, fetched once however many
// people here follow it. How far each feed has been read is one watermark per feed (Curtis,
// 2026-10-27), the `rss_seen` register, written here as the rooms' `rooms_seen` is.
//
// The items are posts (plans/RSS.md, _Feed items are posts_): the right side is the feed's own
// stream (apps/feed.js `FeedStream`) over the node's `rss/feed` door - every followed feed's
// items, or one feed's - with the feed's filters, and each item is a post's card wearing its feed.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import htm from 'htm';

import { api, whileVisible } from '../net.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { PaneHead, Rail, TagColumn, useColTucks, useColWidths } from '../panes.js';
import { TagField } from '../doc/annotations.js';
import { agoUnit, agoWords } from '../pure/ago.js';
import { FeedStream } from '../feedstream.js';

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
                <span class="rss-feed-name">${t('apps.rss.all-feeds', 'all feeds')}</span>
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

export const RssApp = ({ current }) => {
    const root = current && current.root;
    const loc = useLocation();
    const [page, setPage] = useState(null); // { feeds, max } - null until the first load
    // A feed's id, or null for every feed: the address says (`?feed=`), so a feed's name on a
    // card anywhere opens it here.
    const selected = new URLSearchParams(loc.url.split('?')[1] || '').get('feed') || null;
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
    const feed = selected && (feeds || []).find((f) => f.id === selected);
    // Opening a feed reads it to its newest item.
    useEffect(() => {
        if (!root || !feed || feed.newest_ms <= (feed.seen_ms || 0)) return;
        api(`/api/identity/${root}/private/kv/${SEEN}/${feed.id}`, {
            method: 'PUT',
            body: JSON.stringify({ value: String(feed.newest_ms) }),
        })
            .then(loadFeeds)
            .catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, feed && feed.id, feed && feed.newest_ms]);
    if (!root) return null;
    const cloud = feedTagCounts(feeds);
    const shownFeeds =
        feeds && tagFilter.length > 0
            ? feeds.filter((f) => tagFilter.every((tag) => (f.tags || []).includes(tag)))
            : feeds;
    const select = (id) => {
        loc.route(id ? `/ringtome/rss?feed=${id}` : '/ringtome/rss');
        settle();
    };
    const door = selected
        ? `/api/identity/${root}/rss/${selected}/feed`
        : `/api/identity/${root}/rss/feed`;
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
                    page &&
                    html`<${FeedStream}
                        key=${door}
                        root=${root}
                        current=${current}
                        contacts=${[]}
                        feedUrl=${door}
                        labelsUrl=${`${door}/labels`}
                        dial=${false}
                        picksKey=${`rss:${root}`}
                        nullState=${html`<p class="rss-empty">${
                            feeds && feeds.length === 0
                                ? t(
                                      'apps.rss.nothing-followed',
                                      'follow a feed, and what it says shows up here',
                                  )
                                : t('apps.rss.no-items', 'nothing here yet')
                        }</p>`}
                    />`
                }
            </section>
        </div>
    </div>`;
};
