// The colourway names live twice (2026-10-02): colorway.js's COLORWAYS, and the list in index.html's
// first script, which wears the colourway before the bundle has loaded. Nothing imports one from the
// other - the page's script runs before any module - so this holds them together.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../../..', p), 'utf8');
const names = (text, pattern) => {
    const list = text.match(pattern);
    assert.ok(list, `found the list by ${pattern}`);
    return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe('colourways: the early script and the module agree', () => {
    it("index.html's first script knows exactly colorway.js's COLORWAYS", () => {
        const module = names(read('js/colorway.js'), /export const COLORWAYS = \[([^\]]*)\]/);
        const page = names(read('html/index.html'), /var colorways = \[([^\]]*)\]/);
        assert.ok(module.length > 0);
        assert.deepEqual(page, module);
    });

    it('both keep and read the same storage key', () => {
        const key = read('js/colorway.js').match(/const KEPT = '([^']+)'/)[1];
        assert.ok(read('html/index.html').includes(`localStorage.getItem('${key}')`));
    });
});
