// "Block this user" (js/blockmodal.js, 2026-11-02): one button on someone's page opens a modal of
// three choices - private block, public block, public warning - each with its reason, saved only
// by Save. Drives it through all three and the lift, reading back what each wrote.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node block-probe.mjs
import { click, session, signUp, sleep, waitFor } from './boot.mjs';

const J = { 'Content-Type': 'application/json' };
const base = `http://localhost:${process.env.PROBE_PORT || 5299}`;

const them = session(base);
await signUp(them, 'blockee');
const theirRoot = (await (await them.fetch('/api/identity', { method: 'POST', headers: J })).json())
    .root_pubkey;

const s = session(base);
await signUp(s, 'blocker');
const root = (await (await s.fetch('/api/identity', { method: 'POST', headers: J })).json())
    .root_pubkey;

const facts = async () => {
    const r = await (await s.fetch(`/api/identity/${root}/private/kv/contact:${theirRoot}`)).json();
    return Object.fromEntries((r.values || []).map((v) => [v.key, v.value]));
};
const listed = async () =>
    ((await (await s.fetch(`/api/identity/${root}/moderation`)).json()).mine || []).find(
        (m) => m.kind === 'persona' && m.target === theirRoot,
    );

const dom = await s.boot(`/ringtome/user/${theirRoot}`);
const { window } = dom;
const doc = window.document;
const button = () => doc.querySelector('.ledger-block');
await waitFor(doc, button, 'the block button');
console.log('RESULT the button asks:', button().textContent.trim() === 'block this user');

const open = async () => {
    click(window, button());
    return waitFor(doc, () => doc.querySelector('.block-form'), 'the block modal');
};
const choose = (form, i, reason) => {
    const choice = form.querySelectorAll('.block-choice')[i];
    click(window, choice.querySelector('input[type=radio]'));
    const box = form.querySelector('.moderation-reason input');
    box.value = reason;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const press = async (form, words) => {
    await sleep(100);
    const b = [...form.querySelectorAll('.block-actions button')].find(
        (x) => x.textContent.trim() === words,
    );
    click(window, b);
    await waitFor(doc, () => !doc.querySelector('.block-form'), 'the modal to close');
    await sleep(300);
};

let form = await open();
console.log(
    'RESULT three choices, none chosen:',
    form.querySelectorAll('.block-choice').length === 3 && !form.querySelector('.block-chosen'),
);
choose(form, 0, 'changed my mind');
await press(form, 'Cancel');
console.log(
    'RESULT cancel writes nothing:',
    (await facts()).blocked !== 'yes' && !(await listed()),
);

form = await open();
choose(form, 2, 'grumpy about ponies');
await press(form, 'Save');
let l = await listed();
let f = await facts();
console.log(
    'RESULT a public warning: a warn entry, no block:',
    l?.level === 'warn' && l?.reason === 'grumpy about ponies' && f.blocked !== 'yes',
);
await waitFor(doc, () => /warned/.test(button().textContent), 'the button to say so');
console.log('button:', button().textContent.trim());

form = await open();
console.log(
    'RESULT it opens on what was said:',
    form.querySelectorAll('.block-choice')[2].classList.contains('block-chosen'),
);
choose(form, 0, 'mine only');
await press(form, 'Save');
l = await listed();
f = await facts();
console.log(
    'RESULT a private block: off the list, blocked with its reason:',
    !l && f.blocked === 'yes' && f.blocked_reason === 'mine only',
);

form = await open();
choose(form, 1, 'spam, all of it');
await press(form, 'Save');
l = await listed();
f = await facts();
console.log(
    'RESULT a public block: on the list and blocked:',
    l?.level === 'block' && f.blocked === 'yes',
);

form = await open();
await press(form, 'Unblock');
l = await listed();
f = await facts();
console.log('RESULT unblock lifts both:', !l && f.blocked === 'no' && f.blocked_reason === '');
await waitFor(doc, () => button().textContent.trim() === 'block this user', 'the button back');
process.exit(0);
