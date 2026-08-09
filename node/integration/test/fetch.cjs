/*
    A thin fetch wrapper that prepends the node's base URL and carries a per-instance cookie jar,
    so tests exercise the node exactly as a browser client would (including sessions, once those
    exist). Adapted from the old codebase's `fitch`.

    Each call to makeFetch() returns a fresh fetch with its own cookie jar, so tests don't leak
    session state into one another. The base URL is RINGTOME_TEST_HOST or localhost:5281.
*/
const makeFetchCookie = require("fetch-cookie").default;
const { CookieJar } = require("tough-cookie");

const HOST = process.env.RINGTOME_TEST_HOST || "localhost:5281";
// A second node, when the harness boots one (two-node sync tests skip themselves otherwise).
const HOST_B = process.env.RINGTOME_TEST_HOST_B || null;
// A third, for daisy-chain tests (adopt B from A, then C from B).
const HOST_C = process.env.RINGTOME_TEST_HOST_C || null;
// A fourth, booted with NO discovery configured at all - the state a shipped node defaults to,
// and the one the other three (all on `local:`) can never reproduce.
const HOST_DARK = process.env.RINGTOME_TEST_HOST_DARK || null;

function makeFetch(host = HOST) {
    const jar = new CookieJar();
    const cookieFetch = makeFetchCookie(fetch, jar);

    const fn = (path, opts) => {
        const url = `http://${host}/${path.replace(/^\//, "")}`;

        // If we're sending a JSON body, set the Content-Type unless a file upload said otherwise.
        if (opts && opts.body && !opts.file) {
            opts.headers = opts.headers || {};
            opts.headers["Content-Type"] = "application/json";
        }
        if (opts && opts.file) {
            delete opts.file;
        }

        return cookieFetch(url, opts);
    };

    fn.jar = jar;
    return fn;
}

// Convenience for the LOCAL_TEST-only raw SQL passthrough. Returns the parsed { rows, ... } body,
// throwing on a non-200 so tests fail loudly if the node wasn't armed with RINGTOME_LOCAL_TEST.
async function sql(query, host = HOST) {
    const fetch = makeFetch(host);
    const resp = await fetch("test/sql", {
        method: "POST",
        body: JSON.stringify({ sql: query }),
    });
    if (resp.status !== 200) {
        throw new Error(`test/sql returned ${resp.status} (is RINGTOME_LOCAL_TEST set?)`);
    }
    return resp.json();
}

module.exports = { makeFetch, sql, HOST, HOST_B, HOST_C, HOST_DARK };
