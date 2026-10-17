// A public group's open page (plans/PUBLIC_GROUPS.md, ruling 6): its face, its members and its
// public posts, to anyone - signed out at `/ringtome/groups/:group`, and to someone signed in who
// isn't in it, with a follow button (ruling 7). A member sees its public posts on their own page of
// it too (`PublicPosts`). A private group has no open page: the node says there's no such group.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { GroupMark } from './groupface.js';
import { MiniPost } from './postentry.js';
import { PersonChip, bannerStyle } from './person.js';
import { groupHref } from './links.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

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

/// The group's public posts, newest first: each a member's own post, which the group counts as
/// its own.
export const PublicPosts = ({ posts }) =>
    !!posts &&
    posts.length > 0 &&
    html`<section class="public-group-posts">
        <h3 class="group-posts-title">${t('publicgroup.public-posts', 'public posts')}</h3>
        <ul class="public-group-post-list">
            ${posts.map(
                (p) => html`<li key=${`${p.author}/${p.doc_id}`}>
                    <${MiniPost} author=${p.author} doc_id=${p.doc_id} />
                </li>`,
            )}
        </ul>
    </section>`;

/// The public posts list for a member's own page of the group.
export const GroupPublicPosts = ({ group }) => {
    const [page] = usePublicGroup(group);
    return html`<${PublicPosts} posts=${page && page.posts} />`;
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

export const PublicGroupPage = ({ group, current }) => {
    const [page, error] = usePublicGroup(group);
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
                    <${GroupMark} group=${group} picture=${page.picture} size="hero" />
                </div>
            </div>
            <h2 class="group-name">${page.name}</h2>
            <p class="group-public-note">${t('publicgroup.a-public-group', 'a public group: anyone can see who is in it, and its members post in public as the group')}</p>
            ${page.description && html`<p class="group-description">${page.description}</p>`}
            <p class="group-count">
                ${t('apps.groups.member-count', '{count} in the group', { count: page.members.length })}
            </p>
        </header>
        ${
            mine
                ? html`<a class="group-general" href=${groupHref(group)}>${t('publicgroup.open-your-group', 'open the group')}</a>`
                : html`<${FollowGroup} group=${group} page=${page} current=${current} />`
        }
        <section class="public-group-members">
            ${page.members.map(
                (m) => html`<span key=${m.root} class="public-group-member">
                    <${PersonChip} root=${m.root} current=${current} />
                    ${m.owner && html`<span class="group-row-standing">${t('apps.groups.standing-owner', 'owner')}</span>`}
                </span>`,
            )}
        </section>
        <${PublicPosts} posts=${page.posts} />
    </div>`;
};
