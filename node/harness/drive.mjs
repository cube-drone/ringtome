// The from-scratch UI walk: boot the real SPA against a throwaway node and drive it as a user
// would - clicks, prompts, app switches - watching the DOM for wreckage. A debugging
// instrument, not a test suite - STYLE.md's no-automated-UI-testing rule stands; this exists
// for the bug class that rule leaves dark: rendering failures only a running SPA exhibits.
// First catch (2026-07-30): a free `itemNoun` in doc/tree.js threw on the first section a
// user ever created, aborting every re-render mid-diff - orphaned app panels piling up.
//
// Usage: a throwaway node on 5299 (see state.mjs's env recipe), then `node drive.mjs`.
// The SCENARIO below is disposable - rewrite it per investigation; boot.mjs is the keepable part.
import { session, signUp, waitFor, click, sleep } from './boot.mjs';

const BASE = process.env.HARNESS_BASE || 'http://localhost:5299';
const s = session(BASE);

// Pre-provision account + identity via the API, so the SPA auto-opens the persona (no
// spare-key ceremony to click through).
await signUp(s, 'drive');
const J = { 'Content-Type': 'application/json' };
const made = await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json();
console.log('provisioned root', made.root_pubkey.slice(0, 8));

const dom = await s.boot('/home');
const { window } = dom;
const doc = window.document;

const frameKids = () => {
    const inner = doc.querySelector('.app-frame-inner');
    if (!inner) return '(no app-frame-inner)';
    return [...inner.children].map((c) => `${c.tagName.toLowerCase()}.${[...c.classList].join('.')}`).join(' | ');
};
const report = (label) =>
    console.log(`### ${label}\n    frame: ${frameKids()}\n    .wiki=${doc.querySelectorAll('.wiki').length} .tree-pane=${doc.querySelectorAll('.tree-pane').length} url=${window.location.pathname}`);

try {
    await waitFor(doc, () => doc.querySelector('.quickbar-hex'), 'the open persona quickbar');
    report('console (persona open)');

    click(window, [...doc.querySelectorAll('.quickbar-hex')].find((b) => b.title === 'Wikibook'));
    await waitFor(doc, () => doc.querySelector('.wiki'), 'the wiki app');
    report('wiki open');

    const sectionBtn = () => [...doc.querySelectorAll('.tree-tool')].find((b) => /section/.test(b.textContent));
    window.__nextPrompt = 'first directory';
    click(window, await waitFor(doc, sectionBtn, 'the section button'));
    await waitFor(doc, () => [...doc.querySelectorAll('.tree-row-title')].some((t) => t.textContent.includes('first directory')), 'directory 1 in the tree');
    report('after creating directory 1');

    window.__nextPrompt = 'second directory';
    click(window, sectionBtn());
    await waitFor(doc, () => [...doc.querySelectorAll('.tree-row-title')].some((t) => t.textContent.includes('second directory')), 'directory 2 in the tree');
    report('after creating directory 2');

    // Open a page: the editor's opening -> loaded hook transition is the fragile spot the
    // lint gate polices (hooks above the early returns; editor.js, 2026-07-30).
    click(window, [...doc.querySelectorAll('.tree-tool')].find((b) => /page/.test(b.textContent)));
    await waitFor(doc, () => doc.querySelector('.reader, .editor, .wiki-main textarea, .cm-editor'), 'an editor surface');
    await sleep(1000);
    report('after opening a page (editor mounted)');

    click(window, [...doc.querySelectorAll('.quickbar-hex')].find((b) => b.title === 'TurboNotes'));
    await sleep(1500);
    report('after switching to TurboNotes');
} catch (e) {
    console.log('FAILED:', e.message);
    report('failure state');
}
process.exit(0);
