// Groups (plans/GROUPS.md, section 7): a tab in People, and a group's own page under it. The
// tab lists the current persona's groups and the invites waiting on them, and founds new ones.
// The page is shaped like a persona's - the group's details and membership on top, its posts
// beneath - and only a member, or someone it has invited, sees any of it. Everything is the
// node's answer from the group's routes (node/src/roster.rs); nothing here is mirrored, since a
// group's lanes are the node's memo, never the persona's ledger.
import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { appHref, groupHref, groupsHref } from './links.js';
import { openMirror, useLive } from './mirror.js';
import { PersonChip, PersonRow } from './person.js';
import { PostEntry } from './postentry.js';
import { filterContacts } from './pure/people.js';
import {
    groupsInOrder,
    inviteCandidates,
    isInvite,
    membersAtAGlance,
    membersInOrder,
} from './pure/groups.js';
import { speakable } from './speakable.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// People's two tabs: the people you know, and your groups.
export const PeopleTabs = ({ tab }) => {
    const tabLink = (to, href, icon, words) =>
        html`<a class=${tab === to ? 'tab active' : 'tab'} href=${href}><${icon} /> ${words}</a>`;
    return html`<nav class="welcome-tabs people-tabs">
        ${tabLink('people', appHref('people'), Icons.people, t('apps.groups.tab-people', 'people'))}
        ${tabLink('groups', groupsHref(), Icons.group, t('apps.groups.tab-groups', 'groups'))}
    </nav>`;
};

/// A route's answer, re-read on demand: `[value, error, reload]`.
const useAnswer = (path) => {
    const [value, setValue] = useState(null);
    const [error, setError] = useState(null);
    const [turn, setTurn] = useState(0);
    useEffect(() => {
        if (!path) return undefined;
        let live = true;
        api(path)
            .then((v) => {
                if (!live) return;
                setValue(v);
                setError(null);
            })
            .catch((e) => live && setError(e));
        return () => {
            live = false;
        };
    }, [path, turn]);
    return [value, error, useCallback(() => setTurn((n) => n + 1), [])];
};

const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------------------------
// The Groups tab

const STANDING_WORDS = {
    invite: () => t('apps.groups.standing-invite', 'invited you'),
    invited: () => t('apps.groups.standing-invited', 'invited'),
    owner: () => t('apps.groups.standing-owner', 'owner'),
    member: () => t('apps.groups.standing-member', 'member'),
};

export const GroupsTab = ({ current }) => {
    const root = current && current.root;
    const loc = useLocation();
    const [rows, error, reload] = useAnswer(root ? `/api/identity/${root}/groups` : null);
    const [name, setName] = useState('');
    const [founding, setFounding] = useState(false);
    const [foundError, setFoundError] = useState(null);
    const found = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setFounding(true);
        setFoundError(null);
        try {
            const made = await post(`/api/identity/${root}/groups`, { name: name.trim() });
            setName('');
            reload();
            loc.route(groupHref(made.group));
        } catch (err) {
            setFoundError(err.message);
        } finally {
            setFounding(false);
        }
    };
    if (!root) return null;
    const list = groupsInOrder(rows || []);
    return html`<div class="groups">
        <form class="groups-found" onSubmit=${found}>
            <input
                class="groups-found-name jag-field"
                value=${name}
                maxlength="100"
                placeholder=${t('apps.groups.a-new-groups-name', "a new group's name")}
                onInput=${(e) => setName(e.currentTarget.value)}
            />
            <button class="groups-found-go jag-line" disabled=${founding || !name.trim()}>
                <${Icons.plus} /> ${t('apps.groups.found-a-group', 'found a group')}
            </button>
        </form>
        ${foundError && html`<p class="groups-error">${foundError}</p>`}
        ${error && html`<p class="groups-error">${error.message}</p>`}
        ${
            rows &&
            list.length === 0 &&
            html`<p class="people-empty">
                ${t('apps.groups.no-groups-yet', "no groups yet - found one, or wait for someone's invite.")}
            </p>`
        }
        <div class="groups-list">
            ${list.map(
                (g) => html`<a
                    key=${g.group}
                    class=${isInvite(g) ? 'group-row group-row-invite jag-line-2' : 'group-row jag-line-2'}
                    href=${groupHref(g.group)}
                >
                    <span class="group-row-name">${g.name}</span>
                    <span class="group-row-standing">
                        ${(STANDING_WORDS[g.standing] || (() => g.standing))()}
                    </span>
                </a>`,
            )}
        </div>
    </div>`;
};

