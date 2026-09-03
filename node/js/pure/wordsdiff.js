// The private words against the public ones (PUBLISH.md slice 3; Curtis, 2026-09-03: the
// "update" and "diff" buttons show only when the content differs from the public version,
// and the diff itself - "gross, ew, nasty" - is a plain line diff).
//
// A fair comparison masks embed targets: publication rewrites every media reference to its
// public twin (`/id/<root>/docs/<twin>/body/media.avif`), so the raw texts always differ on
// a post with a picture. The alt text and the position survive the mask, so a moved or
// re-captioned picture still reads as a change; swapping one picture for another under the
// same caption does not - the caption is the reader's handle on it, and that is the trade.

const EMBED = /!\[([^\]]*)\]\(([^)\s]*)\)/g;

/// A body with every embed target replaced by a placeholder.
export function maskMedia(text) {
    return String(text || '').replace(EMBED, (_m, alt) => `![${alt}](…)`);
}

/// Whether the private words say what the public words say, media targets aside.
export function sameWords(privateBody, publicBody) {
    return maskMedia(privateBody).trim() === maskMedia(publicBody).trim();
}

const LINE_CAP = 3000;

/// A line diff, oldest-first: `[{ kind: ' ' | '-' | '+', text }]`. Longest common subsequence
/// over lines - quadratic, fine for a document; past the cap it degrades to "everything
/// removed, everything added" rather than freezing the tab.
export function lineDiff(before, after) {
    const a = String(before || '').split('\n');
    const b = String(after || '').split('\n');
    if (a.length > LINE_CAP || b.length > LINE_CAP) {
        return [...a.map((text) => ({ kind: '-', text })), ...b.map((text) => ({ kind: '+', text }))];
    }
    const n = a.length;
    const m = b.length;
    // lcs[i][j] = length of the LCS of a[i..] and b[j..]
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ kind: ' ', text: a[i] });
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push({ kind: '-', text: a[i] });
            i++;
        } else {
            out.push({ kind: '+', text: b[j] });
            j++;
        }
    }
    while (i < n) out.push({ kind: '-', text: a[i++] });
    while (j < m) out.push({ kind: '+', text: b[j++] });
    return out;
}
