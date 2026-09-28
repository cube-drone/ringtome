// The node's people page (PROJECT_PLAN's The node's public face, slice 2): everyone this node lists, with the byline
// it holds - the People app's rows over the node door (nodeface.rs), with no relationship
// to glance at: a stranger has none.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { PersonRow, PersonHex, usePerson } from './person.js';
import { t } from './i18n.js';

const html = htm.bind(h);

export const NodePeople = ({ current, searchQuery }) => {
    const [people, setPeople] = useState(undefined);
    useEffect(() => {
        let live = true;
        api('/api/node/personas')
            .then((r) => live && setPeople(r.people || []))
            .catch(() => live && setPeople([]));
        return () => {
            live = false;
        };
    }, []);
    const q = (searchQuery || '').trim().toLowerCase();
    const shown = (people || []).filter((p) => !q || (p.name || '').toLowerCase().includes(q) || (p.speakable || '').includes(q));
    return html`
        <div class="people-inner node-people">
            <div class="people-shelf-head">
                <span class="people-shelf-title">${t('apps.nodepeople.hosted-here', 'hosted here')}</span>
            </div>
            ${people === undefined && html`<p class="null-sub">${t('apps.nodepeople.loading', 'looking…')}</p>`}
            ${people !== undefined &&
            shown.length === 0 &&
            html`<p class="null-sub">${t('apps.nodepeople.nobody-listed', 'nobody is listed on this node.')}</p>`}
            <div class="people-list">
                ${shown.map(
                    (p) => html`<${PersonRow}
                        key=${p.root}
                        root=${p.root}
                        current=${current || null}
                        profile=${bylineProfile(p)}
                        aside=${p.slug ? `@${p.slug}` : p.speakable || ''}
                    />`
                )}
            </div>
        </div>
    `;
};

/// The profile a node listing hands a person row: the byline the node holds.
const bylineProfile = (p) => ({
    fields: [
        ...(p.name ? [{ field: 'name', value: p.name }] : []),
        ...(p.avatar ? [{ field: 'avatar', value: p.avatar }] : []),
        ...(p.banner ? [{ field: 'banner', value: p.banner }] : []),
    ],
});

/// One face on the front door's shelf: the picture and the name, a link to their page.
const FrontPerson = ({ p }) => {
    const person = usePerson(p.root, { current: null, profile: bylineProfile(p) });
    return html`<a class="front-person" href=${person.href}>
        <${PersonHex} person=${person} size="card" />
        <span class="front-person-name">${person.primary}</span>
    </a>`;
};

/// The front door's "posted lately" (Curtis, 2026-09-28): the listed people who posted most
/// recently, newest first, with the way on to everyone. Nothing at all on a node where nobody has.
export const RecentPeople = ({ limit = 20 }) => {
    const loc = useLocation();
    const [people, setPeople] = useState(undefined);
    useEffect(() => {
        let live = true;
        api(`/api/node/personas?recent=${limit}`)
            .then((r) => live && setPeople(r.people || []))
            .catch(() => live && setPeople([]));
        return () => {
            live = false;
        };
    }, [limit]);
    if (!people || people.length === 0) return null;
    return html`<section class="front-shelf">
        <h2 class="front-shelf-title">${t('nodepeople.posted-lately', 'posted lately')}</h2>
        <div class="front-people">${people.map((p) => html`<${FrontPerson} key=${p.root} p=${p} />`)}</div>
        <a
            class="front-more"
            href="/people"
            onClick=${(e) => {
                e.preventDefault();
                loc.route('/people');
            }}
        >${t('nodepeople.see-more', 'see more...')}</a>
    </section>`;
};
