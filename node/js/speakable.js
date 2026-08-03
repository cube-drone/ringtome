// The speakable identicon (PROJECT_PLAN, Naming): a root pubkey rendered for human
// transport - `pagoda-dimension-4kTx…` - two checksum words derived from the key's hash,
// then the key itself in base58. The words are how friends recognize an address across a
// room and how a paste proves it wasn't mangled; they are NEVER authority (grinding a fresh
// key to collide two words costs an attacker minutes - same posture as every human-facing
// name: pointers, the root decides, pin on first resolution).
//
// The grammar, all forms accepted, first form the canonical mint:
//   pagoda-dimension-<base58>   worded: checksum VERIFIED, mismatch refuses loudly
//   <base58>                    bare dense form (~44 chars)
//   <hex64>                     the escape hatch, canonical since M1
//
// Lives OUTSIDE pure/ only because blake3 is an import and the sanctum admits none - the
// module is pure in every other sense and its vectors run with the pure set's.
// Everything here is a wire format: the wordlist is pinned by index (words.js - never edit),
// the hash is blake3 (the house hash), the alphabet is base58btc (0OIl dropped - this string
// exists to survive handwriting and dictation). Goldens in integration/test/pure/
// speakable.cjs pin JS and the Rust twin (src/speakable.rs) to identical output.
import { blake3 } from '@noble/hashes/blake3.js';

import { WORDS } from './pure/words.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEX64 = /^[0-9a-f]{64}$/;

const hexToBytes = (hex) => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
};

/// The two checksum words for a root: the hash's first two 4-byte windows, big-endian, each
/// reduced mod the list. (32-bit windows so the mod bias over 1296 is a rounding error;
/// byte-pair windows would visibly favor the list's front.)
export function wordsFor(rootHex) {
    const h = blake3(hexToBytes(rootHex));
    const pick = (o) =>
        WORDS[((h[o] * 16777216 + h[o + 1] * 65536 + h[o + 2] * 256 + h[o + 3]) >>> 0) % WORDS.length];
    return [pick(0), pick(4)];
}

/// 32 bytes up, base58 out - leading zero bytes become leading '1's, per the convention
/// every base58 consumer since Bitcoin expects.
export function toBase58(rootHex) {
    let n = BigInt('0x' + rootHex);
    let out = '';
    while (n > 0n) {
        out = B58[Number(n % 58n)] + out;
        n /= 58n;
    }
    for (let i = 0; i < rootHex.length && rootHex.slice(i, i + 2) === '00'; i += 2) {
        out = '1' + out;
    }
    return out;
}

/// Base58 back to 64-hex, or null if the string isn't clean base58 for exactly 32 bytes.
export function fromBase58(s) {
    if (!s) return null;
    let n = 0n;
    for (const c of s) {
        const v = B58.indexOf(c);
        if (v === -1) return null;
        n = n * 58n + BigInt(v);
    }
    let hex = n.toString(16);
    let zeros = 0;
    while (zeros < s.length && s[zeros] === '1') zeros++;
    hex = '00'.repeat(zeros) + (hex === '0' && zeros ? '' : hex.padStart(hex.length + (hex.length % 2), '0'));
    if (hex.length > 64) return null;
    return hex.padStart(64, '0');
}

/// The canonical mint: `word-word-<base58>`.
export function speakable(rootHex) {
    const [a, b] = wordsFor(rootHex);
    return `${a}-${b}-${toBase58(rootHex)}`;
}

/// A pasted reference in ANY dress - a full shared URL, an /id/ path, or a bare address -
/// dissected to { seg, via } for the lookup box. The seg is NOT validated here beyond
/// shape-finding; route it to /id/<seg> and let that surface's own grammar judge it (a
/// mangled checksum gets the "did you mean" there, which beats a terse refusal here).
/// Null: nothing address-shaped in the text at all.
export function parseIdReference(text) {
    let t = (text || '').trim();
    if (!t) return null;
    let via = '';
    const m = t.match(/\/id\/([^/?#\s]+)[^?#\s]*(?:\?([^#\s]*))?/);
    if (m) {
        t = decodeURIComponent(m[1]);
        const viaMatch = (m[2] || '').match(/(?:^|&)via=([^&]*)/);
        via = viaMatch ? decodeURIComponent(viaMatch[1]) : '';
    }
    if (/[/?#\s]/.test(t)) return null; // leftover URL junk that never contained /id/
    if (!parseSpeakable(t) && !t.includes('-')) return null; // not address-shaped at all
    return { seg: t, via };
}

/**
 * Parse any accepted form back to the root.
 *   { ok: true, root }                     - hex, bare base58, or worded with matching words
 *   { ok: false, root, expected }          - the key decoded but the words LIED: refused, with
 *                                            the true words so the UI can say "did you mean";
 *                                            `root` is what the key claims, never to be used
 *                                            without the loud warning
 *   null                                   - not an address in any form
 */
export function parseSpeakable(segment) {
    const s = (segment || '').trim();
    if (HEX64.test(s)) return { ok: true, root: s };
    const parts = s.split('-');
    if (parts.length === 1) {
        const root = fromBase58(s);
        return root ? { ok: true, root } : null;
    }
    if (parts.length !== 3) return null;
    const [a, b, key] = parts;
    const root = fromBase58(key);
    if (!root) return null;
    const [ea, eb] = wordsFor(root);
    if (a === ea && b === eb) return { ok: true, root };
    return { ok: false, root, expected: `${ea}-${eb}` };
}
