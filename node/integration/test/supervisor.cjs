/*
    The supervisor (supervisor/, 2026-09-25): the stable parent that keeps a server node running,
    current, and backed up - and undoes an update that will not come up.

    This file plays GitHub: an http server on loopback serving `server-latest.json` and signed
    release tarballs, exactly the shapes release.yml publishes. It signs them the way
    `tauri signer sign` does (a prehashed minisign signature, base64-wrapped whole) with a key made
    here, using Node's crypto - an implementation independent of the supervisor's verifier - and
    hands the supervisor that key's public half. The node inside every GOOD release is the real
    `target/debug/ringtome`; the BAD release is a script that scribbles in the data directory, the
    way a migration would, and dies.

    One supervisor, one real node, one story in order:
      1. first start: nothing installed, so it installs the release the manifest names and runs it;
      2. a release signed by a stranger is refused - not installed, not run, not skipped;
      3. a correctly signed release that cannot come up is ROLLED BACK - the old binary AND the
         data from the backup taken before it - and never tried again;
      4. the next good release goes in, keeping the previous version as the rollback;
      5. SIGTERM stops the supervisor and the node with it.
*/
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const WORKSPACE = path.resolve(__dirname, "..", "..", "..");
const NODE_BINARY = path.join(WORKSPACE, "target", "debug", "ringtome");
const SUPERVISOR_BINARY = path.join(WORKSPACE, "target", "debug", "ringtome-supervisor");
const PORT = process.env.RINGTOME_TEST_SUPERVISOR_PORT;
// The supervisor's own name for this machine: std::env::consts::{OS, ARCH}.
const PLATFORM = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch}`;

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// --- signing, the way the Tauri signer does it ---------------------------------------------

function makeKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
    const keyId = crypto.randomBytes(8);
    return { privateKey, keyId, publicLine: Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64") };
}

/// base64 of a minisign signature file over `bytes`: algorithm `ED` (Ed25519 over BLAKE2b-512),
/// plus the global signature over the signature and the trusted comment.
function tauriSign(key, bytes, file) {
    const prehash = crypto.createHash("blake2b512").update(bytes).digest();
    const signature = crypto.sign(null, prehash, key.privateKey);
    const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${file}`;
    const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trusted)]), key.privateKey);
    const text =
        "untrusted comment: signature from tauri secret key\n" +
        `${Buffer.concat([Buffer.from("ED"), key.keyId, signature]).toString("base64")}\n` +
        `trusted comment: ${trusted}\n${global.toString("base64")}\n`;
    return Buffer.from(text).toString("base64");
}

// --- the release server ------------------------------------------------------------------

