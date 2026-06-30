const assert = require('assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const makeFetchHappen = require('./fetch.cjs');

describe('backend versions', function() {
    it("should return a 200 status", async function() {
        const fetch = makeFetchHappen();
        const resp = await fetch(`static/0.0.1/app.js`);

        assert.equal(resp.status, 200);
    });

    it("shouldn't let us pass in a non-version version", async function() {
        const fetch = makeFetchHappen();
        const resp = await fetch(`static/FLARPTADOO/app.js`);

        assert.equal(resp.status, 400);
    });

    it("shouldn't let us pass in a version that's way higher than the one that's active", async function() {
        const fetch = makeFetchHappen();
        const resp = await fetch(`static/9999.9999.9999/app.js`);

        assert.equal(resp.status, 400);
    });
});