// The user-facing string tool: mints keys, rewrites call sites, and writes the readable script.
//
// Three jobs over one scanner, because they are the same problem seen from three sides:
//
//   --migrate   wrap bare user-facing text in `t(key, english)`, minting a stable key for each.
//               One-time per string; re-runnable, because anything already wrapped is invisible
//               to it.
//   (default)   sync `js/locales/en.js` with the source, BOTH WAYS. `en.js` is the authoritative
//               English catalog and its wording is never overwritten; a key the catalog has never
//               seen is added from its call-site seed, a key the source no longer has is retired,
//               and every seed is rewritten to agree with the catalog. So new copy flows code ->
//               catalog once, and every edit afterwards flows catalog -> code.
//   --check     the cop: fails when `en.js` is out of step with the source, when a seed disagrees
//               with the catalog, when two phrases share a key, and when user-facing text reaches
//               a person WITHOUT going through `t`. New copy arrives a phrase at a time inside
//               whichever component needed it, which is how a voice drifts with nobody deciding
//               to change it. This makes it impossible to add words silently.
//
// WHAT COUNTS AS VOICE. The words the app itself chooses, from two sources - the Preact UI (text
// nodes and human-facing attributes inside html`` templates, plus the literals handed to the
// message sinks) and the server's user-facing `AppError` prose, which `net.js` renders unchanged.
// That second source is the non-obvious one: about a third of the app's sentences are written in
// Rust and displayed in JavaScript. User content, log lines and developer panics are not voice.
//
// Zero dependencies on purpose: a hand-written scanner rather than a JS parser pulled into a new
// package.json, in the same spirit as the pure core importing only itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(HERE, '..', '..');
const JS_DIR = path.join(WORKSPACE, 'node', 'js');
const RUST_DIR = path.join(WORKSPACE, 'node', 'src');
const EN_FILE = path.join(JS_DIR, 'locales', 'en.js');

/// Attributes whose value a person actually reads. `class`/`href`/`key` are deliberately absent:
/// collecting them would bury the script in machine noise.
const HUMAN_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label']);

/// Functions whose argument is displayed to the user as-is. A new sink added here is how a new
/// kind of message becomes visible to the tool.
const MESSAGE_SINKS = ['setError', 'setFlash', 'setNote', 'setAvatarErr', 'alert'];

/// Files with no voice in them: the pure core is arithmetic and wire formats (its wordlist would
/// flood the script with 1296 dictionary words), and the message layer's own doc comments quote
/// examples that are not real copy.
const SKIP = [/\/pure\//, /eslint\.config\.js$/, /\/i18n\.js$/, /\/locales\//];

/// A private-use codepoint stands in for an interpolation during scanning, so it can never
/// collide with anything in the source.
const HOLE = '';

// --- source scanning -------------------------------------------------------------------------

function walk(dir, ext, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'target') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, ext, out);
        else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
}

const relPath = (p) => path.relative(WORKSPACE, p).split(path.sep).join('/');

