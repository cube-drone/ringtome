// The console: the root point after you open a persona, a launcher of applications (see
// PROJECT_PLAN, The Client Is a Console of Applications). It knows an application only as a
// tile - id, name, icon, tagline - which is the generic boundary the whole vision rests on,
// kept honest even at this baby scale. Today only Notes is real; this list is where a recipe
// book, a journal, a blog will move in over time.
import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

export const APPS = [
    {
        id: 'notes',
        name: 'Notes',
        icon: '📝',
        tagline: 'jot, draft, and keep your documents',
    },
];

export const Console = ({ onLaunch }) => html`
    <div class="console">
        <h1 class="console-title">your applications</h1>
        <div class="console-grid">
            ${APPS.map(
                (app) => html`<button
                    class="app-tile"
                    key=${app.id}
                    onClick=${() => onLaunch(app.id)}
                >
                    <span class="app-tile-icon">${app.icon}</span>
                    <span class="app-tile-name">${app.name}</span>
                    <span class="app-tile-tagline">${app.tagline}</span>
                </button>`
            )}
        </div>
        <p class="console-more">more applications will move in over time.</p>
    </div>
`;
