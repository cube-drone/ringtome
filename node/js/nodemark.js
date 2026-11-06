// A server's face (Curtis, 2026-11-05: "can nodes use their unique node ID to generate a border
// color and a generated icon, in a square box, displayed with the node?"). A person wears the
// heptagon and a group the triangle; a node wears the square - ringed in the colour its endpoint
// id derives, holding the identicon its id draws. An endpoint id is a public key, 32 uniformly
// random bytes like a persona root, so the same pure functions read it, and the same server is the
// same face wherever it is named. `size` is mini (inline, in a line of text), row (the Network
// page's machine row) or hero (its own page).
import { h } from 'preact';
import htm from 'htm';

import { identiconUri } from './pure/identicon.js';
import { personaHue } from './pure/person.js';

const html = htm.bind(h);

const SQUARE_SIZES = { mini: 'node-mark-mini', row: 'node-mark-row', hero: 'node-mark-hero' };

export const NodeMark = ({ endpoint, size = 'mini' }) => html`<span
    class="node-mark ${SQUARE_SIZES[size] || SQUARE_SIZES.mini}"
    style="background: hsl(${personaHue(endpoint)}, 60%, 55%)"
    aria-hidden="true"
>
    <img class="node-mark-img" src=${identiconUri(endpoint)} alt="" />
</span>`;
