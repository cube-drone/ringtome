// The application registry's rules - pure lookups over a hand-written table, and the quiet
// decider of what appears in every list in the product. The bucket <-> app-type mapping is mostly
// IMPLICIT (a bucket named `feed` simply IS a feed bucket), which is cheap and readable and
// exactly the kind of rule that wants vectors: the implicitness is doing real work, and nothing
// else in the codebase states it.
const assert = require('node:assert');

let APPS, DEFAULT_STYLE, appById, appLabel, appForStyle, appTypeOf, bucketsForApp,
    bucketHolds, featuresOf, itemNoun, itemPlural, homeAppFor, editorModes;
let Icons;
before(async () => {
    ({ APPS, DEFAULT_STYLE, appById, appLabel, appForStyle, appTypeOf, bucketsForApp, bucketHolds, homeAppFor,
       featuresOf, itemNoun, itemPlural, editorModes } = await import('../../../js/pure/apps.js'));
    ({ Icons } = await import('../../../js/icons.js'));
});

describe('app registry', () => {
    describe('appTypeOf', () => {
        it('reads a bucket whose NAME is a style as being of that style, with no registry', () => {
            assert.equal(appTypeOf('feed'), 'feed');
            assert.equal(appTypeOf(DEFAULT_STYLE), DEFAULT_STYLE);
        });

        it('sends a RETIRED style to the default app rather than stranding its buckets', () => {
            // Recipes and Wikibook were cut 2026-08-08 (each was Writer with a column taken
            // away). Their buckets and documents outlive them on every dev node and in anyone's
            // data, so the fallback is the whole migration story: a `recipes` bucket simply opens
            // in Writer now. If this ever fails, retiring an app starts losing documents.
            assert.equal(appTypeOf('recipes'), DEFAULT_STYLE);
            assert.equal(appTypeOf('wiki'), DEFAULT_STYLE);
            assert.equal(appForStyle('recipes').id, 'notes');
            assert.equal(homeAppFor({ buckets: ['wiki'] }, []).id, 'notes');
            // The Journal followed them on 2026-09-02: Writer is the one editing primitive,
            // and every day-book bucket simply opens there now.
            assert.equal(appTypeOf('journal'), DEFAULT_STYLE);
            assert.equal(appForStyle('journal').id, 'notes');
            assert.equal(homeAppFor({ buckets: ['journal'] }, []).id, 'notes');
        });

        it('does NOT treat a system app id as a bucket type', () => {
            // Persona has no `style`: it owns no documents, so no bucket is "a persona bucket".
            assert.equal(appTypeOf('persona'), DEFAULT_STYLE);
        });

        it('consults the roster for a user-named bucket', () => {
            const roster = [{ name: 'dream-diary', app: 'feed' }];
            assert.equal(appTypeOf('dream-diary', roster), 'feed');
        });

        it('falls back to the default rather than stranding an unresolvable bucket', () => {
            assert.equal(appTypeOf('dream-diary', []), DEFAULT_STYLE);
            assert.equal(appTypeOf('dream-diary'), DEFAULT_STYLE);
            assert.equal(appTypeOf('a-style-that-never-shipped', [{ name: 'x', app: 'y' }]),
                DEFAULT_STYLE);
        });

        it('lets an implicit name win over a contradicting registry row', () => {
            // The name IS the type; a roster row claiming otherwise cannot rename a style.
            assert.equal(appTypeOf('feed', [{ name: 'feed', app: 'default' }]), 'feed');
        });
    });

    describe('bucketsForApp (the switcher rail)', () => {
        const writer = () => appForStyle(DEFAULT_STYLE);

        it('puts the home bucket first, then the rest alphabetically', () => {
            const roster = [
                { name: 'zebra-nights', app: DEFAULT_STYLE },
                { name: 'apple-mornings', app: DEFAULT_STYLE },
            ];
            assert.deepEqual(bucketsForApp(writer(), roster),
                [DEFAULT_STYLE, 'apple-mornings', 'zebra-nights']);
        });

        it('offers the home bucket even when the roster is empty', () => {
            assert.deepEqual(bucketsForApp(writer(), []), [DEFAULT_STYLE]);
            assert.deepEqual(bucketsForApp(writer()), [DEFAULT_STYLE]);
        });

        it('never lists the home bucket twice when the roster also carries it', () => {
            const roster = [{ name: DEFAULT_STYLE, app: DEFAULT_STYLE }];
            assert.deepEqual(bucketsForApp(writer(), roster), [DEFAULT_STYLE]);
        });

        it('excludes buckets belonging to another app', () => {
            const roster = [
                { name: 'my-feed', app: 'feed' },
                { name: 'dream-diary', app: DEFAULT_STYLE },
            ];
            assert.deepEqual(bucketsForApp(writer(), roster), [DEFAULT_STYLE, 'dream-diary']);
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
            const f = featuresOf(appForStyle('feed'));
            assert.deepEqual(f.modes, ['interactive', 'side', 'plain']); // overridden
            assert.equal(f.date, false); // overridden
            assert.equal(f.tree, false); // overridden
            assert.equal(f.description, true); // NOT overridden: the default stands
        });

        it('gives the tree-having app its tree', () => {
            // Writer is the only one left that mounts it, and it also carries the tag column:
            // the two apps that used to own one each were folded into it.
            const notes = featuresOf(appForStyle(DEFAULT_STYLE));
            assert.equal(notes.tree, true);
            assert.equal(notes.tagColumn, true);
        });

        it('drops the pin from list-less apps: the feed has no list to float atop', () => {
            assert.equal(featuresOf(appForStyle('feed')).pin, false);
            assert.equal(featuresOf(appForStyle(DEFAULT_STYLE)).pin, true, 'lists keep it');
        });
    });

    describe('bucketHolds (what a documents app has in view)', () => {
        const notes = () => appForStyle(DEFAULT_STYLE);
        const feed = () => appForStyle('feed');

        it('holds a document that is a member of the bucket on screen', () => {
            assert.equal(bucketHolds({ buckets: ['feed'] }, feed(), 'feed'), true);
            assert.equal(bucketHolds({ buckets: ['a', 'b'] }, feed(), 'b'), true);
        });

        it('does not hold a document filed somewhere else', () => {
            assert.equal(bucketHolds({ buckets: ['other'] }, feed(), 'feed'), false);
        });

        it('UNBUCKETED documents live ONLY in the everything-view (settled 2026-08-01)', () => {
            // The old catch-all put them in Writer's home; All is the formal home for
            // strays now, labeled "unfiled", so no ordinary notebook quietly mingles them.
            const orphan = { buckets: [] };
            assert.equal(bucketHolds(orphan, notes(), DEFAULT_STYLE), false);
            assert.equal(bucketHolds(orphan, feed(), 'feed'), false);
            assert.equal(bucketHolds(orphan, appById('lost-found'), undefined), true);
        });

        it('is safe on a missing document or app', () => {
            assert.equal(bucketHolds(null, notes(), DEFAULT_STYLE), false);
            assert.equal(bucketHolds({ buckets: [] }, null, DEFAULT_STYLE), false);
        });

        it('the everything-view holds every document, filed or not', () => {
            const all = appById('lost-found');
            assert.equal(all.everything, true, 'the registry carries the flag');
            assert.equal(bucketHolds({ buckets: ['feed'] }, all, undefined), true);
            assert.equal(bucketHolds({ buckets: [] }, all, undefined), true);
        });
    });

    describe('homeAppFor (follow me home)', () => {
        it('routes a bucketed document to its bucket type s app', () => {
            const roster = [{ name: 'dream-diary', app: 'feed' }];
            assert.equal(homeAppFor({ buckets: ['dream-diary'] }, roster).id, 'feed');
            assert.equal(homeAppFor({ buckets: ['feed'] }, []).id, 'feed', 'implicit names too');
        });

        it('routes the unbucketed HOME to the everything-view, the unknown to the default app', () => {
            assert.equal(homeAppFor({ buckets: [] }, []).id, 'lost-found',
                'nothing else holds a stray anymore');
            assert.equal(homeAppFor({}, []).id, 'lost-found');
            assert.equal(homeAppFor({ buckets: ['mystery'] }, []).id, 'notes',
                'an unregistered bucket still resolves to the default type');
        });
    });

    describe('appForStyle / appById', () => {
        it('resolves a live style to its app', () => {
            assert.equal(appForStyle('feed').id, 'feed');
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
            assert.equal(appLabel(appById('notes'), 'Curtis'), 'Writer');
        });

        it('is safe on no app', () => {
            assert.equal(appLabel(null, 'Curtis'), '');
        });
    });

    // The registry names its icons by role rather than importing them, which is what keeps this
    // module import-free - at the cost of a typo becoming a silent fallback glyph instead of an
    // import error. This is the check that buys the indirection back.
    describe('itemNoun', () => {
        it('gives each app its own word for one of its things', () => {
            assert.equal(itemNoun(appById('notes')), 'note');
            assert.equal(itemNoun(appById('feed')), 'post');
            assert.equal(itemNoun(appById('people')), 'person');
        });

        it('falls back to placeholder-ish "item" for an app that never named one', () => {
            assert.equal(itemNoun(appById('persona')), 'item'); // a system app has no things
            assert.equal(itemNoun(undefined), 'item');
        });

        it('pluralizes naively by default, and by declaration when that is wrong', () => {
            assert.equal(itemPlural(appById('notes')), 'notes');
            assert.equal(itemPlural(appById('feed')), 'posts');
            assert.equal(itemPlural(undefined), 'items');
        });

        it('is lowercase, for mid-sentence use', () => {
            const nouns = APPS.filter((a) => a.itemNoun).map((a) => a.itemNoun);
            assert.ok(nouns.length >= 3);
            assert.deepEqual(nouns.filter((n) => n !== n.toLowerCase()), []);
        });

        it('gives every DOCUMENT app one (the surfaces put it in front of the user)', () => {
            const missing = APPS.filter((a) => a.style && !a.itemNoun).map((a) => a.id);
            assert.deepEqual(missing, []);
        });
    });

    describe('icon names', () => {
        it('every app names a glyph that icons.js actually has', () => {
            const missing = APPS.filter((a) => !a.blank).filter((a) => !Icons[a.icon])
                .map((a) => `${a.id}: '${a.icon}'`);
            assert.deepEqual(missing, []);
        });

        it('and no app forgets to name one', () => {
            assert.deepEqual(APPS.filter((a) => !a.blank && !a.icon).map((a) => a.id), []);
        });
    });
});

// The editor's mode row: which tabs a document actually offers (2026-08-06 rules).
describe('editorModes', () => {
    it('hides the plain tab wherever side-by-side is offered - side already shows the source', () => {
        assert.deepEqual(editorModes('marquee', ['interactive', 'side', 'plain', 'read']),
            ['interactive', 'side', 'read']);
    });

    it('keeps plain exactly where it is the only way to edit', () => {
        assert.deepEqual(editorModes('plaintext', ['interactive', 'side', 'plain', 'read']),
            ['plain', 'read']);
    });

    it("the feed's list: no read-only, and side hides plain", () => {
        const feed = featuresOf(appById('feed'));
        assert.deepEqual(editorModes('marquee', feed.modes), ['interactive', 'side']);
        assert.deepEqual(editorModes('plaintext', feed.modes), ['plain'],
            'a plaintext post is still editable');
    });

    it('an app list that leaves a format nothing falls back rather than trapping the doc', () => {
        assert.deepEqual(editorModes('plaintext', ['interactive']), ['plain', 'read']);
    });
});
