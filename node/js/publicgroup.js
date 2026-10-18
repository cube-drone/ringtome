// A public group's open page (plans/PUBLIC_GROUPS.md, ruling 6): its face, its members and its
// public posts as a feed, to anyone - at the group's address in People, signed out or signed in
// and not in it, with a follow button (ruling 7). A member sees its public feed on their own page
// of it too (`GroupFeed`). A private group has no open page: the node says there's no such group.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { GroupHeroMark, GroupTabHead } from './groupface.js';
import { PostEntry } from './postentry.js';
import { PersonChip, bannerStyle } from './person.js';
import { groupHref, publicComposeHref } from './links.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';
import { mergePosts, postCursor } from './pure/feed.js';
import { shelfItem } from './pure/shelf.js';
import { useSearch, narrowParams } from './postsearch.js';
import { LabelFacets, useLabels, usePicks } from './facets.js';
import { PostList } from './postlist.js';

const html = htm.bind(h);

/// The group's open answer, re-read when `turn` moves.
const usePublicGroup = (group, turn = 0) => {
    const [page, setPage] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        if (!group) return undefined;
        let live = true;
        api(`/api/groups/${group}/public`)
            .then((p) => live && setPage(p))
            .catch((e) => live && setError(e));
        return () => {
            live = false;
        };
    }, [group, turn]);
    return [page, error];
};

/// The group's public posts as a feed (Curtis, 2026-10-17: "a full-feed view with filters and
/// such"): the feed's cards, newest first, a page at a time, with the filter strip over them and
/// the header's search - each post its author's own, wearing the group's public band.
export const GroupFeed = ({
    group,
    name,
    current,
    searchQuery = '',
    member = false,
    owner = false,
}) => {
    const viewer = current ? `?as=${current.root}` : '';
    const base = `/api/groups/${group}/posts${viewer}`;
    const [list, setList] = useState(null);
    const [pinned, setPinned] = useState([]);
    const [more, setMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        let live = true;
        setList(null);
        api(base)
            .then((page) => {
                if (!live) return;
                setList(page.posts || []);
                setPinned(page.pinned || []);
                setMore(!!page.more);
            })
            .catch((e) => live && setError(e.message));
        return () => {
            live = false;
        };
    }, [base]);
    const [picks, setPicks] = usePicks(`group-public:${group}`, !current, { inUrl: true });
    const pickQuery = narrowParams('', picks);
    const labels = useLabels(
        `/api/groups/${group}/labels${viewer}${pickQuery ? `${viewer ? '&' : '?'}${pickQuery}` : ''}`,
        (list || []).length,
    );
    const search = useSearch(base, searchQuery, picks);
    const page = async (rows, set, setMoreOf) => {
        const cursor = postCursor(rows);
        if (!cursor) return;
        setLoading(true);
        try {
            const next = await api(
                `${base}${viewer ? '&' : '?'}after_ms=${cursor.after_ms}&after_doc=${cursor.after_doc}`,
            );
            set((seen) => mergePosts(seen, next.posts));
            setMoreOf(!!next.more);
        } catch (e) {
            setError(e.message);
        }
        setLoading(false);
    };
    const asItem = (p) => ({
        ...shelfItem(p, {
            root: p.author,
            authorName: p.author_name,
            authorAvatar: p.author_avatar,
            mine: !!current && current.root === p.author,
        }),
        as_group: { id: group, name },
        // A member pins it to the top of the group's public feed (Curtis, 2026-10-18), as on the
        // private tab: the card's pin chip, on this group.
        pin_group: member ? { id: group, owner, pinned: p.pinned || null } : null,
    });
    // Pinned above the feed, on its first page; the rows below leave out what's pinned.
    const pinnedKeys = new Set(pinned.map((p) => `${p.author}:${p.doc_id}`));
    const pinnedShown = search.active ? [] : pinned.map(asItem);
    const shown = (search.active ? search.results || [] : list || [])
        .filter((p) => search.active || !pinnedKeys.has(`${p.author}:${p.doc_id}`))
        .map(asItem);
    const card = (item, found = null) => html`<${PostEntry}
        key=${`${item.author}:${item.doc_id}`}
        item=${item}
        current=${current}
        found=${found}
        editing=${null}
    />`;
    return html`<section class="group-posts">
        ${
            /* A member's way to say something here, as the private tab's (2026-10-17): the feed's
            composer, on "in public, as" this group. */ ''
        }
        <${GroupTabHead}
            title=${search.active ? t('posts.matching-posts', 'matching posts') : t('publicgroup.public-posts', 'public posts')}
            action=${
                member &&
                html`<a class="group-new-post jag-line" href=${publicComposeHref(group)}>
                    <${Icons.plus} /> ${t('apps.groups.new-post', 'new post')}
                </a>`
            }
        />
        <${LabelFacets} labels=${labels} picks=${picks} onPicks=${setPicks} free=${!current} />
        ${!list && !error && html`<p class="null-sub">${t('publicgroup.fetching-posts', 'fetching its posts…')}</p>`}
        ${
            pinnedShown.length > 0 &&
            html`<div class="group-pinned">
                <div class="people-shelf-head">
                    <span class="people-shelf-title"><${Icons.pin} /> ${t('apps.groups.pinned', 'pinned')}</span>
                </div>
                ${pinnedShown.map((item) => card(item))}
            </div>`
        }
        <${PostList}
            items=${shown}
            card=${card}
            search=${search}
            query=${searchQuery}
            nothingFound=${t('publicgroup.nothing-matches', 'nothing posted as the group says that.')}
            empty=${
                list &&
                pinnedShown.length === 0 &&
                html`<p class="null-sub">${t('publicgroup.no-public-posts-yet', 'nothing posted in public as the group yet.')}</p>`
            }
            more=${more}
            loading=${loading}
            onMore=${() => page(list, setList, setMore)}
            error=${error}
        />
    </section>`;
};

