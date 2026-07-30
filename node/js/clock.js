// The corner clock, in Swatch Internet Time. The arithmetic is swatch.js (pure, and tested); this
// is the once-a-second tick and the little mono pill it lives in - two decimals so it visibly
// moves, with the real local time a hover away.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { beats } from './swatch.js';

const html = htm.bind(h);

export const Clock = () => {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    const date = new Date(now);
    const beat = '@' + beats(date).toFixed(2).padStart(6, '0');
    return html`<span
        class="quickbar-clock"
        title=${`your time: ${date.toLocaleTimeString()}`}
    >${beat}</span>`;
};
