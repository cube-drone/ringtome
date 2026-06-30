const assert = require('assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const makeFetchHappen = require('./fetch.cjs');
let { gen_community, withCommunity } = require('./generators.cjs');

describe('communities', function() {

    it("should allow anybody to create a community, so long as they provide a name, email address, and phone number", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();

        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        let json = await resp.json();
        let community_slug = json.community_slug;
        assert.equal(resp.status, 200);
        assert.equal(json.user_name, community.name);
        // the response should come with a cookie!
        // we need that cookie for stuff!

        // should be able to create the same community again, but the slug should be different
        resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        json = await resp.json();
        let community_slug2 = json.community_slug;
        assert.equal(resp.status, 200);
        assert.notEqual(community_slug, community_slug2);
    });

    it("should allow anybody to create a community with just a name and email address", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();
        delete community.phone_number;

        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        let json = await resp.json();
        assert.equal(resp.status, 200);
        assert.equal(json.user_name, community.name);
    });

    it("should allow anybody to create a community with just a name and phone number", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();
        delete community.email;

        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        let json = await resp.json();
        assert.equal(resp.status, 200);
        assert.equal(json.user_name, community.name);
    });

    it("should allow us to test which slug we're going to end up with", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();

        // this new community should not yet exist
        let resp = await fetch('api/community/name', {
            method: 'POST',
            body: JSON.stringify({
                name: community.community_name,
            })
        });
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.slug);

        // now create the community!
        resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        json = await resp.json();
        assert.equal(resp.status, 200);

        // now the name should be taken
        resp = await fetch('api/community/name', {
            method: 'POST',
            body: JSON.stringify({
                name: community.community_name,
            })
        });
        assert.equal(resp.status, 200);

        json = await resp.json();
        // because the name isn't available the next slug should start with a -1
        assert(json.slug.endsWith('-1'));
    });

    it("should allow us to get a community by its slug", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();
        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });

        assert.equal(resp.status, 200);

        let json = await resp.json();
        assert(json.community_slug);
        let community_slug = json.community_slug;

        resp = await fetch(`api/community/${community_slug}`);
        assert.equal(resp.status, 200);

        json = await resp.json();
        assert.equal(json.community_name, community.community_name);
        assert.equal(json.community_slug, community_slug);
    });

    it("if we try to get community auth for a community that doesn't exist...", async function() {
        let fetch = makeFetchHappen();

        let resp = await fetch(`api/community/doesntexist/auth`);
        assert.equal(resp.status, 400);
    });

    it("once I create a community I should have an auth token that allows me to log in as the owner of that community", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();

        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        let json = await resp.json();
        let community_slug = json.community_slug;
        assert.equal(resp.status, 200);
        assert.equal(json.user_name, community.name);
        assert(json.user_tags.includes('owner'));

        // when I hit the auth endpoint it should bounce back a session
        resp = await fetch(`api/community/${community_slug}/auth`);
        json = await resp.json();
        assert.equal(resp.status, 200);
        assert.strictEqual(json.community_slug, community_slug);
    });

    it("no cookie, no auth", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();

        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        let json = await resp.json();
        let community_slug = json.community_slug;
        assert.equal(resp.status, 200);
        assert.equal(json.user_name, community.name);

        let fetch2 = makeFetchHappen();

        // I don't have the right session cookie
        resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);
    });

    it("i should be able to create an admin community", async function() {
        let { fetch, community, community_slug } = await withCommunity({});

        let resp = await fetch(`api/community/${community_slug}/auth`);
        let json = await resp.json();
        assert.equal(resp.status, 200);
        assert(!json.community_tags.includes('admin'));

        // adminify the community
        resp = await fetch(`api/community/${community_slug}/admin`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        assert.equal(resp.status, 200);

        // now the community should be an admin community
        resp = await fetch(`api/community/${community_slug}/auth`);
        json = await resp.json();
        assert.equal(resp.status, 200);
        assert(json.community_tags.includes('admin'));
    });

    it("create a community that is already verified", async function() {
        let { fetch, community_slug } = await withCommunity({verified: true});

        let resp = await fetch(`api/community/${community_slug}/auth`);
        let json = await resp.json();
        assert.equal(resp.status, 200);
        assert(json.user_tags.includes('has_phone'));
        assert(json.user_tags.includes('phone_verified'));
        assert(json.user_tags.includes('has_email'));
        assert(json.user_tags.includes('email_verified'));
        assert(json.community_tags.includes('verified'));
    })

    it("I should be able to list all of the communities that have been created", async function() {
        let { fetch, community_slug } = await withCommunity({verified: true});

        let firstLetter = community_slug.charAt(0).toUpperCase();

        let resp = await fetch(`api/community?prefix=${firstLetter}&n=1&offset=0`);
        assert.equal(resp.status, 200);
        let json = await resp.json();

        // because we requested a single community, the response should be an array of length 1
        assert.equal(json.length, 1);
        // the community slug should be the same as the one we created
        assert.equal(json[0].community_slug, community_slug);
    });

});