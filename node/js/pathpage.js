// A post at its web address (plans/WEB_ADDRESSES.md): `/ringtome/user/<them>/recipes/sourdough-loaf`.
// The path is the author's own `path` label on the post, so any node holding them answers it - a
// peek too, which carries the whole annotations chain - and the page is the post's own page,
// reached by name rather than by id. The address stays as the reader typed it.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { IdPage } from './idpage.js';
import { PostPage } from './postpage.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// How often, and how far apart, a path this node doesn't know yet is asked again: a peek may be
/// a moment behind a post published since it last looked, and the profile visit before the first
/// ask is what sends it to look again.
const RETRIES = 4;
const RETRY_MS = 1500;

/// The post a path names, then its page. `undefined` while looking, `null` for nothing there.
const PathPost = ({ seg, path, current, onTitle }) => {
    const [post, setPost] = useState(undefined);
    useEffect(() => {
        let live = true;
        let timer = null;
        setPost(undefined);
        const ask = (tries) =>
            api(`/api/id/${seg}/at/${path}`)
                .then((r) => live && setPost(r.post))
                .catch(() => {
                    if (!live) return;
                    if (tries > 0) timer = setTimeout(() => ask(tries - 1), RETRY_MS);
                    else setPost(null);
                });
        // The profile visit first: what teaches this node a persona it doesn't hold, and freshens
        // one it only peeks at (idface.rs, stale-while-revalidate).
        api(`/api/id/${seg}/profile`)
            .catch(() => {})
            .then(() => live && ask(RETRIES));
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
        };
    }, [seg, path]);
    if (post === undefined)
        return html`<p class="postpage-loading">${t('pathpage.looking', 'looking for the post…')}</p>`;
    if (post === null)
        return html`<p class="postpage-missing">${t('pathpage.nothing-here', 'nothing lives at this address - it may have been taken down, or never existed')}</p>`;
    return html`<${PostPage} seg=${seg} doc=${post} current=${current} onTitle=${onTitle} />`;
};

/// Everything under a person's address that isn't one of its own routes: the person's page when
/// there's nothing after them, else a post's web address.
export const PersonOrPath = (props) => {
    const loc = useLocation();
    const prefix = `/ringtome/user/${props.seg}`;
    const rest = loc.path.startsWith(prefix)
        ? loc.path.slice(prefix.length).replace(/^\/+|\/+$/g, '')
        : '';
    if (!rest) return html`<${IdPage} ...${props} />`;
    return html`<${PathPost} seg=${props.seg} path=${rest} current=${props.current} onTitle=${props.onTitle} />`;
};
