// The console: the root point after you open a persona, a launcher of applications (see
// PROJECT_PLAN, The Client Is a Console of Applications). The app registry lives in apps.js;
// `live` apps launch, `soon` are placeholders, `blank` cells fill the honeycomb.
import { h } from 'preact';
import htm from 'htm';

import { APPS } from './apps.js';

const html = htm.bind(h);

// Hexagons pack into a honeycomb: fixed-width rows, every other row shifted half a cell so the
// cells nestle. The rows are chunked here rather than left to wrap - a honeycomb over a
// free-wrapping list is fragile, since the half-cell shift needs to know which cells share a
// row. Fixed columns is the price; a launcher is a fine place to pay it.
const COLUMNS = 4;

function chunk(arr, n) {
    const rows = [];
    for (let i = 0; i < arr.length; i += n) rows.push(arr.slice(i, i + n));
    return rows;
}

// One hexagon: three nested clipped layers make the double border - the outer carries the dark
// ring, the middle the lighter ring, the face the surface and content.
function Hex(app, key, onLaunch) {
    const content = app.blank
        ? ''
        : html`
              <span class="app-tile-icon">${app.icon}</span>
              <span class="app-tile-name">${app.name}</span>
          `;
    const stack = html`<span class="hex-mid"><span class="hex-face">${content}</span></span>`;
    const cls = `app-tile${app.soon ? ' soon' : ''}${app.blank ? ' blank' : ''}`;
    return app.live
        ? html`<button class=${cls} key=${key} onClick=${() => onLaunch(app.id)}>${stack}</button>`
        : html`<div class=${cls} key=${key}>${stack}</div>`;
}

export const Console = ({ onLaunch }) => {
    const rows = chunk(APPS, COLUMNS);
    return html`
        <div class="console">
            <div class="hex-comb">
                ${rows.map(
                    (row, ri) => html`
                        <div class=${ri % 2 ? 'hex-row shift' : 'hex-row'} key=${ri}>
                            ${row.map((app, ci) => Hex(app, ri * COLUMNS + ci, onLaunch))}
                        </div>
                    `
                )}
            </div>
        </div>
    `;
};
