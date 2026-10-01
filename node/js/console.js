// The console: the root point after you open a persona, a launcher of applications (see
// PROJECT_PLAN, The Client Is a Console of Applications). The app registry lives in pure/apps.js;
// `live` apps launch; `blank` cells fill out the honeycomb.
import { h } from 'preact';
import htm from 'htm';

import { consoleCellsFor, appLabel } from './pure/apps.js';
import { tileLabel } from './pure/tilelabel.js';
import { iconFor } from './icons.js';
import { isDevice } from './net.js';
import { t } from './i18n.js';
import { useNarrow } from './panes.js';

const html = htm.bind(h);

// Hexagons pack into a honeycomb: fixed-width rows, every other row shifted half a cell so the
// cells nestle. The rows are chunked here rather than left to wrap - a honeycomb over a
// free-wrapping list is fragile, since the half-cell shift needs to know which cells share a
// row. Fixed columns is the price; a launcher is a fine place to pay it. Two in a narrow window
// (under 900px, where the columns become tabs; Curtis, 2026-09-30: "it can only reasonably support
// two apps per row"), the tiles sized to the screen (console.css).
const COLUMNS = 4;
const NARROW_COLUMNS = 2;

function chunk(arr, n) {
    const rows = [];
    for (let i = 0; i < arr.length; i += n) rows.push(arr.slice(i, i + n));
    return rows;
}

/// What each app is for, in a line - the tile's tooltip, under its name (Curtis, 2026-09-27: a
/// tooltip that only restated the name on the tile said nothing). Chosen here rather than kept in
/// the registry, which is pure and speaks no language; a switch, so every phrase is a literal the
/// strings tool can see.
function appBlurb(app, device) {
    switch (app.id) {
        case 'persona':
            return t('console.blurb-persona', 'you: your profile, your personas, your computers and your settings');
        case 'drawing':
            return t('console.blurb-drawing', 'draw and publish pictures of mostly horses');
        case 'people':
            return t('console.blurb-people', 'the people you know, follow and trust');
        case 'notes':
            return t('console.blurb-notes', 'your notebooks: private pages, published when you choose');
        case 'feed':
            return t('console.blurb-feed', "horse-based social networking: check what's happening on the information superhorseway");
        case 'chat':
            return t('console.blurb-chat', 'rooms, and private conversations');
        case 'notifications':
            return t('console.blurb-notifications', 'notifications, pings, pokes, and other things that might be of interest');
        case 'bank':
            return t('console.blurb-bank', 'your horse capital: every HorseBuck, and where it came from');
        case 'lost-found':
            return t('console.blurb-lost-found', 'every private file from every notebook, where nothing gets lost');
        case 'device':
            return device
                ? t('console.blurb-device', "this computer's settings: who may sign up, and its backups")
                : t('console.blurb-server', "this server's settings: who may sign up, and its backups");
        default:
            return '';
    }
}

// One heptagon: three nested clipped layers make the double border - the outer carries the dark
// ring, the middle the lighter ring, the face the surface and content.
function Hex(app, key, onLaunch, personaName, me) {
    // A long name SHRINKS rather than being cut - the rule and its calibration live in
    // pure/tilelabel.js. The full name still lives in the header and the tooltip either way.
    const label = appLabel(app, personaName, isDevice()) || '';
    const { text, scale } = tileLabel(label);
    const blurb = app.blank ? '' : appBlurb(app, isDevice());
    // The persona's own tile wears their face (Curtis, 2026-09-27): the picture fills it, under
    // the nameplate, and the rings take their colour. A picture of their own needs no name over it
    // (2026-09-30) - the nameplate is for the identicon, which says nothing about who - and the
    // tooltip names them either way.
    const face = app.id === 'persona' && me ? me : null;
    const named = !face || !face.pictured;
    const content = app.blank
        ? ''
        : html`
              ${face ? html`<img class="app-tile-face" src=${face.src} alt="" />` : html`<span class="app-tile-icon"><${iconFor(app, isDevice())} /></span>`}
              ${named &&
              html`<span
                  class="app-tile-name"
                  style=${scale === 1 ? undefined : `font-size: ${scale}rem`}
              >${text}</span>`}
          `;
    const stack = html`<span class="hex-mid"><span class="hex-face">${content}</span></span>`;
    // The whole tile's tooltip, not just the nameplate's: its name, and what it is for.
    const tip = app.blank ? undefined : blurb ? `${label}\n${blurb}` : label;
    const cls = app.blank ? 'app-tile blank' : face ? 'app-tile app-tile-me' : 'app-tile';
    const style = face ? `--me-ring: ${face.ring}; --me-rim: ${face.rim}` : undefined;
    return app.live
        ? html`<button class=${cls} style=${style} key=${key} title=${tip} onClick=${() => onLaunch(app.id)}>${stack}</button>`
        : html`<div class=${cls} style=${style} key=${key} title=${tip}>${stack}</div>`;
}

export const Console = ({ onLaunch, personaName, me, admin }) => {
    const columns = useNarrow() ? NARROW_COLUMNS : COLUMNS;
    const rows = chunk(consoleCellsFor(admin, columns), columns);
    return html`
        <div class="console">
            <div class="hex-comb">
                ${rows.map(
                    (row, ri) => html`
                        <div class=${ri % 2 ? 'hex-row shift' : 'hex-row'} key=${ri}>
                            ${row.map((app, ci) =>
                                Hex(app, ri * columns + ci, onLaunch, personaName, me)
                            )}
                        </div>
                    `
                )}
            </div>
        </div>
    `;
};
