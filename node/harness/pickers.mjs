// The completion-picker probe: boot the real SPA onto a real document, type into the actual
// CodeMirror editor character by character, and report what the autocomplete tooltip holds
// after each keystroke. Written for the [rai-vs-[sid mystery (2026-08-01): tag completions
// worked for some prefixes and not others in the field, while the machinery in isolation
// passed everything - so the instrument that shows the difference is the whole app, running.
//
// Usage: a throwaway node (state.mjs's env recipe), then:
//   HARNESS_BASE=http://localhost:5299 node pickers.mjs "[sid" "[rai" "[wave"
import { session, signUp, sleep } from './boot.mjs';

const BASE = process.env.HARNESS_BASE || 'http://localhost:5299';
const PROBES = process.argv.slice(2).length ? process.argv.slice(2) : ['[sid', '[rai'];

const s = session(BASE);
await signUp(s, 'picker');
const J = { 'Content-Type': 'application/json' };
const made = await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json();
const root = made.root_pubkey;

// A real notebook: a few docs so the link half of the picker has material.
const mk = (title) =>
    s.fetch(`/api/identity/${root}/docs`, {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ title, body: `${title} body`, format: 'marquee', bucket: 'notes' }),
    });
await mk('ramen ideas');
await mk('groceries');
const target = await (await mk('scratchpad')).json();

const dom = await s.boot(`/home/notes/${target.doc_id}`);
const { window } = dom;
const doc = window.document;

// Find the live editor and its EditorView (this @codemirror/view hangs the doc tile off the
// content DOM as `cmTile`, and the tile knows its view).
let view = null;
for (let t = 0; t < 30 && !view; t++) {
    await sleep(500);
    const content = doc.querySelector('.cm-content');
    view = content && content.cmTile && content.cmTile.view;
}
if (!view) {
    console.log('no CodeMirror view appeared; body:', JSON.stringify(doc.body.textContent).slice(0, 300));
    process.exit(1);
}
console.log('editor up; doc holds', JSON.stringify(view.state.doc.toString()).slice(0, 80));

const tooltip = () => {
    const tip = doc.querySelector('.cm-tooltip-autocomplete');
    if (!tip) return '(closed)';
    const opts = [...tip.querySelectorAll('li')].map((li) => li.textContent);
    return `open: ${opts.slice(0, 8).join(', ')}${opts.length > 8 ? ` …+${opts.length - 8}` : ''}`;
};

for (const probe of PROBES) {
    // Fresh line at the end of the doc for each probe.
    const end = view.state.doc.length;
    view.dispatch({
        changes: { from: end, insert: '\n' },
        selection: { anchor: end + 1 },
        userEvent: 'input.type',
    });
    await sleep(150);
    console.log(`--- typing ${JSON.stringify(probe)}`);
    for (const ch of probe) {
        const at = view.state.selection.main.head;
        view.dispatch({
            changes: { from: at, insert: ch },
            selection: { anchor: at + 1 },
            userEvent: 'input.type',
        });
        await sleep(200);
        console.log(`  after ${JSON.stringify(ch)}: ${tooltip()}`);
    }
}
process.exit(0);
