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
import { MarqueeBody, bareSource } from './doc/marqueebody.js';
import { useTurbolinks } from './doc/turbolinks.js';
import { formatWhen } from './pure/when.js';
import { filterContacts } from './pure/people.js';
import { groupsInOrder, inviteCandidates, isInvite, membersInOrder } from './pure/groups.js';
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
            .then((r) => live && r && r.members && setRoster(r))
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
        <${Members} roster=${roster} current=${current} act=${act} />
        ${you.owner && html`<${InviteSomeone} roster=${roster} root=${root} act=${act} />`}
        ${
            you.member &&
            html`<div class="group-leave-row">
                <button class="group-leave jag-line" onClick=${left}>
                    ${t('apps.groups.leave-the-group', 'leave the group')}
                </button>
            </div>`
        }
        ${you.member && html`<${GroupPosts} base=${base} group=${group} root=${root} current=${current} owner=${you.owner} />`}
    </div>`;
};

/// The roster, owners marked, with an owner's verbs on each row. Seniority is the node's to
/// judge: a junior's act against a senior is refused there, and the refusal shows here.
const Members = ({ roster, current, act }) => {
    const owner = roster.you && roster.you.owner;
    const me = current && current.root;
    const ownerWord = (m) =>
        m.root === roster.founder
            ? t('apps.groups.founder', 'founder')
            : m.owner
              ? t('apps.groups.owner', 'owner')
              : null;
    return html`<section class="group-members">
        <div class="people-shelf-head">
            <span class="people-shelf-title">${t('apps.groups.whos-in-it', "who's in it")}</span>
        </div>
        <div class="people-list">
            ${membersInOrder(roster).map(
                (m) => html`<div class="group-member" key=${m.root}>
                    <${PersonRow} root=${m.root} current=${current} aside=${ownerWord(m)} />
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
        }
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

/// The group's posts, newest first. Nobody writes here (Curtis, 2026-10-15): a post to the group
/// is written in the feed or in Writer, with the group as where it goes.
const GroupPosts = ({ base, group, root, current, owner }) => {
    const [answer, error, reload] = useAnswer(`${base}/posts`);
    const [actError, setActError] = useState(null);
    const act = async (path, body) => {
        try {
            await post(`${base}/${path}`, body);
            reload();
        } catch (err) {
            setActError(err.message);
        }
    };
    const posts = (answer && answer.posts) || [];
    return html`<section class="group-posts">
        <div class="people-shelf-head">
            <span class="people-shelf-title">${t('apps.groups.posts', 'posts')}</span>
        </div>
        <p class="group-write-here">
            ${t('apps.groups.to-post-here', 'to post here, write in the feed or in hrseWriter™ and choose this group as where it goes.')}
        </p>
        ${(actError || error) && html`<p class="groups-error">${actError || error.message}</p>`}
        ${answer && posts.length === 0 && html`<p class="people-empty">${t('apps.groups.nothing-posted-yet', 'nothing posted here yet.')}</p>`}
        ${posts.map(
            (p) => html`<${GroupPost}
                key=${p.doc}
                post=${p}
                group=${group}
                current=${current}
                mine=${p.author === root}
                owner=${owner}
                act=${act}
            />`,
        )}
    </section>`;
};

const GroupPost = ({ post: p, current, mine, owner, act }) => {
    const words = p.words || '';
    const profile = useTurbolinks(words, 'marquee');
    // Chosen out here: inside the template, a string comparison reads to the strings cop as copy.
    const marquee = p.format === 'marquee';
    // Its tags, whoever said them, once each (section 7: a group post's labels ride its lane).
    const tags = [
        ...new Set((p.annotations || []).filter((l) => l.key === 'tag').map((l) => l.value)),
    ];
    return html`<article class=${p.hidden ? 'group-post group-post-hidden jag-line-2' : 'group-post jag-line-2'}>
        <header class="group-post-head">
            <${PersonChip} root=${p.author} current=${current} />
            <span class="group-post-when">
                ${formatWhen(p.posted_ms)}${p.edited ? ` · ${t('apps.groups.edited', 'edited')}` : ''}
            </span>
        </header>
        ${p.title && html`<h3 class="group-post-title">${p.title}</h3>`}
        ${p.hidden && html`<p class="group-post-hidden-note">${t('apps.groups.hidden-by-an-owner', 'hidden from the group by an owner')}</p>`}
        ${
            p.words == null
                ? html`<p class="people-empty">${t('apps.groups.words-on-their-way', 'the words are on their way from another member.')}</p>`
                : marquee
                  ? html`<${MarqueeBody} source=${words} profile=${profile} onUnparsable=${bareSource} />`
                  : html`<p class="group-post-plain">${words}</p>`
        }
        ${
            tags.length > 0 &&
            html`<div class="group-post-tags">
                ${tags.map((tag) => html`<span class="label-chip" key=${tag}>${tag}</span>`)}
            </div>`
        }
        ${
            (mine || owner) &&
            html`<footer class="group-post-acts">
                ${
                    mine &&
                    html`<button class="group-act jag-line" onClick=${() => act(`docs/${p.doc}/retract`)}>
                        <${Icons.trash} /> ${t('apps.groups.take-down', 'take down')}
                    </button>`
                }
                ${
                    /* Hiding is for someone else's post: your own you take down. Unless another
                    owner hid it - then you may ask to show it, and seniority decides. */ ''
                }
                ${
                    owner &&
                    (!mine || p.hidden) &&
                    html`<button class="group-act jag-line" onClick=${() => act(`docs/${p.doc}/hide`, { hidden: !p.hidden })}>
                        ${p.hidden ? t('apps.groups.show-it-again', 'show it again') : t('apps.groups.hide-from-the-group', 'hide from the group')}
                    </button>`
                }
            </footer>`
        }
    </article>`;
};