/// Comments blanked to spaces, byte positions preserved. This codebase's comments are essays that
/// quote the very strings below them, so reading them would double-count every phrase; blanking
/// rather than deleting keeps every later offset honest, which is what makes both the line
/// numbers and the rewrite positions trustworthy.
function stripComments(src) {
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

function lineAt(src, offset) {
    let line = 1;
    for (let i = 0; i < offset; i++) if (src[i] === '\n') line++;
    return line;
}

/**
 * Every html`` template in a source file.
 *
 * A single linear pass with an explicit state stack, because "find the matching backtick" fails
 * on this codebase's real shape: templates nest inside their own interpolations (`${open &&
 * html`<div>…</div>`}` is the standard conditional-render idiom), and a quote inside an
 * interpolation must not end anything.
 *
 * Returns per template: `body` (text with interpolations collapsed to HOLE), `map` (body index ->
 * exact source offset, which is what makes rewriting possible rather than approximate), and
 * `interps` (each hole's body position and its own source, with nested templates blanked so their
 * words are not read twice).
 */
function htmlTemplates(src) {
    const found = [];
    const stack = [];
    let i = 0;
    const top = () => stack[stack.length - 1];
    const inTemplate = () => top()?.kind === 'template';

    while (i < src.length) {
        const c = src[i];

        if ((c === '"' || c === "'") && !inTemplate()) {
            const quote = c;
            i++;
            while (i < src.length && src[i] !== quote) {
                if (src[i] === '\\') i++;
                i++;
            }
            i++;
            continue;
        }

        if (c === '\\' && inTemplate()) {
            i += 2;
            continue;
        }

        if (!inTemplate() && src.startsWith('html`', i)) {
            stack.push({ kind: 'template', body: '', map: [], interps: [], start: i });
            i += 5;
            continue;
        }

        // Any other template literal: tracked so its backticks and braces cannot be mistaken for
        // an enclosing html`` template's, but its text is not collected.
        if (!inTemplate() && c === '`') {
            stack.push({ kind: 'template', body: null, map: null, interps: [], start: i });
            i++;
            continue;
        }

        if (inTemplate() && c === '`') {
            const frame = stack.pop();
            if (frame.body !== null) found.push(frame);
            if (top()?.kind === 'interp') top().nested.push([frame.start, i + 1]);
            i++;
            continue;
        }

        if (inTemplate() && c === '$' && src[i + 1] === '{') {
            const owner = top();
            const bodyPos = owner.body === null ? -1 : owner.body.length;
            if (owner.body !== null) {
                owner.body += HOLE;
                owner.map.push(i);
            }
            stack.push({ kind: 'interp', braces: 0, owner, bodyPos, start: i, srcStart: i + 2, nested: [] });
            i += 2;
            continue;
        }

        if (top()?.kind === 'interp') {
            if (c === '{') top().braces++;
            else if (c === '}') {
                if (top().braces === 0) {
                    const frame = stack.pop();
                    if (frame.bodyPos >= 0) {
                        let text = src.slice(frame.srcStart, i);
                        for (const [from, to] of frame.nested) {
                            const a = from - frame.srcStart;
                            const b = to - frame.srcStart;
                            text = text.slice(0, a) + ' '.repeat(b - a) + text.slice(b);
                        }
                        frame.owner.interps.push({
                            bodyPos: frame.bodyPos,
                            src: text,
                            srcStart: frame.srcStart,
                            start: frame.start,
                            end: i + 1,
                            hasNested: frame.nested.length > 0,
                        });
                    }
                    i++;
                    continue;
                }
                top().braces--;
            }
            i++;
            continue;
        }

        if (inTemplate() && top().body !== null) {
            top().body += c;
            top().map.push(i);
        }
        i++;
    }
    return found;
}

/**
 * The readable strings inside one template body: text nodes, and the values of the attributes a
 * person reads. A deliberately small HTML-ish tokenizer - htm's dialect is regular enough that
 * tracking "inside a tag or not" is the whole job, and `<${Component}>` reads as an ordinary tag
 * because the component name has already become a HOLE.
 *
 * `<code>` spans are skipped: they hold literals a reader copies (`/id/`, `sway-broke-AwTy…`),
 * not prose a reader hears.
 */
function stringsInTemplate(body) {
    const out = [];
    let i = 0;
    let inCode = false;
    while (i < body.length) {
        if (body[i] !== '<') {
            const start = i;
            while (i < body.length && body[i] !== '<') i++;
            if (!inCode) out.push({ kind: 'text', start, end: i });
            continue;
        }
        i++;
        const tagMatch = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(body.slice(i));
        if (tagMatch && tagMatch[2].toLowerCase() === 'code') inCode = !tagMatch[1];
        while (i < body.length && body[i] !== '>') {
            const nameMatch = /^([a-zA-Z-]+)\s*=\s*/.exec(body.slice(i));
            if (!nameMatch) {
                i++;
                continue;
            }
            const name = nameMatch[1].toLowerCase();
            let j = i + nameMatch[0].length;
            if (body[j] === '"' || body[j] === "'") {
                const quote = body[j];
                const valueStart = ++j;
                while (j < body.length && body[j] !== quote) j++;
                if (HUMAN_ATTRS.has(name)) {
                    // The span covers the quotes too: `title="close"` becomes `title=${t(…)}`.
                    out.push({ kind: name, start: i + nameMatch[0].length, end: j + 1, valueStart, valueEnd: j });
                }
                j++;
            } else if (body[j] === HOLE && HUMAN_ATTRS.has(name)) {
                // A computed attribute value. Most are machinery, but the choice idiom puts real
                // sentences here - `title=${empty ? 'write something first' : 'publish these
                // words'}` - and they are as much voice as any text node.
                out.push({ kind: name, holePos: j });
                j++;
            }
            i = j;
        }
        i++;
    }
    return out;
}

/**
 * The sentences hiding inside a choice expression.
 *
 * Only the branches are read - everything left of the first `?`/`&&`/`||`/`??` is the test, and a
 * test's literals are comparands (`flash === 'saved' ? …`), not words anyone reads. An expression
 * with no choice in it is skipped: `${fmt(doc, 'short')}` has a string in it and none of it is
 * voice. Each hit carries its offset within the expression so it can be rewritten in place.
 */
function conditionalStrings(exprSrc) {
    let depth = 0;
    let cut = -1;
    for (let i = 0; i < exprSrc.length && cut < 0; i++) {
        const c = exprSrc[i];
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (c === '"' || c === "'") {
            const quote = c;
            i++;
            while (i < exprSrc.length && exprSrc[i] !== quote) {
                if (exprSrc[i] === '\\') i++;
                i++;
            }
        } else if (depth === 0) {
            if (c === '&' && exprSrc[i + 1] === '&') cut = i + 2;
            else if (c === '|' && exprSrc[i + 1] === '|') cut = i + 2;
            else if (c === '?' && exprSrc[i + 1] === '?') cut = i + 2;
            else if (c === '?' && exprSrc[i + 1] !== '.') cut = i + 1;
        }
    }
    if (cut < 0) return [];
    const out = [];
    const pattern = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = pattern.exec(exprSrc.slice(cut))) !== null) {
        out.push({ raw: m[1] ?? m[2], start: cut + m.index, end: cut + m.index + m[0].length });
    }
    return out;
}

