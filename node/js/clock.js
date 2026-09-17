// The corner clock, in Swatch Internet Time. The arithmetic is pure/swatch.js (pure, and tested);
// this is the once-a-second tick and the little sunken box it lives in - two decimals so it
// visibly moves, the real local time a hover away, and beside the number a pie of the day:
// empty at @000, full at @999.99 (Curtis, 2026-09-17).
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { beats } from './pure/swatch.js';

const html = htm.bind(h);

// A disc whose stroke is as wide as its radius, dashed to the day's fraction, reads as a pie
// slice with no arc arithmetic: the dash runs clockwise from twelve.
const R = 5;
const C = 2 * Math.PI * R;

const DayPie = ({ fraction }) => html`<svg class="quickbar-clock-pie" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1" opacity="0.55" />
    <circle
        cx="8"
        cy="8"
        r=${R}
        fill="none"
        stroke="currentColor"
        stroke-width=${R * 2}
        stroke-dasharray=${`${C * fraction} ${C}`}
        transform="rotate(-90 8 8)"
    />
</svg>`;

export const Clock = () => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    const date = new Date(now);
    const b = beats(date);
    const beat = '@' + b.toFixed(2).padStart(6, '0');
    return html`<span
        class="quickbar-clock"
        title=${`your time: ${date.toLocaleTimeString()}`}
    ><${DayPie} fraction=${b / 1000} />${beat}</span>`;
};
