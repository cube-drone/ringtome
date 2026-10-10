// The text helpers' rules (plans/TEXT_HELPERS.md): Writer's buttons that write Marquee for people
// who don't know markup. Pure - every function takes the source and the selection (`from`, `to`)
// and answers `{ source, from, to }`, the new words and what to select - so the rules are vectors
// (integration/test/pure/markuphelp.cjs) and the two editing surfaces share one copy
// (doc/editor.js applies the answer to CodeMirror or a textarea).
//
// The rules, from the plan:
// - nothing selected: the word "text" goes in, wearing the style, and is selected;
// - after a press the styled words stay selected - the words inside the span, not its tags;
// - a selection that is exactly the inside of a span of the same kind changes that span rather
//   than nesting another (six fonts in a row edit one span): font, size and colour take the new
//   value (size 3, the normal size, takes the span away), the same effect again takes it off, a
//   different effect nests inside;
// - across paragraphs, each paragraph's part gets a span of its own (Marquee's spans never cross
//   blocks); headings and list items are blocks of their own too, and a blank line, a divider, a
//   directive's line, a comment or code is left as it is;
// - a block button acts on every line the selection touches, and takes off what is already there.

import { smallestChange } from './caret.js';

/// What a button writes when nothing is selected.
export const PLACEHOLDER = 'text';

/// The effects the menu offers, in the plan's order: each one's span name.
export const EFFECTS = [
    'rainbow',
    'wave',
    'bounce',
    'blink',
    'jitter',
    'rubber',
    'marquee',
    'typewriter',
    'fadein',
    'spoiler',
];

/// The size dial (the font element's seven): each step and the word the menu shows for it.
export const SIZES = [
    [1, 'teeny'],
    [2, 'tiny'],
    [3, 'normal'],
    [4, 'big'],
    [5, 'bigger'],
    [6, 'huge'],
    [7, 'enormous'],
];

/// The spans that carry one value each - a second pick replaces it rather than nesting.
const VALUED = new Set(['font', 'size', 'color']);

/// A span's name: the first word of what goes inside its opening bracket (`font=lobster` is
/// `font`, `rainbow by=letter` is `rainbow`).
export const spanName = (open) => open.split(/[\s=]/, 1)[0];

// ---------------------------------------------------------------------------------------------
// Edits, and where a position goes through them

/// One change: at `at`, `del` characters become `ins`.
const edit = (at, del, ins) => ({ at, del, ins });

/// The source with `edits` (sorted, never overlapping) made.
function applyEdits(source, edits) {
    let out = '';
    let at = 0;
    for (const e of edits) {
        out += source.slice(at, e.at) + e.ins;
        at = e.at + e.del;
    }
    return out + source.slice(at);
}

/// Where `pos` lands once `edits` are made: `right` puts it after anything inserted exactly at it
/// (a span's first letter, past the new opener), else before (its end, short of the new closer).
function mapPos(edits, pos, right) {
    let shift = 0;
    for (const e of edits) {
        const end = e.at + e.del;
        if (pos < e.at) break;
        if (pos > end || (pos === end && e.del > 0)) {
            shift += e.ins.length - e.del;
            continue;
        }
        if (pos === e.at && e.del === 0) {
            if (right) shift += e.ins.length;
            continue;
        }
        return e.at + shift + (right ? e.ins.length : 0);
    }
    return pos + shift;
}

// ---------------------------------------------------------------------------------------------
// Lines and the blocks they make

/// Every line of the source: `{ start, end, text }`, `end` before its newline.
function lines(source) {
    const out = [];
    let start = 0;
    for (;;) {
        const nl = source.indexOf('\n', start);
        const end = nl < 0 ? source.length : nl;
        out.push({ start, end, text: source.slice(start, end) });
        if (nl < 0) return out;
        start = nl + 1;
    }
}

