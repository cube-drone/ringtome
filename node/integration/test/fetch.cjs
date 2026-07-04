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

function makeFetch() {
    const jar = new CookieJar();
    const cookieFetch = makeFetchCookie(fetch, jar);

    const fn = (path, opts) => {
        const url = `http://${HOST}/${path.replace(/^\//, "")}`;

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

module.exports = { makeFetch, HOST };
