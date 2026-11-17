// node node/tools/play-upload.mjs <bundle.aab>
//
// Hands a signed app bundle to Google Play (plans/STORES.md, section 3): the last job of
// release.yml runs this once the GitHub Release is out. One "edit" of the app's listing - upload
// the bundle, put it on a track as a release, commit - through the Play Developer API, as a service
// account the Play Console has given leave to release this app. Nothing but Node: the API is four
// requests, and the account's key is not something to hand a third party's action.
//
// From the environment:
//   PLAY_SERVICE_ACCOUNT_JSON  the service account's key file, whole (a secret)
//   PLAY_PACKAGE               the app's id on Play (the bundle identifier)
//   PLAY_TRACK                 internal | alpha | beta | production, or a closed track's own name
//   PLAY_STATUS                draft | completed. A draft waits in the Console for somebody to
//                              press "roll out"; completed goes to the track's testers (or, on
//                              production, to review and then everyone) with nobody pressing
//                              anything. Play takes only drafts for an app it has never published.
//   PLAY_RELEASE_NAME          what the Console calls the release (the version)
//
// Nothing is changed on Play until the commit, so a failure before it leaves the listing as it
// was. Run again for a bundle Play already holds and the upload is refused - a version code is
// used once - which is the right answer: the bundle is there.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = 'https://androidpublisher.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const fail = (message) => {
    console.error(`::error::${message}`);
    process.exit(1);
};

const need = (name) => process.env[name] || fail(`${name} is not set`);

const base64url = (data) => Buffer.from(data).toString('base64url');

/// A bearer token for the service account: a JWT it signs with its own key, traded at Google's
/// token endpoint (OAuth 2.0 for service accounts).
async function accessToken(account) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: account.client_email,
        scope: SCOPE,
        aud: account.token_uri,
        iat: now,
        exp: now + 600,
    };
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
    const response = await fetch(account.token_uri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${unsigned}.${base64url(signature)}`,
        }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
        fail(
            `Google refused the service account (${response.status}): ${body.error_description || body.error || 'no reason given'}`,
        );
    }
    return body.access_token;
}

const [bundle] = process.argv.slice(2);
if (!bundle) fail('usage: play-upload.mjs <bundle.aab>');

let account;
try {
    account = JSON.parse(need('PLAY_SERVICE_ACCOUNT_JSON'));
} catch {
    fail('PLAY_SERVICE_ACCOUNT_JSON is not JSON: paste the whole key file, braces and all');
}
if (!account.client_email || !account.private_key || !account.token_uri) {
    fail(
        'PLAY_SERVICE_ACCOUNT_JSON is not a service account key: no client_email, private_key or token_uri',
    );
}
const pkg = need('PLAY_PACKAGE');
const track = need('PLAY_TRACK');
const status = need('PLAY_STATUS');
if (!['draft', 'completed'].includes(status))
    fail(`PLAY_STATUS is "${status}": draft or completed`);
const name = process.env.PLAY_RELEASE_NAME || '';

const token = await accessToken(account);

/// One request of the edit. Play's errors are JSON with a `message` worth reading in the log.
async function call(what, path, options = {}) {
    const response = await fetch(`${API}${path}`, {
        ...options,
        headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    const text = await response.text();
    let body = {};
    try {
        body = JSON.parse(text);
    } catch {
        /* not JSON: the text itself is the message */
    }
    if (!response.ok) {
        fail(
            `${what} failed (${response.status}): ${(body.error && body.error.message) || text.slice(0, 500)}`,
        );
    }
    return body;
}

const app = `/androidpublisher/v3/applications/${encodeURIComponent(pkg)}`;
const edit = await call('opening an edit', `${app}/edits`, { method: 'POST' });

const uploaded = await call(
    'uploading the bundle',
    `/upload${app}/edits/${edit.id}/bundles?uploadType=media`,
    {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: readFileSync(bundle),
    },
);
console.log(`Play has the bundle: version code ${uploaded.versionCode}`);

await call(
    `putting it on the ${track} track`,
    `${app}/edits/${edit.id}/tracks/${encodeURIComponent(track)}`,
    {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            track,
            releases: [
                { ...(name ? { name } : {}), versionCodes: [String(uploaded.versionCode)], status },
            ],
        }),
    },
);

await call('committing the edit', `${app}/edits/${edit.id}:commit`, { method: 'POST' });
console.log(`On Play's ${track} track as a ${status} release${name ? ` named ${name}` : ''}.`);