const HEADING = /^(#{1,8}) /;
const LIST = /^(\s*)([-*+]|\d+\.) /;
const QUOTE = /^(>\s?)+/;

/// What a line is, for the inline buttons: `skip` (blank, a divider, a directive's line, a comment,
/// code), `own` (a heading, a list item or a quote line - a block of its own, its words after its
/// marker, which `at` says), or `prose` (a paragraph's line, joined to the ones beside it).
function lineKinds(source) {
    let fence = null;
    return lines(source).map((line) => {
        const t = line.text;
        const ticks = /^(`{3,})/.exec(t);
        if (fence) {
            if (ticks && ticks[1].length >= fence && t.trim() === ticks[1]) fence = null;
            return { ...line, kind: 'skip' };
        }
        if (ticks) {
            fence = ticks[1].length;
            return { ...line, kind: 'skip' };
        }
        if (!t.trim() || t.trim() === '---' || t.startsWith(':::') || t.startsWith('%%')) {
            return { ...line, kind: 'skip' };
        }
        const marker = HEADING.exec(t) || LIST.exec(t) || QUOTE.exec(t);
        if (marker) return { ...line, kind: 'own', at: line.start + marker[0].length };
        return { ...line, kind: 'prose', at: line.start };
    });
}

/// The stretches of words a selection covers, one per block: `[from, to)` each, trimmed of the
/// spaces at either end.
function pieces(source, from, to) {
    const found = [];
    let open = null; // the paragraph being gathered: [start, end)
    const close = () => {
        if (open) found.push(open);
        open = null;
    };
    for (const line of lineKinds(source)) {
        if (line.end < from && line.start < from) continue;
        if (line.start > to) break;
        if (line.kind === 'skip') {
            close();
            continue;
        }
        const a = Math.max(from, line.at);
        const b = Math.min(to, line.end);
        if (line.kind === 'own') {
            close();
            if (a < b) found.push([a, b]);
            continue;
        }
        if (a > b) continue;
        if (open && a > open[1] + 1) close();
        open = open ? [open[0], b] : [a, b];
    }
    close();
    return found
        .map(([a, b]) => {
            while (a < b && /\s/.test(source[a])) a++;
            while (b > a && /\s/.test(source[b - 1])) b--;
            return [a, b];
        })
        .filter(([a, b]) => a < b);
}

// ---------------------------------------------------------------------------------------------
// Spans

/// The spans that wrap `[from, to)` exactly - an opener right before, its closer right after -
/// innermost first: `{ name, open, openAt, openEnd, closeAt, closeEnd }`.
function wrappers(source, from, to) {
    const found = [];
    let a = from;
    let b = to;
    for (;;) {
        const before = /\[([a-z]+)(?:[ =][^\]\n]*)?\]$/.exec(source.slice(Math.max(0, a - 200), a));
        if (!before) return found;
        const closer = `[/${before[1]}]`;
        if (!source.startsWith(closer, b)) return found;
        const openAt = a - before[0].length;
        found.push({
            name: before[1],
            open: before[0].slice(1, -1),
            openAt,
            openEnd: a,
            closeAt: b,
            closeEnd: b + closer.length,
        });
        a = openAt;
        b += closer.length;
    }
}

/// A stretch with the span tags at its ends peeled off, down to the words: a span whole inside it,
/// a closer whose opener sits just before it, an opener whose closer sits just after. A press
/// across paragraphs selects from the first one's words to the last one's, tags between and all,
/// so the next press sees `one[/font]` as a paragraph's words - this finds `one` again.
function peel(source, a, b) {
    const OPENER = /^\[([a-z]+)(?:[ =][^\]\n]*)?\]/;
    const CLOSER = /\[\/([a-z]+)\]$/;
    for (;;) {
        const text = source.slice(a, b);
        const head = OPENER.exec(text);
        const tail = CLOSER.exec(text);
        if (head && tail && head[1] === tail[1]) {
            // The same span only if its first closer is this one (not `[b]x[/b] and [b]y[/b]`).
            const first = text.indexOf(`[/${head[1]}]`, head[0].length);
            if (first === text.length - tail[0].length) {
                a += head[0].length;
                b -= tail[0].length;
                continue;
            }
        }
        const opener = (name) =>
            new RegExp(`\\[${name}(?:[ =][^\\]\\n]*)?\\]$`).test(
                source.slice(Math.max(0, a - 200), a),
            );
        if (tail && opener(tail[1])) {
            b -= tail[0].length;
            continue;
        }
        if (head && source.startsWith(`[/${head[1]}]`, b)) {
            a += head[0].length;
            continue;
        }
        return [a, b];
    }
}

/// What a press of a span button does to one stretch `[a, b)`: the edits, never empty.
function spanEdits(source, a, b, open) {
    const name = spanName(open);
    const there = wrappers(source, a, b).find((w) => w.name === name);
    const remove = (w) => [
        edit(w.openAt, w.openEnd - w.openAt, ''),
        edit(w.closeAt, w.closeEnd - w.closeAt, ''),
    ];
    if (there && VALUED.has(name)) {
        // A new value for the span already there - or, for the normal size, no span at all.
        if (open === 'size=3') return remove(there);
        return [edit(there.openAt, there.openEnd - there.openAt, `[${open}]`)];
    }
    // The same effect again takes it off; a different one nests inside.
    if (there) return remove(there);
    if (open === 'size=3') return [];
    return [edit(a, 0, `[${open}]`), edit(b, 0, `[/${name}]`)];
}

/// A span button: `open` is what goes inside the opening bracket (`font=lobster`, `color=teal`,
/// `size=5`, `rainbow`, `wave by=letter`).
export function applySpan(source, from, to, open) {
    if (from === to) {
        const name = spanName(open);
        const tag = `[${open}]`;
        return {
            source: source.slice(0, from) + `${tag}${PLACEHOLDER}[/${name}]` + source.slice(from),
            from: from + tag.length,
            to: from + tag.length + PLACEHOLDER.length,
        };
    }
    const stretches = pieces(source, from, to)
        .map(([a, b]) => peel(source, a, b))
        .filter(([a, b]) => a < b);
    if (!stretches.length) return { source, from, to };
    const edits = stretches.flatMap(([a, b]) => spanEdits(source, a, b, open));
    edits.sort((x, y) => x.at - y.at);
    return {
        source: applyEdits(source, edits),
        from: mapPos(edits, stretches[0][0], true),
        to: mapPos(edits, stretches[stretches.length - 1][1], false),
    };
}

/// The link button: the words become `[words](address)`, a paragraph at a time; with nothing
/// selected, `[text](address)` with "text" selected. Words that are already a link's take the new
/// address instead.
export function applyLink(source, from, to, address) {
    const target = address.trim();
    if (from === to) {
        return {
            source: `${source.slice(0, from)}[${PLACEHOLDER}](${target})${source.slice(from)}`,
            from: from + 1,
            to: from + 1 + PLACEHOLDER.length,
        };
    }
    const stretches = pieces(source, from, to);
    if (!stretches.length) return { source, from, to };
    const edits = [];
    for (const [a, b] of stretches) {
        const linked = source[a - 1] === '[' && source.startsWith('](', b);
        const shut = linked ? source.indexOf(')', b + 2) : -1;
        if (linked && shut > 0 && !source.slice(b + 2, shut).includes('\n')) {
            edits.push(edit(b + 2, shut - (b + 2), target));
        } else {
            edits.push(edit(a, 0, '['), edit(b, 0, `](${target})`));
        }
    }
    edits.sort((x, y) => x.at - y.at);
    return {
        source: applyEdits(source, edits),
        from: mapPos(edits, stretches[0][0], true),
        to: mapPos(edits, stretches[stretches.length - 1][1], false),
    };
}

// ---------------------------------------------------------------------------------------------
// Blocks

/// The block buttons.
export const BLOCKS = [
    'quote',
    'heading1',
    'heading2',
    'heading3',
    'bullets',
    'numbers',
    'divider',
    'center',
    'spoiler',
    'table',
];

/// The table a press of "table" starts.
export const TABLE_STARTER = `:::table header=row\n[c]heading[/c] [c]heading[/c]\n\n[c]${PLACEHOLDER}[/c] [c]${PLACEHOLDER}[/c]\n:::`;

/// The lines a selection touches: a selection ending at a line's very start doesn't take it.
function touched(source, from, to) {
    const all = lines(source);
    const last = to > from && (to === 0 || source[to - 1] === '\n') ? to - 1 : to;
    return all.filter((l) => l.end >= from && l.start <= last);
}

/// A run of lines rewritten, each by `rewrite(text)`, and the run selected after.
function rewriteLines(source, run, rewrite) {
    const start = run[0].start;
    const end = run[run.length - 1].end;
    const text = run.map((l) => rewrite(l.text)).join('\n');
    return {
        source: source.slice(0, start) + text + source.slice(end),
        from: start,
        to: start + text.length,
    };
}

/// A line prefix that toggles: `has` says whether a line carries it, `strip` takes it (and any of
/// its family) off, `add` puts it on.
function prefixed(source, run, { has, strip, add, keepBlank }) {
    const words = run.filter((l) => l.text.trim());
    const on = words.length > 0 && words.every((l) => has(l.text));
    return rewriteLines(source, run, (t) => {
        if (on) return strip(t);
        if (!t.trim()) return keepBlank ? keepBlank(t) : t;
        return add(strip(t));
    });
}

/// The line `at` is on and what it says.
const lineAt = (source, at) => lines(source).find((l) => at >= l.start && at <= l.end);

/// A starter put on an empty line (or on a line of its own after a full one): `text` the
/// starter, `select` the stretch of it to select.
function starter(source, from, text, select) {
    const line = lineAt(source, from);
    const empty = !line.text.trim();
    const before = empty ? source.slice(0, line.start) : `${source.slice(0, line.end)}\n`;
    const after = empty ? source.slice(line.end) : source.slice(line.end);
    const at = before.length + text.indexOf(select);
    return { source: before + text + after, from: at, to: at + select.length };
}

/// A block button: one of `BLOCKS`.
export function applyBlock(source, from, to, block) {
    const run = touched(source, from, to);
    const blank = run.every((l) => !l.text.trim());
    if (block === 'table') return starter(source, to, TABLE_STARTER, 'heading');
    if (block === 'divider') {
        const last = run[run.length - 1];
        if (!last.text.trim()) {
            const s = source.slice(0, last.start) + '---' + source.slice(last.end);
            return { source: s, from: last.start + 3, to: last.start + 3 };
        }
        const s = `${source.slice(0, last.end)}\n---${source.slice(last.end)}`;
        return { source: s, from: last.end + 4, to: last.end + 4 };
    }
    if (block === 'center' || block === 'spoiler') {
        const above = lineAt(source, run[0].start - 1);
        const below = lineAt(source, run[run.length - 1].end + 1);
        const opened = above && run[0].start > 0 && above.text.trim() === `:::${block}`;
        const closed =
            below &&
            run[run.length - 1].end < source.length &&
            /^:::\s*(\w+)?\s*$/.test(below.text);
        if (opened && closed) {
            const inner = source.slice(run[0].start, run[run.length - 1].end);
            const s = source.slice(0, above.start) + inner + source.slice(below.end);
            return { source: s, from: above.start, to: above.start + inner.length };
        }
        if (blank) return starter(source, from, `:::${block}\n${PLACEHOLDER}\n:::`, PLACEHOLDER);
        const start = run[0].start;
        const end = run[run.length - 1].end;
        const inner = source.slice(start, end);
        const open = `:::${block}\n`;
        return {
            source: `${source.slice(0, start)}${open}${inner}\n:::${source.slice(end)}`,
            from: start + open.length,
            to: start + open.length + inner.length,
        };
    }
    const shapes = {
        quote: {
            has: (t) => QUOTE.test(t),
            strip: (t) => t.replace(/^>\s?/, ''),
            add: (t) => `> ${t}`,
            // A blank line inside a quote stays in it: every line wears its `>`.
            keepBlank: () => '>',
            starter: `> ${PLACEHOLDER}`,
        },
        bullets: {
            has: (t) => /^\s*[-*+] /.test(t),
            strip: (t) => t.replace(LIST, '$1'),
            add: (t) => `- ${t}`,
            starter: `- ${PLACEHOLDER}`,
        },
        numbers: {
            has: (t) => /^\s*\d+\. /.test(t),
            strip: (t) => t.replace(LIST, '$1'),
            add: (t) => `1. ${t}`,
            starter: `1. ${PLACEHOLDER}`,
        },
    };
    const heading = /^heading([1-8])$/.exec(block);
    if (heading) {
        const marks = '#'.repeat(Number(heading[1]));
        shapes[block] = {
            has: (t) => t.startsWith(`${marks} `),
            strip: (t) => t.replace(HEADING, ''),
            add: (t) => `${marks} ${t}`,
            starter: `${marks} ${PLACEHOLDER}`,
        };
    }
    const shape = shapes[block];
    if (!shape) return { source, from, to };
    if (blank && run.length === 1) return starter(source, from, shape.starter, PLACEHOLDER);
    return prefixed(source, run, shape);
}

// ---------------------------------------------------------------------------------------------
// Several selections at once

/// A rule (`applySpan`, `applyLink` or `applyBlock`, bound to its choice) applied to each of
/// several selections - a vim visual block is one a row - as one change: the last first, so each
/// stretch is read where it stands, and the ones already done moved by what each earlier change
/// put in or took out. Answers `{ source, ranges }`, each range the words its rule left selected,
/// in the order they were given.
export function applyEach(source, ranges, rule) {
    const order = ranges.map((r, i) => ({ ...r, i })).sort((a, b) => b.from - a.from);
    const out = new Array(ranges.length);
    let now = source;
    for (const r of order) {
        const before = now;
        const res = rule(now, Math.min(r.from, r.to), Math.max(r.from, r.to));
        now = res.source;
        const change = smallestChange(before, now);
        const shift = change.insert.length - (change.to - change.from);
        for (const done of out) {
            if (!done) continue;
            if (done.from >= change.to) done.from += shift;
            if (done.to >= change.to) done.to += shift;
        }
        out[r.i] = { from: res.from, to: res.to };
    }
    return { source: now, ranges: out };
}
