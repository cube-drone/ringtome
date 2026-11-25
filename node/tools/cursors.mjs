// The pixel cursors (Curtis, 2026-11-25: "replacing the smooth, modern cursor with something chunky
// and pixelated - for all of the varying cursor states"): writes `js/cursor-tokens.css`, one
// `--cursor-*` token per cursor the app uses, from the 16px tiles in `js/cursors/` (Kenney's Cursor
// Pixel Pack, CC0 - `js/cursors/LICENSE-kenney.txt`; the tile each one was, in CURSORS below).
//
//   node node/tools/cursors.mjs          write js/cursor-tokens.css
//   node node/tools/cursors.mjs --show   print every tile as text, with its hotspot marked -
//                                        how a hotspot is chosen, and checked
//
// WHY DATA URIS. The node serves its fonts and sounds from routes of their own, embedded in the
// binary; a cursor is a few hundred bytes, and inlined into the stylesheet it needs no route, no
// Rust, and rides the stylesheet's own cache.
//
// WHY 2x, DECLARED 2x. A cursor is drawn at 16 CSS px, the tile's own size: one CSS pixel per tile
// pixel, the size of the system's own arrow. (It was 32 at first, each pixel doubled - Curtis,
// the same day: "the suddenly much smaller verdana website and gigantic pixel icons are kinda funny
// together, but I think these pixel icons need to be 1x size".) The tile is scaled 2x with
// nearest-neighbour and declared `2x` in an `image-set`, so a retina screen draws it pixel for
// pixel; a 1x screen halves it, and halving a 2x nearest-neighbour picture is exact whatever
// filter does it - each 2x2 block is one colour. Where `image-set` isn't understood as a cursor,
// the tile itself at 1x stands in (the `@supports` block): crisp on a 1x screen, softened by the
// browser on a retina one.
//
// THE HOTSPOT is the tile pixel that clicks, in tile pixels - which are CSS pixels, at this size.
// For an arrow it is the tip's own pixel, so the click lands where the point looks to be.
//
// Zero dependencies on purpose, like strings.mjs: PNG is zlib plus a few filters, and these tiles
// are the simplest PNGs there are (2-bit, paletted, one transparent entry).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TILES = path.join(here, '..', 'js', 'cursors');
const OUT = path.join(here, '..', 'js', 'cursor-tokens.css');

// One per cursor keyword the stylesheets use (`cursor: none` needs no picture). `hotspot` in tile
// pixels; `keyword` is the system cursor that stands in if the picture can't be drawn.
const CURSORS = [
    { name: 'default', tile: 168, hotspot: [1, 1], keyword: 'default' },
    { name: 'pointer', tile: 137, hotspot: [5, 0], keyword: 'pointer' },
    { name: 'grab', tile: 138, hotspot: [8, 8], keyword: 'grab' },
    { name: 'grabbing', tile: 139, hotspot: [8, 8], keyword: 'grabbing' },
    { name: 'text', tile: 141, hotspot: [8, 8], keyword: 'text' },
    { name: 'wait', tile: 11, hotspot: [8, 8], keyword: 'wait' },
    { name: 'progress', tile: 167, hotspot: [1, 1], keyword: 'progress' },
    { name: 'help', tile: 163, hotspot: [1, 1], keyword: 'help' },
    { name: 'not-allowed', tile: 15, hotspot: [8, 8], keyword: 'not-allowed' },
    { name: 'crosshair', tile: 122, hotspot: [8, 8], keyword: 'crosshair' },
    { name: 'col-resize', tile: 123, hotspot: [8, 8], keyword: 'col-resize' },
    { name: 'zoom-in', tile: 7, hotspot: [6, 6], keyword: 'zoom-in' },
    // The drawing's transform frame (doc/drawing.js `gripCursor`), set from script by token name.
    { name: 'ns-resize', tile: 0, hotspot: [8, 8], keyword: 'ns-resize' },
    { name: 'ew-resize', tile: 1, hotspot: [8, 8], keyword: 'ew-resize' },
    { name: 'nesw-resize', tile: 2, hotspot: [8, 8], keyword: 'nesw-resize' },
    { name: 'nwse-resize', tile: 3, hotspot: [8, 8], keyword: 'nwse-resize' },
    { name: 'move', tile: 5, hotspot: [8, 8], keyword: 'move' },
    { name: 'rotate', tile: 209, hotspot: [8, 8], keyword: 'crosshair' },
];

