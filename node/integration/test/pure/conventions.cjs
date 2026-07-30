// The UI's architecture cops, as tests - the sibling of node/tests/conventions.rs, which does the
// same job for the Rust side (STYLE.md: "architecture cops are tests, not runtime machinery").
// Nothing here needs a browser or a node; it reads the source tree and asserts things about it.
//
// Three rules, each of which has already been broken once by hand:
//   1. no dead CSS - a class the stylesheet dresses but no module ever names;
//   2. no colour literals outside tokens.css - the palette's comment claims to be exhaustive;
//   3. the pure core stays pure - and stays tested.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.join(__dirname, '..', '..', '..', 'js');
const PURE_TEST_DIR = __dirname;

// Every source file under js/, skipping the build output and dependencies.
function walk(dir, ext, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'target') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, ext, out);
        else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
}
const rel = (p) => path.relative(JS_DIR, p);
const read = (p) => fs.readFileSync(p, 'utf8');

/// Source with its comments removed - these cops ask what the CODE does, and this codebase's
/// comments legitimately discuss the very things the code must not touch (keepalive.js's module
/// doc is four paragraphs about `fetch`). Block comments and whole-line `//` only: a conservative
/// pair that cannot mangle a URL or a regex mid-line.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const cssFiles = walk(JS_DIR, '.css');
const jsFiles = walk(JS_DIR, '.js');
const allJs = jsFiles.map(read).join('\n');

describe('css conventions', () => {
    // Class names owned by someone else: marquee's rendering contract, CodeMirror's internals, the
    // Phosphor seating hook, and the highlight registered by name through the CSS Highlight API.
    const FOREIGN = /^(mq-|cm-|ph$|highlight)/;

    it('has no dead classes - every class it dresses is named by some module', () => {
        const dead = [];
        for (const file of cssFiles) {
            for (const line of read(file).split('\n')) {
                // Only class selectors at the start of a selector line; that is where rules are
                // declared, and it keeps the check blunt enough to trust.
                const m = /^\s*\.([a-z][a-z0-9-]*)/.exec(line);
                if (!m) continue;
                const cls = m[1];
                if (FOREIGN.test(cls)) continue;
                // A module names a class as a bare string, inside a class attribute, or via a
                // template expression - so a substring search over all the JS is the honest test.
                if (!allJs.includes(cls)) dead.push(`${rel(file)}: .${cls}`);
            }
        }
        assert.deepEqual([...new Set(dead)], [],
            'dead CSS rules (nothing in js/ mentions these):\n  ' + [...new Set(dead)].join('\n  '));
    });

    it('keeps every colour literal in tokens.css', () => {
        // tokens.css's own comment promises this: "a literal colour anywhere below is a bug".
        const offenders = [];
        for (const file of cssFiles) {
            if (path.basename(file) === 'tokens.css') continue;
            read(file).split('\n').forEach((line, i) => {
                if (/^\s*(\/\*|\*)/.test(line)) return; // a comment may discuss a colour
                if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line)) {
                    offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        assert.deepEqual(offenders, [],
            'colour literals outside tokens.css:\n  ' + offenders.join('\n  '));
    });

    it('imports every partial from index.css (no orphans, no missing files)', () => {
        const index = read(path.join(JS_DIR, 'index.css'));
        const imported = [...index.matchAll(/@import\s+"\.\/([^"]+)"/g)].map((m) => m[1]);
        const onDisk = cssFiles.map(rel).filter((p) => p !== 'index.css')
            .map((p) => p.split(path.sep).join('/'));
        assert.deepEqual(imported.slice().sort(), onDisk.slice().sort(),
            'index.css is the table of contents: every partial appears exactly once');
    });
});

describe('the import graph', () => {
    // Local imports only; a package or an out-of-tree path (video-ingest) is somebody else's graph.
    function localDeps(file) {
        const dir = path.dirname(file);
        return [...read(file).matchAll(/from\s+'(\.[^']+)'/g)]
            .map((m) => path.resolve(dir, m[1]))
            .filter((t) => t.startsWith(JS_DIR + path.sep) && fs.existsSync(t));
    }

    it('is acyclic', () => {
        // It became acyclic when `rootTitleFor` moved to doc/naming.js, which retired the
        // slugs<->tree cycle that had carried an apologetic comment ("safe: both sides only call
        // the other's functions at runtime"). A cycle is survivable in ES modules and miserable to
        // reason about; now that there are none, keep it that way.
        const seen = new Set();
        const stack = [];
        const cycles = [];
        const visit = (node) => {
            if (stack.includes(node)) {
                cycles.push([...stack.slice(stack.indexOf(node)), node].map(rel).join(' -> '));
                return;
            }
            if (seen.has(node)) return;
            seen.add(node);
            stack.push(node);
            for (const dep of localDeps(node)) visit(dep);
            stack.pop();
        };
        for (const f of jsFiles) visit(f);
        assert.deepEqual([...new Set(cycles)], []);
    });

    it('has exactly one HTTP client and one mirror owner', () => {
        // net.js owns fetch; mirror.js owns the Dexie handle. Anyone else reaching for either is
        // how twelve copies of `api()` and five owners of the prefs table happened.
        const offenders = { fetch: [], Dexie: [] };
        for (const f of jsFiles) {
            const base = rel(f);
            const src = code(f);
            if (base !== 'net.js' && /\bfetch\s*\(/.test(src)) offenders.fetch.push(base);
            if (base !== 'mirror.js' && /\bDexie\b/.test(src)) offenders.Dexie.push(base);
        }
        assert.deepEqual(offenders, { fetch: [], Dexie: [] });
    });
});

describe('the pure core', () => {
    // The declared pure set: the UI's conformance boundary, the client-side echo of
    // ringtome-proto. Growing this list is the point (REFACTOR_UI P); it is a list rather than a
    // directory only until it reaches eight (S2).
    const PURE = ['lookout.js', 'keepalive.js', 'docdate.js', 'swatch.js'];
    const BROWSER = ['fetch', 'document', 'window', 'Dexie', 'preact', 'localStorage'];

    for (const name of PURE) {
        describe(name, () => {
            const src = () => code(path.join(JS_DIR, name));

            it('imports nothing at all - values in, values out', () => {
                const imports = [...src().matchAll(/^import\s.*$/gm)].map((m) => m[0]);
                assert.deepEqual(imports, []);
            });

            it('never reaches for the browser', () => {
                const found = BROWSER.filter((g) => new RegExp(`\\b${g}\\b`).test(src()));
                assert.deepEqual(found, [], `${name} mentions ${found.join(', ')}`);
            });

            it('has vectors in test/pure/', () => {
                // The clause a test glob can never provide: a glob finds the tests that exist, so
                // only a cop that enumerates the MODULES catches one nobody tested.
                const stem = name.replace(/\.js$/, '');
                const tests = fs.readdirSync(PURE_TEST_DIR).filter((f) => f.endsWith('.cjs'));
                const covered = tests.some((t) => read(path.join(PURE_TEST_DIR, t))
                    .includes(`/js/${stem}.js`));
                assert.ok(covered, `no test in test/pure/ imports js/${stem}.js`);
            });
        });
    }

    it('is still small enough to be a list rather than a directory (REFACTOR_UI S2)', () => {
        const zeroImport = jsFiles.filter((f) => !/^import\s/m.test(read(f)));
        assert.ok(zeroImport.length < 8,
            `${zeroImport.length} modules now have zero imports (${zeroImport.map(rel).join(', ')}) ` +
            '- at eight, reopen the rules/ directory question in REFACTOR_UI S2');
    });
});
