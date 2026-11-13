/*
    The age screen a store build shows at sign-up (plans/STORES.md, section 1). Only a year is
    asked, so the rule has to assume the birthday has not come yet: "might be under 13" is a no.
    The server holds the same rule (src/store.rs).
*/
const assert = require('node:assert');

let ageAnswer;
before(async () => {
    ({ ageAnswer } = await import('../../../js/pure/age.js'));
});

describe('the age screen', () => {
    it('turns away anyone who might still be twelve', () => {
        assert.equal(ageAnswer(2012, 2026), 'ok', '13 or 14');
        assert.equal(ageAnswer(2013, 2026), 'young', '12 or 13');
        assert.equal(ageAnswer(2026, 2026), 'young');
        assert.equal(ageAnswer('1950', 2026), 'ok', 'a field hands over a string');
    });

    it('takes no answer from a year nobody was born in', () => {
        assert.equal(ageAnswer('', 2026), 'none');
        assert.equal(ageAnswer('12', 2026), 'none');
        assert.equal(ageAnswer(2027, 2026), 'none');
        assert.equal(ageAnswer('20x2', 2026), 'none');
    });
});
