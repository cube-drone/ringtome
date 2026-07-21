const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql } = require("./fetch.cjs");

describe("node database", function () {
    it("recorded a boot in boot_timestamps", async function () {
        const { rows } = await sql(
            "SELECT id, booted_at_ms, app_version FROM boot_timestamps ORDER BY id DESC LIMIT 1"
        );
        assert.equal(rows.length, 1, "expected at least one boot row");

        const boot = rows[0];
        assert.ok(Number.isInteger(boot.id), "id should be an integer");
        assert.ok(boot.booted_at_ms > 0, "booted_at_ms should be a positive timestamp");
        assert.ok(boot.app_version, "app_version should be present");
    });

    it("ran its migrations (schema version is stamped)", async function () {
        const { rows } = await sql("PRAGMA user_version");
        assert.ok(rows[0].user_version >= 1, "expected a stamped schema version");
    });

    it("supports round-tripping via the raw SQL passthrough", async function () {
        // Prove read+write through the passthrough against a scratch table.
        await sql("CREATE TABLE IF NOT EXISTS _probe (k TEXT, v INTEGER)");
        await sql("DELETE FROM _probe");
        await sql("INSERT INTO _probe (k, v) VALUES ('answer', 42)");

        const { rows } = await sql("SELECT k, v FROM _probe WHERE k = 'answer'");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].k, "answer");
        assert.equal(rows[0].v, 42);
    });
});
