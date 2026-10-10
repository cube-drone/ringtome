// The text helpers' rules (pure/markuphelp.js, plans/TEXT_HELPERS.md): Writer's buttons that write
// Marquee for people who don't know markup. Each vector is the text before and after, the selection
// marked in it: «selected» or | for a caret.
const assert = require('node:assert');

let applySpan, applyLink, applyBlock, applyEach, TABLE_STARTER;
before(async () => {
    ({ applySpan, applyLink, applyBlock, applyEach, TABLE_STARTER } =
        await import('../../../js/pure/markuphelp.js'));
});

/// `«x»` or `|` in a string, as `{ source, from, to }`.
const marked = (s) => {
    if (s.includes('|') && !s.includes('«')) {
        const at = s.indexOf('|');
        return { source: s.slice(0, at) + s.slice(at + 1), from: at, to: at };
    }
    const from = s.indexOf('«');
    const to = s.indexOf('»') - 1;
    return { source: s.replace('«', '').replace('»', ''), from, to };
};
/// An answer, marked the same way.
const mark = ({ source, from, to }) =>
    from === to
        ? source.slice(0, from) + '|' + source.slice(from)
        : source.slice(0, from) + '«' + source.slice(from, to) + '»' + source.slice(to);

const span = (s, open) => {
    const { source, from, to } = marked(s);
    return mark(applySpan(source, from, to, open));
};
const block = (s, which) => {
    const { source, from, to } = marked(s);
    return mark(applyBlock(source, from, to, which));
};
const link = (s, address) => {
    const { source, from, to } = marked(s);
    return mark(applyLink(source, from, to, address));
};

describe('the text helpers: spans', () => {
    it('wraps the selected words, and keeps them selected', () => {
        assert.equal(
            span('a «brown» horse', 'font=lobster'),
            'a [font=lobster]«brown»[/font] horse',
        );
        assert.equal(
            span('a «brown» horse', 'rainbow by=letter'),
            'a [rainbow by=letter]«brown»[/rainbow] horse',
        );
    });

    it('with nothing selected, writes "text" wearing the style, selected', () => {
        assert.equal(span('a | horse', 'color=teal'), 'a [color=teal]«text»[/color] horse');
    });

    it('six fonts in a row edit one span', () => {
        let s = span('a «brown» horse', 'font=lobster');
        for (const f of ['orbitron', 'comic', 'serif', 'vt323', 'sans']) s = span(s, `font=${f}`);
        assert.equal(s, 'a [font=sans]«brown»[/font] horse');
    });

    it('a new value finds its span through others wrapped tight around the words', () => {
        assert.equal(
            span('[rainbow][size=5][color=red]«hi»[/color][/size][/rainbow]', 'size=6'),
            '[rainbow][size=6][color=red]«hi»[/color][/size][/rainbow]',
        );
    });

    it('the normal size takes the size away, and adds none', () => {
        assert.equal(span('[size=6]«big»[/size] words', 'size=3'), '«big» words');
        assert.equal(span('«plain» words', 'size=3'), '«plain» words');
    });

    it('the same effect again takes it off; a different one nests inside', () => {
        assert.equal(span('[wave]«hi»[/wave]', 'wave'), '«hi»');
        assert.equal(span('[wave]«hi»[/wave]', 'blink'), '[wave][blink]«hi»[/blink][/wave]');
    });

    it('a selection that only partly covers a span wraps, never edits the span', () => {
        assert.equal(
            span('[font=lobster]a «brown»[/font] horse', 'font=serif'),
            '[font=lobster]a [font=serif]«brown»[/font][/font] horse',
        );
    });

    it('across paragraphs: each its own span; blank lines and dividers left be', () => {
        assert.equal(
            span('«one\nstill one\n\ntwo\n---\nthree»', 'color=teal'),
            '[color=teal]«one\nstill one[/color]\n\n[color=teal]two[/color]\n---\n[color=teal]three»[/color]',
        );
    });

    it('a heading or a list item is wrapped after its marker, each line its own', () => {
        assert.equal(
            span('«# Title\n- one\n- two»', 'wave'),
            '# [wave]«Title[/wave]\n- [wave]one[/wave]\n- [wave]two»[/wave]',
        );
    });

    it('code and directive lines are never wrapped', () => {
        assert.equal(
            span('«words\n```\ncode\n```\n:::center\nmore»', 'blink'),
            '[blink]«words[/blink]\n```\ncode\n```\n:::center\n[blink]more»[/blink]',
        );
    });

    it('spaces at the ends of a selection stay outside the span', () => {
        assert.equal(span('a« brown »horse', 'font=serif'), 'a [font=serif]«brown»[/font] horse');
    });

    it('fonts in a row across paragraphs edit their spans, from the selection each press leaves', () => {
        let s = span('«one\n\ntwo»', 'font=lobster');
        assert.equal(s, '[font=lobster]«one[/font]\n\n[font=lobster]two»[/font]');
        s = span(s, 'font=orbitron');
        assert.equal(s, '[font=orbitron]«one[/font]\n\n[font=orbitron]two»[/font]');
    });

    it('every paragraph already wearing the font changes all at once', () => {
        assert.equal(
            span('«[font=a]one[/font]\n\n[font=a]two[/font]»', 'font=b'),
            '[font=b]«one[/font]\n\n[font=b]two»[/font]',
        );
    });
});

