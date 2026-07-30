// The composition root: the front door, the signed-in shell, and the router - wiring, and as little
// else as this can get away with. Everything that used to be implemented here now lives beside its
// own concern: the bucket switcher and its state machine in buckets.js, the corner clock in
// clock.js, Swatch time in swatch.js, the documents-app spine in doc/docapp.js.
//
// Routes are session-relative and identity-free by design (PROJECT_PLAN, The Client Is a Console).
// The whole internal UI lives under /home: `/home` is the console, `/home/<app>[/<doc>]` an app, and
// `/home/persona[/profile|/computers]` is identity management. Root bounces to /home, which keeps
// the bare paths free for the API and a future public face.
import { h, render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { LocationProvider, Router, useLocation, ErrorBoundary } from 'preact-iso';

import { useSession, Welcome } from './auth.js';
import {
    usePersona,
    NullState,
    SpareKeyCeremony,
    NamePicker,
    JoinFlow,
    PersonaHome,
    Profile,
    usePersonaName,
} from './persona.js';
import { Computers } from './computers.js';
import { DocsApp } from './apps/notes.js';
import { JournalApp } from './apps/journal.js';
import { WikiApp } from './apps/wiki.js';
import { Console } from './console.js';
import { liveApps, appById, appLabel, appTypeOf, appForStyle } from './apps.js';
import { BucketSwitcher, useBucketChoice } from './buckets.js';
import { Clock } from './clock.js';
import { openMirror, useLive } from './mirror.js';
import { resolveSlugPath } from './doc/address.js';
import { slugify, HEX_ID } from './doc/naming.js';
import { Icons, IconContext, iconFor } from './icons.js';

const html = htm.bind(h);

// Nothing lives at this address. Internal URLs are session-relative (no identity in them, so
// they never look shareable - PROJECT_PLAN, The Client Is a Console); an unknown one just
// sends you home.
const NotFound = () => html`
    <div class="console">
        <p class="null-sub">
            there's nothing at this address.
            ${' '}<a href="/home">back to your applications</a>.
        </p>
    </div>
`;

// EVERY document-app path renders here - /home/<app>, /home/<app>/<hex>, /home/<app>/<slug>,
// and the deep cozy forms alike - as the Router's default, so navigating between documents
// (whatever the URL's shape) reconciles ONE mounted component instead of bouncing between
// routes. That's the anti-jitter: the list, tags, tree, and column widths hold still while
// only the document pane changes; per-app routes used to lose the whole structure the moment
// a cozy path picked up a taxonomy segment. App-id + hex (and bare-app) paths resolve
// SYNCHRONOUSLY - no intermediate frame at all; cozy forms resolve async while the PREVIOUS
// view stays painted, so "looking that up" shows only on a cold deep link. The doc apps are
// keyed by app id: same app reconciles (state holds), switching apps remounts (state resets -
// deliberately, the per-app guards assume it).
const SlugRoute = ({ current, searchQuery, bucket }) => {
    const loc = useLocation();
    // Async resolutions are TAGGED with the path they answered, and the last actually-PAINTED
    // view rides a ref. Both are load-bearing (field-tested 2026-07-29): a bare
    // `syncHit || resolved` fallback once flashed the PREVIOUS document during the hex->cozy
    // re-dress - the freshest async resolution was one document old, and for a beat it won.
    // Mid-flight, the user keeps seeing exactly what they last saw; a resolution for a path
    // we've already left is ignored at render, not just at set.
    const [resolved, setResolved] = useState(null); // { path, hit: {appId,docId} | 'nope' }
    const lastView = useRef(null);
    const segs = loc.path.split('/').filter(Boolean).slice(1); // drop the 'home'
    const app0 = segs.length ? appById(segs[0]) : null;
    const syncHit =
        app0 && segs.length === 1
            ? { appId: app0.id, docId: null }
            : app0 && segs.length === 2 && HEX_ID.test(segs[1])
            ? { appId: app0.id, docId: segs[1] }
            : null;
    useEffect(() => {
        if (syncHit) return; // exact already - nothing to resolve
        let alive = true;
        const path = loc.path;
        resolveSlugPath(current.root, segs)
            .then((h) =>
                alive &&
                setResolved({ path, hit: h ? { appId: h.appId, docId: h.docId } : 'nope' })
            )
            .catch(() => alive && setResolved({ path, hit: 'nope' }));
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loc.path]);
    const fresh = resolved && resolved.path === loc.path ? resolved.hit : null;
    const view = syncHit || fresh || lastView.current;
    if (view && view !== 'nope') lastView.current = view;
    if (!view) {
        return html`<div class="console"><p class="null-sub">looking that up…</p></div>`;
    }
    if (view === 'nope') return html`<${NotFound} />`;
    const app = appById(view.appId);
    if (!app) return html`<${NotFound} />`;
    if (app.journal) {
        // The journal has no per-document view; the entry lives in its stream.
        return html`<${JournalApp}
            key=${app.id}
            current=${current}
            searchQuery=${searchQuery}
            bucket=${bucket}
        />`;
    }
    if (app.wiki) {
        return html`<${WikiApp}
            key=${app.id}
            app=${app}
            current=${current}
            docId=${view.docId}
            searchQuery=${searchQuery}
            bucket=${bucket}
        />`;
    }
    return html`<${DocsApp}
        key=${app.id}
        app=${app}
        current=${current}
        docId=${view.docId}
        searchQuery=${searchQuery}
        bucket=${bucket}
    />`;
};


// The signed-in shell: which persona is loaded decides everything past the session bar. Once a
// persona is open, routing takes over. The whole internal UI lives under /home (root bounces
// there, and stays free for the API / a future public face): `/home` is the console,
// `/home/notes[/<doc_id>]` the notes app, and `/home/persona[/profile|/computers]` is identity
// management (reached by the dock's persona tile). Routes are session-relative and identity-free by
// design (PROJECT_PLAN, The Client Is a Console).
const Inside = ({ session }) => {
    const persona = usePersona(session.account);
    const loc = useLocation();
    const open = persona.state === 'open';
    const inApp = loc.path !== '/home';

    // Which app the shell is showing (from `/home/<app>/<doc?>`), and whether a document is open
    // inside it - the two facts the unified app header needs. Null for persona/not-found routes,
    // which keep their own heads and so get no app header. A first segment that isn't an app id
    // may be a BUCKET's slug - a cozy address at rest (doc/naming.js) - resolved off the live roster:
    // the app is the bucket's rail, and the URL itself names the bucket.
    const root = persona.current && persona.current.root;
    const roster = useLive(() => (root ? openMirror(root).buckets.toArray() : []), [root]);
    const pathParts = loc.path.split('/'); // ['', 'home', '<app-or-bucket>', '<doc?>']
    const seg = pathParts[2] || '';
    const appDirect = appById(seg);
    const cozyBucketRow =
        !appDirect && seg ? (roster || []).find((b) => slugify(b.name) === seg) || null : null;
    const appHere =
        appDirect || (cozyBucketRow ? appForStyle(appTypeOf(cozyBucketRow.name, roster)) : null);
    const inDoc = !!(appHere && pathParts[3]);

    // The Persona app wears the current persona's name (live), everywhere its label shows - the
    // console tile and the app header. '' until a persona is open or named, and then `appLabel`
    // falls the Persona tile back to "Persona".
    const personaName = usePersonaName(persona.current);

    // Search is a top-level, consistent feature: its box lives in the app header (not buried in a
    // column), the same place across every app that offers it. The query is lifted here so the
    // header owns the input and the app reads it; it clears when you switch apps. Only document
    // apps (those with a `style`) offer search.
    const showSearch = !!(appHere && appHere.style);
    const [query, setQuery] = useState('');
    useEffect(() => {
        setQuery('');
    }, [appHere && appHere.id]);

    // The bucket in view, and the way to change it (buckets.js owns the state machine: the
    // last-open memory, cozy addresses outranking it, and the deep-link correction).
    const { bucket, switchBucket } = useBucketChoice({
        root,
        appHere,
        roster,
        cozyBucketRow,
        docSegment: pathParts[3],
    });

    // The Quickbar: the persistent bottom bar, now purely the app dock - a hexagon per app (icon
    // only, the console glyphs without their names), a fast switch between apps. The tiles run
    // TALLER than the bar and bottom-align, so their teal rim pokes up above it; within the bar
    // that rim is the same teal as the backdrop and vanishes, so it only reads on the part above.
    // The user's own tile (Persona, first) runs a little bigger. Persona being the first tile is
    // why there's no name or gear on the right - the persona tile IS both.
    const bar = html`
        <footer class="quickbar">
            <span class="quickbar-apps">
                ${open &&
                liveApps.map((app) => {
                    const isActive = !!(appHere && appHere.id === app.id);
                    // Clicking the app you're already in closes it (back to the launcher).
                    return html`<button
                        class=${[
                            'quickbar-hex',
                            app.id === 'persona' ? 'quickbar-hex-lead' : '',
                            isActive ? 'active' : '',
                        ]
                            .filter(Boolean)
                            .join(' ')}
                        key=${app.id}
                        title=${appLabel(app, personaName)}
                        onClick=${() => loc.route(isActive ? '/home' : '/home/' + app.id)}
                    ><span class="quickbar-hex-face"><${iconFor(app)} /></span></button>`;
                })}
            </span>
            <${Clock} />
        </footer>
    `;

    // The unified app header: a solid ink band (the frame colour) atop every app - its title on
    // the left, back/close on the right - so no app draws its own top bar. Back appears only
    // inside a document (return to the app's list); close leaves the app for the launcher. Absent
    // for persona/not-found (appHere null), which carry their own heads.
    const appHeader =
        appHere &&
        html`<header class="app-header">
            <span class="app-header-lead">
                <span class="app-header-title">${appLabel(appHere, personaName)}</span>
                ${!!appHere.style &&
                html`<${BucketSwitcher}
                    root=${root}
                    app=${appHere}
                    roster=${roster}
                    bucket=${bucket}
                    onSwitch=${switchBucket}
                />`}
            </span>
            ${showSearch &&
            html`<input
                class="app-header-search"
                type="search"
                placeholder="search…"
                value=${query}
                onInput=${(e) => setQuery(e.currentTarget.value)}
            />`}
            <span class="app-header-actions">
                ${inDoc &&
                html`<button
                    class="app-header-btn"
                    title="back to the list"
                    onClick=${() => loc.route('/home/' + appHere.id)}
                ><${Icons.back} /></button>`}
                <button
                    class="app-header-btn app-header-btn-square"
                    title="close this app"
                    onClick=${() => loc.route('/home')}
                ><${Icons.close} /></button>
            </span>
        </header>`;

    // Two wrappers over the same footer. `shell` is the bordered app frame (an app is open): the
    // ink header band, then the surface content. `stage` is the bare desktop - the app selector
    // and pre-persona flows, which aren't apps and so get no shell. Either way the footer (`bar`)
    // renders after, and the flex column in `.app-main` stacks the region above it.
    const shell = (content) =>
        html`<div class="app-frame">
            ${appHeader}
            <div class="app-frame-inner">${content}</div>
        </div>${bar}`;
    const stage = (content) => html`<div class="app-stage">${content}</div>${bar}`;

    // The persona lifecycle preempts routing - you can't reach any app without an open persona,
    // whatever the URL says. These onboarding flows aren't apps either, so they ride the stage.
    if (persona.state === 'checking') {
        return stage(html`<div class="loading-shell"><p>Loading…</p></div>`);
    }
    if (persona.state === 'ceremony') {
        return stage(html`<${SpareKeyCeremony} persona=${persona} />`);
    }
    if (persona.state === 'naming') {
        return stage(html`<${NamePicker} persona=${persona} account=${session.account} />`);
    }
    if (persona.state === 'join') {
        return stage(html`<${JoinFlow} persona=${persona} />`);
    }
    if (persona.state === 'none') {
        return stage(html`<${NullState} persona=${persona} />`);
    }

    // Once open, the URL is honored (a deep link survives the flow). The console lives at `/home`
    // on the bare stage; an open app (any deeper route) gets the shell. `inApp` is that line.
    const routed = html`
        <${Router}>
            <${Console}
                path="/home"
                onLaunch=${(id) => loc.route('/home/' + id)}
                personaName=${personaName}
            />
            <${PersonaHome} path="/home/persona" persona=${persona} session=${session} />
            <${Profile} path="/home/persona/profile" current=${persona.current} />
            <${Computers} path="/home/persona/computers" current=${persona.current} />
            <${SlugRoute} default current=${persona.current} searchQuery=${query} bucket=${bucket} />
        </${Router}>
    `;
    return inApp ? shell(routed) : stage(routed);
};

const App = () => {
    const session = useSession();

    // First paint: don't flash the front door at someone who's already in.
    if (session.checking) {
        return html`<div class="app-main"><div class="loading-shell"><p>Loading…</p></div></div>`;
    }

    if (!session.account) {
        return html`<div class="app-main"><${Welcome} session=${session} /></div>`;
    }

    return html`
        <${LocationProvider} scope="/home">
            <${ErrorBoundary} onError=${error => console.error(error)}>
                <div class="app-main">
                    <${Inside} session=${session} />
                </div>
            </${ErrorBoundary}>
        </${LocationProvider}>
    `;
};

function main() {
    let app = document.getElementById('app');
    console.log("Ringtome UI loaded!");
    // One provider at the root sets the house icon style: Phosphor, DUOTONE, sized to the font
    // (1em, so the containers' existing font-size rules size the glyphs), in currentColor. The
    // provider value REPLACES Phosphor's defaults rather than merging, so size lives here too; the
    // `ph` class is the hook the stylesheet uses to seat the glyphs on the text baseline.
    render(
        html`<${IconContext.Provider}
            value=${{ weight: 'duotone', size: '1em', className: 'ph' }}
        ><${App} /></${IconContext.Provider}>`,
        app
    );
}

main();
