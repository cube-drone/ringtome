// The application registry's rules - pure lookups over a hand-written table, and the quiet
// decider of what appears in every list in the product. The bucket <-> app-type mapping is mostly
// IMPLICIT (a bucket named `recipes` simply IS a recipes bucket), which is cheap and readable and
// exactly the kind of rule that wants vectors: the implicitness is doing real work, and nothing
// else in the codebase states it.
const assert = require('node:assert');

let DEFAULT_STYLE, appById, appLabel, appForStyle, appTypeOf, bucketsForApp, featuresOf;
before(async () => {
    ({ DEFAULT_STYLE, appById, appLabel, appForStyle, appTypeOf, bucketsForApp, featuresOf } =
        await import('../../../js/apps.js'));
});

describe('app registry', () => {
    describe('appTypeOf', () => {
        it('reads a bucket whose NAME is a style as being of that style, with no registry', () => {
            assert.equal(appTypeOf('recipes'), 'recipes');
            assert.equal(appTypeOf('journal'), 'journal');
            assert.equal(appTypeOf('wiki'), 'wiki');
            assert.equal(appTypeOf(DEFAULT_STYLE), DEFAULT_STYLE);
        });

        it('does NOT treat a system app id as a bucket type', () => {
            // Persona has no `style`: it owns no documents, so no bucket is "a persona bucket".
            assert.equal(appTypeOf('persona'), DEFAULT_STYLE);
        });

        it('consults the roster for a user-named bucket', () => {
            const roster = [{ name: 'grandmas-recipes', app: 'recipes' }];
            assert.equal(appTypeOf('grandmas-recipes', roster), 'recipes');
        });

        it('falls back to the default rather than stranding an unresolvable bucket', () => {
            assert.equal(appTypeOf('grandmas-recipes', []), DEFAULT_STYLE);
            assert.equal(appTypeOf('grandmas-recipes'), DEFAULT_STYLE);
            assert.equal(appTypeOf('a-style-that-never-shipped', [{ name: 'x', app: 'y' }]),
                DEFAULT_STYLE);
        });

        it('lets an implicit name win over a contradicting registry row', () => {
            // The name IS the type; a roster row claiming otherwise cannot rename a style.
            assert.equal(appTypeOf('recipes', [{ name: 'recipes', app: 'wiki' }]), 'recipes');
        });
    });

    describe('bucketsForApp (the switcher rail)', () => {
        const recipes = () => appForStyle('recipes');

        it('puts the home bucket first, then the rest alphabetically', () => {
            const roster = [
                { name: 'zebra-cakes', app: 'recipes' },
                { name: 'apple-pies', app: 'recipes' },
            ];
            assert.deepEqual(bucketsForApp(recipes(), roster),
                ['recipes', 'apple-pies', 'zebra-cakes']);
        });

        it('offers the home bucket even when the roster is empty', () => {
            assert.deepEqual(bucketsForApp(recipes(), []), ['recipes']);
            assert.deepEqual(bucketsForApp(recipes()), ['recipes']);
        });

        it('never lists the home bucket twice when the roster also carries it', () => {
            const roster = [{ name: 'recipes', app: 'recipes' }];
            assert.deepEqual(bucketsForApp(recipes(), roster), ['recipes']);
        });

        it('excludes buckets belonging to another app', () => {
            const roster = [
                { name: 'my-wiki', app: 'wiki' },
                { name: 'my-cookbook', app: 'recipes' },
            ];
            assert.deepEqual(bucketsForApp(recipes(), roster), ['recipes', 'my-cookbook']);
        });
    });

    describe('featuresOf', () => {
        it('gives the full experience by default, and is safe on nothing at all', () => {
            const f = featuresOf();
            assert.equal(f.format, true);
            assert.equal(f.date, true);
            assert.equal(f.description, true);
            assert.deepEqual(f.modes, ['interactive', 'side', 'plain', 'read']);
        });

        it('applies an app override without losing the un-overridden defaults', () => {
            const f = featuresOf(appForStyle('recipes'));
            assert.deepEqual(f.modes, ['interactive']); // overridden
            assert.equal(f.date, false); // overridden
            assert.equal(f.tagColumn, true); // overridden
            assert.equal(f.tree, false); // NOT overridden: the default stands
        });

        it('gives the tree-having app its tree', () => {
            assert.equal(featuresOf(appForStyle('wiki')).tree, true);
            assert.equal(featuresOf(appForStyle(DEFAULT_STYLE)).tree, true);
        });
    });

    describe('appForStyle / appById', () => {
        it('resolves a live style to its app', () => {
            assert.equal(appForStyle('wiki').id, 'wiki');
            assert.equal(appForStyle('journal').id, 'journal');
        });

        it('falls back to the default app for a style no app claims', () => {
            assert.equal(appForStyle('webring').style, DEFAULT_STYLE);
            assert.equal(appForStyle(undefined).style, DEFAULT_STYLE);
        });

        it('finds a live app by route id, and nothing else', () => {
            assert.equal(appById('notes').style, DEFAULT_STYLE);
            assert.equal(appById('persona').id, 'persona');
            assert.equal(appById('nope'), null);
            assert.equal(appById(undefined), null);
        });
    });

    describe('appLabel', () => {
        it('makes the persona app wear the persona s own name', () => {
            assert.equal(appLabel(appById('persona'), 'Curtis'), 'Curtis');
        });

        it('falls the persona app back to its registry name when unnamed', () => {
            assert.equal(appLabel(appById('persona'), ''), 'Persona');
        });

        it('leaves every other app on its registry name', () => {
            assert.equal(appLabel(appById('notes'), 'Curtis'), 'TurboNotes');
        });

        it('is safe on no app', () => {
            assert.equal(appLabel(null, 'Curtis'), '');
        });
    });
});
