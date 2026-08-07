/*
    The mainline field test: real public infrastructure, no local stubs.

    Two nodes on this box with RINGTOME_DISCOVERY=mainline - serving records published to the
    actual mainline DHT via pkarr, endpoint discovery riding iroh's N0 preset (n0 relays + DNS).
    The rungs, in order:

      1. A publishes a serving record; B resolves it back OUT OF THE REAL DHT through its own
         pkarr client (the /test/resolve-serving passthrough - the only caller of the mainline
         resolve path).
      2. The adoption ceremony runs A->B. The grant code carries one-shot bootstrap addresses
         by design, so this act alone proves nothing about discovery - it just builds the pair.
      3. Both nodes RESTART. That wipes iroh's in-memory address cache and rebinds both
         endpoints on fresh UDP ports, so the post-restart sync can only succeed if B turns
         A's bare endpoint id into fresh addresses via the public discovery infrastructure.

    Deliberately NOT part of `npm test` or CI pushes: it depends on the open internet and the
    health of public infrastructure (fast when healthy - observed full runs take ~7s, since
    pkarr relays and n0 DNS answer in one round trip - but budgeted in minutes for when the
    relay shortcuts are down), and each run publishes throwaway records (including this
    machine's public IP) to the public DHT. Run it via `just mainline-smoke` or the dispatch-only GitHub action.
    Arms itself only when RINGTOME_TEST_MAINLINE is set; skips silently otherwise.

    Unlike the rest of the suite this file spawns its own node processes - it has to, because
    the restart in act 3 is the whole point. The harness does not boot nodes for it.
*/
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const ARMED = !!process.env.RINGTOME_TEST_MAINLINE;

const WORKSPACE = path.resolve(__dirname, "..", "..", "..");
const BINARY = process.env.RINGTOME_TEST_BINARY
    || path.join(WORKSPACE, "target", "debug", process.platform === "win32" ? "ringtome.exe" : "ringtome");
const DATA_ROOT = path.join(WORKSPACE, "data", "test-mainline");
// `just mainline-smoke` passes the ringtome-alt twin offset through, so a parallel checkout's
// smoke test can't steal these ports either; a bare run (offset unset) keeps the base ports.
const PORT_A = 5293 + parseInt(process.env.RINGTOME_PORT_OFFSET || "0", 10);
const PORT_B = 5294 + parseInt(process.env.RINGTOME_PORT_OFFSET || "0", 10);

// Ceilings, not expectations: healthy runs clear each rung on the first poll (relay/DNS paths
// are one round trip), so these budgets only matter when the relays are down and we're waiting
// on genuine DHT propagation and republish cycles.
const RESOLVE_TIMEOUT_MS = 3 * 60 * 1000;
const REDISCOVER_TIMEOUT_MS = 5 * 60 * 1000;

/* Keep retrying `fn` until it returns without throwing; on deadline, fail with the last error
   so the report says what the world actually looked like, not just "timed out". */
async function eventually(label, timeoutMs, intervalMs, fn) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    for (;;) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
        }
        if (Date.now() > deadline) {
            throw new Error(`${label}: not satisfied within ${timeoutMs}ms; last: ${lastErr}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

function spawnNode(name, port) {
    const dataDir = path.join(DATA_ROOT, name);
    const logPath = path.join(DATA_ROOT, `${name}.log`);
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    const log = fs.openSync(logPath, "a");
    const child = spawn(BINARY, [], {
        env: {
            ...process.env,
            RINGTOME_PORT: String(port),
            RINGTOME_DATA_DIRECTORY: dataDir,
            RINGTOME_DISCOVERY: "mainline",
            RINGTOME_LOCAL_TEST: "1",
        },
        stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    return { name, port, logPath, child, host: `127.0.0.1:${port}` };
}

async function waitHealthy(node) {
    await eventually(`${node.name} /health`, 30_000, 250, async () => {
        const resp = await fetch(`http://${node.host}/health`);
        if (resp.status !== 200) throw new Error(`status ${resp.status}`);
    });
}

async function stopNode(node) {
    if (!node || node.child.exitCode !== null) return;
    const exited = new Promise((r) => node.child.once("exit", r));
    node.child.kill();
    const timeout = new Promise((r) => setTimeout(r, 5000, "timeout"));
    if ((await Promise.race([exited, timeout])) === "timeout") {
        node.child.kill("SIGKILL");
        await exited;
    }
}

function logTail(node, lines = 60) {
    try {
        const all = fs.readFileSync(node.logPath, "utf8").split("\n");
        return all.slice(-lines).join("\n");
    } catch (e) {
        return `(no log: ${e})`;
    }
}

