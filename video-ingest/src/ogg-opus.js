// ogg-opus.js
//
// Minimal Ogg container muxer for Opus packets. WebCodecs' AudioEncoder gives
// us raw Opus packets (EncodedAudioChunk), but nothing in the browser will play
// or `decodeAudioData` a bare packet stream, and a Rust decoder wants a real
// container too. So we hand-mux a standards-compliant Ogg Opus (.opus) stream:
//
//   - a BOS page carrying the "OpusHead" identification header,
//   - a page carrying the "OpusTags" comment header,
//   - then one Opus audio packet per page, EOS flag on the last.
//
// Refs: RFC 7845 (Ogg Encapsulation for Opus), RFC 3533 (Ogg framing).

// Ogg uses CRC32 with polynomial 0x04c11db7, MSB-first, no input/output
// reflection, zero init, zero final-xor. This is NOT the same CRC as PNG.
const OGG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) {
      c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
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

function u32le(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
function u16le(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
// 64-bit little-endian granule position from a JS number (safe up to 2^53).
function u64le(n) {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

// Build the lacing segment table for a single packet.
function lacing(len) {
  const segs = [];
  let remaining = len;
  while (remaining >= 255) {
    segs.push(255);
    remaining -= 255;
  }
  segs.push(remaining); // final value < 255 (may be 0 if len%255==0)
  return segs;
}

// Assemble one Ogg page carrying exactly one packet.
function makePage({ serial, seq, headerType, granule, packet }) {
  const segTable = lacing(packet.length);
  if (segTable.length > 255) throw new Error('packet too large for single-page muxing');

  const header = new Uint8Array(27 + segTable.length);
  header.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  header[4] = 0; // stream structure version
  header[5] = headerType; // 0x01 cont, 0x02 BOS, 0x04 EOS
  header.set(u64le(granule), 6); // granule position
  header.set(u32le(serial), 14); // bitstream serial number
  header.set(u32le(seq), 18); // page sequence number
  // CRC (bytes 22..25) left zero for the checksum computation.
  header[26] = segTable.length; // number of segments
  header.set(new Uint8Array(segTable), 27);

  const page = concat([header, packet]);
  const crc = oggCrc(page); // computed over the whole page with CRC field zeroed
  page.set(u32le(crc), 22);
  return page;
}

// OpusHead identification header (RFC 7845 section 5.1).
function opusHead({ channels, preSkip, inputSampleRate }) {
  return concat([
    new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]), // "OpusHead"
    new Uint8Array([1]), // version
    new Uint8Array([channels]), // channel count
    u16le(preSkip), // pre-skip
    u32le(inputSampleRate), // original input sample rate (informational)
    u16le(0), // output gain Q7.8
    new Uint8Array([0]), // channel mapping family 0 (mono/stereo)
  ]);
}

// OpusTags comment header (RFC 7845 section 5.2).
function opusTags() {
  const vendor = new TextEncoder().encode('ringtome-video-ingest');
  return concat([
    new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]), // "OpusTags"
    u32le(vendor.length),
    vendor,
    u32le(0), // user comment list length
  ]);
}

// muxOggOpus(packets, { channels, inputSampleRate, preSkip }) -> Blob
//
// `packets` is an array of { data: Uint8Array, samples: number } where `samples`
// is the packet's decoded sample count at 48 kHz (the Opus granule clock).
export function muxOggOpus(packets, opts) {
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const channels = opts.channels ?? 1;
  const preSkip = opts.preSkip ?? 0;
  const inputSampleRate = opts.inputSampleRate ?? 48000;

  const pages = [];
  let seq = 0;

  // BOS page: OpusHead.
  pages.push(
    makePage({
      serial,
      seq: seq++,
      headerType: 0x02,
      granule: 0,
      packet: opusHead({ channels, preSkip, inputSampleRate }),
    })
  );

  // Second page: OpusTags.
  pages.push(
    makePage({ serial, seq: seq++, headerType: 0x00, granule: 0, packet: opusTags() })
  );

  // Audio pages: one packet each, EOS on the last.
  let granule = 0;
  for (let i = 0; i < packets.length; i++) {
    granule += packets[i].samples;
    const isLast = i === packets.length - 1;
    pages.push(
      makePage({
        serial,
        seq: seq++,
        headerType: isLast ? 0x04 : 0x00,
        granule,
        packet: packets[i].data,
      })
    );
  }

  return new Blob([concat(pages)], { type: 'audio/ogg' });
}
