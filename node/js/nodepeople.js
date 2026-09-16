// The node's people page (UNAUTHED.md, slice 2): everyone this node lists, with the byline
// it holds - the People app's rows over the node door (nodeface.rs), with no relationship
// to glance at: a stranger has none.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { PersonRow } from './person.js';
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
                        profile=${{ fields: [
                            ...(p.name ? [{ field: 'name', value: p.name }] : []),
                            ...(p.avatar ? [{ field: 'avatar', value: p.avatar }] : []),
                        ] }}
                        aside=${p.speakable || ''}
                    />`
                )}
            </div>
        </div>
    `;
};
