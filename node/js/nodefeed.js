// The node's front page (UNAUTHED.md, slice 2): what a stranger sees at `/` - every listed
// persona's open posts and shares, newest first, on the feed's own body over the node
// door (nodeface.rs). No composer, no fresh bar, no dial: there is no reader here.
import { h } from 'preact';
import htm from 'htm';

import { FeedStream } from './apps/feed.js';
import { t } from './i18n.js';

const html = htm.bind(h);

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
        />
    </div>
`;
