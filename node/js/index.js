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
import { DocsApp } from './notes.js';
import { JournalApp } from './journal.js';
import { WikiApp } from './wiki.js';
import { Console } from './console.js';
import { liveApps, docApps, appById, appLabel, bucketsForApp, appTypeOf, appForStyle } from './apps.js';
import { openMirror, useLive } from './cache.js';
import { resolveSlugPath, slugify } from './slugs.js';
import { Icons, IconContext } from './icons.js';

const html = htm.bind(h);

// The bucket you last had open in each app, keyed `${root}:${app.id}` - the same idea (and
// lifetime) as the last-open-document memory in notes.js: an in-memory session convenience,
// forgotten on reload.
const lastBucketMemory = new Map();

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body.message || `request failed (${res.status})`);
    }
    return body;
}

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

// A path no explicit route claims gets tried as a COZY ADDRESS (slugs.js):
// /home/<bucket>/<sections…>/<title-slug>. Cozy URLs are the RESTING form - this route
// resolves the path and renders the right app in place (the hex id stays a prop, never the
// address bar); unresolved, it's honestly nothing.
const SlugRoute = ({ current, searchQuery, bucket }) => {
    const loc = useLocation();
    const [hit, setHit] = useState(undefined); // undefined = resolving, null = nothing there
    useEffect(() => {
        setHit(undefined);
        let alive = true;
        const segs = loc.path.split('/').filter(Boolean).slice(1); // drop the 'home'
        resolveSlugPath(current.root, segs)
            .then((h) => alive && setHit(h || null))
            .catch(() => alive && setHit(null));
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loc.path]);
    if (hit === undefined) {
        return html`<div class="console"><p class="null-sub">looking that up…</p></div>`;
    }
    if (hit === null) return html`<${NotFound} />`;
    const app = appById(hit.appId);
    if (!app) return html`<${NotFound} />`;
    if (app.journal) {
        // The journal has no per-document view; the entry lives in its stream.
        return html`<${JournalApp} current=${current} searchQuery=${searchQuery} bucket=${bucket} />`;
    }
    if (app.wiki) {
        return html`<${WikiApp}
            app=${app}
            current=${current}
            docId=${hit.docId}
            searchQuery=${searchQuery}
            bucket=${bucket}
        />`;
    }
    return html`<${DocsApp}
        app=${app}
        current=${current}
        docId=${hit.docId}
        searchQuery=${searchQuery}
        bucket=${bucket}
    />`;
};

// Swatch Internet Time: the day cut into 1000 ".beats" on Biel Mean Time (UTC+1, no DST). One
// beat is 86.4 seconds; @000 is midnight in Biel. Silly, beloved, exactly right for a retro-web
// corner clock. Shown to two decimals so it visibly ticks; the real local time is a hover away.
function beats(date) {
    const bmt = new Date(date.getTime() + 3600000); // shift to UTC+1 (Biel)
    const secs =
        bmt.getUTCHours() * 3600 +
        bmt.getUTCMinutes() * 60 +
        bmt.getUTCSeconds() +
        bmt.getUTCMilliseconds() / 1000;
    return (secs / 86.4) % 1000;
}

const Clock = () => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    const date = new Date(now);
    const beat = '@' + beats(date).toFixed(2).padStart(6, '0');
    return html`<span
        class="quickbar-clock"
        title=${`your time: ${date.toLocaleTimeString()}`}
    >${beat}</span>`;
};

