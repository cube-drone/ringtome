const assert = require('assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const makeFetchHappen = require('./fetch.cjs');

describe('sms', function() {
    it("send a test sms, then test that it's the most recently sent sms in the logs", async function() {
        let fetch = makeFetchHappen();
        // this sends a test sms
        let resp = await fetch(`test/sms`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`test/sms`);
        assert.equal(resp.status, 200);
        const messages = await resp.json();

        assert(messages.length > 0);
        // the most recent email should be the last one in the list, so we can just check that
        const lastSms = messages[messages.length - 1];
        assert(lastSms.phone_number);
        assert(lastSms.message);
    });
});