// ---------------------------------------------------------------------------------------------
// A group's page

/// A group's page. It reads the roster; an invite the bell holds but nothing has opened yet
/// answers "no such group here", and is opened - fetched from the node that delivered it - so
/// the invitee sees whom they'd be joining. Each visit also syncs, in the background.
export const GroupPage = ({ group, current }) => {
    const root = current && current.root;
    const loc = useLocation();
    const base = root && group ? `/api/identity/${root}/groups/${group}` : null;
    const [roster, setRoster] = useState(null);
    const [missing, setMissing] = useState(false);
    const [error, setError] = useState(null);
    const [turn, setTurn] = useState(0);
    const refresh = useCallback(() => setTurn((n) => n + 1), []);
    const [synced, setSynced] = useState(0);
    // The group's posts, the feed narrowed to it: listed beneath, and read by the faces above for
    // who posted last. Re-read when the visit's sync lands, which may bring posts with it.
    const [posts, postsError, reloadPosts] = useAnswer(
        root && group ? `/api/identity/${root}/feed?group=${group}` : null,
    );
    useEffect(() => {
        if (synced) reloadPosts();
    }, [synced, reloadPosts]);
    const items = (posts && posts.items) || [];
    useEffect(() => {
        if (!base) return undefined;
        let live = true;
        setMissing(false);
        api(base)
            .catch((e) => {
                if (e.status !== 404) throw e;
                return post(`${base}/open`);
            })
            .then((r) => live && setRoster(r))
            .catch((e) => {
                if (!live) return;
                if (e.status === 404) setMissing(true);
                else setError(e.message);
            });
        return () => {
            live = false;
        };
    }, [base, turn]);
    // Bring the group up to date once a visit: pushes this persona's lane, pulls everyone's.
    useEffect(() => {
        if (!base) return undefined;
        let live = true;
        post(`${base}/sync`)
            .then((r) => {
                if (!live) return;
                if (r && r.members) setRoster(r);
                setSynced((n) => n + 1);
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [base]);
    const act = async (path, body) => {
        setError(null);
        try {
            const r = await post(`${base}/${path}`, body);
            if (r && r.members) setRoster(r);
            else refresh();
            return r;
        } catch (e) {
            setError(e.message);
            return null;
        }
    };

    if (!root) return null;
    if (missing) {
        return html`<div class="group-page">
            <a class="skip-link" href=${groupsHref()}>${t('apps.groups.back-to-groups', 'back to groups')}</a>
            <p class="people-empty">
                ${t('apps.groups.not-here', "this group isn't here - you may not be in it, or it can't be reached just now.")}
            </p>
        </div>`;
    }
    if (!roster) {
        return html`<div class="group-page">
            ${error ? html`<p class="groups-error">${error}</p>` : html`<p class="people-empty">${t('apps.groups.fetching', 'fetching the group…')}</p>`}
        </div>`;
    }
    const you = roster.you || {};
    const left = async () => {
        if (await act('leave')) loc.route(groupsHref());
    };
    return html`<div class="group-page">
        <a class="skip-link" href=${groupsHref()}>${t('apps.groups.back-to-groups', 'back to groups')}</a>
        <header class="group-head">
            <h2 class="group-name">${roster.name}</h2>
            ${roster.description && html`<p class="group-description">${roster.description}</p>`}
            <p class="group-count">
                ${t('apps.groups.member-count', '{count} in the group', { count: (roster.members || []).length })}
            </p>
        </header>
        ${error && html`<p class="groups-error">${error}</p>`}
        ${
            !you.member &&
            html`<div class="group-invite jag-line-2">
                <p>${t('apps.groups.youre-invited', "you're invited. Joining shows everyone in it who you are, and lets you read and post here.")}</p>
                <button class="group-join jag-line" onClick=${() => act('join')}>
                    <${Icons.plus} /> ${t('apps.groups.join', 'join')}
                </button>
            </div>`
        }
        <${Members} roster=${roster} current=${current} act=${act} posts=${items} />
        ${
            you.member &&
            html`<div class="group-leave-row">
                <button class="group-leave jag-line" onClick=${left}>
                    ${t('apps.groups.leave-the-group', 'leave the group')}
                </button>
            </div>`
        }
        ${you.member && html`<${GroupPosts} answer=${posts} error=${postsError} current=${current} />`}
    </div>`;
};

/// How many faces the members' closed box shows: about two rows of them.
const GLANCE = 14;

/// The members (Curtis, 2026-10-16), in the disclosure a person's page keeps your relationship in
/// (person.js `ContactLedger`): its heading, and under it who's in it at a glance - a line or two
/// of faces that say who on a point, the founder, the owners, whoever posted last. Open, the whole
/// roster, each name wearing its standing, with the invited and an owner's invite there too, off
/// the group's front page. The box draws its jag behind it (`group-members-box`), so a face's
/// pop-over isn't cut off at its edge.
const Members = ({ roster, current, act, posts }) => {
    const [open, setOpen] = useState(false);
    const glance = membersAtAGlance(roster, posts, GLANCE);
    return html`<details class="contact-ledger group-members-box" onToggle=${(e) => setOpen(e.currentTarget.open)}>
        <summary class="ledger-head group-members-head">
            <span class="group-members-title">${t('apps.groups.members', 'members')}</span>
            ${
                !open &&
                html`<span class="group-glance">
                    ${glance.map((r) => html`<${PersonChip} key=${r} root=${r} current=${current} />`)}
                </span>`
            }
        </summary>
        ${
            open &&
            html`<${Roster} roster=${roster} current=${current} act=${act} />
                ${roster.you && roster.you.owner && html`<${InviteSomeone} roster=${roster} root=${current.root} act=${act} />`}
                <${Gone} roster=${roster} current=${current} act=${act} />`
        }
    </details>`;
};

/// A member's standing beside their name (Curtis, 2026-10-16): a cowboy hat for the founder and the
/// owners, a cow for everyone else, saying which on a point.
const StandingMark = ({ founder, owner }) => {
    const words = founder
        ? t('apps.groups.founder-created-the-group', 'founder: this user created the group')
        : owner
          ? t('apps.groups.owner-can-manage-the-group', 'owner: this user can manage the group')
          : t('apps.groups.member', 'member');
    return html`<span class="group-standing" title=${words} aria-label=${words}>
        <${founder || owner ? Icons.groupOwner : Icons.groupMember} />
    </span>`;
};

/// The whole roster, each name wearing its standing, with an owner's verbs on each row, and the
/// invited. Seniority
/// is the node's to judge: a junior's act against a senior is refused there, and the refusal shows
/// here.
const Roster = ({ roster, current, act }) => {
    const owner = roster.you && roster.you.owner;
    const me = current && current.root;
    return html`<div class="people-list">
            ${membersInOrder(roster).map(
                (m) => html`<div class="group-member" key=${m.root}>
                    <${PersonRow}
                        root=${m.root}
                        current=${current}
                        mark=${html`<${StandingMark} founder=${m.root === roster.founder} owner=${m.owner} />`}
                    />
                    ${
                        owner &&
                        m.root !== me &&
                        html`<span class="group-member-acts">
                            ${
                                m.owner
                                    ? html`<button class="group-act jag-line" onClick=${() => act('demote', { target: m.root })}>
                                          ${t('apps.groups.demote', 'demote')}
                                      </button>`
                                    : html`<button class="group-act jag-line" onClick=${() => act('appoint', { target: m.root })}>
                                          ${t('apps.groups.make-owner', 'make owner')}
                                      </button>`
                            }
                            <button class="group-act jag-line" onClick=${() => act('remove', { target: m.root })}>
                                ${t('apps.groups.remove', 'remove')}
                            </button>
                            <button class="group-act jag-line" onClick=${() => act('remove', { target: m.root, ban: true })}>
                                ${t('apps.groups.ban', 'ban')}
                            </button>
                        </span>`
                    }
                </div>`,
            )}
        </div>
        ${
            (roster.invited || []).length > 0 &&
            html`<div class="people-shelf-head">
                    <span class="people-shelf-title">${t('apps.groups.invited', 'invited')}</span>
                </div>
                <div class="people-list">
                    ${roster.invited.map((r) => html`<${PersonRow} key=${r} root=${r} current=${current} />`)}
                </div>`
        }`;
};

/// Whoever was removed or banned and isn't back (Curtis, 2026-10-16: a banned persona nobody can
/// see is lost for good), at the foot of the roster. An owner may invite someone removed back -
/// the invite readmits the removal - or lift a ban, after which they're removed, and may be
/// invited back in turn.
const Gone = ({ roster, current, act }) => {
    const banned = roster.banned || [];
    const removed = roster.removed || [];
    if (banned.length + removed.length === 0) return null;
    const owner = roster.you && roster.you.owner;
    const row = (r, isBanned) => html`<div class="group-member" key=${r}>
        <${PersonRow}
            root=${r}
            current=${current}
            aside=${isBanned ? t('apps.groups.banned', 'banned') : t('apps.groups.removed', 'removed')}
        />
        ${
            owner &&
            html`<span class="group-member-acts">
                ${
                    isBanned
                        ? html`<button class="group-act jag-line" onClick=${() => act('unban', { target: r })}>
                              ${t('apps.groups.lift-the-ban', 'lift the ban')}
                          </button>`
                        : html`<button class="group-act jag-line" onClick=${() => act('invites', { invitee: r })}>
                              ${t('apps.groups.invite-back', 'invite back')}
                          </button>`
                }
            </span>`
        }
    </div>`;
    return html`<section class="group-gone">
        <div class="people-shelf-head">
            <span class="people-shelf-title">${t('apps.groups.removed-or-banned', 'removed or banned')}</span>
        </div>
        <div class="people-list">
            ${banned.map((r) => row(r, true))}
            ${removed.map((r) => row(r, false))}
        </div>
    </section>`;
};

/// An owner's invite: anyone from their own contacts, filtered as People's shelf is.
const InviteSomeone = ({ roster, root, act }) => {
    const [filter, setFilter] = useState('');
    const [sent, setSent] = useState([]);
    const contacts = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    const rows = filterContacts(
        inviteCandidates(contacts, roster, root)
            .filter((c) => !sent.includes(c.root))
            .map((c) => ({ ...c, words: speakable(c.root) })),
        filter,
    ).slice(0, 8);
    const invite = async (who) => {
        if (await act('invites', { invitee: who })) setSent((s) => [...s, who]);
    };
    return html`<section class="group-invite-someone">
        <div class="people-shelf-head">
            <span class="people-shelf-title">${t('apps.groups.invite-someone', 'invite someone')}</span>
        </div>
        <input
            class="group-invite-filter jag-field"
            value=${filter}
            placeholder=${t('apps.groups.find-someone-you-know', 'find someone you know')}
            onInput=${(e) => setFilter(e.currentTarget.value)}
        />
        ${sent.length > 0 && html`<p class="group-invite-sent">${t('apps.groups.invites-sent', 'invited: {count}. They hear about it in their notifications.', { count: sent.length })}</p>`}
        <div class="people-list">
            ${rows.map(
                (c) => html`<div class="group-member" key=${c.root}>
                    <${PersonRow} root=${c.root} />
                    <span class="group-member-acts">
                        <button class="group-act jag-line" onClick=${() => invite(c.root)}>${t('apps.groups.invite', 'invite')}</button>
                    </span>
                </div>`,
            )}
        </div>
    </section>`;
};

// ---------------------------------------------------------------------------------------------
// A group post just posted, held for its own page until the node's row for it answers - the
// optimistic pattern (pure/optimistic.js, Curtis 2026-10-01: "updating the local state and then
// reconciling it when the server catches up") for a page the browser's mirror doesn't hold. The
// composer holds the card (pure/groups.js `groupPostItem`) before it routes; the page draws it at
// once, keeps asking while the node says it has no such post, and lets it go when the node's own
// card arrives. In this tab's memory only: a reload asks the node, as any page does.
const HOLD_MS = 120_000;
const held = new Map(); // `${group}/${doc}` -> { item, at }

const keyOf = (group, doc) => `${group}/${doc}`;

/// Hold this card for its page.
export function holdGroupPost(item) {
    if (item && item.group) held.set(keyOf(item.group.id, item.doc_id), { item, at: Date.now() });
}

/// The card held for this post, while the hold lasts - else null.
function heldGroupPost(group, doc) {
    const h = held.get(keyOf(group, doc));
    if (!h) return null;
    if (Date.now() - h.at > HOLD_MS) {
        held.delete(keyOf(group, doc));
        return null;
    }
    return h.item;
}

/// The node answered for it: the hold is done.
function releaseGroupPost(group, doc) {
    held.delete(keyOf(group, doc));
}

/// The group's posts, newest first: the feed's own cards, from the feed narrowed to this group
/// (Curtis, 2026-10-16: a persona's page is the bellwether - the same post objects as the feed,
/// under a filter of its own, each one clicking through to a page of its own). Nobody writes here
/// (Curtis, 2026-10-15): a post to the group is written in the feed or in Writer, with the group
/// as where it goes. The page fetches them, since its faces read them too.
const GroupPosts = ({ answer, error, current }) => {
    const items = (answer && answer.items) || [];
    return html`<section class="group-posts">
        <div class="people-shelf-head">
            <span class="people-shelf-title">${t('apps.groups.posts', 'posts')}</span>
        </div>
        <p class="group-write-here">
            ${t('apps.groups.to-post-here', 'to post here, write in the feed or in hrseWriter™ and choose this group as where it goes.')}
        </p>
        ${error && html`<p class="groups-error">${error.message}</p>`}
        ${answer && items.length === 0 && html`<p class="people-empty">${t('apps.groups.nothing-posted-yet', 'nothing posted here yet.')}</p>`}
        ${items.map(
            (item) => html`<${PostEntry}
                key=${item.doc_id}
                item=${item}
                current=${current}
                editing=${null}
                quote=${false}
            />`,
        )}
    </section>`;
};

/// A group post's own page, inside its group: the feed's card, alone. There to the group's members
/// only, and not to one it's hidden from - the node answers no such post to anyone else.
export const GroupPostPage = ({ group, doc, current }) => {
    const root = current && current.root;
    const [answer, error, reload] = useAnswer(
        root && group && doc ? `/api/identity/${root}/groups/${group}/posts/${doc}` : null,
    );
    // Just posted from this tab: its card, drawn at once (the hold above). While the hold lasts, the
    // node saying "no such post" means "not yet", and it is asked again; its own card ends the hold.
    const held = heldGroupPost(group, doc);
    const [tries, setTries] = useState(0);
    const notYet = !!held && !!error && error.status === 404 && tries < HELD_TRIES;
    useEffect(() => {
        if (!notYet) return undefined;
        const again = setTimeout(() => {
            setTries((n) => n + 1);
            reload();
        }, 1000);
        return () => clearTimeout(again);
    }, [notYet, tries, reload]);
    useEffect(() => {
        if (answer && answer.item) releaseGroupPost(group, doc);
    }, [answer, group, doc]);
    if (!root) return null;
    const item = (answer && answer.item) || held;
    return html`<div class="group-page">
        <a class="skip-link" href=${groupHref(group)}>${t('apps.groups.back-to-the-group', 'back to the group')}</a>
        ${
            error &&
            !item &&
            (error.status === 404
                ? html`<p class="people-empty">
                      ${t('apps.groups.post-not-here', "this post isn't here - it may have been taken down or hidden, or you may not be in its group.")}
                  </p>`
                : html`<p class="groups-error">${error.message}</p>`)
        }
        ${!item && !error && html`<p class="people-empty">${t('apps.groups.fetching-the-post', 'fetching the post…')}</p>`}
        ${
            item &&
            html`<${PostEntry}
                key=${item.doc_id}
                item=${item}
                current=${current}
                editing=${null}
                quote=${false}
                standalone=${true}
            />`
        }
    </div>`;
};

/// How many times a held post's page asks again, a second apart, before "no such post" stands.
const HELD_TRIES = 10;