describe('the text helpers: links', () => {
    it('wraps the words, or writes "text", selected', () => {
        assert.equal(
            link('see «the barn»', 'https://horse.example'),
            'see [«the barn»](https://horse.example)',
        );
        assert.equal(link('see |', 'https://h.example'), 'see [«text»](https://h.example)');
    });

    it("a link's words take a new address rather than a second link", () => {
        assert.equal(
            link('[«barn»](https://old.example)', 'https://new.example'),
            '[«barn»](https://new.example)',
        );
    });
});

describe('the text helpers: blocks', () => {
    it('a quote puts > on every line - blank ones too - and takes it off again', () => {
        assert.equal(block('«one\n\ntwo»', 'quote'), '«> one\n>\n> two»');
        assert.equal(block('«> one\n>\n> two»', 'quote'), '«one\n\ntwo»');
    });

    it('acts on every line the selection touches, even partly', () => {
        assert.equal(block('on«e\ntw»o\nthree', 'quote'), '«> one\n> two»\nthree');
    });

    it('a heading changes level, and the same level again takes it off', () => {
        assert.equal(block('|Title', 'heading1'), '«# Title»');
        assert.equal(block('# «Title»', 'heading2'), '«## Title»');
        assert.equal(block('## «Title»', 'heading2'), '«Title»');
    });

    it('lists swap kinds, and toggle off', () => {
        assert.equal(block('«a\nb»', 'bullets'), '«- a\n- b»');
        assert.equal(block('«- a\n- b»', 'numbers'), '«1. a\n1. b»');
        assert.equal(block('«1. a\n1. b»', 'numbers'), '«a\nb»');
    });

    it('on an empty line, a starter with "text" selected', () => {
        assert.equal(block('above\n|\nbelow', 'quote'), 'above\n> «text»\nbelow');
        assert.equal(block('|', 'heading1'), '# «text»');
    });

    it('centre wraps the lines in a directive, and unwraps them', () => {
        assert.equal(block('«one\ntwo»', 'center'), ':::center\n«one\ntwo»\n:::');
        assert.equal(block(':::center\n«one\ntwo»\n:::', 'center'), '«one\ntwo»');
        assert.equal(block('|', 'spoiler'), ':::spoiler\n«text»\n:::');
    });

    it('a divider goes on a line of its own after the selection', () => {
        assert.equal(block('words|', 'divider'), 'words\n---|');
        assert.equal(block('words\n|', 'divider'), 'words\n---|');
    });

    it('a table starts below the line, its first heading selected', () => {
        const out = block('words|', 'table');
        assert.ok(out.startsWith('words\n:::table header=row\n[c]«heading»[/c]'), out);
        assert.equal(out.replace('«', '').replace('»', ''), `words\n${TABLE_STARTER}`);
    });
});

describe('the text helpers: several selections at once (a vim visual block)', () => {
    // A visual block over the middle letters of three rows: a selection a row.
    const rows = 'abcd\nefgh\nijkl';
    const block = [
        { from: 1, to: 3 },
        { from: 6, to: 8 },
        { from: 11, to: 13 },
    ];
    const words = ({ source, ranges }) => ranges.map((r) => source.slice(r.from, r.to));

    it("styles each row, and leaves each row's words selected", () => {
        const out = applyEach(rows, block, (s, a, b) => applySpan(s, a, b, 'font=lobster'));
        assert.equal(
            out.source,
            'a[font=lobster]bc[/font]d\ne[font=lobster]fg[/font]h\ni[font=lobster]jk[/font]l',
        );
        assert.deepEqual(words(out), ['bc', 'fg', 'jk']);
    });

    it("a second pick changes every row's span, as one does", () => {
        const first = applyEach(rows, block, (s, a, b) => applySpan(s, a, b, 'font=lobster'));
        const second = applyEach(first.source, first.ranges, (s, a, b) =>
            applySpan(s, a, b, 'font=serif'),
        );
        assert.equal(
            second.source,
            'a[font=serif]bc[/font]d\ne[font=serif]fg[/font]h\ni[font=serif]jk[/font]l',
        );
        assert.deepEqual(words(second), ['bc', 'fg', 'jk']);
    });

    it('a block rule takes each row, and they are given back in their own order', () => {
        const out = applyEach(rows, [block[2], block[0]], (s, a, b) =>
            applyBlock(s, a, b, 'quote'),
        );
        assert.equal(out.source, '> abcd\nefgh\n> ijkl');
        assert.deepEqual(words(out), ['> ijkl', '> abcd']);
    });
});
