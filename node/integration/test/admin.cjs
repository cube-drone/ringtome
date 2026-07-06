const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, makeFetch } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

// In local-test mode the "first account becomes node_admin" bootstrap is disabled, so a freshly
// registered user reliably starts with no tags. We grant exactly the tags each actor needs via the
// LOCAL_TEST SQL passthrough, keeping every test order-independent. (The bootstrap rule itself is
// covered by a Rust unit test, since it can't run while local-test disables it.)

function esc(s) {
    return s.replace(/'/g, "''");
}

async function setTag(accountId, tag) {
    await sql(
        `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${esc(accountId)}', '${esc(tag)}')`
    );
}

// A user with a known, explicit tag set (defaults to no tags = genuinely plain).
async function userWithTags(prefix, tags = []) {
    const user = await makeUserFetch({ prefix });
    for (const t of tags) await setTag(user.account.id, t);
    return user;
}

async function grant(actor, username, tag) {
    return actor("api/admin/grant", {
        method: "POST",
        body: JSON.stringify({ username, tag }),
    });
}

async function revoke(actor, username, tag) {
    return actor("api/admin/revoke", {
        method: "POST",
        body: JSON.stringify({ username, tag }),
    });
}

describe("admin authorization", function () {
    it("a plain user cannot hit admin endpoints", async function () {
        const user = await userWithTags("plain", []);
        assert.equal((await user("api/admin/ping")).status, 403);
        assert.equal((await user("api/admin/node/ping")).status, 403);
    });

    it("an unauthenticated caller gets 401, not 403", async function () {
        assert.equal((await makeFetch()("api/admin/ping")).status, 401);
    });

    it("an admin can hit admin/ping but not node/ping", async function () {
        const admin = await userWithTags("adm", ["admin"]);
        assert.equal((await admin("api/admin/ping")).status, 200);
        assert.equal((await admin("api/admin/node/ping")).status, 403);
    });

    it("a node_admin can hit both", async function () {
        const nodeAdmin = await userWithTags("nadm", ["node_admin"]);
        assert.equal((await nodeAdmin("api/admin/ping")).status, 200);
        assert.equal((await nodeAdmin("api/admin/node/ping")).status, 200);
    });
});

describe("tag grant/revoke rules", function () {
    it("an admin can grant and revoke ordinary tags", async function () {
        const admin = await userWithTags("granter", ["admin"]);
        const target = await userWithTags("grantee", []);

        assert.equal((await grant(admin, target.username, "beta")).status, 200);
        assert.equal((await revoke(admin, target.username, "beta")).status, 200);
    });

    it("an admin CANNOT grant or revoke node_admin", async function () {
        const admin = await userWithTags("wannabe", ["admin"]);
        const target = await userWithTags("victim", []);

        assert.equal(
            (await grant(admin, target.username, "node_admin")).status,
            403,
            "admin must not grant node_admin"
        );
        assert.equal(
            (await revoke(admin, target.username, "node_admin")).status,
            403,
            "admin must not revoke node_admin"
        );
    });

    it("a node_admin CAN grant and revoke node_admin", async function () {
        const nodeAdmin = await userWithTags("kingmaker", ["node_admin"]);
        const target = await userWithTags("heir", []);

        assert.equal((await grant(nodeAdmin, target.username, "node_admin")).status, 200);
        // The target really is a node_admin now.
        assert.equal((await target("api/admin/node/ping")).status, 200);

        assert.equal((await revoke(nodeAdmin, target.username, "node_admin")).status, 200);
        assert.equal((await target("api/admin/node/ping")).status, 403);
    });

    it("granting to a nonexistent user is 404", async function () {
        const nodeAdmin = await userWithTags("grantfail", ["node_admin"]);
        assert.equal((await grant(nodeAdmin, "nobody-here", "beta")).status, 404);
    });
});
