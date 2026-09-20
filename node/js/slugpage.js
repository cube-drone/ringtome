// A persona's page under its short name on this node (PROJECT_PLAN's The node's public face, ruling 6): `/@slug`
// resolves through the node's slug door, then IS the persona page - the real address stays
// the persona's name everywhere, and the page says so beside it.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { IdPage } from './idpage.js';
import { t } from './i18n.js';

const html = htm.bind(h);

export const SlugPage = ({ slug, current, persona, session, onTitle, searchQuery }) => {
    const loc = useLocation();
    const [who, setWho] = useState(undefined);
    useEffect(() => {
        let live = true;
        setWho(undefined);
        api(`/api/node/slugs/${encodeURIComponent(slug || '')}`)
            .then((r) => {
                if (!live) return;
                // The last slug sends the reader on to the current one (ruling 7).
                if (r && r.slug && !r.current) loc.route(`/@${r.slug}`, true);
                else setWho(r);
            })
            .catch(() => live && setWho(null));
        return () => {
            live = false;
        };
    }, [slug, loc]);
    if (who === undefined) return html`<div class="persona-page id-page"><p class="id-quiet">${t('slugpage.looking', 'looking…')}</p></div>`;
    if (who === null || !who.speakable) {
        return html`<div class="persona-page id-page">
            <h1 class="persona-page-title">${t('slugpage.nobody-here-by-that-name', 'nobody on this node goes by that name')}</h1>
            <p>${t('slugpage.a-name-is-this-nodes', 'short names only work on this site. A real address starts with /id/.')}</p>
        </div>`;
    }
    return html`<${IdPage} seg=${who.speakable} current=${current} persona=${persona} session=${session} onTitle=${onTitle} searchQuery=${searchQuery} />`;
};
