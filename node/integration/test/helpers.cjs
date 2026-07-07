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

module.exports = { makeUserFetch, uniqueUsername };
