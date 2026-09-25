/*
    Backups (node/src/backup.rs, 2026-09-25): the node packs itself into one archive while it keeps
    running, and the archive RESTORES. The door is the machine itself (a direct loopback request -
    which this test process is) or a node administrator; a request that came through a proxy is
    refused. A backup is a ticket: 202 with its log while it runs, 200 with the archive's path when
    whole. The proof of the archive is not a file listing but the node's own code opening an
    unpacked copy - the keystore, node.db, and a persona through the ordinary user-database manager
    - and finding the post this test published.
*/
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { HOST, makeFetch } = require("./fetch.cjs");

const j = (who, p, body, method = "POST") => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
// The rig runs every node from the workspace root, so a path the node reports resolves there.
const WORKSPACE = path.resolve(__dirname, "..", "..", "..");

describe("backups: the node packs itself, and the archive restores", function () {
    this.timeout(600000);

    let ada, adaRoot;

    before(async () => {
        ada = await makeUserFetch({ prefix: "backada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "backed up", body: "the words to keep", format: "plaintext" })).json();
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.text());
    });

    it("a request that came through a proxy is refused", async () => {
        const r = await makeFetch(HOST)("api/admin/backup", { method: "POST", headers: { "X-Forwarded-For": "203.0.113.9" } });
        assert.equal(r.status, 403, await r.text());
    });

    it("the machine itself gets a ticket, and the ticket ends in a whole archive that restores", async () => {
        const node = makeFetch(HOST);
        const started = await node("api/admin/backup", { method: "POST" });
        assert.equal(started.status, 202, await started.clone().text());
        const ticket = await started.json();
        assert.ok(ticket.id, "a ticket");

        let done = null;
        let sawRunning = false;
        for (let i = 0; i < 120 && !done; i++) {
            const r = await node(`api/admin/backup/${ticket.id}`);
            const body = await r.json();
            if (r.status === 200) done = body;
            else {
                assert.equal(r.status, 202, `running, not failed: ${JSON.stringify(body)}`);
                sawRunning = true;
                await wait(250);
            }
        }
        assert.ok(done, "the backup finished");
        assert.equal(done.status, "done");
        assert.ok(done.log.some((l) => /persona databases/.test(l)), `a log of the work: ${done.log.join(" | ")}`);
        assert.match(path.basename(done.path), /^backup_\d{8}T\d{6}Z\.tar\.gz$/, "named by its UTC time");
        void sawRunning;

        const archive = path.resolve(WORKSPACE, done.path);
        assert.ok(fs.existsSync(archive), `the archive is where the ticket says: ${archive}`);
        assert.ok(!fs.existsSync(`${archive}.partial`), "and nothing half-written is left beside it");
        const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
        const has = (name) => listing.some((l) => l.replace(/^\.\//, "") === name);
        assert.ok(has("envelope.key"), "the key that unlocks the rest");
        assert.ok(has("node.db"), "the node's database");
        assert.ok(has(`users/${adaRoot}.db`), "the persona's database");
        assert.ok(has(`journals/${adaRoot}.jnl`), "and its journal");
        assert.ok(!listing.some((l) => /(^|\/)backups\//.test(l)), "never the backups themselves");

        // The proof: unpack it, and let the node's own code open the copy.
        const restored = fs.mkdtempSync(path.join(os.tmpdir(), "ringtome-restore-"));
        try {
            execFileSync("tar", ["-xzf", archive, "-C", restored]);
            const verify = await j(node, "test/backup-verify", { dir: restored, root: adaRoot });
            const found = await verify.json();
            assert.equal(verify.status, 200, JSON.stringify(found));
            assert.equal(found.hosted, true, "the restored node still hosts the persona");
            assert.equal(found.has_entries, true, "its chain came back");
            assert.ok(found.titles.includes("backed up"), `and its post: ${JSON.stringify(found.titles)}`);
        } finally {
            fs.rmSync(restored, { recursive: true, force: true });
            fs.rmSync(archive, { force: true });
        }
    });
});
