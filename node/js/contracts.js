// Contract names, in the reader's language (Curtis, 2026-10-04). The node keeps the contracts -
// what each is worth, and whether it's done (bank.rs `CONTRACTS`) - and names them in English; the
// words a person reads come from here, by the contract's id, so a translation reaches the
// Contracts column, the ledger's line and the hrseMsg message alike. One literal `t()` per
// contract, never a key built from the id (STYLE: never assemble a name at runtime) - the strings
// tool reads them. A contract the node knows and this table doesn't yet wears the node's English.
import { t } from './i18n.js';
import { appHref } from './links.js';

const NAMES = {
    'draw-a-horse': () => t('contracts.draw-a-horse', 'Draw a horse in hrseDrawing™'),
};

/// The fine print (Curtis, 2026-10-04): exactly what reaching the goal takes, said on hover over a
/// small link - which goes where the work is done.
const FINE_PRINT = {
    'draw-a-horse': () => ({
        text: t(
            'contracts.draw-a-horse-fine-print',
            'Please open the hrseDrawing™ application and draw anything you like. It must contain at least three brush-strokes to qualify.',
        ),
        href: appHref('drawing'),
    }),
};

/// The contract's name as the reader reads it: this table's, else the node's `fallback`.
export const contractName = (id, fallback = '') => (NAMES[id] ? NAMES[id]() : fallback);

/// The contract's fine print - `{ text, href }` - or null for a contract that has none.
export const contractFinePrint = (id) => (FINE_PRINT[id] ? FINE_PRINT[id]() : null);
