import { h, render } from 'preact';
import htm from 'htm';
import { LocationProvider, Router, useLocation, ErrorBoundary } from 'preact-iso';

import { useSession, Welcome } from './auth.js';
import {
    usePersona,
    NullState,
    SpareKeyCeremony,
    NamePicker,
    JoinFlow,
    PersonaBadge,
    PersonaHome,
    Profile,
    usePersonaName,
} from './persona.js';
import { Computers } from './computers.js';
import { DocsApp } from './notes.js';
import { Console } from './console.js';
import { docApps, appById, appLabel } from './apps.js';
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

    // The bar shows the *persona* once one is open; the account username recedes into a
    // hover title - the account never gets a noun (GLOSSARY, Cozyweb language mapping).
    // Left: app navigation (back to the console). Right: who you are + a gear into persona
    // management (profile, your computers, log out all live under /home/persona now).
    const bar = html`
        <header class="session-bar">
            ${/* An open app carries its own close in the unified header, so the footer only shows
                a way out for shell routes that DON'T get that header (persona management, a
                not-found) - which would otherwise be stranded. The empty span keeps identity right. */ ''}
            <span class="session-nav">
                ${open && inApp && !appHere &&
                html`<button class="session-out" onClick=${() => loc.route('/home')}><${Icons.back} /> apps</button>`}
            </span>
            <span class="session-identity" title="signed in as ${session.account.username}">
                ${open
                    ? html`<${PersonaBadge} current=${persona.current} />`
                    : html`<span class="session-who">hi, ${session.account.username}</span>`}
                ${open &&
                html`<button
                    class="session-gear"
                    title="persona &amp; settings"
                    onClick=${() => loc.route('/home/persona')}
                ><${Icons.gear} /></button>`}
            </span>
        </header>
    `;

    // The unified app header: a solid ink band (the frame colour) atop every app - its title on
    // the left, back/close on the right - so no app draws its own top bar. Back appears only
    // inside a document (return to the app's list); close leaves the app for the launcher. Absent
    // for persona/not-found (appHere null), which carry their own heads.
    const appHeader =
        appHere &&
        html`<header class="app-header">
            <span class="app-header-title"><${appHere.icon} /> ${appLabel(appHere, personaName)}</span>
            <span class="app-header-actions">
                ${inDoc &&
                html`<button
                    class="app-header-btn"
                    title="back to the list"
                    onClick=${() => loc.route('/home/' + appHere.id)}
                ><${Icons.back} /> back</button>`}
                <button
                    class="app-header-btn"
                    title="close this app"
                    onClick=${() => loc.route('/home')}
                ><${Icons.close} /> close</button>
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
