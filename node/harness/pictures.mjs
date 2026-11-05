// A handful of simple pictures for `just test-data` (Curtis, 2026-11-04): moderation needs
// pictures that differ, because a seal or a picture entry acts on one file and on whatever
// fingerprints like it. Every run paints its own from the run's seed - stripes, checks, rings,
// waves and blobs in a couple of colours - as PNGs written by hand, so the harness gains no
// dependency. Every third one also has a lookalike: the same painting, tinted and speckled, which
// is another file with nearly the same fingerprint (`family` says which belong together).
import zlib from 'node:zlib';

const SIZE = 256;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
}

/// `paint(x, y)` gives each pixel as [r, g, b], 0 to 255.
function png(paint) {
    const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
    let at = 0;
    for (let y = 0; y < SIZE; y++) {
        raw[at++] = 0; // the row's filter: none
        for (let x = 0; x < SIZE; x++) {
            const [r, g, b] = paint(x, y);
            raw[at++] = r;
            raw[at++] = g;
            raw[at++] = b;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(SIZE, 0);
    header.writeUInt32BE(SIZE, 4);
    header[8] = 8; // bits per channel
    header[9] = 2; // RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const COLOURS = [
    [231, 111, 81],
    [244, 162, 97],
    [233, 196, 106],
    [42, 157, 143],
    [38, 70, 83],
    [131, 56, 236],
    [255, 0, 110],
    [58, 134, 255],
    [245, 240, 225],
    [30, 30, 36],
];

/// Each pattern answers which colour a pixel is, 0 or 1, from a few drawn numbers.
const PATTERNS = [
    (rng) => {
        const angle = rng() * Math.PI;
        const width = 14 + rng() * 40;
        const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
        return (x, y) => Math.floor((x * cos + y * sin) / width) & 1;
    },
    (rng) => {
        const w = 18 + Math.floor(rng() * 50);
        const h = 18 + Math.floor(rng() * 50);
        return (x, y) => (Math.floor(x / w) + Math.floor(y / h)) & 1;
    },
    (rng) => {
        const [cx, cy] = [rng() * SIZE, rng() * SIZE];
        const width = 12 + rng() * 36;
        return (x, y) => Math.floor(Math.hypot(x - cx, y - cy) / width) & 1;
    },
    (rng) => {
        const [fx, fy] = [0.01 + rng() * 0.05, 0.01 + rng() * 0.05];
        const phase = rng() * Math.PI * 2;
        return (x, y) => (Math.sin(x * fx + phase) + Math.sin(y * fy) > 0 ? 1 : 0);
    },
    (rng) => {
        const blobs = Array.from({ length: 4 + Math.floor(rng() * 5) }, () => [
            rng() * SIZE,
            rng() * SIZE,
            16 + rng() * 60,
        ]);
        return (x, y) => (blobs.some(([cx, cy, r]) => Math.hypot(x - cx, y - cy) < r) ? 1 : 0);
    },
];

/// `count` pictures in their own families, plus a lookalike of every third. Each is
/// `{ bytes, name, family, retired }`: the generator retires a family once a seal or a server's
/// block would refuse it, so later posts don't spend their turn on a refused upload.
export function makePictures(rng, count = 12) {
    const out = [];
    for (let family = 0; family < count; family++) {
        const pattern = PATTERNS[family % PATTERNS.length](rng);
        const a = COLOURS[Math.floor(rng() * COLOURS.length)];
        let b = COLOURS[Math.floor(rng() * COLOURS.length)];
        if (b === a) b = COLOURS[(COLOURS.indexOf(a) + 3) % COLOURS.length];
        // Broad light and shade, of its own for each painting: a fingerprint sees a picture at a
        // coarse scale, where a fine pattern averages away to nothing it could tell apart.
        const [fx, fy] = [(1 + rng() * 2) / SIZE, (1 + rng() * 2) / SIZE];
        const [turn, phase] = [rng() < 0.5 ? 1 : -1, rng() * Math.PI * 2];
        const shade = (x, y) =>
            0.6 + 0.4 * Math.sin(Math.PI * 2 * (x * fx + turn * y * fy) + phase);
        const flat = (x, y) => {
            const light = shade(x, y);
            return (pattern(x, y) ? a : b).map((c) => Math.round(c * light));
        };
        out.push({ bytes: png(flat), name: `picture-${family}`, family, retired: false });
        if (family % 3 === 0) {
            const speckle = (x, y) => ((x * 31 + y * 17) % 7) * 2 - 6;
            const near = (x, y) =>
                flat(x, y).map((c) => Math.max(0, Math.min(255, c + 8 + speckle(x, y))));
            out.push({
                bytes: png(near),
                name: `picture-${family}-again`,
                family,
                retired: false,
            });
        }
    }
    return out;
}
