// "+ new IM" (Rob, via Curtis, 2026-10-31): the IMs heading shows with no IMs yet, its "+ new IM"
// lists the people you know with no chat, and one click opens the chat - after which that person
// is a row under IMs and no longer offered.
//
//   just scratch 1   (prints the port)
//   PROBE_PORT=<port> node new-im-probe.mjs
import { session, signUp, sleep, waitFor, click } from './boot.mjs';

const J = { 'Content-Type': 'application/json' };
const base = `http://localhost:${process.env.PROBE_PORT || 5299}`;
const rob = session(base);
await signUp(rob, 'imrob');
const bea = session(base);
await signUp(bea, 'imbea');
const api = async (s, path, method = 'GET', body) => {
    const r = await s.fetch(path, { method, headers: J, body: body && JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 300) console.log('refused', method, path, r.status, text.slice(0, 120));
    return text ? JSON.parse(text) : null;
};
const robRoot = (await api(rob, '/api/identity', 'POST')).root_pubkey;
const beaRoot = (await api(bea, '/api/identity', 'POST')).root_pubkey;
await api(rob, `/api/identity/${robRoot}/private/kv/contact:${beaRoot}/trust`, 'PUT', {
    value: 'high',
});

const dom = await rob.boot('/ringtome/chat');
const { window } = dom;
const doc = window.document;
const dividers = () =>
    [...doc.querySelectorAll('.chat-rooms .chat-list-divider')].map((d) => d.textContent.trim());
await waitFor(doc, () => dividers().includes('IMs'), 'the IMs heading, with no IMs');
const link = await waitFor(
    doc,
    () =>
        [...doc.querySelectorAll('.chat-group-new')].find((a) => a.textContent.includes('new IM')),
    'the + new IM link',
);
console.log('RESULT the IMs heading shows with no IMs, and + new IM heads it:', !!link);
click(window, link);
const row = await waitFor(
    doc,
    () => doc.querySelector('.chat-im-people .chat-row'),
    'a person to chat with',
);
await sleep(1000);
const offered = [...doc.querySelectorAll('.chat-im-people .chat-row')].map((r) =>
    r.textContent.trim(),
);
console.log('RESULT offered:', JSON.stringify(offered));
click(window, doc.querySelector('.chat-im-people .chat-row'));
await waitFor(doc, () => window.location.pathname.includes('/room/'), 'the chat opening', 20000);
console.log('RESULT opened:', window.location.pathname);
await waitFor(
    doc,
    () => {
        const ul = [...doc.querySelectorAll('.chat-rooms .chat-list-divider')].find(
            (d) => d.textContent.trim() === 'IMs',
        );
        return (
            ul &&
            ul.nextElementSibling &&
            ul.nextElementSibling.querySelectorAll('.chat-row').length > 0
        );
    },
    'the chat under IMs',
    20000,
);
console.log('RESULT the chat is a row under IMs');
click(
    window,
    [...doc.querySelectorAll('.chat-group-new')].find((a) => a.textContent.includes('new IM')),
);
await sleep(2500);
console.log(
    'RESULT offered now:',
    JSON.stringify(
        [...doc.querySelectorAll('.chat-im-people .chat-row')].map((r) => r.textContent.trim()),
    ),
    JSON.stringify(
        doc.querySelector('.chat-new-pane') &&
            doc.querySelector('.chat-new-pane').textContent.slice(0, 200),
    ),
);
process.exit(0);
