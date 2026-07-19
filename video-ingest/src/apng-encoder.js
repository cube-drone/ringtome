// apng-encoder.js
//
// Hand-rolled APNG assembler. The browser has no API to emit an animated PNG,
// so we take one ordinary PNG per frame (via canvas.toBlob('image/png')) and
// stitch them into a single valid APNG by re-using the raw compressed image
// data. We never re-compress pixels; we just re-frame existing IDAT streams.
//
// APNG layout (superset of PNG, per the spec at
// https://wiki.mozilla.org/APNG_Specification):
//
//   PNG signature
//   IHDR                       (from frame 0)
//   acTL   num_frames num_plays
//   fcTL   seq=0  (control for frame 0)
//   IDAT   ...                 (frame 0 pixel data, unchanged)
//   fcTL   seq=1  (control for frame 1)
//   fdAT   seq=2  <frame 1 IDAT bytes>
//   fcTL   seq=3
//   fdAT   seq=4  <frame 2 IDAT bytes>
//   ...
//   IEND
//
// Every fcTL and fdAT shares one monotonically increasing sequence number.
// A chunk is: length(4 BE) | type(4 ascii) | data | crc32(4 over type+data).

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---- CRC32 (standard PNG polynomial) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---- little byte-writer helpers ----
function u32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function u16(n) {
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
}
function concat(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// Build one full chunk (length + type + data + crc).
function makeChunk(type, data) {
  const typeBytes = new Uint8Array([
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ]);
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

// Parse a single PNG blob's bytes: return { ihdr, idat } where ihdr is the
// 13-byte IHDR data and idat is the concatenation of all IDAT chunk payloads.
function parsePng(bytes) {
  // Verify signature.
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('not a PNG (bad signature)');
  }
  let off = 8;
  let ihdr = null;
  const idatParts = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off < bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    const data = bytes.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') ihdr = data.slice();
    else if (type === 'IDAT') idatParts.push(data.slice());
    else if (type === 'IEND') break;
    off = dataStart + len + 4; // skip data + crc
  }
  if (!ihdr) throw new Error('PNG missing IHDR');
  if (idatParts.length === 0) throw new Error('PNG missing IDAT');
  return { ihdr, idat: concat(idatParts) };
}

// Render a canvas to a PNG blob.
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

// encodeApng(frames, { width, height, delayMs, numPlays }) -> Blob (image/apng)
//
// `frames` is an array of { canvas } (each same width/height). delayMs is the
// per-frame display duration; we encode it as a rational delay_num/delay_den.
export async function encodeApng(frames, opts) {
  if (!frames.length) throw new Error('encodeApng: no frames');
  const width = opts.width;
  const height = opts.height;
  const delayMs = Math.max(1, Math.round(opts.delayMs ?? 50));
  const numPlays = opts.numPlays ?? 0; // 0 = loop forever

  // Delay is expressed as delay_num / delay_den seconds. Use den=1000 so
  // delay_num is just the millisecond count (fits in u16 for our frame rates).
  const delayDen = 1000;
  const delayNum = Math.min(0xffff, delayMs);

  // PNG-encode every frame up front.
  const pngs = [];
  for (const f of frames) {
    const blob = await canvasToPngBlob(f.canvas);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    pngs.push(parsePng(bytes));
  }

  const out = [PNG_SIG];

  // IHDR from the first frame. We override width/height defensively to the
  // requested output size (they should already match).
  const ihdr = pngs[0].ihdr.slice();
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  out.push(makeChunk('IHDR', ihdr));

  // acTL: number of frames + play count.
  out.push(makeChunk('acTL', concat([u32(pngs.length), u32(numPlays)])));

  let seq = 0;
  for (let i = 0; i < pngs.length; i++) {
    // fcTL controls the i-th frame.
    const fctl = concat([
      u32(seq++), // sequence_number
      u32(width), // width
      u32(height), // height
      u32(0), // x_offset
      u32(0), // y_offset
      u16(delayNum), // delay_num
      u16(delayDen), // delay_den
      new Uint8Array([0]), // dispose_op = APNG_DISPOSE_OP_NONE
      new Uint8Array([0]), // blend_op   = APNG_BLEND_OP_SOURCE
    ]);
    out.push(makeChunk('fcTL', fctl));

    if (i === 0) {
      // Frame 0 uses a plain IDAT chunk (unchanged bytes).
      out.push(makeChunk('IDAT', pngs[0].idat));
    } else {
      // Later frames use fdAT = sequence_number + IDAT bytes.
      out.push(makeChunk('fdAT', concat([u32(seq++), pngs[i].idat])));
    }
  }

  out.push(makeChunk('IEND', new Uint8Array(0)));

  return new Blob([concat(out)], { type: 'image/apng' });
}
