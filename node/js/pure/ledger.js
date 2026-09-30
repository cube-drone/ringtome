// hrseBank's ledger, grouped (Curtis, 2026-09-29: "five similar entries in a row - we might slam these
// together, displaying multiple emoji (or 'users followed')"). A run of consecutive lines of one kind
// on one UTC day becomes one row with the run's total: words and strokes also stay within one
// document, reactions gather their emoji, follows their people. A publication and a day of use each
// stand alone - they're the lines worth reading.

const ALONE = new Set(['publication', 'heartbeat']);
const BY_DOCUMENT = new Set(['words', 'strokes']);

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function keyOf(line) {
    if (ALONE.has(line.kind)) return `${line.kind}|${line.source}`;
    const d = line.detail || {};
    const doc = BY_DOCUMENT.has(line.kind) ? d.title || '' : '';
    return `${line.kind}|${dayOf(line.at_ms)}|${doc}`;
}

/// The lines (newest first, as the node sends them) grouped into rows: `{ kind, date, at_ms, count,
/// pennies (a decimal string), n (the lines' own counts summed - words, strokes), title, emoji[],
/// people[], lines }`.
export function groupLedger(lines) {
    const rows = [];
    for (const line of lines || []) {
        const key = keyOf(line);
        const last = rows[rows.length - 1];
        const d = line.detail || {};
        if (last && last.key === key) {
            last.count += 1;
            last.pennies = String(BigInt(last.pennies) + BigInt(line.pennies));
            last.n += d.count || 0;
            if (d.emoji) last.emoji.push(d.emoji);
            for (const who of [d.by, d.of]) if (who && !last.people.includes(who)) last.people.push(who);
            last.lines.push(line);
            continue;
        }
        rows.push({
            key,
            kind: line.kind,
            date: dayOf(line.at_ms),
            at_ms: line.at_ms,
            count: 1,
            pennies: String(line.pennies),
            n: d.count || 0,
            title: d.title || '',
            source: line.source,
            emoji: d.emoji ? [d.emoji] : [],
            people: [d.by, d.of].filter(Boolean),
            lines: [line],
        });
    }
    return rows;
}