/**
 * An expression with every `t(...)` call blanked to spaces, positions preserved.
 *
 * Without this the migration is not idempotent, which is not a tidiness point but a correctness
 * one: a second run finds the English sitting inside the `t(…)` it wrapped on the first run and
 * wraps it AGAIN - `t(t('a.b','a.b'), t('a.b-2','b'))` - and the key of the outer call becomes the
 * key of the inner one. Caught by running the codemod twice, which is now how it is tested.
 */
function blankTCalls(expr) {
    let out = expr;
    const pattern = /\bt(?:Nodes)?\(/g;
    let m;
    while ((m = pattern.exec(out)) !== null) {
        let i = m.index + m[0].length;
        let depth = 1;
        while (i < out.length && depth > 0) {
            const c = out[i];
            if (c === '"' || c === "'" || c === '`') {
                const quote = c;
                i++;
                while (i < out.length && out[i] !== quote) {
                    if (out[i] === '\\') i++;
                    i++;
                }
            } else if (c === '(') depth++;
            else if (c === ')') depth--;
            i++;
        }
        out = out.slice(0, m.index) + ' '.repeat(i - m.index) + out.slice(i);
        pattern.lastIndex = i;
    }
    return out;
}

/// Literal arguments to the sinks that render text verbatim. Template-literal arguments come back
/// with their interpolation expressions, so a message with a hole can be parameterized.
function sinkStrings(src) {
    const out = [];
    const pattern = new RegExp(`\\b(${MESSAGE_SINKS.join('|')})\\(\\s*(['"\`])`, 'g');
    let m;
    while ((m = pattern.exec(src)) !== null) {
        const quote = m[2];
        const argStart = m.index + m[0].length - 1;
        let i = argStart + 1;
        let raw = '';
        const exprs = [];
        while (i < src.length && src[i] !== quote) {
            if (src[i] === '\\') {
                raw += src.slice(i, i + 2);
                i += 2;
                continue;
            }
            if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
                let depth = 0;
                const from = i + 2;
                i += 2;
                while (i < src.length) {
                    if (src[i] === '{') depth++;
                    else if (src[i] === '}') {
                        if (depth === 0) break;
                        depth--;
                    }
                    i++;
                }
                exprs.push(src.slice(from, i));
                raw += HOLE;
                i++;
                continue;
            }
            raw += src[i];
            i++;
        }
        out.push({ kind: 'message', raw, exprs, start: argStart, end: i + 1 });
    }
    return out;
}

// --- what counts as voice --------------------------------------------------------------------

/// Whitespace collapsed and the entities the codebase actually uses spelled back out. Holes are
/// left standing as HOLE for the caller to name.
function normalize(raw) {
    return raw
        .replace(/\s+/g, ' ')
        .replace(/&hellip;/g, '…')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

/// Is this something a person reads? Rejects the debris every extractor collects: pure
/// punctuation, lone interpolations, bare values passing through. It must contain a letter.
function isVoice(text) {
    const withoutHoles = text.split(HOLE).join('').trim();
    return Boolean(withoutHoles) && /[a-zA-Z]/.test(withoutHoles);
}

// --- keys ------------------------------------------------------------------------------------

/// A key is a NAME: minted once from the file it lives in and the first few words it said, then
/// frozen. It is never regenerated from edited copy - rewording a sentence must not orphan its
/// translations, which is the entire reason keys exist alongside the English.
function mintKey(file, text, taken) {
    // The namespace is the file's path, not its basename: two `routes.rs` live in this tree
    // (auth's and identity's) and a key that could mean either is not a name.
    const stem = file
        .replace(/^node\/(js|src)\//, '')
        .replace(/\.(js|rs)$/, '')
        .split('/')
        .join('.');
    const slug =
        text
            .split(HOLE)
            .join(' ')
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 5)
            .join('-') || 'text';
    let key = `${stem}.${slug}`;
    let n = 2;
    while (taken.has(key)) key = `${stem}.${slug}-${n++}`;
    taken.add(key);
    return key;
}

/// A readable name for a hole, taken from the expression that fills it when that expression is
/// simply a name (`${query}` -> `{query}`, `${item.title}` -> `{title}`). Anything more complex
/// gets a positional name, because a translator needs a label, not an expression.
function paramName(expr, index, used) {
    const trimmed = expr.trim();
    let name = null;
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) {
        name = trimmed.split('.').pop();
    }
    if (!name || used.has(name)) name = `p${index}`;
    let n = 2;
    while (used.has(name)) name = `p${index}_${n++}`;
    used.add(name);
    return name;
}

// --- rendering literals ----------------------------------------------------------------------

