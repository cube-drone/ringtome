const assert = require('assert');
const dns = require('node:dns');
const makeFetchHappen = require('./fetch.cjs');
const delay = ms => new Promise(res => setTimeout(res, ms));

dns.setDefaultResultOrder('ipv4first');

let { withCommunity, withUser } = require('./generators.cjs');

describe('messages', function() {

    it("we can set and read company settings, but only as the owner", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        let resp = await asUser(`api/community/${community_slug}/settings`);
        assert.equal(resp.status, 200);
        let settings = await resp.json();
        assert.equal(settings.viral_growth_enabled, false);
        assert.equal(settings.lock_community, false);

        resp = await asOwner(`api/community/${community_slug}/settings`, {
            method: 'POST',
            body: JSON.stringify({
                butts_ahoy: true,
            }),
        });
        assert.equal(resp.status, 422);

        settings.viral_growth_enabled = true;
        settings.lock_community = true;

        resp = await asUser(`api/community/${community_slug}/settings`, {
            method: 'POST',
            body: JSON.stringify(settings),
        });
        assert.equal(resp.status, 403);

        resp = await asOwner(`api/community/${community_slug}/settings`, {
            method: 'POST',
            body: JSON.stringify(settings),
        });
        assert.equal(resp.status, 200);
        let newSettings = await resp.json();
        assert.deepEqual(newSettings, settings);
    });

    it("if lock_community is enabled, new users cannot join", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { community: community2 } = await withCommunity();

        let resp = await asOwner(`api/community/${community_slug}/settings`);
        assert.equal(resp.status, 200);
        let settings = await resp.json();
        settings.lock_community = true;

        resp = await asOwner(`api/community/${community_slug}/settings`, {
            method: 'POST',
            body: JSON.stringify(settings),
        });
        assert.equal(resp.status, 200);
        let newSettings = await resp.json();
        assert.strictEqual(newSettings.lock_community, true);

        // as the owner, create an invite code
        resp = await asOwner(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'once'}),
        });
        assert.equal(resp.status, 200);
        let code = await resp.json();
        let invite_code = code.invite_code;

        let new_person = {
            name: community2.name,
            phone_number: community2.phone_number,
            password: community2.password,
            tos: true,
        }

        let fetch2 = makeFetchHappen();
        resp = await fetch2(`api/community/${community_slug}/invite/${invite_code}`, {
            method: 'POST',
            body: JSON.stringify(new_person),
        });
        assert.equal(resp.status, 403);
    });

    it("if viral_growth_enabled is true, all users can create and view invite codes", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        let resp = await asOwner(`api/community/${community_slug}/settings`);
        assert.equal(resp.status, 200);
        let settings = await resp.json();
        assert.equal(settings.viral_growth_enabled, false);

        // by default, users cannot view or create invite codes
        resp = await asUser(`api/community/${community_slug}/invite`);
        assert.equal(resp.status, 403);

        resp = await asUser(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'once'}),
        });
        assert.equal(resp.status, 403);

        // enable viral growth
        settings.viral_growth_enabled = true;
        resp = await asOwner(`api/community/${community_slug}/settings`, {
            method: 'POST',
            body: JSON.stringify(settings),
        });
        assert.equal(resp.status, 200);

        // now users can view and create invite codes
        resp = await asUser(`api/community/${community_slug}/invite`);
        assert.equal(resp.status, 200);
        let codes = await resp.json();
        assert.equal(Array.isArray(codes), true);
        // this user has no codes yet
        // note: 1 code exists (this user was invited by an admin) but the user can not see admin codes
        assert.equal(codes.length, 0);

        // now create an invite code
        resp = await asUser(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'once'}),
        });
        assert.equal(resp.status, 200);
        let code = await resp.json();
        assert.ok(code.invite_code);

        // common users can't create unlimited codes
        resp = await asUser(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'unlimited'}),
        });
        assert.equal(resp.status, 403);
    });

});