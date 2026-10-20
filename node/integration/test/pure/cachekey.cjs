// A query a CDN can't confuse with another (2026-10-20): BunnyCDN keys on a repeated parameter's
// first value, so a fingerprint rides along wherever a key repeats - and only there.
const assert = require('node:assert');

let cacheKeyed;
before(async () => {
    ({ cacheKeyed } = await import('../../../js/pure/cachekey.js'));
});

describe('cacheKeyed', () => {
    it('leaves an address with no repeated key exactly as it was', () => {
        for (const path of ['/api/node', '/api/id/ab/posts?tag=comics', '/api/x?a=1&b=2'])
            assert.equal(cacheKeyed(path), path);
    });

    it('fingerprints a query whose keys repeat, so its first values no longer name it', () => {
        const both = cacheKeyed('/api/id/ab/posts?tag=comics&not_bucket=blog&not_bucket=toots');
        assert.match(
            both,
            /^\/api\/id\/ab\/posts\?tag=comics&not_bucket=blog&not_bucket=toots&qk=[0-9a-f]+$/,
        );
        const other = cacheKeyed('/api/id/ab/posts?tag=comics&not_bucket=blog&not_bucket=drafts');
        assert.notEqual(both.split('qk=')[1], other.split('qk=')[1], 'another query, another key');
        assert.equal(
            cacheKeyed('/api/id/ab/posts?tag=comics&not_bucket=blog&not_bucket=toots'),
            both,
            'the same query, the same key - the copy is still shared by everyone asking it',
        );
    });
});