/// A JS string literal for `text`, single-quoted where that reads cleanly.
function jsString(text) {
    if (!text.includes("'") && !text.includes('\\')) return `'${text}'`;
    return JSON.stringify(text);
}

/// The `t(...)` call that replaces a piece of bare copy.
function tCall(key, english, params) {
    const args = [jsString(key), jsString(english)];
    if (params.length) args.push(`{ ${params.map(([n, e]) => (n === e.trim() ? n : `${n}: ${e.trim()}`)).join(', ')} }`);
    return `t(${args.join(', ')})`;
}

// --- finding bare copy -----------------------------------------------------------------------

/**
 * Every piece of user-facing text in one JS file that is NOT yet behind `t`, as a list of edits.
 *
 * The interesting judgement is what a hole in running text means. `${count}` is a value and
 * belongs INSIDE the message as a named parameter, because a translator must be free to move it -
 * word order is the first thing that changes between languages. `${cond && html`<b>…</b>`}` is an
 * element and cannot go inside a string at all, so it splits the text into separate messages
 * either side of it. Getting this wrong in the cheap direction (splitting everything) produces a
 * catalog of sentence fragments that cannot be translated well, which is the failure mode worth
 * spending code to avoid.
 */
function bareStrings(file, src, taken) {
    const edits = [];
    const record = (start, end, text, params, kindLabel) => {
        const english = normalize(text);
        if (!isVoice(english)) return;
        let named = english;
        const holeNames = [];
        const used = new Set();
        let index = 0;
        named = named
            .split(HOLE)
            .reduce((acc, piece, n) => {
                if (n === 0) return piece;
                const name = paramName(params[index] ?? '', index, used);
                holeNames.push([name, params[index] ?? '']);
                index++;
                return `${acc}{${name}}${piece}`;
            }, '');
        const key = mintKey(file, english, taken);
        edits.push({ start, end, key, english: named, params: holeNames, kind: kindLabel });
    };

    for (const tpl of htmlTemplates(src)) {
        const byPos = new Map(tpl.interps.map((it) => [it.bodyPos, it]));
        // A hole is a plain value only when nothing structural hides in it. A bare string literal
        // is excluded too: `${' '}` is a space the author placed by hand to survive whitespace
        // collapsing, and turning it into a translatable parameter would be nonsense.
        const isValueHole = (pos) => {
            const it = byPos.get(pos);
            if (!it || it.hasNested) return false;
            if (conditionalStrings(blankTCalls(it.src)).length > 0) return false;
            return !/^\s*(['"`]).*\1\s*$/s.test(it.src);
        };
        // The branches of a choice are prose wherever the choice sits - in running text or in a
        // `title=`. Rewritten where they stand, rather than lifted out of the expression.
        const rewriteChoice = (it) => {
            if (!it) return;
            for (const cond of conditionalStrings(blankTCalls(it.src))) {
                const english = normalize(cond.raw.replace(/\\(.)/g, '$1'));
                if (!isVoice(english)) continue;
                edits.push({
                    start: it.srcStart + cond.start,
                    end: it.srcStart + cond.end,
                    key: mintKey(file, english, taken),
                    english,
                    params: [],
                    kind: 'message',
                });
            }
        };
        const srcStartOf = (pos) => (tpl.body[pos] === HOLE ? byPos.get(pos).start : tpl.map[pos]);
        const srcEndOf = (pos) => (tpl.body[pos] === HOLE ? byPos.get(pos).end : tpl.map[pos] + 1);

        for (const piece of stringsInTemplate(tpl.body)) {
            if (piece.kind === 'text') {
                // Split the run at every hole that is a boundary rather than a value.
                let segStart = piece.start;
                for (let p = piece.start; p <= piece.end; p++) {
                    const boundary = p === piece.end || (tpl.body[p] === HOLE && !isValueHole(p));
                    if (!boundary) continue;
                    // Trim the segment; whitespace outside it stays in the template as written.
                    let a = segStart;
                    let b = p;
                    while (a < b && /\s/.test(tpl.body[a])) a++;
                    while (b > a && /\s/.test(tpl.body[b - 1])) b--;
                    if (b > a) {
                        const text = tpl.body.slice(a, b);
                        const params = [];
                        for (let q = a; q < b; q++) if (tpl.body[q] === HOLE) params.push(byPos.get(q).src);
                        record(srcStartOf(a), srcEndOf(b - 1), text, params, 'text');
                    }
                    segStart = p + 1;
                }
                for (let p = piece.start; p < piece.end; p++) rewriteChoice(byPos.get(p));
                continue;
            }
            if (piece.holePos !== undefined) {
                rewriteChoice(byPos.get(piece.holePos));
                continue;
            }
            // An attribute value: the span covers its quotes, so `title="close"` becomes
            // `title=${t(…)}`.
            const text = tpl.body.slice(piece.valueStart, piece.valueEnd);
            const params = [];
            for (let q = piece.valueStart; q < piece.valueEnd; q++) {
                if (tpl.body[q] === HOLE) params.push(byPos.get(q).src);
            }
            record(srcStartOf(piece.valueStart) - 1, srcEndOf(piece.valueEnd - 1) + 1, text, params, piece.kind);
        }
    }

    for (const sink of sinkStrings(src)) {
        record(sink.start, sink.end, sink.raw.replace(/\\(.)/g, '$1'), sink.exprs, 'message');
    }

    return edits.sort((a, b) => a.start - b.start);
}

/// Edits applied back to front, so each one's offsets are still valid when its turn comes.
function applyEdits(src, edits) {
    let out = src;
    for (const e of [...edits].sort((a, b) => b.start - a.start)) {
        const call = tCall(e.key, e.english, e.params);
        const replacement = e.kind === 'message' ? call : `\${${call}}`;
        out = out.slice(0, e.start) + replacement + out.slice(e.end);
    }
    return out;
}

/// `import { t } from './i18n.js';` placed after the last existing import, which is where this
/// codebase's imports end and its code begins.
function ensureImport(src, file) {
    if (/^import \{[^}]*\bt\b[^}]*\} from ['"][^'"]*i18n\.js['"]/m.test(src)) return src;
    const dir = path.dirname(file);
    let spec = path.relative(dir, path.join(JS_DIR, 'i18n.js')).split(path.sep).join('/');
    if (!spec.startsWith('.')) spec = './' + spec;
    const statement = `import { t } from '${spec}';\n`;
    const imports = [...src.matchAll(/^import .*?;$/gm)];
    if (!imports.length) return statement + src;
    const last = imports[imports.length - 1];
    const at = last.index + last[0].length + 1;
    return src.slice(0, at) + statement + src.slice(at);
}

