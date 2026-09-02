const assert = require("node:assert");
/*
    Test fixtures built on top of the raw fetch wrapper.

    makeUserFetch() registers a fresh account and logs it in, returning an authenticated fetch
    (its own cookie jar carries the session). Use it whenever a test needs "some logged-in user"
    without caring about the credentials:

        const alice = await makeUserFetch();
        const resp = await alice("api/auth/whoami");   // already authenticated

    The returned fetch is annotated with the account it belongs to, so tests can assert against it:

        alice.username // the generated username
        alice.account  // the AccountInfo body from registration { id, username }
*/
const { makeFetch } = require("./fetch.cjs");

let counter = 0;

// Unique per call within a run; the counter guards against two calls landing in the same ms.
function uniqueUsername(prefix = "user") {
    counter += 1;
    return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

/*
    Options:
      fetch    - reuse an existing fetch/cookie-jar instead of making a fresh one
      host     - target a different node (e.g. HOST_B in two-node tests)
      username - override the generated username
      password - override the default password
      prefix   - prefix for the generated username (handy for readable test output)
*/
async function makeUserFetch(opts = {}) {
    const fetch = opts.fetch || makeFetch(opts.host);
    const username = opts.username || uniqueUsername(opts.prefix);
    const password = opts.password || "test-password-123";

    const regResp = await fetch("api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password }),
    });
    if (regResp.status !== 200) {
        const body = await regResp.text();
        throw new Error(`makeUserFetch: register failed (${regResp.status}): ${body}`);
    }
    const account = await regResp.json();

    const loginResp = await fetch("api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
    });
    if (loginResp.status !== 200) {
        const body = await loginResp.text();
        throw new Error(`makeUserFetch: login failed (${loginResp.status}): ${body}`);
    }

    fetch.username = username;
    fetch.password = password;
    fetch.account = account;
    return fetch;
}

// Open an adoption code's envelope (`rt1.` + base64url(deflate(JSON))) for tests that need to
// peek at a field (usually the minted leaf pubkey). Tolerates the bare-JSON form too, mirroring
// the server's unpack.
function decodeCode(code) {
    const zlib = require("node:zlib");
    const trimmed = code.trim();
    if (trimmed.startsWith("{")) return JSON.parse(trimmed);
    if (!trimmed.startsWith("rt1.")) throw new Error(`not a code: ${trimmed.slice(0, 12)}…`);
    const deflated = Buffer.from(trimmed.slice(4), "base64url");
    return JSON.parse(zlib.inflateRawSync(deflated).toString("utf8"));
}


/// The one settle loop, previously copy-pasted into fifteen files with only the default
/// budget differing - which meant no way to give CI more patience than a dev machine
/// without editing fifteen files (the 2026-08-23 flake hunt's last finding: every CI-only
/// red was a settle window sized for local hardware losing to a 4-vCPU runner). Each file
/// picks its default budget; RINGTOME_TEST_SETTLE_SCALE multiplies every budget centrally
/// (ci.yml sets 2). Green settles return early, so the scale costs a green run nothing -
/// only failing waits and the two absence-shaped asserts run longer.
const SETTLE_SCALE = Math.max(1, parseInt(process.env.RINGTOME_TEST_SETTLE_SCALE || "1", 10) || 1);
const settleWith = (defaultTries) => async (fn, tries = defaultTries) => {
    for (let i = 0; i < tries * SETTLE_SCALE; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
}

const zlib = require("node:zlib");

function makePng(width, height) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type 2 = truecolor RGB
    const raw = Buffer.alloc(height * (1 + width * 3));
    let o = 0;
    for (let y = 0; y < height; y++) {
        raw[o++] = 0; // filter: none
        for (let x = 0; x < width; x++) {
            raw[o++] = Math.floor((x * 255) / width);
            raw[o++] = Math.floor((y * 255) / height);
            raw[o++] = 128;
        }
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

// AVIF is ISOBMFF: an `ftyp` box at offset 4, with an `avif`/`avis` brand near the head.
function assertIsAvif(buf, why) {
    assert.ok(buf.length > 12, `${why}: non-empty`);
    assert.equal(buf.slice(4, 8).toString("ascii"), "ftyp", `${why}: ISOBMFF ftyp box`);
    const head = buf.slice(0, 64).toString("ascii");
    assert.ok(head.includes("avif") || head.includes("avis"), `${why}: AVIF brand present`);
}

// Poll the owner's ingest queue until the job finishes. Transcode is async (quarantine -> queue
// -> AV1 encode), so callers wait for `done` before the document has a version.

module.exports = { makeUserFetch, uniqueUsername, decodeCode, settleWith, makePng, assertIsAvif };
