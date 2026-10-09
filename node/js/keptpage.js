// A page kept under a post (Curtis, 2026-10-09: the personal feed came back exactly where you left
// it after opening a post - "other people's posts and the public feed don't work this way. Could we
// fix this everywhere?"). A route is unmounted when you leave it, and a list page's loaded pages,
// pictures and scroll go with it; so a page you open posts from is drawn beside the router, from
// the moment you open it until you go anywhere that is not a post. Under a post it is there but
// unseen and inert; back is the post going away and the page as you left it.
//
// Two shells use it (index.js): the signed-in one keeps the feed and a person's page, the
// stranger's the node's public feed and a person's page.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

/// A post's page - the one place a kept page stays alive under.
export const POST_PATH = /^\/ringtome\/user\/[^/]+\/post\//;
/// A person's own page, `/ringtome/user/<seg>`, and nothing under it.
export const PERSON_PATH = /^\/ringtome\/user\/([^/]+)\/?$/;

/// The address of the page to draw beside the router, or null: the page itself while you're on
/// it, the one you came from while you're on a post opened from it. `keeps(path)` says which pages
/// are kept at all.
export function useKeptUrl(loc, keeps) {
    const [kept, setKept] = useState(null);
    const here = keeps(loc.path);
    const underPost = POST_PATH.test(loc.path);
    useEffect(() => {
        if (here) setKept(loc.url);
        else if (!underPost) setKept(null);
    }, [loc.url, here, underPost]);
    if (here) return { url: loc.url, visible: true };
    return kept && underPost ? { url: kept, visible: false } : { url: null, visible: false };
}

/// The kept page's frame. `fill`: the page scrolls inside itself (the feed's stream), so the box
/// takes the frame's height. Otherwise the page scrolls the shell's own frame, whose position is
/// remembered while the page is in view, set back to the top for the post opened over it, and put
/// back when the page returns.
export const KeptLayer = ({ visible, fill = false, children }) => {
    const box = useRef(null);
    const saved = useRef(0);
    const frameOf = () => box.current && box.current.closest('.app-frame-inner');
    useEffect(() => {
        const frame = frameOf();
        if (!frame || !visible) return undefined;
        const note = () => {
            saved.current = frame.scrollTop;
        };
        frame.addEventListener('scroll', note, { passive: true });
        return () => frame.removeEventListener('scroll', note);
    }, [visible]);
    useLayoutEffect(() => {
        const frame = frameOf();
        if (!frame) return;
        frame.scrollTop = visible ? saved.current : 0;
    }, [visible]);
    const cls = ['kept-page', fill && 'kept-page-fill', !visible && 'kept-page-under']
        .filter(Boolean)
        .join(' ');
    return html`<div ref=${box} class=${cls} inert=${!visible} aria-hidden=${visible ? undefined : 'true'}>
        ${children}
    </div>`;
};

/// A kept page's route: the page is drawn beside the router (`KeptLayer`), so its route draws
/// nothing - every child of the router must still be a route.
export const KeptRoute = () => null;