// --- reading what is already behind `t` --------------------------------------------------------

/// Every `t(key, seed)` / `tNodes(key, seed)` call in a source file. The scanner is literal-only
/// on purpose: a key
/// or an English default that is computed at runtime is not a string this tool can catalogue, and
/// silently skipping one would be worse than never supporting it (STYLE.md: never assemble a name
/// at runtime).
function tCalls(src) {
    const out = [];
    const pattern = /\bt(?:Nodes)?\(\s*(['"`])/g;
    let m;
    while ((m = pattern.exec(src)) !== null) {
        let i = m.index + m[0].length - 1;
        let seedStart = -1;
        const readLiteral = () => {
            const quote = src[i];
            if (quote !== "'" && quote !== '"' && quote !== '`') return null;
            i++;
            let value = '';
            while (i < src.length && src[i] !== quote) {
                if (src[i] === '\\') {
                    value += { n: '\n', t: '\t', "'": "'", '"': '"', '\\': '\\', '`': '`' }[src[i + 1]] ?? src[i + 1];
                    i += 2;
                    continue;
                }
                value += src[i];
                i++;
            }
            i++;
            return value;
        };
        const key = readLiteral();
        if (key === null) continue;
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src[i] !== ',') continue;
        i++;
        while (i < src.length && /\s/.test(src[i])) i++;
        seedStart = i;
        const english = readLiteral();
        if (english === null) continue;
        // The seed's span, quotes included, so the catalog can be written back over it.
        out.push({ key, english, offset: m.index, seedStart, seedEnd: i });
    }
    return out;
}

/// The `AppError` variants that carry prose to the browser. `Internal` is excluded on purpose: it
/// renders as a 500 and its text is for the log, not the reader.
const RUST_VARIANTS = ['BadRequest', 'Unauthorized', 'Forbidden', 'RevokedSigner', 'NotFound', 'Unprocessable', 'TooManyRequests'];

/**
 * Every user-facing `AppError` in one Rust file that is not yet a `msg!`, as a list of edits.
 *
 * Three shapes, because that is what the codebase actually holds:
 *   "literal"                    -> msg!(key, "literal")
 *   format!("…{name}…")          -> msg!(key, "…{name}…", name = name)      params recoverable
 *   format!("…{}…", expr)        -> msg!(key, format!("…{}…", expr))        params NOT recoverable
 * The third keeps its English but loses the ability to be reordered in another language, because
 * nothing here can tell which `{}` a given expression fills. Those sites are reported by name so
 * they can be converted by hand rather than quietly shipping as half-translatable.
 */
function bareRustErrors(file, src, taken) {
    const edits = [];
    const pattern = new RegExp(`AppError::(${RUST_VARIANTS.join('|')})\\(`, 'g');
    let m;
    while ((m = pattern.exec(src)) !== null) {
        const innerStart = m.index + m[0].length;
        let i = innerStart;
        let depth = 1;
        while (i < src.length && depth > 0) {
            const c = src[i];
            if (c === '"') {
                i++;
                while (i < src.length && src[i] !== '"') {
                    if (src[i] === '\\') i++;
                    i++;
                }
            } else if (c === '(') depth++;
            else if (c === ')') depth--;
            i++;
        }
        const innerEnd = i - 1;
        const inner = src.slice(innerStart, innerEnd).trim();
        if (/^(crate::)?msg!/.test(inner)) continue;

        // The trailing comma is not cosmetic: rustfmt breaks a long construction across lines and
        // leaves one behind, and a pattern anchored without it silently skips exactly the longest
        // (and most user-visible) messages.
        const asStatic = /^"((?:[^"\\]|\\.)*)"\s*(?:\.into\(\)|\.to_string\(\))?\s*,?\s*$/s.exec(inner);
        const asFormat = /^format!\(\s*"((?:[^"\\]|\\.)*)"\s*(,[\s\S]*?)?\)\s*,?\s*$/s.exec(inner);
        if (!asStatic && !asFormat) continue;

        const literal = (asStatic ?? asFormat)[1];
        const english = normalize(literal.replace(/\\(.)/g, '$1'));
        if (!isVoice(english)) continue;
        const key = mintKey(file, english, taken);

        let replacement;
        let manual = false;
        if (asStatic) {
            replacement = `crate::msg!("${key}", "${literal}")`;
        } else if (!asFormat[2]) {
            // Inline captures: the hole names ARE the variable names, so the params come free.
            const names = [...literal.matchAll(/\{(\w+)(?::[^}]*)?\}/g)].map((h) => h[1]);
            const unique = [...new Set(names)];
            replacement = unique.length
                ? `crate::msg!("${key}", "${literal}", ${unique.map((n) => `${n} = ${n}`).join(', ')})`
                : `crate::msg!("${key}", "${literal}")`;
        } else {
            replacement = `crate::msg!("${key}", format!("${literal}"${asFormat[2]}))`;
            manual = true;
        }
        edits.push({ start: innerStart, end: innerEnd, replacement, english, key, manual });
    }
    return edits;
}

