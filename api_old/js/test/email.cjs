const assert = require('assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const makeFetchHappen = require('./fetch.cjs');

describe('email', function() {
    it("send a test email, then test that it's the most recently sent email in the logs", async function() {
        // this sends a test email
        let fetch = makeFetchHappen();
        let resp = await fetch(`test/email`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`test/email`);
        assert.equal(resp.status, 200);
        const emails = await resp.json();

        assert(emails.length > 0);
        // the most recent email should be the last one in the list, so we can just check that
        const lastEmail = emails[emails.length - 1];
        assert(lastEmail.to);
        assert(lastEmail.subject);
        assert(lastEmail.message);
    });
});