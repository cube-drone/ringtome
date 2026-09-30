// The hit counter under the sign-in (census.rs; Curtis, 2026-09-29): "Now with [0 0 0 0 0 0 3]
// active users!" - this node's estimate of the network's daily actives, on mechanical wheels that
// roll up when the page opens. Click it for the graph: each day's estimate, as this node saw it.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { odometerDigits, censusMonth } from './pure/census.js';

const html = htm.bind(h);

/// How long the wheels take to roll up to the number.
const ROLL_MS = 1200;

export const HitCounter = () => {
    const [census, setCensus] = useState(null);
    const [rolled, setRolled] = useState(0);
    const [open, setOpen] = useState(false);
    // The day the readout names: the one pointed at, else today (Curtis, 2026-09-29: "there's no
    // way to read the values on that graph!").
    const [pointed, setPointed] = useState(null);
    useEffect(() => {
        api('/api/node/census').then(setCensus).catch(() => setCensus(null));
    }, []);
    // Roll up from nothing, the way a mechanical counter would be seen to turn.
    const shown = census ? census.shown : 0;
    useEffect(() => {
        if (!shown) return undefined;
        let frame = 0;
        const start = performance.now();
        const step = (now) => {
            const p = Math.min(1, (now - start) / ROLL_MS);
            setRolled(Math.round(shown * (1 - (1 - p) ** 3)));
            if (p < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
    }, [shown]);
    if (!census) return null;
    const month = censusMonth(census.history, Date.now());
    // The line's points in a 300 x 80 box, a little inset so the line never touches the edge.
    const at = (i, p) => `${(4 + (i * 292) / (month.length - 1)).toFixed(1)},${(76 - p.height * 70).toFixed(1)}`;
    return html`<div class="hit-counter">
        <button
            class="hit-counter-line"
            type="button"
            aria-expanded=${open}
            title=${t('census.what-it-counts', "this computer's best guess at how many people used the network today, from the computers it talks to")}
            onClick=${() => setOpen((o) => !o)}
        >
            ${t('census.now-with', 'Now with')}
            <span class="hit-counter-wheels" aria-label=${String(census.shown)}>
                ${odometerDigits(rolled).map((d, i) => html`<span class="hit-counter-wheel" key=${i}>${d}</span>`)}
            </span>
            ${t('census.active-users', 'active users!')}
        </button>
        ${open &&
        html`<div class="hit-counter-graph">
            <div class="hit-counter-frame">
                <span class="hit-counter-scale" aria-hidden="true">
                    <span>${Math.max(...month.map((p) => p.active))}</span>
                    <span>0</span>
                </span>
                <svg class="hit-counter-plot" viewBox="0 0 300 80" role="img" aria-label=${t('census.graph', 'daily active users, by day')} onMouseLeave=${() => setPointed(null)}>
                    <polyline class="hit-counter-line-path" points=${month.map((p, i) => at(i, p)).join(' ')} />
                    ${month.map((p, i) => {
                        const [x, y] = at(i, p).split(',');
                        return html`<g key=${p.date} class=${pointed === i ? 'hit-counter-day pointed' : 'hit-counter-day'} onMouseEnter=${() => setPointed(i)} onClick=${() => setPointed(i)}>
                            <circle class="hit-counter-hit" cx=${x} cy=${y} r="6" />
                            <circle class="hit-counter-dot" cx=${x} cy=${y} r="1.8" />
                        </g>`;
                    })}
                </svg>
            </div>
            <p class="hit-counter-dates" aria-hidden="true">
                <span>${month[0].date}</span>
                <span>${month[Math.floor(month.length / 2)].date}</span>
                <span>${month[month.length - 1].date}</span>
            </p>
            <p class="hit-counter-readout">
                ${(() => {
                    const p = month[pointed ?? month.length - 1];
                    return pointed === null
                        ? t('census.readout-today', 'today so far: {n} active', { n: p.active })
                        : t('census.readout-day', '{date}: {n} active', { date: p.date, n: p.active });
                })()}
            </p>
        </div>`}
    </div>`;
};
