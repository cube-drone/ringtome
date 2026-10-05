// The balance in the corner (HORSE_BASED_CURRENCIES.md, slice 3; Curtis 2026-09-29): the persona's
// HorseBucks at the dock's far right, beside the clock, counting up while they earn; a click opens
// hrseBank. The node's ledger is the truth (bank.rs): asked again every few seconds while the tab
// is visible and whenever the persona's own documents move, and rolled up to the new figure.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { t } from './i18n.js';
import { useLedger } from './unlocks.js';
import { appHref } from './links.js';
import { formatHorseBucks } from './pure/horsebucks.js';

const html = htm.bind(h);

/// How long a rise takes to roll up.
const ROLL_MS = 900;

export const CornerBank = ({ root }) => {
    const loc = useLocation();
    // BigInt horsepennies, from the node: the shell's one poll (unlocks.js `useLedgerPoll`) asks,
    // since the same answer carries what's unlocked.
    const target = useLedger(root).balance;
    const [shown, setShown] = useState(null);
    const from = useRef(null);
    // Roll from what's shown to the new figure (BigInt steps, so a squidjillion rolls too).
    useEffect(() => {
        if (target === null) return undefined;
        const start = shown === null ? target : shown;
        if (start === target) {
            setShown(target);
            return undefined;
        }
        from.current = start;
        let frame = 0;
        const began = performance.now();
        const step = (now) => {
            const p = Math.min(1, (now - began) / ROLL_MS);
            const eased = BigInt(Math.round((1 - (1 - p) ** 3) * 1000));
            setShown(from.current + ((target - from.current) * eased) / 1000n);
            if (p < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return () => cancelAnimationFrame(frame);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);
    if (!root || shown === null) return null;
    // Inside the clock's box: a divider, then the balance on the time's own line.
    return html`<span class="quickbar-clock-sep" aria-hidden="true"></span><button
            class="quickbar-bank"
            type="button"
            title=${t('cornerbank.open-hrsebank', 'your HorseBucks - open hrseBank')}
            onClick=${() => loc.route(appHref('bank'))}
        >${formatHorseBucks(shown)}</button>`;
};
