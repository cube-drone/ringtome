// A persona's page under its short name on this node (PROJECT_PLAN's The node's public face, ruling 6): `/@slug`
// resolves through the node's slug door, then IS the persona page - the real address stays
// the persona's name everywhere, and the page says so beside it.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { PathPost } from './pathpage.js';
import { IdPage } from './idpage.js';
import { PostPage } from './postpage.js';
import { PostHistory } from './posthistory.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// The person's routes that aren't a post's: under a short name, they're at the real address.
const ELSEWHERE = ['doc', 'docs', 'room', 'ui-demo'];

/// `rest`: anything after the name - a post's web address, `/@cube-drone/recipes/sourdough-loaf`
/// (plans/WEB_ADDRESSES.md), a notebook's folder, or a post by its id, `/@cube-drone/post/<id>`
/// (2026-10-18), for one with no web address. `hidden`: the person's page, kept under a post.
export const SlugPage = ({
    slug,
    rest = '',
    current,
    persona,
    session,
    onTitle,
    searchQuery,
    hidden = false,
}) => {
    const loc = useLocation();
    const [who, setWho] = useState(undefined);
    useEffect(() => {
        let live = true;
        setWho(undefined);
        api(`/api/node/slugs/${encodeURIComponent(slug || '')}`)
            .then((r) => {
                if (!live) return;
                // The last slug sends the reader on to the current one (ruling 7).
                if (r && r.slug && !r.current)
                    loc.route(`/@${r.slug}${rest ? `/${rest}` : ''}`, true);
                else if (r && r.speakable && ELSEWHERE.includes(rest.split('/')[0]))
                    loc.route(`/ringtome/user/${r.speakable}/${rest}`, true);
                else setWho(r);
            })
            .catch(() => live && setWho(null));
        return () => {
            live = false;
        };
        // Not on `loc`, which is new at every move: the person's page kept under a post (keptpage.js)
        // would ask again, and be drawn again from nothing, each time a post opens over it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug, rest]);
    if (who === undefined)
        return html`<div class="persona-page id-page"><p class="id-quiet">${t('slugpage.looking', 'looking…')}</p></div>`;
    if (who === null || !who.speakable) {
        return html`<div class="persona-page id-page">
            <h1 class="persona-page-title">${t('slugpage.nobody-here-by-that-name', 'nobody on this node goes by that name')}</h1>
            <p>${t('slugpage.a-name-is-this-nodes', 'short names only work on this site. A real address starts with /ringtome/user/.')}</p>
        </div>`;
    }
    const parts = rest.split('/');
    if (parts[0] === 'post' && parts[1]) {
        if (parts[2] === 'history')
            return html`<${PostHistory} seg=${who.speakable} doc=${parts[1]} />`;
        return html`<${PostPage} seg=${who.speakable} doc=${parts[1]} page=${parts[2] === 'page' ? parts[3] : undefined} current=${current} onTitle=${onTitle} />`;
    }
    if (rest)
        return html`<${PathPost} seg=${who.speakable} path=${rest} current=${current} persona=${persona} session=${session} onTitle=${onTitle} searchQuery=${searchQuery} />`;
    return html`<${IdPage} seg=${who.speakable} current=${current} persona=${persona} session=${session} onTitle=${onTitle} searchQuery=${searchQuery} hidden=${hidden} />`;
};
