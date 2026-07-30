// The UI's architecture cops, as tests - the sibling of node/tests/conventions.rs, which does the
// same job for the Rust side (STYLE.md: "architecture cops are tests, not runtime machinery").
// Nothing here needs a browser or a node; it reads the source tree and asserts things about it.
//
// Every rule here has already been broken once by hand, which is the only reason it is a rule:
//   - no dead CSS, and no colour literal outside tokens.css (the palette claims to be exhaustive);
//   - index.css imports every partial exactly once - it IS the table of contents;
//   - the import graph is acyclic, no app imports another app, and `fetch`/`Dexie` have one owner
//     each (twelve copies of `api()` and five owners of the prefs table are how we got here);
//   - the pure core imports only itself, never touches a browser API, and always has vectors.
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

    it('has no app importing another app', () => {
        // Apps compose what is below them in doc/, never each other. The Wikibook used to import
        // `RightColumn` and `useArrowNav` out of apps/notes.js, which made the dependency graph
        // claim the wiki was downstream of notes - it isn't, they are siblings over one spine.
        const sideways = [];
        for (const f of jsFiles.filter((f) => rel(f).startsWith('apps' + path.sep))) {
            for (const dep of localDeps(f).map(rel)) {
                if (dep.startsWith('apps' + path.sep)) sideways.push(`${rel(f)} -> ${dep}`);
            }
        }
        assert.deepEqual(sideways, []);
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
    // The declared pure set is now a DIRECTORY, not a list: `js/pure/` is the UI's conformance
    // boundary, the client-side echo of ringtome-proto, and membership is where a file lives. It
    // mirrors this directory - `js/pure/x.js` is tested by `test/pure/x.cjs` - so both halves of
    // the declaration are self-evident and neither can drift out of a hand-written array.
    const PURE = fs.readdirSync(path.join(JS_DIR, 'pure'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => `pure/${f}`);

    it('is not empty (a glob that finds nothing would pass every check below)', () => {
        assert.ok(PURE.length >= 7, `only found ${PURE.length} pure modules`);
    });
    // Patterns that match USE, not mention. A bare word list kept tripping on prose - this
    // codebase's comments legitimately discuss `fetch` (keepalive.js's whole module doc) and
    // documents (everywhere) - and comment-stripping only got the whole-line cases. Asking for
    // `document.` rather than `document` is both stricter about what it catches and blind to
    // English. Importing preact needs no pattern: the imports-only-pure-set rule above covers it.
    const BROWSER = [
        ['fetch', /\bfetch\s*\(/],
        ['document', /\bdocument\s*[.[]/],
        ['window', /\bwindow\s*[.[]/],
        ['localStorage', /\blocalStorage\s*[.[]/],
        ['Dexie', /\bnew\s+Dexie\b|\bDexie\s*\./],
        ['IndexedDB', /\bindexedDB\s*[.[]/],
    ];

    for (const name of PURE) {
        describe(name, () => {
            const src = () => code(path.join(JS_DIR, name));

            it('imports only other pure modules', () => {
                // The rule used to be "imports nothing at all", which was simple but excluded the
                // most valuable pure module in the UI: doc/naming.js legitimately needs the app
                // registry. Closing the set under its own imports is the actual firewall - every
                // member's dependencies are members, so the whole closure is checked here - and it
                // is what made apps.js drop its icon import to get in.
                const outside = [...src().matchAll(/^import\s.*?from\s+'([^']+)'/gms)]
                    .map((m) => m[1])
                    .map((spec) =>
                        spec.startsWith('.')
                            ? path.relative(JS_DIR, path.resolve(path.dirname(path.join(JS_DIR, name)), spec))
                                  .split(path.sep).join('/')
                            : spec)
                    .filter((dep) => !PURE.includes(dep));
                assert.deepEqual(outside, [], `${name} imports outside the pure set`);
            });

            it('never reaches for the browser', () => {
                const found = BROWSER.filter(([, re]) => re.test(src())).map(([g]) => g);
                assert.deepEqual(found, [], `${name} uses ${found.join(', ')}`);
            });

            it('has vectors in test/pure/', () => {
                // The clause a test glob can never provide: a glob finds the tests that exist, so
                // something has to enumerate the MODULES to catch one nobody tested. That is what
                // js/pure/ now is.
                const tests = fs.readdirSync(PURE_TEST_DIR).filter((f) => f.endsWith('.cjs'));
                const covered = tests.some((t) => read(path.join(PURE_TEST_DIR, t))
                    .includes(`/js/${name}`));
                assert.ok(covered, `no test in test/pure/ imports js/${name}`);
            });
        });
    }

    it('holds every module that qualifies - nothing pure hides outside it', () => {
        // A module with no local imports that touches no browser API belongs in pure/. This is the
        // nudge, not a law: it catches the case where someone writes a genuinely pure module in the
        // wrong place, which is how the set got scattered in the first place. Modules that import a
        // package we cannot inspect (icons.js pulls in Phosphor) are exempt, since "that package
        // renders" is not visible from here.
        // Match on `from '...'` rather than the start of an import: this codebase's package
        // imports are often multi-line (icons.js names 45 glyphs before saying where from).
        const strays = jsFiles
            .map(rel)
            .filter((f) => !f.startsWith('pure' + path.sep) && f !== 'index.js')
            .filter((f) => {
                const src = code(path.join(JS_DIR, f));
                if (/from\s+'\./.test(src)) return false; // has local imports
                if (/from\s+'[^.']/.test(src)) return false; // leans on a package we cannot judge
                return !BROWSER.some(([, re]) => re.test(src));
            });
        assert.deepEqual(strays, [], 'these look pure and belong in js/pure/');
    });
});
