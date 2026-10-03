const assert = require('node:assert');

let placeholderAt;
before(async () => {
    ({ placeholderAt } = await import('../../../js/pure/placeholder.js'));
});

describe('the block picker selects its placeholder (2026-09-30)', () => {
    const selected = (head, body, pick) => {
        const text = `${head}\n${body}\n:::`;
        const at = placeholderAt(head, body, pick);
        return text.slice(at, at + pick.length);
    };

    it('finds a body placeholder', () => {
        assert.equal(placeholderAt(':::center', 'text', 'text'), ':::center\n'.length);
        assert.equal(selected(':::center', 'text', 'text'), 'text');
    });

    it("finds a value on the opening line, where the body search can't", () => {
        assert.equal(
            placeholderAt(':::section font=serif', 'text', 'serif'),
            ':::section font='.length,
        );
    });

    it("picks a layout's placeholder line, not the same word in slot=", () => {
        const body = ':::section slot=nav\nnav\n:::\n:::section slot=main\nmain\n:::';
        const at = placeholderAt(':::page layout=nav-footer', body, 'nav');
        assert.equal(
            at,
            ':::page layout=nav-footer\n:::section slot=nav\n'.length,
            'not the nav in nav-footer either',
        );
    });

    it("finds a placeholder inside a line when no line is exactly it (a table's heading)", () => {
        assert.equal(
            selected(
                ':::table header=row',
                '[c]heading[/c] [c]heading[/c]\n[c]cell[/c]',
                'heading',
            ),
            'heading',
        );
        assert.equal(
            placeholderAt(':::table header=row', '[c]heading[/c]', 'heading'),
            ':::table header=row\n[c]'.length,
        );
    });
});
