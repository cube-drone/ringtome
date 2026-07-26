import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
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
import { Console } from './console.js';
import { liveApps, docApps, appById, appLabel } from './apps.js';
import { Icons, IconContext } from './icons.js';

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
    // which keep their own heads and so get no app header.
    const pathParts = loc.path.split('/'); // ['', 'home', '<app>', '<doc?>']
    const appHere = appById(pathParts[2] || '');
    const inDoc = !!(appHere && pathParts[3]);

    // The Persona app wears the current persona's name (live), everywhere its label shows - the
    // console tile and the app header. '' until a persona is open or named, and then `appLabel`
    // falls the Persona tile back to "Persona".
    const personaName = usePersonaName(persona.current);

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
                liveApps.map(
                    (app) => html`<button
                        class=${[
                            'quickbar-hex',
                            app.id === 'persona' ? 'quickbar-hex-lead' : '',
                            appHere && appHere.id === app.id ? 'active' : '',
                        ]
                            .filter(Boolean)
                            .join(' ')}
                        key=${app.id}
                        title=${appLabel(app, personaName)}
                        onClick=${() => loc.route('/home/' + app.id)}
                    ><span class="quickbar-hex-face"><${app.icon} /></span></button>`
                )}
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
            <span class="app-header-title">${appLabel(appHere, personaName)}</span>
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
            ${docApps.map(
                (app) => html`<${DocsApp}
                    path="/home/${app.id}/:docId?"
                    key=${app.id}
                    app=${app}
                    current=${persona.current}
                />`
            )}
            <${NotFound} default />
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
