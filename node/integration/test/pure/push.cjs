/*
    Web Push's browser-side decisions (js/pure/push.js, 2026-09-25): turning the node's key into
    the bytes the Push API wants, deciding what this browser can do, and whether it is one of the
    endpoints the node pushes to for this persona.
*/
const assert = require('node:assert');

let keyBytes, pushSupport, subscribedHere;
before(async () => {
    ({ keyBytes, pushSupport, subscribedHere } = await import('../../../js/pure/push.js'));
});

describe('web push, the browser half', () => {
    it('decodes a base64url key to the raw point, padding or not', () => {
        // RFC 8291's example sender key: an uncompressed P-256 point, 65 bytes, leading 0x04.
        const k = keyBytes('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
        assert.equal(k.length, 65);
        assert.equal(k[0], 4);
        assert.deepEqual(Array.from(keyBytes('-_8')), [0xfb, 0xff], 'the url alphabet, unpadded');
    });

    it('says what this browser can do, in the order a person needs to hear it', () => {
        const all = { desktop: false, secure: true, serviceWorker: true, pushManager: true, notification: true, permission: 'default' };
        assert.equal(pushSupport(all), 'ready');
        assert.equal(pushSupport({ ...all, desktop: true }), 'desktop', 'the app notifies natively');
        assert.equal(pushSupport({ ...all, notification: false }), 'unsupported');
        assert.equal(pushSupport({ ...all, secure: false }), 'insecure', 'plain http off localhost');
        assert.equal(pushSupport({ ...all, pushManager: false }), 'unsupported');
        assert.equal(pushSupport({ ...all, permission: 'denied' }), 'denied');
        assert.equal(pushSupport({ ...all, permission: 'granted' }), 'ready');
    });

    it('knows whether this browser is subscribed for this persona', () => {
        assert.ok(subscribedHere('https://push/a', ['https://push/a', 'https://push/b']));
        assert.ok(!subscribedHere('https://push/c', ['https://push/a']), 'another persona\'s browser');
        assert.ok(!subscribedHere(null, ['https://push/a']), 'no subscription at all');
        assert.ok(!subscribedHere('https://push/a', undefined));
    });
});
