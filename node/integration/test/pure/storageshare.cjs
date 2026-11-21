/*
    The Storage page's arithmetic (js/pure/storageshare.js): a bar's width against the whole, the
    kinds a place's total is shown as, and who is listed before "show everyone".
*/
const assert = require('node:assert');

let shareOf, placeParts, kindParts, laneParts, personParts, peopleShown, PEOPLE_SHOWN;
before(async () => {
    ({ shareOf, placeParts, kindParts, laneParts, personParts, peopleShown, PEOPLE_SHOWN } =
        await import('../../../js/pure/storageshare.js'));
});

describe('storage, as the page shows it', () => {
    it('draws a share of the whole, never past it and never invisibly thin', () => {
        assert.equal(shareOf(50, 200), 25);
        assert.equal(shareOf(300, 200), 100, 'a figure past the whole fills the bar and stops');
        assert.equal(shareOf(1, 1_000_000), 1, 'something is never drawn as nothing');
        assert.equal(shareOf(0, 200), 0);
        assert.equal(shareOf(50, 0), 0, 'no whole, no bar');
        assert.equal(shareOf(undefined, 200), 0);
    });

    it("splits a place's total into its kinds, in order, leaving out the empty ones", () => {
        const place = {
            total_bytes: 600,
            files_bytes: 300,
            chains_bytes: 200,
            backups_bytes: 0,
            other_bytes: 100,
        };
        assert.deepEqual(placeParts(place), [
            { kind: 'files', bytes: 300 },
            { kind: 'chains', bytes: 200 },
            { kind: 'other', bytes: 100 },
        ]);
        assert.deepEqual(placeParts(null), []);
    });

    it("splits a persona's files into their kinds, in order, leaving out the empty ones", () => {
        assert.deepEqual(kindParts({ pictures: 30, video: 0, audio: 5, writing: 12, other: 0 }), [
            { kind: 'pictures', bytes: 30 },
            { kind: 'audio', bytes: 5 },
            { kind: 'writing', bytes: 12 },
        ]);
        assert.deepEqual(kindParts(null), [], 'a persona not yet split has no kinds to show');
        assert.deepEqual(kindParts({}), []);
    });

    it('splits the files into a public lane and a private one, each by kind', () => {
        const persona = {
            public_kinds: { pictures: 30, video: 0, audio: 0, writing: 12, other: 0 },
            private_kinds: { pictures: 0, video: 0, audio: 0, writing: 0, other: 0 },
        };
        assert.deepEqual(laneParts(persona), [
            {
                lane: 'public',
                bytes: 42,
                parts: [
                    { kind: 'pictures', bytes: 30 },
                    { kind: 'writing', bytes: 12 },
                ],
            },
            { lane: 'private', bytes: 0, parts: [] },
        ]);
        assert.deepEqual(
            laneParts(null).map((l) => l.bytes),
            [0, 0],
        );
    });

    it('lists what one person takes biggest first, their records among their files', () => {
        const jeff = {
            chains_bytes: 40,
            kinds: { pictures: 3, video: 1600, audio: 250, writing: 0, other: 0 },
        };
        assert.deepEqual(personParts(jeff), [
            { kind: 'video', bytes: 1600 },
            { kind: 'audio', bytes: 250 },
            { kind: 'records', bytes: 40 },
            { kind: 'pictures', bytes: 3 },
        ]);
        assert.deepEqual(
            personParts({ chains_bytes: 40, kinds: null }),
            [{ kind: 'records', bytes: 40 }],
            'not yet split: the records alone',
        );
        assert.deepEqual(personParts(null), []);
    });

    it('lists the biggest people first and holds the rest back until asked', () => {
        const people = Array.from({ length: PEOPLE_SHOWN + 3 }, (_, i) => ({
            root: `r${String(i).padStart(3, '0')}`,
            bytes: i,
        }));
        const first = peopleShown(people);
        assert.equal(first.shown.length, PEOPLE_SHOWN);
        assert.equal(first.rest, 3);
        assert.equal(first.shown[0].bytes, PEOPLE_SHOWN + 2, 'the biggest leads');
        const all = peopleShown(people, true);
        assert.equal(all.shown.length, PEOPLE_SHOWN + 3);
        assert.equal(all.rest, 0);
        assert.deepEqual(peopleShown(undefined), { shown: [], rest: 0 });
    });

    it('holds the order still between people of the same size', () => {
        const { shown } = peopleShown([
            { root: 'b', bytes: 5 },
            { root: 'a', bytes: 5 },
        ]);
        assert.deepEqual(
            shown.map((p) => p.root),
            ['a', 'b'],
        );
    });
});
