import { h, render } from 'preact';
import htm from 'htm';
import { LocationProvider, ErrorBoundary, Router, Route } from 'preact-iso';
import { Marquee } from '@cube-drone/marquee-react-renderer';

import { useSession, Welcome } from './auth.js';

const html = htm.bind(h);

const SAMPLE_MARQUEE = `
# Ringtome

Welcome to **Ringtome** — a cozy p2p retro-web social network.

[rainbow by=letter]IRC-flavored chat, bulletin boards, geocities-style pages,
webrings, hit counters, MIDI files.[/rainbow]

---

## What is this?

This is the *node UI* — the web interface served by a Ringtome connector node.
Right now it's a [font=press-start]Hello World[/font], but it will grow into
the full experience.

## Some Marquee Demos

### Fonts

* [font=press-start]Press Start 2P[/font]
* [font=vt323]VT323 — the classic terminal[/font]
* [font=silkscreen]Silkscreen — pixel-perfect[/font]
* [font=comic-neue]Comic Neue — no apologies[/font]
* [font=creepster]Creepster — spooky vibes[/font]

### Animations

* [blink]blink[/blink]
* [bounce]bounce[/bounce]
* [wave by=letter]a true undulating wave[/wave]
* [jitter by=letter]scattered nerves[/jitter]
* [marquee][rainbow by=letter]still open at 3am[/rainbow][/marquee]

### Sizes

* [teeny]teeny[/teeny]
* [small]small[/small]
* normal
* [big]big[/big]
* [huge]huge[/huge]
* [enormous]ENORMOUS[/enormous]

### Colors

* [color=goldenrod]goldenrod[/color]
* [color=#f06]hot pink[/color]
* [color=dodgerblue]dodger blue[/color]

### Code

\`\`\`
fn main() {
    println!("Hello from Ringtome!");
}
\`\`\`

> Every line of the quote is marked,
> line by line — you need to include
> the \`>\` symbol on every line.

---

[typewriter speed=30]This page is rendered live by the Marquee interactive React renderer,
running under Preact via preact/compat.[/typewriter]
`;

const Home = () => {
    return html`
        <div class="marquee-page">
            <${Marquee} source=${SAMPLE_MARQUEE} animate="visible" />
        </div>
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
        <${LocationProvider}>
            <${ErrorBoundary} onError=${error => console.error(error)}>
                <div class="app-main">
                    <header class="session-bar">
                        <span class="session-who">hi, ${session.account.username}</span>
                        <button class="session-out" onClick=${session.logout}>head out</button>
                    </header>
                    <${Router}>
                        <${Route} path="/" component=${Home} />
                        <${Route} path="/home" component=${Home} />
                        <${Route} path="/home/*" component=${Home} />
                    </${Router}>
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