/// The server's user-facing error prose, as `msg!(code, english)` pairs.
function rustMessages(src) {
    const out = [];
    const pattern = /\bmsg!\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = pattern.exec(src)) !== null) {
        // `m[0]` ends on the closing quote of the seed, so its span falls straight out.
        const seedEnd = m.index + m[0].length;
        out.push({
            key: m[1],
            english: m[2].replace(/\\(.)/g, '$1'),
            offset: m.index,
            seedStart: seedEnd - (m[2].length + 2),
            seedEnd,
        });
    }
    return out;
}

/// The `{name}` holes in a message.
const holesOf = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

/// A Rust string literal for `text`. Only the two escapes a one-line message can contain: the
/// English is whitespace-collapsed before it ever reaches here.
function rustString(text) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// --- collection and rendering ------------------------------------------------------------------

const jsFiles = () =>
    walk(JS_DIR, '.js')
        .map(relPath)
        .filter((f) => !SKIP.some((re) => re.test(f)))
        .sort();

const rustFiles = () => walk(RUST_DIR, '.rs').map(relPath).sort();

/// Every catalogued phrase, in source order, grouped by the file it lives in.
function collect() {
    const entries = [];
    for (const file of jsFiles()) {
        const src = stripComments(fs.readFileSync(path.join(WORKSPACE, file), 'utf8'));
        for (const c of tCalls(src)) {
            entries.push({ file, line: lineAt(src, c.offset), key: c.key, english: c.english });
        }
    }
    for (const file of rustFiles()) {
        const src = stripComments(fs.readFileSync(path.join(WORKSPACE, file), 'utf8'));
        for (const c of rustMessages(src)) {
            entries.push({ file, line: lineAt(src, c.offset), key: c.key, english: c.english });
        }
    }
    return entries;
}

/// The English catalog as it stands on disk, or `{}` before there is one.
async function loadEnglish() {
    if (!fs.existsSync(EN_FILE)) return {};
    const mod = await import(new URL(`file://${EN_FILE}`).href);
    return mod.default ?? {};
}

/**
 * `locales/en.js` - the English catalog. HAND-EDITED for wording, generated for structure.
 *
 * The values come from the existing file wherever it has the key, so a copy edit made here is
 * never clobbered by a regeneration; only keys the catalog has never seen take their text from the
 * seed at the call site. Grouping and ordering always come from the source, so a phrase that moves
 * between files moves here too.
 */
function renderEnglish(entries, existing) {
    const lines = [];
    lines.push('// The English catalog: every phrase the application says to a person, in one place.');
    lines.push('//');
    lines.push('// THIS FILE IS AUTHORITATIVE FOR ENGLISH, and it is the one to edit to change what the app');
    lines.push('// says. `just strings` will not overwrite your wording - it only adds keys that are new in');
    lines.push('// the source, drops keys the source no longer has, and rewrites the seeds at the call sites');
    lines.push('// to agree with what is written here. Structure (grouping, order) is regenerated; values');
    lines.push('// are yours.');
    lines.push('//');
    lines.push('// Keys are names, minted once and never edited: renaming one orphans every translation');
    lines.push('// attached to it. To start another language, copy this file, translate the values, and');
    lines.push('// register it in i18n.js - the keys are already right.');
    lines.push('//');
    lines.push(`// ${entries.length} phrases across ${new Set(entries.map((e) => e.file)).size} files.`);
    lines.push('export default {');
    let currentFile = null;
    for (const e of entries) {
        if (e.file !== currentFile) {
            if (currentFile !== null) lines.push('');
            currentFile = e.file;
            lines.push(`    // --- ${e.file} ---`);
        }
        const value = Object.prototype.hasOwnProperty.call(existing, e.key) ? existing[e.key] : e.english;
        lines.push(`    ${jsString(e.key)}: ${jsString(value)},`);
    }
    lines.push('};');
    lines.push('');
    return lines.join('\n');
}