// The bucket switcher: a doc-app is a shelf of notebooks (buckets), and this is how you move
// along the shelf. It sits in the app header next to the title: a plus (bind a fresh, empty
// notebook of this app's type), arrows that page left/right along the rail (wrapping), and the
// current bucket's name - click it for the full list, where the current one can also be deleted.
// Deleting is the heavy hammer: every document inside is tombstoned, then the bucket itself is
// undefined - hence the BIG confirm. The home bucket (the eponymous one) can't be deleted.
const BucketSwitcher = ({ root, app, roster, bucket, onSwitch }) => {
    const [menu, setMenu] = useState(false);
    const boxRef = useRef(null);

    // The menu closes on any press outside it (the usual dropdown contract).
    useEffect(() => {
        if (!menu) return;
        const onDown = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target)) setMenu(false);
        };
        document.addEventListener('pointerdown', onDown);
        return () => document.removeEventListener('pointerdown', onDown);
    }, [menu]);

    const names = bucketsForApp(app, roster);
    const at = Math.max(0, names.indexOf(bucket));
    const step = (d) => onSwitch(names[(at + d + names.length) % names.length]);
    const isHome = bucket === app.style;
    const membersOf = (name) => {
        const row = (roster || []).find((b) => b.name === name);
        return row ? row.members : 0;
    };

    const create = async () => {
        const name = (prompt(`A name for the new ${app.bucketNoun}:`) || '').trim();
        if (!name) return;
        try {
            await api(`/api/identity/${root}/buckets`, {
                method: 'POST',
                body: JSON.stringify({ name, app: app.style }),
            });
            onSwitch(name); // it exists empty right away; the roster row follows via the stream
        } catch (e) {
            alert(`couldn't create it: ${e.message}`);
        }
    };

    const destroy = async () => {
        // Count from the mirror, not the roster row - same docs the view shows.
        const docs = await openMirror(root).docs.toArray();
        const members = docs.filter((d) => (d.buckets || []).includes(bucket));
        const inside =
            members.length === 0
                ? 'It is empty - nothing else is lost.'
                : `EVERY DOCUMENT INSIDE IT - all ${members.length} of ${
                      members.length === 1 ? 'it' : 'them'
                  } - GOES TOO.`;
        if (
            !confirm(
                `DELETE THE ${app.bucketNoun.toUpperCase()} “${bucket}”?\n\n${inside}\n\n` +
                    `This is the big one. Are you sure?`
            )
        )
            return;
        setMenu(false);
        try {
            for (const d of members) {
                await api(`/api/identity/${root}/docs/${d.doc_id}`, { method: 'DELETE' });
            }
            await api(`/api/identity/${root}/buckets/${encodeURIComponent(bucket)}`, {
                method: 'DELETE',
            });
            onSwitch(app.style); // land back on the shelf's home notebook
        } catch (e) {
            alert(`couldn't delete it: ${e.message}`);
        }
    };

    return html`
        <span class="bucket-switch" ref=${boxRef}>
            <button class="bucket-btn" title="New ${app.bucketNoun}" onClick=${create}>
                <${Icons.plus} />
            </button>
            <button
                class="bucket-btn"
                title="the previous ${app.bucketNoun}"
                disabled=${names.length < 2}
                onClick=${() => step(-1)}
            ><${Icons.back} /></button>
            <button
                class="bucket-name"
                title="all of your notebooks"
                onClick=${() => setMenu((m) => !m)}
            >${bucket}</button>
            <button
                class="bucket-btn"
                title="the next ${app.bucketNoun}"
                disabled=${names.length < 2}
                onClick=${() => step(1)}
            ><${Icons.forward} /></button>
            ${menu &&
            html`<div class="bucket-menu">
                ${names.map(
                    (name) => html`<button
                        key=${name}
                        class=${name === bucket ? 'bucket-menu-item current' : 'bucket-menu-item'}
                        onClick=${() => {
                            onSwitch(name);
                            setMenu(false);
                        }}
                    >
                        <span>${name}</span>
                        <span class="bucket-menu-count">${membersOf(name)}</span>
                    </button>`
                )}
                ${!isHome &&
                html`<button class="bucket-menu-item bucket-menu-delete" onClick=${destroy}>
                    Delete this ${app.bucketNoun}…
                </button>`}
            </div>`}
        </span>
    `;
};

