// A pie: each part its share of the circle (the arithmetic is pure/pie.js). hrseAmp's stations
// and the Storage page's files by kind draw theirs with it; a part's colour is the class its
// caller gives it, so the pie's slice and the legend's swatch can wear the same one.
import { h } from 'preact';
import htm from 'htm';

import { wedges } from './pure/pie.js';

const html = htm.bind(h);

const C = 50;
const R = 46;
const at = (turn) => [
    C + R * Math.cos(2 * Math.PI * turn - Math.PI / 2),
    C + R * Math.sin(2 * Math.PI * turn - Math.PI / 2),
];

/// `parts[i]` is slice i's size (any unit), `classes[i]` its colour, `labels[i]` what the pointer
/// reads over it; `label` names the whole pie to a screen reader. `empty` is the class of the
/// plain circle drawn when no part has anything.
export const Pie = ({ parts, classes = [], labels = [], label, empty, ...rest }) => {
    const drawn = wedges(parts).map((wedge, i) => {
        if (!wedge) return null;
        const said = labels[i] && html`<title>${labels[i]}</title>`;
        if (wedge.to - wedge.from >= 1)
            return html`<circle key=${i} class=${classes[i]} cx=${C} cy=${C} r=${R}>${said}</circle>`;
        const [x1, y1] = at(wedge.from);
        const [x2, y2] = at(wedge.to);
        return html`<path key=${i} class=${classes[i]} d=${`M${C} ${C} L${x1} ${y1} A${R} ${R} 0 ${wedge.to - wedge.from > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`}>${said}</path>`;
    });
    return html`<svg ...${rest} viewBox="0 0 100 100" role="img" aria-label=${label}>
        ${drawn.some(Boolean) ? drawn : html`<circle class=${empty} cx=${C} cy=${C} r=${R} />`}
    </svg>`;
};
