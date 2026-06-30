const makeFetchHappen = require('./fetch.cjs');

exports.mochaHooks = {
    beforeEach: async function() {
        let fetch = makeFetchHappen();

        resp = await fetch('api/admin/start_test', {
            method: 'POST',
            body: JSON.stringify({
                name: this.currentTest.fullTitle(),
            })
        });
        json = await resp.json();
    }
}