/**
 * Rewrite every call site's seed to match the catalog.
 *
 * This is what makes `en.js` authoritative rather than merely first-consulted: without it, editing
 * a word in the catalog would leave every call site quietly claiming the old wording, and the code
 * would stop being readable as prose - which is the only reason the seed is there at all.
 */
function syncSeeds(catalog) {
    let changed = 0;
    const refused = [];
    const rewrite = (file, calls, quote) => {
        const full = path.join(WORKSPACE, file);
        const raw = fs.readFileSync(full, 'utf8');
        const stripped = stripComments(raw);
        const edits = [];
        for (const c of calls(stripped)) {
            if (!Object.prototype.hasOwnProperty.call(catalog, c.key)) continue;
            if (catalog[c.key] === c.english) continue;
            // A seed whose holes the catalog entry lacks is not drift, it is a SHAPE change:
            // overwriting it would drop `{suggestion}` and the value it carried would silently
            // stop rendering. Caught the hard way, by merging split sentences onto their old keys
            // and watching the link vanish. The catalog wins on wording, never on structure.
            const lost = [...holesOf(c.english)].filter((h) => !holesOf(catalog[c.key]).has(h));
            if (lost.length) {
                refused.push(
                    `${file}:${lineAt(stripped, c.offset)}  ${c.key}\n` +
                        `    seed:    ${JSON.stringify(c.english)}\n` +
                        `    catalog: ${JSON.stringify(catalog[c.key])}\n` +
                        `    the catalog entry has no ${lost.map((h) => `{${h}}`).join(', ')}`,
                );
                continue;
            }
            edits.push({ start: c.seedStart, end: c.seedEnd, text: quote(catalog[c.key]) });
        }
        if (!edits.length) return;
        let out = raw;
        for (const e of edits.sort((a, b) => b.start - a.start)) {
            out = out.slice(0, e.start) + e.text + out.slice(e.end);
        }
        fs.writeFileSync(full, out);
        changed += edits.length;
    };
    for (const file of jsFiles()) rewrite(file, tCalls, jsString);
    for (const file of rustFiles()) rewrite(file, rustMessages, rustString);
    if (refused.length) {
        console.error(
            `\nREFUSED to rewrite ${refused.length} seed(s) - the catalog entry would drop a hole:\n\n` +
                refused.join('\n\n') +
                '\n\n  Update the catalog entry to the new shape, or - if the message now means\n' +
                '  something different - give the call site a NEW key and let the old one retire.\n' +
                '  Everything else was synced.',
        );
        process.exitCode = 1;
    }
    return changed;
}

// --- entry points ------------------------------------------------------------------------------

function migrate() {
    const taken = new Set(collect().map((e) => e.key));
    let files = 0;
    let strings = 0;
    for (const file of jsFiles()) {
        const full = path.join(WORKSPACE, file);
        const raw = fs.readFileSync(full, 'utf8');
        // Scanning reads comment-blanked source so an essay quoting a string is not mistaken for
        // one; the edits are applied to the REAL source, whose offsets are identical by
        // construction.
        const edits = bareStrings(file, stripComments(raw), taken);
        if (!edits.length) continue;
        fs.writeFileSync(full, ensureImport(applyEdits(raw, edits), full));
        files++;
        strings += edits.length;
    }
    console.log(`wrapped ${strings} interface strings across ${files} files`);

    const manual = [];
    let errors = 0;
    for (const file of rustFiles()) {
        const full = path.join(WORKSPACE, file);
        const raw = fs.readFileSync(full, 'utf8');
        const edits = bareRustErrors(file, stripComments(raw), taken);
        if (!edits.length) continue;
        let out = raw;
        for (const e of [...edits].sort((a, b) => b.start - a.start)) {
            out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
        }
        fs.writeFileSync(full, out);
        errors += edits.length;
        manual.push(...edits.filter((e) => e.manual).map((e) => `${file}  ${e.english}`));
    }
    console.log(`wrapped ${errors} server errors`);
    if (manual.length) {
        console.log(
            `\n${manual.length} carry positional holes and kept their format! - their values cannot\n` +
                'be reordered by a translator until the holes are named by hand:\n' +
                manual.map((s) => `  ${s}`).join('\n'),
        );
    }
}

