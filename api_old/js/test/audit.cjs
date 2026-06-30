const assert = require('assert');
const dayjs = require('dayjs');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const makeFetchHappen = require('./fetch.cjs');
const tty = require('testytesterson');

let { gen_community, withCommunity, withUser } = require('./generators.cjs');

describe('audit', function() {

    it("we can get, as an admin, some audit info on what is happening in the community", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        // the user can not make themselves an admin
        let resp = await asUser(`api/community/${community_slug}/audit`);
        assert.equal(resp.status, 400);
        let json = await resp.json();
        assert(json.message.includes("admin"));

        // the owner can get audit logs
        resp = await asOwner(`api/community/${community_slug}/audit`);
        assert.equal(resp.status, 200);
        let audits = await resp.json();
        assert(Array.isArray(audits));
        assert(audits.length > 0);
    });

    it("if we lock a user, that shows up in the audit logs", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        // the owner can lock the user
        let resp = await asOwner(`api/community/${community_slug}/user/${new_person.id}/lock`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        // flush the event queue
        resp = await asUser(`api/admin/flush`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        // the owner can get audit logs
        resp = await asOwner(`api/community/${community_slug}/audit`);
        assert.equal(resp.status, 200);
        let audits = await resp.json();
        assert(Array.isArray(audits));
        assert(audits.length > 0);

        // grab the first three logs
        audits = audits.slice(0, 3);

        // one of them (probably the first one) should be action:"UserLocked"
        let found = audits.find(a => a.action === "UserLocked");
        assert(found, "We should have found a UserLocked action in the audit logs");

        // let's find that specific audit log
        resp = await asOwner(`api/community/${community_slug}/audit?user_id=${new_person.id}&action=UserLocked`);
        assert.equal(resp.status, 200);
        audits = await resp.json();
        assert(audits);
        assert.equal(audits.length, 1);
        let audit = audits[0];
        assert.equal(audit.action, "UserLocked");
        assert.equal(audit.user_id, new_person.id);


    });

});