// The signed-in shell: which persona is loaded decides everything past the session bar. Once a
// persona is open, routing takes over. The whole internal UI lives under /home (root bounces
// there, and stays free for the API / a future public face): `/home` is the console,
// `/home/notes[/<doc_id>]` the notes app, and `/home/persona[/profile|/computers]` is identity
// management (reached by the dock gear). Routes are session-relative and identity-free by
// design (PROJECT_PLAN, The Client Is a Console).
const Inside = ({ session }) => {
    const persona = usePersona(session.account);
    const loc = useLocation();
    const open = persona.state === 'open';
    const inApp = loc.path !== '/home';

    // Which app the shell is showing (from `/home/<app>/<doc?>`), and whether a document is open
    // inside it - the two facts the unified app header needs. Null for persona/not-found routes,
    // which keep their own heads and so get no app header. A first segment that isn't an app id
    // may be a BUCKET's slug - a cozy address at rest (slugs.js) - resolved off the live roster:
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

    // The current bucket, lifted like the search query: the header owns the switcher, the app
    // reads the choice. Null means "the app's home bucket" (the eponymous one). Entering an app
    // returns you to the bucket you last had open there (the same session memory as the
    // last-open document); home when there's no memory. A cozy URL trumps everything - the
    // address names the notebook. Switching buckets while resting on a cozy address first steps
    // back to the app's own route, so the URL stops overriding the choice.
    const [bucketPick, setBucketPick] = useState(null);
    const switchBucket = (name) => {
        setBucketPick(name);
        if (root && appHere) lastBucketMemory.set(`${root}:${appHere.id}`, name);
        if (cozyBucketRow) loc.route(`/home/${appHere.id}`);
    };
    useEffect(() => {
        setBucketPick((root && appHere && lastBucketMemory.get(`${root}:${appHere.id}`)) || null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appHere && appHere.id]);
    // Resting on a cozy URL also SETTLES the pick (and the memory): stepping from the cozy
    // address to an ordinary in-app route keeps you in that notebook instead of bouncing home.
    useEffect(() => {
        if (cozyBucketRow && appHere) {
            setBucketPick(cozyBucketRow.name);
            if (root) lastBucketMemory.set(`${root}:${appHere.id}`, cozyBucketRow.name);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cozyBucketRow && cozyBucketRow.name, appHere && appHere.id]);
    const bucket =
        (cozyBucketRow && cozyBucketRow.name) || bucketPick || (appHere && appHere.style) || '';

    // Deep-link bucket correction: arriving on a document URL (a refresh, a pasted link), the
    // in-memory bucket choice is gone but the URL still names the page - and the page knows its
    // notebook. Once the mirror answers, if the current bucket doesn't hold the document, switch
    // to the doc's bucket that belongs on this app's rail. Corrected AT MOST ONCE per document
    // (the ref), so it never fights a deliberate later bucket switch made while a doc is open.
    const deepDoc = (appHere && appHere.style && pathParts[3]) || null;
    const docsRows = useLive(() => (root ? openMirror(root).docs.toArray() : []), [root]);
    const correctedFor = useRef(null);
    useEffect(() => {
        if (!deepDoc || correctedFor.current === deepDoc) return;
        if (!docsRows || !roster) return; // wait for the mirror before judging membership
        const row = docsRows.find((d) => d.doc_id === deepDoc);
        if (!row) return; // not mirrored (yet) - leave the bucket alone
        correctedFor.current = deepDoc;
        const names = row.buckets || [];
        if (names.includes(bucket)) return; // the current bucket already holds it
        if (!names.length) return; // unbucketed: the default app's home gathers it
        const target = names.find((n) => appTypeOf(n, roster) === appHere.style);
        if (target) switchBucket(target);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deepDoc, docsRows, roster, bucket, appHere && appHere.id]);

    // The Quickbar: the persistent bottom bar, now purely the app dock - a hexagon per app (icon
    // only, the console glyphs without their names), a fast switch between apps. The tiles run
    // TALLER than the bar and bottom-align, so their teal rim pokes up above it; within the bar
    // that rim is the same teal as the backdrop and vanishes, so it only reads on the part above.
    // The user's own tile (Persona, first) runs a little bigger. Persona being the first tile is
    // why the old name + gear on the right are gone - the persona tile IS both now.
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
                    ><span class="quickbar-hex-face"><${app.icon} /></span></button>`;
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
            ${docApps.map((app) =>
                app.journal
                    ? html`<${JournalApp}
                          path="/home/${app.id}"
                          key=${app.id}
                          current=${persona.current}
                          searchQuery=${query}
                          bucket=${appHere && appHere.id === app.id ? bucket : app.style}
                      />`
                    : app.wiki
                    ? html`<${WikiApp}
                          path="/home/${app.id}/:docId?"
                          key=${app.id}
                          app=${app}
                          current=${persona.current}
                          searchQuery=${query}
                          bucket=${appHere && appHere.id === app.id ? bucket : app.style}
                      />`
                    : html`<${DocsApp}
                          path="/home/${app.id}/:docId?"
                          key=${app.id}
                          app=${app}
                          current=${persona.current}
                          searchQuery=${query}
                          bucket=${appHere && appHere.id === app.id ? bucket : app.style}
                      />`
            )}
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