// --- PNG in: paletted, bit depth 1/2/4/8, with tRNS. Every pixel comes out [r, g, b, a].
function decode(bytes) {
    let width, height, depth, colourType;
    let palette = [];
    let alpha = [];
    const idat = [];
    for (let at = 8; at < bytes.length;) {
        const length = bytes.readUInt32BE(at);
        const type = bytes.toString('ascii', at + 4, at + 8);
        const data = bytes.subarray(at + 8, at + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            colourType = data[9];
            if (data[12] !== 0) throw new Error('interlaced PNG: not handled');
        } else if (type === 'PLTE') {
            for (let i = 0; i < data.length; i += 3)
                palette.push([data[i], data[i + 1], data[i + 2]]);
        } else if (type === 'tRNS') {
            alpha = [...data];
        } else if (type === 'IDAT') {
            idat.push(data);
        }
        at += 12 + length;
    }
    if (colourType !== 3)
        throw new Error(`colour type ${colourType}: only paletted tiles are handled`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = Math.ceil((width * depth) / 8);
    const bpp = 1; // the filters' byte distance, for any paletted depth
    const rows = [];
    let previous = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        for (let i = 0; i < stride; i++) {
            const left = i >= bpp ? line[i - bpp] : 0;
            const up = previous[i];
            const upLeft = i >= bpp ? previous[i - bpp] : 0;
            let add = 0;
            if (filter === 1) add = left;
            else if (filter === 2) add = up;
            else if (filter === 3) add = (left + up) >> 1;
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - upLeft);
                add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            }
            line[i] = (line[i] + add) & 0xff;
        }
        const pixels = [];
        for (let x = 0; x < width; x++) {
            const bit = x * depth;
            const index = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
            const [r, g, b] = palette[index];
            pixels.push([r, g, b, index < alpha.length ? alpha[index] : 255]);
        }
        rows.push(pixels);
        previous = line;
    }
    return { width, height, rows };
}

// --- PNG out: 8-bit RGBA, no filtering - the picture is flat colour, and deflate does the rest.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}
function encode(rows) {
    const height = rows.length;
    const width = rows[0].length;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    const raw = Buffer.alloc(height * (1 + width * 4));
    rows.forEach((pixels, y) => {
        const start = y * (1 + width * 4);
        pixels.forEach((rgba, x) => raw.set(rgba, start + 1 + x * 4));
    });
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function scale(rows, factor) {
    return rows.flatMap((pixels) => {
        const wide = pixels.flatMap((rgba) => Array(factor).fill(rgba));
        return Array.from({ length: factor }, () => wide);
    });
}

const dataUri = (png) => `url("data:image/png;base64,${png.toString('base64')}")`;

const tiles = CURSORS.map((cursor) => ({
    ...cursor,
    picture: decode(fs.readFileSync(path.join(TILES, `${cursor.name}.png`))),
}));

if (process.argv.includes('--show')) {
    for (const { name, tile, hotspot, picture } of tiles) {
        console.log(`${name} (tile ${tile}), hotspot ${hotspot.join(',')}:`);
        picture.rows.forEach((pixels, y) => {
            const line = pixels
                .map(([r, , , a], x) =>
                    x === hotspot[0] && y === hotspot[1]
                        ? '@'
                        : a === 0
                          ? '.'
                          : r === 0
                            ? '#'
                            : 'o',
                )
                .join('');
            console.log('  ' + line);
        });
    }
    process.exit(0);
}

const token = ({ name, hotspot, keyword }, image) =>
    `    --cursor-${name}: ${image} ${hotspot[0]} ${hotspot[1]}, ${keyword};`;

const css = `/* GENERATED by node/tools/cursors.mjs from the tiles in js/cursors/ - edit the tool's table and run
   it again, never this file. The pixel cursors (Kenney's Cursor Pixel Pack, CC0), one token per
   cursor keyword the stylesheets use; cursor.css says which element wears which. Why 2x pictures
   declared 2x is the tool's header. */
:root {
${tiles.map((t) => token(t, dataUri(encode(t.picture.rows)))).join('\n')}
}

@supports (cursor: image-set(url("data:,") 2x) 0 0, auto) {
    :root {
${tiles.map((t) => '    ' + token(t, `image-set(${dataUri(encode(scale(t.picture.rows, 2)))} 2x)`)).join('\n')}
    }
}
`;
fs.writeFileSync(OUT, css);
console.log(
    `wrote ${path.relative(process.cwd(), OUT)}: ${tiles.length} cursors, ${css.length} bytes`,
);
