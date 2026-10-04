// Contract names, in the reader's language (Curtis, 2026-10-04). The node keeps the contracts -
// what each is worth, and whether it's done (bank.rs `CONTRACTS`) - and names them in English; the
// words a person reads come from here, by the contract's id, so a translation reaches the
// Contracts column, the ledger's line and the hrseMsg message alike. One literal `t()` per
// contract, never a key built from the id (STYLE: never assemble a name at runtime) - the strings
// tool reads them. A contract the node knows and this table doesn't yet wears the node's English.
import { t } from './i18n.js';

const NAMES = {
    'draw-a-horse': () => t('contracts.draw-a-horse', 'Draw a horse in hrseDrawing™'),
};

/// The contract's name as the reader reads it: this table's, else the node's `fallback`.
export const contractName = (id, fallback = '') => (NAMES[id] ? NAMES[id]() : fallback);
