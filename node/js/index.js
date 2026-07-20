import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { LocationProvider, ErrorBoundary, Router, Route } from 'preact-iso';

const html = htm.bind(h);

const Home = () => {
    const [pulse, setPulse] = useState(true);

    useEffect(() => {
        const id = setInterval(() => setPulse(p => !p), 2000);
        return () => clearInterval(id);
    }, []);

    return html`
        <div class="page home-page">
            <h1>Ringtome</h1>
            <p class="subtitle">Hello, World!</p>
            <div class="status-dot ${pulse ? 'pulse' : ''}"></div>
            <p class="hint">The node UI lives here. Start building!</p>
        </div>
    `;
};

const App = () => html`
    <${LocationProvider}>
        <${ErrorBoundary} onError=${error => console.error(error)}>
            <div class="app-main">
                <${Router}>
                    <${Route} path="/" component=${Home} />
                    <${Route} path="/home" component=${Home} />
                    <${Route} path="/home/*" component=${Home} />
                </${Router}>
            </div>
        </${ErrorBoundary}>
    </${LocationProvider}>
`;

function main() {
    let app = document.getElementById('app');
    console.log("Ringtome UI loaded!");
    render(html`<${App} />`, app);
}

main();
