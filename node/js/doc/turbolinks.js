// Turbolink wiring: the embedder-policy chain every Marquee surface in the UI shares.
//
// The chain is marquee-turbolink's fetchless defaults (YouTube, Spotify, image/audio/video
// kinds - all derivable from the URL) plus our own OpenGraph plugin composed LAST. The
// package's own opengraphPlugin fetches target pages directly, which a browser cannot do
// (CORS); ours asks the node's /api/unfurl endpoint instead - the node fetches on our
// behalf, SSRF-guarded, globally rate-limited, and cached per URL (net::unfurl). Same
// summary shape, so the package's renderCard draws the card.
//
// Resolution is two-phase by the plugin contract: resolve() gathers (async, network),
// render() is sync over gathered data. The gathered data lives in this module's `resolved`
// map, shared by every surface - one unfurl per URL per page load, no matter how many
// editors and readers show it.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { nameToEmoji } from 'gemoji';
import { parse } from '@cube-drone/marquee-react-renderer';
import { api } from '../net.js';
import {
    composeTurbolinks,
    defaultPlugins,
    renderCard,
    resolveTargets,
    turbolinkStyles,
    turbolinkTargets,
} from '@cube-drone/marquee-turbolink';

const ogPlugin = {
    name: 'ringtome-og',
    match: (target) => /^https?:\/\//i.test(target),
    resolve: async (target) => {
        try {
            // A summary, or null for "that page has no card".
            return await api(`/api/unfurl?url=${encodeURIComponent(target)}`);
        } catch {
            return null; // refused, rate-limited, or failed: the link stays plain
        }
    },
    render: (target, { level, data }) => (data ? renderCard(target, data, level) : null),
};

const plugins = [...defaultPlugins, ogPlugin];

// One stylesheet for the whole chain, injected once - turbolinkStyles collects each
// plugin's declared skin plus the standard card's baseline.
if (typeof document !== 'undefined' && !document.getElementById('turbolink-styles')) {
    const style = document.createElement('style');
    style.id = 'turbolink-styles';
    style.textContent = turbolinkStyles(plugins);
    document.head.appendChild(style);
}

// The shared resolve cache: plugin-keyed, exactly the map composeTurbolinks consumes.
// `attempted` keeps a failed or card-less target from re-fetching every keystroke.
const resolved = new Map();
const attempted = new Set();

async function prime(targets) {
    const fresh = targets.filter((t) => !attempted.has(t));
    if (fresh.length === 0) return false;
    fresh.forEach((t) => attempted.add(t));
    const found = await resolveTargets(fresh, plugins, { concurrency: 4 });
    for (const [key, value] of found) {
        resolved.set(key, value);
    }
    return found.size > 0;
}

/// The hook a surface uses: hand it the current Marquee source, get back a profile whose
/// turbolink socket knows everything resolved so far. The profile is a fresh object each
/// time new data lands, so renderers re-render on identity change; per-keystroke re-parses
/// are cheap and re-fetch nothing (`attempted` dedupes).
export function useTurbolinks(source, format) {
    const [gen, setGen] = useState(0);
    useEffect(() => {
        if (format !== 'marquee' || !source) return;
        let doc;
        try {
            doc = parse(source);
        } catch {
            return; // a mid-edit unparsable doc resolves nothing; next parse catches up
        }
        const targets = turbolinkTargets(doc);
        if (targets.length === 0) return;
        let alive = true;
        prime(targets).then((changed) => {
            if (alive && changed) setGen((g) => g + 1);
        });
        return () => {
            alive = false;
        };
    }, [source, format]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(
        () => ({
            turbolink: composeTurbolinks(plugins, resolved),
            // The gemoji table: `:smile:` -> 😄. Marquee's emoji socket is embedder-supplied
            // by design (bareWebProfile ships no table - the spec's custom-emoji map is our
            // configuration); this is the table. Unknown slugs stay literal `:slug:`.
            emoji: (slug) => nameToEmoji[slug] || null,
        }),
        [gen]
    );
}
