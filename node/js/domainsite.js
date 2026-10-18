// A person's own domain (plans/CUSTOM_DOMAINS.md, slice 3): a node serving cube-drone.com answers
// it as cube-drone's website, and says whose in the page (`<meta name="ringtome-site">`,
// domainsite.rs). Here the app is a reading site of theirs (section 5): `/` is their page, `/<path>`
// a post or a folder, `/post/<id>` a post by its id - and their address in the node's form
// (`/ringtome/user/<them>/...`), which the app's links are minted in, is the same place at home.
// Nothing here signs in: anything of the node's - someone else, the console, the front page - is a
// whole page load, which the node sends on to its own address.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { IdPage } from './idpage.js';
import { PostPage } from './postpage.js';
import { PostHistory } from './posthistory.js';
import { PathPost } from './pathpage.js';
import { Icons } from './icons.js';
import { publicUrl } from './links.js';
import { t } from './i18n.js';
import { atHome } from './pure/ringtome.js';

const html = htm.bind(h);

/// The node's own paths: nobody's site has them.
const NODE_PATH = /^\/(ringtome|id|upload)(\/|$)|^\/@/;

export const DomainSite = ({ seg }) => {
    const loc = useLocation();
    const [title, setTitle] = useState(null);
    const [node, setNode] = useState('');
    useEffect(() => {
        publicUrl().then(setNode);
    }, []);
    const home = atHome(seg, loc.path);
    const foreign = home === null && NODE_PATH.test(loc.path);
    useEffect(() => {
        const query = loc.url.includes('?') ? loc.url.slice(loc.url.indexOf('?')) : '';
        if (home !== null) loc.route(`${home}${query}`, true);
        // Replaced, not pushed, so going back doesn't land on the address that sent us away.
        else if (foreign) window.location.replace(loc.url);
    }, [loc, home, foreign]);
    if (home !== null || foreign) return null;

    const parts = loc.path.split('/').filter(Boolean);
    const shared = { seg, current: null, onTitle: setTitle };
    let page;
    if (!parts.length) {
        page = html`<${IdPage} ...${shared} persona=${null} session=${null} />`;
    } else if (parts[0] === 'post' && parts[1]) {
        page =
            parts[2] === 'history'
                ? html`<${PostHistory} seg=${seg} doc=${parts[1]} />`
                : html`<${PostPage} ...${shared} doc=${parts[1]} page=${parts[2] === 'page' ? parts[3] : undefined} />`;
    } else {
        page = html`<${PathPost} ...${shared} persona=${null} session=${null} path=${parts.join('/')} />`;
    }
    return html`<div class="app-frame">
        <header class="app-header">
            <span class="app-header-lead">
                <span class="app-header-title outside-band-title">${title || ''}</span>
            </span>
            <span class="app-header-actions">
                ${
                    node &&
                    html`<a
                        class="app-header-btn"
                        href=${node}
                        title=${t('domainsite.on-the-node', 'on Horse Drawing Tycoon 2')}
                    ><${Icons.home} /></a>`
                }
            </span>
        </header>
        <div class="app-frame-inner">
            ${title && html`<h1 class="outside-page-title">${title}</h1>`}
            ${page}
        </div>
    </div>`;
};
