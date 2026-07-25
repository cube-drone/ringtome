import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { LocationProvider, ErrorBoundary } from 'preact-iso';

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

const html = htm.bind(h);

// The signed-in shell: which persona is loaded decides everything past the session bar.
const Inside = ({ session }) => {
    const persona = usePersona(session.account);
    const [view, setView] = useState('home'); // 'home' | 'computers'

    // The bar shows the *persona* once one is open; the account username recedes into a
    // hover title - the account never gets a noun (GLOSSARY, Cozyweb language mapping).
    const open = persona.state === 'open';
    const bar = html`
        <header class="session-bar">
            <span title="signed in as ${session.account.username}">
                ${open
                    ? html`<${PersonaBadge} current=${persona.current} />`
                    : html`<span class="session-who">hi, ${session.account.username}</span>`}
            </span>
            <span class="session-actions">
                ${open &&
                html`<button
                    class="session-out"
                    onClick=${() => setView(view === 'computers' ? 'home' : 'computers')}
                >${view === 'computers' ? 'back home' : 'your computers'}</button>`}
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

    if (view === 'computers') {
        return html`${bar}<${Computers} current=${persona.current} />`;
    }
    // Home is the notes app - the flagship (NOTES_APP.md). The cozy-OS window dressing
    // arrives with the shell; for now the app IS the desktop.
    return html`${bar}<${Notes} current=${persona.current} />`;
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
        <${LocationProvider}>
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
