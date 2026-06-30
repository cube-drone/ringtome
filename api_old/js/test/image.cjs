const assert = require('assert');
const dayjs = require('dayjs');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const delay = (x) => { return new Promise(resolve => setTimeout(resolve, 1000)); };

const { readFile } = require('node:fs/promises');
const { basename } = require('node:path');

const tty = require('testytesterson');

let { withCommunity, withUser, uuid } = require('./generators.cjs');

let localImagePath = 'test/testobjects/test-image.png';

let base64Image = "data:image/png;base64,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";

describe('images', function() {

    it("any user can upload an image", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        const buf = await readFile(localImagePath);
        const blob = new Blob([buf], { type: 'image/png' });

        const form = new FormData();
        form.append('image', blob, basename(localImagePath));

        const resp = await asUser(`api/community/${community_slug}/image`, {
            method: 'POST',
            body: form,
            file: true
        });

        const fileId = await resp.json();
        assert.strictEqual(resp.status, 200);
        assert.ok(fileId);

        // now get the image
        const getResp = await asUser(`api/community/${community_slug}/image/${fileId}`);
        // the response should be the image
        assert.strictEqual(getResp.status, 200);
        const contentType = getResp.headers.get('content-type');
        // it doesn't matter what the original image type was, we convert it to webp on upload
        assert.strictEqual(contentType, 'image/webp');
        const imageData = await getResp.arrayBuffer();
        assert.ok(imageData.byteLength > 0);
    });

    it("any user can upload a base64 image", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        const resp = await asUser(`api/community/${community_slug}/image_base64`, {
            method: 'POST',
            body: JSON.stringify({
                image: base64Image,
                visibility: "private"
            })
        });

        const fileId = await resp.json();
        assert.strictEqual(resp.status, 200);
        assert.ok(fileId);

        // now get the image
        const getResp = await asUser(`api/community/${community_slug}/image/${fileId}`);
        // the response should be the image
        assert.strictEqual(getResp.status, 200);
        const contentType = getResp.headers.get('content-type');
        // it doesn't matter what the original image type was, we convert it to webp on upload
        assert.strictEqual(contentType, 'image/webp');
        const imageData = await getResp.arrayBuffer();
        assert.ok(imageData.byteLength > 0);
    });

    it("images default to being private, which means that other users cannot see them", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});
        let { fetch: asOtherUser, new_person: other_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        const buf = await readFile(localImagePath);
        const blob = new Blob([buf], { type: 'image/png' });

        const form = new FormData();
        form.append('image', blob, basename(localImagePath));
        const resp = await asUser(`api/community/${community_slug}/image`, {
            method: 'POST',
            body: form,
            file: true
        });

        const fileId = await resp.json();
        assert.strictEqual(resp.status, 200);
        assert.ok(fileId);

        // now get the image as the other user
        const getResp = await asOtherUser(`api/community/${community_slug}/image/${fileId}`);
        // the response should be a 404
        assert.strictEqual(getResp.status, 404);

        // now get the image as the owner
        const getResp2 = await asUser(`api/community/${community_slug}/image/${fileId}`);
        // the response should be the image
        assert.strictEqual(getResp2.status, 200);

        // now get the image as the admin
        const getResp3 = await asOwner(`api/community/${community_slug}/image/${fileId}`);
        // the response should be the image
        assert.strictEqual(getResp3.status, 200);
    });

    it("users can upload images that are public, which means that other users can see them", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});
        let { fetch: asOtherUser, new_person: other_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        const buf = await readFile(localImagePath);
        const blob = new Blob([buf], { type: 'image/png' });

        const form = new FormData();
        form.append('image', blob, basename(localImagePath));
        form.append('visibility', 'public');
        const resp = await asUser(`api/community/${community_slug}/image`, {
            method: 'POST',
            body: form,
            file: true
        });

        const fileId = await resp.json();
        assert.strictEqual(resp.status, 200);
        assert.ok(fileId);

        // this time the other user should be able to see it
        const getResp = await asOtherUser(`api/community/${community_slug}/image/${fileId}`);
        assert.strictEqual(getResp.status, 200);
    });

    it("users can upload 'globalpublic' images, which means that anyone can see them", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});
        let { fetch: asAnonymous } = await withAnonymous();

        const buf = await readFile(localImagePath);
        const blob = new Blob([buf], { type: 'image/png' });
        const form = new FormData();
        form.append('image', blob, basename(localImagePath));
        form.append('visibility', 'globalpublic');
        const resp = await asUser(`api/community/${community_slug}/image`, {
            method: 'POST',
            body: form,
            file: true
        });

        const fileId = await resp.json();
        assert.strictEqual(resp.status, 200);
        assert.ok(fileId);

        // now get the image as an anonymous user
        const getResp = await asAnonymous(`api/community/${community_slug}/public/image/${fileId}`);
        assert.strictEqual(getResp.status, 200);
        assert.ok(getResp.body);
        const contentType = getResp.headers.get('content-type');
        // it doesn't matter what the original image type was, we convert it to webp on upload
        assert.strictEqual(contentType, 'image/webp');
        const imageData = await getResp.arrayBuffer();
        assert.ok(imageData.byteLength > 0);

    });

});