(ARMED ? describe : describe.skip)("mainline field test (REAL public DHT)", function () {
    // Every act waits on the public internet; budget accordingly.
    this.timeout(15 * 60 * 1000);

    let nodeA = null;
    let nodeB = null;

    before(async function () {
        assert.ok(
            fs.existsSync(BINARY),
            `no node binary at ${BINARY} - build first (just mainline-smoke does)`
        );
        fs.rmSync(DATA_ROOT, { recursive: true, force: true });
        nodeA = spawnNode("a", PORT_A);
        nodeB = spawnNode("b", PORT_B);
        await waitHealthy(nodeA);
        await waitHealthy(nodeB);
    });

    after(async function () {
        await stopNode(nodeA);
        await stopNode(nodeB);
    });

    afterEach(function () {
        if (this.currentTest && this.currentTest.state === "failed") {
            for (const node of [nodeA, nodeB]) {
                if (!node) continue;
                console.error(`\n--- ${node.name} log tail (${node.logPath}) ---`);
                console.error(logTail(node));
            }
        }
    });

    it("publishes, resolves, adopts, and rediscovers over public infrastructure", async function () {
        // --- Rung 1: a record into the DHT and back out the other side.
        const alice = await makeUserFetch({ prefix: "mainline", host: nodeA.host });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        await alice(`api/identity/${root}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Mainline Milly" }),
        });

        const nodeInfoA = await (await alice("api/node")).json();
        const endpointIdA = nodeInfoA.endpoint_id;

        const serveResp = await (await alice(`api/identity/${root}/serve`, { method: "POST" })).json();
        assert.equal(serveResp.served, true, "the publication act must report success");

        // B's pkarr client pulls the record from the real DHT. On the creating node the serving
        // leaf IS the root, so the record is published under the root key.
        const anonOnB = makeFetch(nodeB.host);
        const resolved = await eventually("B resolves A's serving record", RESOLVE_TIMEOUT_MS, 5000, async () => {
            const resp = await anonOnB(`test/resolve-serving/${root}`);
            assert.equal(resp.status, 200);
            const body = await resp.json();
            assert.ok(body.found, "record not yet resolvable from the DHT");
            return body;
        });
        assert.equal(resolved.root, root, "resolved record names the served root");
        assert.equal(resolved.node_key, root, "creating node's serving leaf is the root");
        assert.equal(resolved.endpoint_id, endpointIdA, "resolved record points at A's endpoint");

        // --- Rung 2: the adoption ceremony (bootstrap addresses by design - not a discovery test).
        const aliceOnB = await makeUserFetch({ prefix: "mainlineb", host: nodeB.host });
        const request = await (await aliceOnB("api/identity/adopt/begin", { method: "POST" })).json();
        const grant = await (
            await alice(`api/identity/${root}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        const adopted = await (
            await aliceOnB("api/identity/adopt/complete", {
                method: "POST",
                body: JSON.stringify({ code: grant.code }),
            })
        ).json();
        assert.equal(adopted.root_pubkey, root, "B now agents the identity");

        const profileOnB = await (await aliceOnB(`api/identity/${root}/profile`)).json();
        assert.equal(
            (profileOnB.find((f) => f.field === "name") || {}).value,
            "Mainline Milly",
            "adoption synced the profile"
        );

        // --- Rung 3: restart BOTH nodes. Address caches are gone and both endpoints rebind on
        // fresh ports, so B reaching A again can only work via id -> address rediscovery
        // through iroh's public machinery.
        await stopNode(nodeA);
        await stopNode(nodeB);
        nodeA = spawnNode("a", PORT_A);
        nodeB = spawnNode("b", PORT_B);
        await waitHealthy(nodeA);
        await waitHealthy(nodeB);

        // Sessions are node.db-backed and the cookie jars survived, so the same fetches work.
        await alice(`api/identity/${root}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Post-Restart Pat" }),
        });

        const rediscovered = await eventually("B re-syncs from A by bare endpoint id", REDISCOVER_TIMEOUT_MS, 10_000, async () => {
            const results = await (await aliceOnB(`api/identity/${root}/sync`, { method: "POST" })).json();
            const toA = results.find((r) => r.peer === endpointIdA);
            assert.ok(toA, `A's endpoint id not among B's peers: ${JSON.stringify(results)}`);
            assert.ok(toA.ok, `dial-by-id to A failed: ${toA.error}`);
            const profile = await (await aliceOnB(`api/identity/${root}/profile`)).json();
            const name = (profile.find((f) => f.field === "name") || {}).value;
            assert.equal(name, "Post-Restart Pat", "post-restart write has not propagated yet");
            return toA;
        });
        assert.ok(rediscovered.stats, "the rediscovered sync reported stats");
    });
});
