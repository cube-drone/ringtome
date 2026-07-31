// The headless SPA driver: boot the REAL bundle inside jsdom against a throwaway node, walk
// the UI programmatically, and inspect the DOM. A debugging instrument, not a test suite -
// STYLE.md's no-automated-UI-testing rule stands (Selenium-class suites rot); this exists for
// the bug class that rule leaves dark: rendering failures only a running SPA exhibits.
// First catch (2026-07-30): a free `itemNoun` in doc/tree.js threw on the first section a
// user ever created, aborting every re-render mid-diff - orphaned app panels piling up in the
// DOM. Server data was provably clean; only driving the real bundle surfaced it.
//
// Usage:
//   RINGTOME_PORT=5299 RINGTOME_DATA_DIRECTORY=/tmp/harness-data RINGTOME_LOCAL_TEST=1 \
//     cargo run --bin ringtome &          # a throwaway node (fresh dir = fresh world)
//   cd node/harness && npm install && node drive.mjs
//
// The SCENARIO at the bottom is disposable - rewrite it per investigation (it is a scratch
// probe, not a regression suite; the current one is the tree-pane walk that caught the bug).
// The BOOT half is the part worth keeping: the browser-global stubs, the cookie-jar fetch
// bridge, and the API pre-provisioning that skips the onboarding ceremony.
import pkg from 'jsdom';
const { JSDOM, ResourceLoader } = pkg;
import 'fake-indexeddb/auto';

const BASE = process.env.HARNESS_BASE || 'http://localhost:5299';
let cookies = ''; // one shared jar: the SPA's session cookie, shared with pre-provisioning

// Node fetch bridging jsdom to the node, carrying cookies both ways (jsdom has no fetch).
async function bridgedFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, BASE).href;
    const headers = new Headers(init.headers || {});
    if (cookies) headers.set('cookie', cookies);
    const resp = await fetch(url, { ...init, headers, redirect: 'manual' });
    const setc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    for (const c of setc) {
        const pair = c.split(';')[0];
        const name = pair.split('=')[0];
        const rest = cookies.split('; ').filter((x) => x && !x.startsWith(name + '='));
        cookies = [...rest, pair].join('; ');
    }
    return resp;
}

/// Register + sign in + mint an identity via the API, so the SPA auto-opens the persona and
/// the drive starts at the console - no spare-key ceremony to click through.
async function provision() {
    const user = `harness${Date.now() % 100000}`;
    const J = { 'Content-Type': 'application/json' };
    const creds = JSON.stringify({ username: user, password: 'harness-password-123' });
    await bridgedFetch('/api/auth/register', { method: 'POST', headers: J, body: creds });
    await bridgedFetch('/api/auth/login', { method: 'POST', headers: J, body: creds });
    const made = await (await bridgedFetch('/api/identity', { method: 'POST', headers: J })).json();
    console.log(`provisioned ${user}, root ${made.root_pubkey.slice(0, 8)}`);
    return made;
}

/// The stubbed browser: everything the bundle touches that jsdom doesn't provide. `prompt`
/// answers with `window.__nextPrompt` so scenarios can script dialog-driven flows.
async function boot() {
    const html = await (await fetch(`${BASE}/home`)).text();
    const dom = new JSDOM(html, {
        url: `${BASE}/home`,
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        resources: new ResourceLoader(),
        beforeParse(window) {
            window.fetch = bridgedFetch;
            window.Headers = Headers;
            window.TextEncoder = TextEncoder;
            window.TextDecoder = TextDecoder;
            window.crypto = globalThis.crypto;
            window.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 16);
            window.cancelAnimationFrame = clearTimeout;
            window.indexedDB = indexedDB; // fake-indexeddb/auto owns the global
            window.IDBKeyRange = IDBKeyRange;
            window.WebSocket = class {
                // The live-cache stream stub: connects nowhere, never errors. The mirror
                // stays empty; components that read it render their empty states, which is
                // fine for driving - the HTTP writes underneath are all real.
                constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
                send() {}
                close() {}
                addEventListener(t, f) { if (t === 'open') setTimeout(f, 0); }
                removeEventListener() {}
            };
            window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
            window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
            window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
            window.scrollTo = () => {};
            window.Element.prototype.scrollIntoView = () => {}; // jsdom doesn't implement it
            window.prompt = (msg) => { console.log(`[prompt] ${msg} -> "${window.__nextPrompt}"`); return window.__nextPrompt; };
            window.alert = (m) => console.log(`[alert] ${m}`);
            window.console.warn = (...a) => console.log('[warn]', ...a);
            window.console.error = (...a) => console.log('[error]', ...a);
        },
    });
    return dom;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// The scenario (disposable - rewrite per investigation).

await provision();
const dom = await boot();
const { window } = dom;
const doc = window.document;

async function waitFor(pred, what, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const v = pred();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}\n--- body:\n${doc.body.innerHTML.slice(0, 1500)}`);
}

const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

const frameKids = () => {
    const inner = doc.querySelector('.app-frame-inner');
    if (!inner) return '(no app-frame-inner)';
    return [...inner.children].map((c) => `${c.tagName.toLowerCase()}.${[...c.classList].join('.')}`).join(' | ');
};
const report = (label) =>
    console.log(`### ${label}\n    frame: ${frameKids()}\n    .wiki=${doc.querySelectorAll('.wiki').length} .tree-pane=${doc.querySelectorAll('.tree-pane').length} url=${window.location.pathname}`);

try {
    await waitFor(() => doc.querySelector('.quickbar-hex'), 'the open persona quickbar');
    report('console (persona open)');

    click([...doc.querySelectorAll('.quickbar-hex')].find((b) => b.title === 'Wikibook'));
    await waitFor(() => doc.querySelector('.wiki'), 'the wiki app');
    report('wiki open');

    const sectionBtn = () => [...doc.querySelectorAll('.tree-tool')].find((b) => /section/.test(b.textContent));
    window.__nextPrompt = 'first directory';
    click(await waitFor(sectionBtn, 'the section button'));
    await waitFor(() => [...doc.querySelectorAll('.tree-row-title')].some((t) => t.textContent.includes('first directory')), 'directory 1 in the tree');
    report('after creating directory 1');

    window.__nextPrompt = 'second directory';
    click(sectionBtn());
    await waitFor(() => [...doc.querySelectorAll('.tree-row-title')].some((t) => t.textContent.includes('second directory')), 'directory 2 in the tree');
    report('after creating directory 2');

    // Open a page: the editor's opening -> loaded hook transition is the fragile spot the
    // lint gate polices (hooks above the early returns; editor.js, 2026-07-30).
    click([...doc.querySelectorAll('.tree-tool')].find((b) => /page/.test(b.textContent)));
    await waitFor(() => doc.querySelector('.reader, .editor, .wiki-main textarea, .cm-editor'), 'an editor surface');
    await sleep(1000);
    report('after opening a page (editor mounted)');

    click([...doc.querySelectorAll('.quickbar-hex')].find((b) => b.title === 'TurboNotes'));
    await sleep(1500);
    report('after switching to TurboNotes');
} catch (e) {
    console.log('FAILED:', e.message);
    report('failure state');
}
process.exit(0);
