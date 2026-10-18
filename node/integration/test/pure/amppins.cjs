// hrseAmp's pins (pure/amppins.js): read back from their registers, an unpin left out, pinned lists
// in the order they were pinned, and the car's lists with the pinned ones first.
const assert = require('node:assert');

let p;
before(async () => {
    p = await import('../../../js/pure/amppins.js');
});

describe("hrseAmp's pins (pure/amppins.js)", () => {
    it('reads pins, passing over an unpin and a value not ours', () => {
        const pins = p.readPins([
            { key: 'filter:a', value: '20' },
            { key: 'station:b', value: '' },
            { key: 'mixtape:c', value: 'soon' },
            { key: 'mixtape:d', value: '10' },
        ]);
        assert.deepEqual(
            [...pins],
            [
                ['filter:a', 20],
                ['mixtape:d', 10],
            ],
        );
    });

    it('lists what is pinned, oldest pin first, past a pin whose list is gone', () => {
        const pins = new Map([
            ['station:s', 5],
            ['filter:f', 9],
            ['mixtape:gone', 1],
        ]);
        const got = p.pinnedLists(pins, {
            filters: [{ id: 'f' }, { id: 'g' }],
            tapes: [{ id: 't' }],
            stations: [{ id: 's' }],
        });
        assert.deepEqual(
            got.map((l) => p.pinKey(l.kind, l.item.id)),
            ['station:s', 'filter:f'],
        );
    });

    it('puts the pinned car lists first, the rest in their order', () => {
        const lists = ['all', 'mixtape:t', 'filter:f', 'station:s', 'station:u'].map((id) => ({
            id,
        }));
        const pins = new Map([
            ['station:s', 2],
            ['filter:f', 1],
        ]);
        assert.deepEqual(
            p.pinnedFirst(lists, pins).map((l) => l.id),
            ['filter:f', 'station:s', 'all', 'mixtape:t', 'station:u'],
        );
    });
});
