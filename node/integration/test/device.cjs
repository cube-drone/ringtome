/*
    The Server app (Device, in the desktop app) - node/src/registration.rs and the backup doors in
    node/src/backup.rs (Curtis, 2026-09-25). Two halves:

    On a SERVER (the rig's own node): who may sign up is the administrator's choice - open, a
    shared sign-up password, or closed - enforced at the one door that makes accounts; the choice
    and every backup door are for node administrators only; and a backup can be listed and
    downloaded whole, by its exact name and nothing else.

    On a DEVICE - a single-tenant node like the desktop app's, which this file starts itself, since
    the rig's nodes are all servers: nobody else signs up (a desktop app is its owner's alone), and a
    backup is shown in the file manager rather than downloaded - read back from the node's
    local-test record of what it asked the app around it (desktop/src/requests.rs does the showing).
*/
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { HOST, makeFetch, sql } = require("./fetch.cjs");

const WORKSPACE = path.resolve(__dirname, "..", "..", "..");
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const j = (who, p, body, method = "POST") => who(p, { method, body: JSON.stringify(body) });

async function nodeAdmin(prefix, host = HOST) {
    const user = await makeUserFetch({ prefix, host });
    await sql(`INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${user.account.id}', 'node_admin')`, host);
    return user;
}

/// Sign up at `host` as a stranger would: a fresh cookie jar, no session.
const signUp = (username, password, registration_password, host = HOST) =>
    j(makeFetch(host), "api/auth/register", { username, password, registration_password });

describe("the Server app: registration and backups, for administrators", function () {
    this.timeout(600000);

    let admin, plain;
    const setMode = (mode, password) => j(admin, "api/admin/registration", { mode, password }, "PUT");

    before(async () => {
        admin = await nodeAdmin("devadm");
        plain = await makeUserFetch({ prefix: "devplain" });
    });

    it("its doors are for node administrators only", async () => {
        for (const [p, method] of [
            ["api/admin/registration", "GET"],
            ["api/admin/registration", "PUT"],
            ["api/admin/backups", "GET"],
            ["api/admin/backups/backup_20260925T183012Z.tar.gz", "GET"],
        ]) {
            const r = await plain(p, { method, body: method === "PUT" ? JSON.stringify({ mode: "closed" }) : undefined });
            assert.equal(r.status, 403, `${method} ${p} for a plain account`);
            assert.equal((await makeFetch()(p, { method })).status, 401, `${method} ${p} for nobody`);
        }
        const status = await (await admin("api/admin/registration")).json();
        assert.equal(status.mode, "open", "a server starts open, as every server did before this");
        assert.equal(status.chosen, false);
    });

    it("sign-ups follow the administrator's choice: a shared password, then closed, then open again", async () => {
        const name = (tag) => `dev${tag}${crypto.randomBytes(3).toString("hex")}`;
        try {
            const noPassword = await setMode("password");
            assert.equal(noPassword.status, 400, "the first switch to password needs one");

            assert.equal((await setMode("password", "bring a friend")).status, 200);
            assert.deepEqual(await (await makeFetch()("api/registration")).json(), { mode: "password" }, "the signup screen can ask");
            assert.equal((await signUp(name("a"), "password123")).status, 403, "no sign-up password");
            assert.equal((await signUp(name("b"), "password123", "bring an enemy")).status, 403, "the wrong one");
            const right = await signUp(name("c"), "password123", "bring a friend");
            assert.equal(right.status, 200, await right.text());

            assert.equal((await setMode("closed")).status, 200);
            assert.equal((await makeFetch()("api/registration").then((r) => r.json())).mode, "closed");
            assert.equal((await signUp(name("d"), "password123", "bring a friend")).status, 403, "closed means nobody, password or not");

            assert.equal((await setMode("password")).status, 200, "back to password keeps the one already set");
            assert.equal((await signUp(name("e"), "password123", "bring a friend")).status, 200);
        } finally {
            assert.equal((await setMode("open")).status, 200, "the rig's node goes back to open for every other file");
        }
        assert.equal((await signUp(name("f"), "password123")).status, 200, "open again");
    });

    it("a backup is listed, and downloads whole - by its exact name and nothing else", async () => {
        const started = await admin("api/admin/backup", { method: "POST" });
        assert.equal(started.status, 202);
        const { id } = await started.json();
        let done = null;
        for (let i = 0; i < 240 && !done; i++) {
            const r = await admin(`api/admin/backup/${id}`);
            if (r.status === 200) done = await r.json();
            else await wait(250);
        }
        assert.ok(done, "the backup finished");
        const name = path.basename(done.path);
        try {
            const list = await (await admin("api/admin/backups")).json();
            const row = list.find((a) => a.name === name);
            assert.ok(row, `listed: ${JSON.stringify(list)}`);
            const onDisk = fs.statSync(path.resolve(WORKSPACE, done.path)).size;
            assert.equal(row.bytes, onDisk);

            const download = await admin(`api/admin/backups/${name}`);
            assert.equal(download.status, 200);
            assert.equal(download.headers.get("content-disposition"), `attachment; filename="${name}"`);
            const bytes = Buffer.from(await download.arrayBuffer());
            assert.equal(bytes.length, onDisk, "every byte");
            assert.equal(bytes[0], 0x1f, "a gzip stream");

            assert.equal((await plain(`api/admin/backups/${name}`)).status, 403, "never to anyone else");
            for (const not of ["envelope.key", "node.db", "..%2Fenvelope.key", `${name}.partial`]) {
                assert.equal((await admin(`api/admin/backups/${not}`)).status, 404, `nothing but an archive: ${not}`);
            }
            assert.equal((await admin(`api/admin/backups/${name}/reveal`, { method: "POST" })).status, 404, "a server has no file manager to show it in");
        } finally {
            fs.rmSync(path.resolve(WORKSPACE, done.path), { force: true });
        }
    });
});

