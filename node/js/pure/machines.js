// The Network page's rules, pure (plans/NETWORK.md): how a machine stands, what to call it, and
// which rows a filter keeps. The node says what happened; these say what it means to a reader.

/**
 * How a machine stands right now:
 *
 * - `dark`: it didn't answer, and this node isn't asking again until `dark_until_ms`.
 * - `answering`: the last connect to it worked.
 * - `unanswered`: the last connect failed, and the rest is over - the next ask may reach it.
 * - `dials-in`: never reached from here, but it reaches this node (a phone, a machine behind a
 *   router that won't take calls).
 * - `unknown`: heard of, never tried either way.
 */
export function machineStatus(m, now) {
    if (m.dark_until_ms && m.dark_until_ms > now) return 'dark';
    if (m.last_ok_ms && (!m.last_fail_ms || m.last_ok_ms >= m.last_fail_ms)) return 'answering';
    if (m.last_fail_ms) return 'unanswered';
    if (m.last_inbound_ms) return 'dials-in';
    return 'unknown';
}

/// What the page calls a machine: the name it announced, else its speakable words.
export const machineLabel = (m) => (m && (m.name || m.words || m.endpoint)) || '';

/// Reliability as a whole percentage, or null for a machine never dialed from here - its one half
/// is "unknown", not "fifty-fifty".
export const reliabilityPct = (m) =>
    m && m.tries > 0 ? Math.round((m.reliability || 0) * 100) : null;

/// The rows a filter keeps: `mine` keeps the machines the viewer has a link to.
export const machinesShown = (machines, mine) =>
    (machines || []).filter((m) => !mine || (m.links || []).length > 0);