/// Follow the group itself, or stop, for someone signed in (ruling 7): its public posts come to
/// their feed direct. The follow says where the page came from, for a node that holds none of it.
const FollowGroup = ({ group, page, current }) => {
    const root = current && current.root;
    const [following, setFollowing] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        api(`/api/identity/${root}/groups/${group}/follow`)
            .then((r) => live && setFollowing(!!r.following))
            .catch(() => live && setFollowing(false));
        return () => {
            live = false;
        };
    }, [root, group]);
    if (!root || following === null) return null;
    const toggle = async () => {
        setBusy(true);
        setError(null);
        try {
            const r = await api(`/api/identity/${root}/groups/${group}/follow`, {
                method: following ? 'DELETE' : 'POST',
                body: following
                    ? undefined
                    : JSON.stringify({
                          via: page.endpoint ? [page.endpoint] : [],
                          members: [page.founder, ...page.members.map((m) => m.root)],
                      }),
            });
            setFollowing(!!r.following);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    return html`<div class="public-group-follow">
        <button class="group-join jag-line" disabled=${busy} onClick=${toggle}>
            ${
                following
                    ? t('publicgroup.unfollow', 'stop following')
                    : html`<${Icons.plus} /> ${t('publicgroup.follow', 'follow the group')}`
            }
        </button>
        <p class="null-sub">
            ${
                following
                    ? t(
                          'publicgroup.following-explained',
                          "Its members' public posts as the group come to your feed.",
                      )
                    : t(
                          'publicgroup.follow-explained',
                          "Follow it to get its members' public posts as the group in your feed, without following each of them.",
                      )
            }
        </p>
        ${error && html`<p class="groups-error">${error}</p>`}
    </div>`;
};

export const PublicGroupPage = ({ group, current, onTitle, searchQuery = '' }) => {
    const [page, error] = usePublicGroup(group);
    // The page's title, where the frame shows one (signed out: `outside-page-title`).
    useEffect(() => {
        if (onTitle && page) onTitle(page.name);
        return () => onTitle && onTitle(null);
    }, [onTitle, page]);
    if (error) {
        return html`<div class="group-page">
            <p class="people-empty">
                ${
                    error.status === 404
                        ? t(
                              'publicgroup.no-such-group',
                              "there's no public group here by that name - it may be private, or not reached yet.",
                          )
                        : error.message
                }
            </p>
        </div>`;
    }
    if (!page) {
        return html`<div class="group-page">
            <p class="people-empty">${t('publicgroup.fetching', 'fetching the group…')}</p>
        </div>`;
    }
    const mine = !!current && page.members.some((m) => m.root === current.root);
    return html`<div class="group-page">
        <header class="group-head">
            <div
                class="person-card-hero group-hero"
                style=${page.banner ? `background-image: url(${page.banner})` : bannerStyle(group, '')}
            >
                <div class="person-card-top">
                    <${GroupHeroMark} group=${group} picture=${page.picture} isPublic=${true} />
                </div>
            </div>
            <h2 class="group-name">${page.name}</h2>
        </header>
        ${
            mine
                ? html`<a class="group-general" href=${groupHref(group)}>${t('publicgroup.open-your-group', 'open the group')}</a>`
                : html`<${FollowGroup} group=${group} page=${page} current=${current} />`
        }
        <span class="group-members-title">
            ${t('apps.groups.members', 'members')}
            <span class="group-members-count">(${page.members.length})</span>
        </span>
        <section class="public-group-members">
            ${page.members.map(
                (m) => html`<span key=${m.root} class="public-group-member">
                    <${PersonChip} root=${m.root} current=${current} />
                    ${m.owner && html`<span class="group-row-standing">${t('apps.groups.standing-owner', 'owner')}</span>`}
                </span>`,
            )}
        </section>
        ${page.description && html`<p class="person-card-bio">${page.description}</p>`}
        <${GroupFeed} group=${group} name=${page.name} current=${current} searchQuery=${searchQuery} />
    </div>`;
};