const DEVICE_PORT = process.env.RINGTOME_TEST_DEVICE_PORT;

(DEVICE_PORT ? describe : describe.skip)("the Device app: a desktop app's own", function () {
    this.timeout(600000);

    const token = crypto.randomBytes(32).toString("hex");
    const host = `127.0.0.1:${DEVICE_PORT}`;
    let tmp, child;
    /// The desktop window: the launch token is the session.
    const owner = (p, opts = {}) =>
        fetch(`http://${host}/${p}`, {
            ...opts,
            headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        });
    const shellAsked = async () => (await fetch(`http://${host}/test/shell`)).json();

    before(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ringtome-device-"));
        child = spawn(path.join(WORKSPACE, "target", "debug", "ringtome"), [], {
            cwd: WORKSPACE,
            stdio: ["ignore", fs.openSync(path.join(tmp, "node.log"), "a"), fs.openSync(path.join(tmp, "node.log"), "a")],
            env: {
                ...process.env,
                RINGTOME_PORT: DEVICE_PORT,
                RINGTOME_DATA_DIRECTORY: path.join(tmp, "data"),
                RINGTOME_LOCAL_TEST: "1",
                RINGTOME_TENANCY: "single",
                RINGTOME_LAUNCH_TOKEN: token,
                RINGTOME_DISCOVERY: "off",
                RINGTOME_NODE_NAME: "a-laptop",
            },
        });
        for (let i = 0; i < 200; i++) {
            try {
                if ((await fetch(`http://${host}/health`)).ok) break;
            } catch {}
            await wait(100);
        }
        // The first launch-token request mints this computer's account; local-test mode skips the
        // first-account-is-administrator rule (auth.rs), so the test grants what the app would have.
        const me = await (await owner("api/auth/whoami")).json();
        await sql(`INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${me.id}', 'node_admin')`, host);
    });

    after(() => {
        if (child) child.kill("SIGKILL");
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("nobody else signs up: the app is its owner's alone", async () => {
        assert.equal((await (await fetch(`http://${host}/api/registration`)).json()).mode, "closed");
        assert.equal((await signUp("stranger", "password123", undefined, host)).status, 403);
    });

    it("a backup shows in the file manager rather than downloading", async () => {
        const { id } = await (await owner("api/admin/backup", { method: "POST" })).json();
        let done = null;
        for (let i = 0; i < 240 && !done; i++) {
            const r = await owner(`api/admin/backup/${id}`);
            if (r.status === 200) done = await r.json();
            else await wait(250);
        }
        assert.ok(done, "the backup finished");
        const name = path.basename(done.path);
        assert.equal((await owner(`api/admin/backups/${name}/reveal`, { method: "POST" })).status, 204);
        assert.deepEqual(await shellAsked(), [{ kind: "reveal", path: done.path }]);
    });
});
