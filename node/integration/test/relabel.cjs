/*
    A renamed note's links follow it (Curtis, 2026-10-23: "if I had created a link that just read
    [here](http:///), I probably wouldn't want it renamed - if I'd created a link [JEFF KAPLAN], I
    probably _would_ want it renamed"). The links to it that wear its old title, in any case, take
    the new one; a link with words of its own, a link to another note and a note in another
    persona's hands are left as they are. Asked when the title lets go (`…/relabel`), and by a
    rename said once (`PATCH …/title`).
*/
const assert = require('node:assert');
const { makeUserFetch } = require('./helpers.cjs');

async function note(user, root, title, body) {
    const res = await user(`api/identity/${root}/docs`, {
        method: 'POST',
        body: JSON.stringify({ title, body, format: 'marquee' }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).doc_id;
}

const read = async (user, root, id) => (await user(`api/identity/${root}/docs/${id}`)).json();

describe('relabel: a renamed note’s links follow it', function () {
    this.timeout(30000);

    it('renames the links wearing its old title, and only those', async () => {
        const user = await makeUserFetch({ prefix: 'relabel' });
        const root = (await (await user('api/identity', { method: 'POST' })).json()).root_pubkey;
        const jeff = await note(user, root, 'JEFF KAPLAN', 'a person');
        const other = await note(user, root, 'JEFF KAPLAN', 'a namesake');
        const to = (id) => `/ringtome/user/${root}/doc/${id}?bucket=default`;
        const a = await note(
            user,
            root,
            'meeting',
            `Met [JEFF KAPLAN](${to(jeff)}) - notes [here](${to(jeff)}), and [Jeff Kaplan](/home/notes/${jeff}).`,
        );
        const b = await note(user, root, 'namesake', `Not him: [JEFF KAPLAN](${to(other)}).`);
        const untouched = (await read(user, root, b)).heads;

        // A rename said once - the details panel's, a picture's - follows at once.
        const patched = await user(`api/identity/${root}/docs/${jeff}/title`, {
            method: 'PATCH',
            body: JSON.stringify({ title: 'BONK MONKEYDONK' }),
        });
        assert.equal(patched.status, 200);
        assert.equal(
            (await read(user, root, a)).body,
            `Met [BONK MONKEYDONK](${to(jeff)}) - notes [here](${to(jeff)}), and [BONK MONKEYDONK](/home/notes/${jeff}).`,
        );
        assert.deepEqual((await read(user, root, b)).heads, untouched, 'a link to another note');

        // The editors' title box saves as it's typed, and asks once it lets go.
        const res = await user(`api/identity/${root}/docs/${jeff}/relabel`, {
            method: 'POST',
            body: JSON.stringify({ from: 'BONK MONKEYDONK', to: 'Bonk' }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { changed: 1 });
        assert.equal(
            (await read(user, root, a)).body,
            `Met [Bonk](${to(jeff)}) - notes [here](${to(jeff)}), and [Bonk](/home/notes/${jeff}).`,
        );
    });
});
