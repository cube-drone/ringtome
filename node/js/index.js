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
} from './persona.js';
import { Computers } from './computers.js';
import { Notes } from './notes.js';
import { Console } from './console.js';

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
// there, and stays free for the API / a future public face): `/home` is the console, `/home/
// notes[/<doc_id>]` the notes app, `/home/computers` the system view. Routes are session-
// relative and identity-free by design (PROJECT_PLAN, The Client Is a Console).
const Inside = ({ session }) => {
    const persona = usePersona(session.account);
    const loc = useLocation();
    const open = persona.state === 'open';
    const inApp = loc.path !== '/home';

    // The bar shows the *persona* once one is open; the account username recedes into a
    // hover title - the account never gets a noun (GLOSSARY, Cozyweb language mapping).
    const bar = html`
        <header class="session-bar">
            <span title="signed in as ${session.account.username}">
                ${open
                    ? html`<${PersonaBadge} current=${persona.current} />`
                    : html`<span class="session-who">hi, ${session.account.username}</span>`}
            </span>
            <span class="session-actions">
                ${open &&
                (inApp
                    ? html`<button class="session-out" onClick=${() => loc.route('/home')}>◀ apps</button>`
                    : html`<button class="session-out" onClick=${() => loc.route('/home/computers')}>your computers</button>`)}
                <button
                    class="session-out"
                    onClick=${async () => {
                        // Heading out forgets this browser: stream stopped, mirror dropped -
                        // a signed-out browser keeps no copy of anyone's things.
                        await persona.shutdown();
                        session.logout();
                    }}
                >head out</button>
            </span>
        </header>
    `;

    // The persona lifecycle preempts routing - you can't reach any app without an open persona,
    // whatever the URL says. Once open, the URL is honored (a deep link survives the flow).
    if (persona.state === 'checking') {
        return html`${bar}<div class="loading-shell"><p>Loading…</p></div>`;
    }
    if (persona.state === 'ceremony') {
        return html`${bar}<${SpareKeyCeremony} persona=${persona} />`;
    }
    if (persona.state === 'naming') {
        return html`${bar}<${NamePicker} persona=${persona} account=${session.account} />`;
    }
    if (persona.state === 'join') {
        return html`${bar}<${JoinFlow} persona=${persona} />`;
    }
    if (persona.state === 'none') {
        return html`${bar}<${NullState} persona=${persona} />`;
    }

    return html`
        ${bar}
        <${Router}>
            <${Console} path="/home" onLaunch=${(id) => loc.route('/home/' + id)} />
            <${Notes} path="/home/notes/:docId?" current=${persona.current} />
            <${Computers} path="/home/computers" current=${persona.current} />
            <${NotFound} default />
        </${Router}>
    `;
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
    render(html`<${App} />`, app);
}

main();