(PORT ? describe : describe.skip)("supervisor: running, updating, and rolling back a server node", function () {
    this.timeout(600000);

    let brokenBinary, tmp, supDir, dataDir, backupDir, logFile, server, baseUrl, supervisor, exited;
    const files = new Map();
    let manifest = null;
    const releaseKey = makeKey();
    const nodeUrl = `http://127.0.0.1:${PORT}`;

    const state = () => {
        try {
            return JSON.parse(fs.readFileSync(path.join(supDir, "state.json"), "utf8"));
        } catch {
            return {};
        }
    };
    const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");
    const healthy = async () => {
        try {
            return (await fetch(`${nodeUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
            return false;
        }
    };
    async function until(what, check, ms = 120000) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (exited) assert.fail(`the supervisor exited while waiting for ${what}:\n${log()}`);
            if (await check()) return;
            await wait(250);
        }
        assert.fail(`timed out waiting for ${what}; state ${JSON.stringify(state())}\n--- supervisor log ---\n${log()}`);
    }

    /// Publish `version` as the newest release: a tarball holding `binary` as `ringtome`, signed
    /// by `key`, named in the manifest.
    function release(version, binary, key = releaseKey) {
        const dirName = `ringtome-server-${version}-test-${PLATFORM}`;
        const stage = path.join(tmp, `stage-${version}`, dirName);
        fs.mkdirSync(stage, { recursive: true });
        fs.copyFileSync(binary, path.join(stage, "ringtome"));
        fs.chmodSync(path.join(stage, "ringtome"), 0o755);
        const tarball = path.join(tmp, `${dirName}.tar.gz`);
        execFileSync("tar", ["-czf", tarball, "-C", path.dirname(stage), dirName]);
        const bytes = fs.readFileSync(tarball);
        const name = path.basename(tarball);
        files.set(`/download/${name}`, bytes);
        manifest = {
            version,
            name: `${version}-test`,
            tag: `v${version}-test`,
            pub_date: new Date().toISOString(),
            platforms: {
                [PLATFORM]: {
                    url: `${baseUrl}/download/${name}`,
                    signature: tauriSign(key, bytes, name),
                    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
                },
            },
        };
    }

    before(async () => {
        assert.ok(fs.existsSync(SUPERVISOR_BINARY), `built by \`just build\`: ${SUPERVISOR_BINARY}`);
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ringtome-supervisor-"));
        supDir = path.join(tmp, "supervisor");
        dataDir = path.join(tmp, "data");
        backupDir = path.join(supDir, "backups");
        logFile = path.join(tmp, "supervisor.log");

        server = http.createServer((req, res) => {
            if (req.url === "/server-latest.json" && manifest) {
                res.writeHead(200, { "content-type": "application/json" });
                return res.end(JSON.stringify(manifest));
            }
            const bytes = files.get(req.url);
            if (bytes) {
                res.writeHead(200, { "content-type": "application/gzip" });
                return res.end(bytes);
            }
            res.writeHead(404);
            res.end();
        });
        await new Promise((res) => server.listen(0, "127.0.0.1", res));
        baseUrl = `http://127.0.0.1:${server.address().port}`;

        // The deliberately broken release: it gets as far as touching the data - the way a
        // migration moves a schema forward - and then cannot run.
        brokenBinary = path.join(tmp, "broken-ringtome");
        fs.writeFileSync(
            brokenBinary,
            '#!/bin/sh\necho "a newer schema was here" > "$RINGTOME_DATA_DIRECTORY/broken-was-here"\nexit 3\n'
        );
        fs.chmodSync(brokenBinary, 0o755);
    });

    after(async () => {
        if (supervisor && !exited) supervisor.kill("SIGKILL");
        // On Linux the node dies with the supervisor (PR_SET_PDEATHSIG); elsewhere, by its pid file.
        try {
            const pid = parseInt(fs.readFileSync(path.join(supDir, "node.pid"), "utf8"), 10);
            if (pid) process.kill(pid, "SIGKILL");
        } catch {}
        if (server) server.close();
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("on first start it installs the release the manifest names, and runs it", async () => {
        release("0.0.1", NODE_BINARY);
        // Run from a directory of its own: beside the build's `ringtome`, it would adopt that one
        // (install.rs, `adopt`) instead of installing what the manifest names.
        const alone = path.join(tmp, "bin", "ringtome-supervisor");
        fs.mkdirSync(path.dirname(alone), { recursive: true });
        fs.copyFileSync(SUPERVISOR_BINARY, alone);
        fs.chmodSync(alone, 0o755);
        const out = fs.openSync(logFile, "a");
        supervisor = spawn(alone, [], {
            cwd: WORKSPACE,
            stdio: ["ignore", out, out],
            env: {
                ...process.env,
                RINGTOME_SUPERVISOR_DIRECTORY: supDir,
                RINGTOME_DATA_DIRECTORY: dataDir,
                RINGTOME_PORT: PORT,
                RINGTOME_DISCOVERY: "off",
                RINGTOME_NODE_NAME: "supervised",
                RINGTOME_UPDATE_MANIFEST_URL: `${baseUrl}/server-latest.json`,
                RINGTOME_UPDATE_PUBLIC_KEY: releaseKey.publicLine,
                RINGTOME_UPDATE_CHECK_SECONDS: "1",
                RINGTOME_UPDATE_PROBATION_SECONDS: "2",
                RINGTOME_UPDATE_HEALTH_TIMEOUT_SECONDS: "60",
                RINGTOME_STOP_GRACE_SECONDS: "5",
            },
        });
        exited = false;
        supervisor.on("exit", () => (exited = true));

        await until("the first install to come up", async () => state().current?.version === "0.0.1" && (await healthy()));
        assert.ok(fs.existsSync(path.join(supDir, "versions", "0.0.1", "ringtome")), "installed where the state says");
        assert.ok(fs.existsSync(path.join(dataDir, "node.db")), "and the node made its data where it was told");
    });

    it("a release signed by anyone but the release key is refused - not installed, not run, not skipped", async () => {
        fs.writeFileSync(path.join(dataDir, "pre-update-marker"), "before every update");
        release("0.0.2", NODE_BINARY, makeKey());
        await until("the forgery to be refused", async () => /does not verify against the release key/.test(log()));
        await wait(1500); // and a check or two more, for anything that would happen after the refusal
        const s = state();
        assert.equal(s.current.version, "0.0.1", "still running what it ran");
        assert.ok(!(s.skipped || []).includes("0.0.2"), "a refusal is not a failed version: a correctly signed copy may yet appear");
        assert.ok(!fs.existsSync(path.join(supDir, "versions", "0.0.2")), "nothing of it written");
        assert.ok(await healthy(), "and the node never stopped");
    });

    it("a signed release that cannot come up is rolled back: the old binary, and the data from before", async () => {
        release("0.0.3", brokenBinary);
        await until(
            "the rollback",
            async () => /rolled back/.test(log()) && (state().skipped || []).includes("0.0.3") && (await healthy())
        );
        const s = state();
        assert.equal(s.current.version, "0.0.1", "back on the version before");
        assert.equal(s.pending, null, "the update is settled");
        assert.match(log(), /the update failed/);
        assert.ok(!fs.existsSync(path.join(dataDir, "broken-was-here")), "what the failed version wrote is gone");
        assert.equal(fs.readFileSync(path.join(dataDir, "pre-update-marker"), "utf8"), "before every update", "the data is the backup's");
        assert.ok(
            fs.readdirSync(dataDir).every((n) => !n.startsWith(".rollback-")),
            "and the failed version's data, kept aside until the rollback came up, is cleared"
        );
        assert.ok(
            fs.readdirSync(backupDir).some((n) => /^backup_\d{8}T\d{6}Z\.tar\.gz$/.test(n)),
            `the backup the rollback came from is kept: ${fs.readdirSync(backupDir)}`
        );
        await wait(2500);
        assert.equal(state().current.version, "0.0.1", "and the failed version is never tried again");
    });

    it("the next good release goes in, and the version before it stays installed as the rollback", async () => {
        release("0.0.4", NODE_BINARY);
        await until("the update", async () => state().current?.version === "0.0.4" && !state().pending && (await healthy()));
        const s = state();
        assert.equal(s.previous.version, "0.0.1");
        assert.deepEqual(fs.readdirSync(path.join(supDir, "versions")).sort(), ["0.0.1", "0.0.4"], "the failed one pruned");
        assert.equal(fs.readFileSync(path.join(dataDir, "pre-update-marker"), "utf8"), "before every update", "the data carried forward");
    });

    it("SIGTERM stops the supervisor and the node with it", async () => {
        supervisor.kill("SIGTERM");
        await new Promise((res) => (exited ? res() : supervisor.on("exit", res)));
        const deadline = Date.now() + 15000;
        while ((await healthy()) && Date.now() < deadline) await wait(250);
        assert.ok(!(await healthy()), "the node is gone too");
        assert.ok(!fs.existsSync(path.join(supDir, "node.pid")), "and so is its pid file");
    });
});
