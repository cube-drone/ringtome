// The node's front page (PROJECT_PLAN's The node's public face, slice 2): what a stranger sees at `/` - every listed
// persona's open posts and shares, newest first, on the feed's own body over the node
// door (nodeface.rs). No composer, no fresh bar, no dial: there is no reader here.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { useLocation } from 'preact-iso';

import { FeedStream } from './apps/feed.js';
import { PostEntry } from './postentry.js';
import { api } from './net.js';
import { t } from './i18n.js';

const html = htm.bind(h);

// An empty front page (Curtis, 2026-09-16): a stranger can neither follow nor write, so the
// null state is the door to signing in or making a persona.
const EmptyNode = () => {
    const loc = useLocation();
    return html`<p class="null-sub">
        ${t('nodefeed.nobody-has-said-anything', 'nobody has said anything on this node yet.')}
        ${' '}
        <a href="/home" onClick=${(e) => { e.preventDefault(); loc.route('/home'); }}>${t('nodefeed.sign-in-or-make-a-persona', 'sign in, or make a persona here')}</a>
    </p>`;
};

export const NodeFeed = ({ current, searchQuery }) => html`
    <div class="feed-app node-feed">
        <h2 class="public-posts-head">${t('apps.nodefeed.on-this-node', 'on this node')}</h2>
        <${FeedStream}
            root=${null}
            current=${current || null}
            contacts=${[]}
            feedUrl="/api/node/feed"
            labelsUrl="/api/node/feed/labels"
            dial=${false}
            picksKey="node:feed"
            searchQuery=${searchQuery}
            nullState=${html`<${EmptyNode} />`}
        />
    </div>
`;

/// The front door's newest posts (Curtis, 2026-09-28): the node feed's first ten, as the feed
/// shows them, and the way on to the rest. Nothing at all on a node where nobody has posted.
export const RecentPosts = ({ limit = 10 }) => {
    const loc = useLocation();
    const [items, setItems] = useState(undefined);
    useEffect(() => {
        let live = true;
        api(`/api/node/feed?limit=${limit}`)
            .then((r) => live && setItems(r.items || []))
            .catch(() => live && setItems([]));
        return () => {
            live = false;
        };
    }, [limit]);
    if (!items || items.length === 0) return null;
    return html`<section class="front-shelf feed-app">
        <h2 class="front-shelf-title">${t('nodefeed.lately-on-this-node', 'lately on this node')}</h2>
        ${items.map((item) => html`<${PostEntry} key=${`${item.author}:${item.doc_id}`} item=${item} current=${null} />`)}
        <a
            class="front-more"
            href="/feed"
            onClick=${(e) => {
                e.preventDefault();
                loc.route('/feed');
            }}
        >${t('nodefeed.see-more', 'see more...')}</a>
    </section>`;
};
