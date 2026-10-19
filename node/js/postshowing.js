// Whether a single post holds the screen (Curtis, 2026-10-19): the header's search box has
// nothing to narrow there, so the shell hides it. Told by the post's page itself rather than
// guessed from the address, because a post has many - its id under /post/, its path under an
// @name, a group's, an author's own domain - and some of them only become a post once the node
// has looked the path up. A count, not a flag: one post's page leaving as the next arrives
// never reads as none.
import { useState, useEffect, useLayoutEffect } from 'preact/hooks';

let showing = 0;
const watchers = new Set();
const tell = () => watchers.forEach((watch) => watch(showing > 0));

/// Said by a post's page while it is mounted.
export function useShowsAPost() {
    useLayoutEffect(() => {
        showing += 1;
        tell();
        return () => {
            showing -= 1;
            tell();
        };
    }, []);
}

/// True while any post's page is mounted.
export function usePostShowing() {
    const [on, setOn] = useState(showing > 0);
    useEffect(() => {
        watchers.add(setOn);
        setOn(showing > 0);
        return () => watchers.delete(setOn);
    }, []);
    return on;
}