async function writeEnglish() {
    const entries = collect();
    const existing = await loadEnglish();
    fs.mkdirSync(path.dirname(EN_FILE), { recursive: true });
    fs.writeFileSync(EN_FILE, renderEnglish(entries, existing));

    const had = new Set(Object.keys(existing));
    const has = new Set(entries.map((e) => e.key));
    const added = [...has].filter((k) => !had.has(k));
    const dropped = [...had].filter((k) => !has.has(k));
    console.log(`${relPath(EN_FILE)}: ${entries.length} phrases (+${added.length} new, -${dropped.length} retired)`);
    // A dropped key takes a hand-written English value with it, and every translation of it in
    // every other catalog is now orphaned too - worth naming, not just counting.
    for (const k of dropped) console.log(`  retired ${k}: ${JSON.stringify(existing[k])}`);

    const synced = syncSeeds(await loadEnglish());
    if (synced) console.log(`rewrote ${synced} call-site seed(s) to match the catalog`);
}

async function check() {
    const entries = collect();
    const problems = [];

    const onDisk = fs.existsSync(EN_FILE) ? fs.readFileSync(EN_FILE, 'utf8') : '';
    const catalogNow = await loadEnglish();
    if (onDisk !== renderEnglish(entries, catalogNow)) {
        // Say WHICH of the three it is. Lumping them together sends someone hunting for a missing
        // key when all they did was type "double quotes" where the generator writes 'single' -
        // this file is meant to be edited by hand, so its cop has to tell an edit from a gap.
        const inSource = new Set(entries.map((e) => e.key));
        const inCatalog = new Set(Object.keys(catalogNow));
        const missing = [...inSource].filter((k) => !inCatalog.has(k));
        const orphaned = [...inCatalog].filter((k) => !inSource.has(k));
        const some = (keys) => keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', …' : '');
        const detail = [];
        if (missing.length) detail.push(`  ${missing.length} phrase(s) in the source have no entry: ${some(missing)}`);
        if (orphaned.length) detail.push(`  ${orphaned.length} entr(ies) are no longer in the source: ${some(orphaned)}`);
        if (!detail.length) {
            detail.push('  Every key matches - only the formatting differs (quoting, order, or grouping');
            detail.push('  against code that has moved). Your wording is safe; this just normalizes it.');
        }
        problems.push(`locales/en.js is out of step with the source.\n${detail.join('\n')}\n  Run \`just strings\` and read the diff.`);
    }

    // The catalog outranks the seeds, so a disagreement means the code is claiming to say something
    // the app does not say - the call site has stopped being readable as prose, which is the seed's
    // only job.
    const catalog = await loadEnglish();
    const drifted = [];
    for (const file of jsFiles()) {
        const src = stripComments(fs.readFileSync(path.join(WORKSPACE, file), 'utf8'));
        for (const c of tCalls(src)) {
            if (catalog[c.key] !== undefined && catalog[c.key] !== c.english) {
                drifted.push(`${file}:${lineAt(src, c.offset)}  seed ${JSON.stringify(c.english)} vs catalog ${JSON.stringify(catalog[c.key])}`);
            }
        }
    }
    for (const file of rustFiles()) {
        const src = stripComments(fs.readFileSync(path.join(WORKSPACE, file), 'utf8'));
        for (const c of rustMessages(src)) {
            if (catalog[c.key] !== undefined && catalog[c.key] !== c.english) {
                drifted.push(`${file}:${lineAt(src, c.offset)}  seed ${JSON.stringify(c.english)} vs catalog ${JSON.stringify(catalog[c.key])}`);
            }
        }
    }
    if (drifted.length) {
        problems.push(
            `${drifted.length} call-site seed(s) disagree with locales/en.js:\n` +
                drifted.map((d) => `  ${d}`).join('\n') +
                '\n  The catalog is authoritative. `just strings` rewrites the seeds to match it; if the\n' +
                '  seed is the wording you meant, put it in the catalog and run that.',
        );
    }

    // Duplicate keys would silently collapse two phrases into one translation.
    const seen = new Map();
    for (const e of entries) {
        if (seen.has(e.key)) {
            problems.push(`duplicate key ${e.key}: ${seen.get(e.key)} and ${e.file}:${e.line}`);
        }
        seen.set(e.key, `${e.file}:${e.line}`);
    }

    // Copy that never went through `t` - the whole point of the cop.
    const bare = [];
    for (const file of jsFiles()) {
        const src = stripComments(fs.readFileSync(path.join(WORKSPACE, file), 'utf8'));
        for (const e of bareStrings(file, src, new Set())) {
            bare.push(`${file}:${lineAt(src, e.start)}  ${e.english}`);
        }
    }
    if (bare.length) {
        problems.push(
            `${bare.length} phrase(s) are shown to a person without going through t():\n` +
                bare.map((b) => `  ${b}`).join('\n') +
                '\n  Wrap them: t(\'a.stable-key\', \'the English\'). `just strings-migrate` does it for you.',
        );
    }

    if (problems.length) {
        console.error(problems.join('\n\n'));
        process.exit(1);
    }
    console.log(`locales/en.js is current (${entries.length} phrases), and no copy bypasses t().`);
}

const mode = process.argv[2];
if (mode === '--migrate') migrate();
else if (mode === '--check') await check();
else await writeEnglish();
