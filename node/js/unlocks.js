// Unlocks (plans/UNLOCKS.md; Curtis, 2026-10-05): the paywall as tutorial. A new player has their
// persona, hrseDrawing, hrseBank and Nags; the rest is bought in hrseBank's Market, a piece at a
// time, each with a word on what it opens. The node keeps the purchases (bank.rs `UNLOCKS`, a
// private register) and sells them; the GATES are here - the client hides what isn't owned. It is
// a tutorial, not a lock: the node serves every feature to anyone who asks.
//
// What's owned rides the corner balance's poll (`useLedgerPoll`, once, in the shell): one answer
// carries the balance and the owned ids, so a purchase reaches every gate within a poll, and at
// once on the tab that bought it. Nothing on the client decides by itself - no pref, nothing kept
// past the tab: until the node has answered, only the starting set shows.
//
// The names and explanations a player reads are here, one literal `t()` apiece, by the unlock's id
// (as contracts.js names contracts); an unlock this table doesn't know wears the node's English.
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t, tNodes } from './i18n.js';
import { openMirror, useLive } from './mirror.js';
import { Icons } from './icons.js';
import { appHref } from './links.js';
import { COLORWAY_WORDS, colorwayOf } from './colorway.js';

const html = htm.bind(h);

// ---- what's owned ----

/// The persona the answer is for, its balance (BigInt horsepennies), the ids it owns, and whether
/// it owns everything - the test rig's answer, or an administrator's "Unlock everything". `known`
/// is false until the node answers.
let state = { root: null, balance: null, owned: new Set(), everything: false, known: false };
const listeners = new Set();

const publish = (next) => {
    state = next;
    for (const l of listeners) l(state);
};

/// Take the node's answer (`/bank?lines=0`, or the bank's own) as what `root` owns now.
///
/// An answer that changes nothing publishes nothing (2026-10-08, from a Firefox profile of slow
/// typing): the poll asks every ten seconds, and every answer used to hand every listener a fresh
/// state - a fresh Set - which re-rendered the shell, the open app and every row of its list, a
/// 0.9 s freeze mid-sentence each time.
export const noteBank = (root, answer) => {
    const owned = answer.unlocked
        ? new Set(answer.unlocked)
        : new Set((answer.unlocks || []).filter((u) => u.bought_ms).map((u) => u.id));
    const balance =
        answer.balance !== undefined
            ? BigInt(answer.balance)
            : state.root === root
              ? state.balance
              : null;
    const everything = !!answer.everything;
    if (
        state.known &&
        state.root === root &&
        state.balance === balance &&
        state.everything === everything &&
        sameSet(state.owned, owned)
    ) {
        return;
    }
    publish({ root, balance, owned, everything, known: true });
};

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/// Ask the node again now - after a purchase, so the gates open on this tab at once.
export const refreshUnlocks = (root) =>
    api(`/api/identity/${root}/bank?lines=0`)
        .then((b) => noteBank(root, b))
        .catch(() => {});

const useLedgerState = () => {
    const [s, setS] = useState(state);
    useEffect(() => {
        listeners.add(setS);
        setS(state);
        return () => listeners.delete(setS);
    }, []);
    return s;
};

/// The ledger's state for this persona - another persona's answer, or none yet, reads as nothing.
export const useLedger = (root) => {
    const s = useLedgerState();
    return s.root === root
        ? s
        : { root, balance: null, owned: new Set(), everything: false, known: false };
};

/// The gate where no persona is in hand (a filter strip, a picker): the persona open in this tab,
/// whose answer the shell's poll keeps - one persona per tab.
export const useOwns = (id) => unlockedIn(useLedgerState(), id);

/// The same, as a question to ask of many ids: `(id) => owned`.
export const useOwnership = () => {
    const s = useLedgerState();
    return (id) => unlockedIn(s, id);
};

/// Is this unlock owned? No id is always yes - the starting set needs nothing.
export const unlockedIn = (ledger, id) => !id || ledger.everything || ledger.owned.has(id);

/// The gate: true when `id` (or every id of a list) is owned by the persona open.
export const useUnlocked = (root, id) => {
    const ledger = useLedger(root);
    return Array.isArray(id) ? id.every((i) => unlockedIn(ledger, i)) : unlockedIn(ledger, id);
};

/// An app's features (pure/apps.js `featuresOf`) as this persona owns them: the columns and chips
/// the Market sells, off where they aren't bought. Idempotent - a surface handed features already
/// gated may gate them again.
/// The same object while nothing it's made of changes, so a memoized row handed it (apps/notes.js
/// `NoteRow`) skips a re-render: `feat` arrives a fresh object every render (`featuresOf`), so its
/// contents are the key, with what's owned.
export const useGatedFeatures = (root, feat) => {
    const ledger = useLedger(root);
    const key = JSON.stringify(feat);
    return useMemo(() => {
        const owns = (id) => unlockedIn(ledger, id);
        return {
            ...feat,
            tree: feat.tree && owns('taxonomy'),
            bookColumn: feat.bookColumn && owns('taxonomy') && owns('social'),
            linkColumn: feat.linkColumn && owns('links'),
            tagColumn: feat.tagColumn && owns('tags'),
            pin: feat.pin && owns('pins'),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, ledger.owned, ledger.everything]);
};

/// How often the shell asks the node while the tab is visible.
const ASK_MS = 10_000;

/// The one poll (in the shell): the balance for the corner, and what's owned for every gate. Asked
/// every ten seconds while the tab is visible, and again whenever the persona's own documents move
/// (the commonest earning).
export const useLedgerPoll = (root) => {
    const docsMoved = useLive(
        () =>
            root
                ? openMirror(root)
                      .docs.toArray()
                      .then((rows) => rows.reduce((m, d) => Math.max(m, d.updated_ms || 0), 0))
                : 0,
        [root],
    );
    // What's owned, first and alone: one register read, answered before the poll's catch-up.
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        api(`/api/identity/${root}/bank/unlocks`)
            .then((b) => live && noteBank(root, b))
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [root]);
    // The beat: every ten seconds while the tab is visible.
    const ask = useRef(() => {});
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        ask.current = () => {
            if (document.hidden) return;
            api(`/api/identity/${root}/bank?lines=0`)
                .then((b) => live && noteBank(root, b))
                .catch(() => {});
        };
        ask.current();
        const timer = setInterval(() => ask.current(), ASK_MS);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [root]);
    // And a moment after the documents move (2026-10-08): an autosave lands every few seconds while
    // anyone types, and asking on each one - restarting the beat each time - was a bank request
    // per save. The earning shows a few seconds late, which a rolling corner hides anyway.
    useEffect(() => {
        if (!root || !docsMoved) return undefined;
        const later = setTimeout(() => ask.current(), SETTLE_MS);
        return () => clearTimeout(later);
    }, [root, docsMoved]);
};

/// How long the documents stay still before the poll asks about them.
const SETTLE_MS = 3000;

// ---- the Market's words ----

const NAMES = {
    everything: () => t('unlocks.everything', 'Unlock everything'),
    friends: () => t('unlocks.friends', 'Friends'),
    social: () => t('unlocks.social', 'Social'),
    'private-notes': () => t('unlocks.private-notes', 'Private notes'),
    chat: () => t('unlocks.chat', 'Chat'),
    taxonomy: () => t('unlocks.taxonomy', 'Taxonomy & tree publication'),
    tags: () => t('unlocks.tags', 'Reactions, tags & filters'),
    'file-upload': () => t('unlocks.file-upload', 'File upload'),
    pins: () => t('unlocks.pins', 'Pins'),
    'post-editing': () => t('unlocks.post-editing', 'Public post editing'),
    'video-upload': () => t('unlocks.video-upload', 'Video upload'),
    sharing: () => t('unlocks.sharing', 'Sharing'),
    links: () => t('unlocks.links', 'Links'),
    'chats-for-two': () => t('unlocks.chats-for-two', 'Chats for two'),
    sealing: () => t('unlocks.sealing', 'Trusted only posts & post audiences'),
    'horse-financial': () => t('unlocks.horse-financial', 'Horse Financial'),
};

const ABOUT = {
    // A node administrator's alone (Curtis, 2026-10-07; bank.rs `EVERYTHING`).
    everything: () =>
        t(
            'unlocks.everything-about',
            "For the people who run this server: every app and every feature at once, without the tutorial. Free, and only offered to node administrators. Skip it if you'd rather play.",
        ),
    'horse-financial': () =>
        t(
            'unlocks.horse-financial-about',
            "Unlocks hrseBank™'s market to financial instruments like hrseBonds.",
        ),
    friends: () =>
        t(
            'unlocks.friends-about',
            'Unlocks Neighbors: look people up by their address, follow them, and keep track of everyone you know.',
        ),
    social: () =>
        t(
            'unlocks.social-about',
            'Unlocks hrseFeed™, and publishing everywhere: post your drawings and your writing for the people who follow you.',
        ),
    'private-notes': () =>
        t(
            'unlocks.private-notes-about',
            'Unlocks hrseWriter™: private notebooks, which you can choose to publish if you like.',
        ),
    chat: () =>
        t(
            'unlocks.chat-about',
            'Unlocks hrseChat™: chatrooms of your own, and the chatrooms of the people you follow.',
        ),
    taxonomy: () =>
        t(
            'unlocks.taxonomy-about',
            "Unlocks hrseWriter™'s tree - sections and pages, allowing you to structure your notebook like a book, and publish the whole thing as one.",
        ),
    tags: () =>
        t(
            'unlocks.tags-about',
            'Tag your notes and your posts, react to posts and chat lines with an emoji, and filter every list by its tags.',
        ),
    'file-upload': () =>
        t(
            'unlocks.file-upload-about',
            'Unlocks hrseFiles™, and the upload button everywhere: pictures and sounds from your computer, into notes, posts and rooms.',
        ),
    pins: () =>
        t(
            'unlocks.pins-about',
            'Pin a note to the top of its notebook, and a post to the top of your page.',
        ),
    'post-editing': () =>
        t(
            'unlocks.post-editing-about',
            'Change a post after it is published: everyone who has it gets the new version, and its history shows what changed.',
        ),
    'video-upload': () =>
        t('unlocks.video-upload-about', 'Upload video, maybe. It might not work.'),
    sharing: () =>
        t('unlocks.sharing-about', "Share someone else's post with the people who follow you."),
    links: () =>
        t(
            'unlocks.links-about',
            "Unlocks hrseWriter™'s links column: every note that links in, and every note that links out.",
        ),
    'chats-for-two': () =>
        t(
            'unlocks.chats-for-two-about',
            'Start a private chat with one person, from their page: only the two of you can read it.',
        ),
    sealing: () =>
        t(
            'unlocks.sealing-about',
            'Set a post so only the people you trust can read it - or address it to a group of your contacts.',
        ),
};

/// The warning a card carries, for the unlocks that need one.
const WARNINGS = {
    'video-upload': () =>
        t(
            'unlocks.video-upload-warning',
            "Experimental: video doesn't work in every browser or on every computer yet.",
        ),
};

const ICONS = {
    everything: Icons.key,
    friends: Icons.people,
    social: Icons.feed,
    'private-notes': Icons.notes,
    chat: Icons.chat,
    taxonomy: Icons.tree,
    tags: Icons.tag,
    'file-upload': Icons.upload,
    pins: Icons.pin,
    'post-editing': Icons.update,
    'video-upload': Icons.fileVideo,
    sharing: Icons.colRebroadcast,
    links: Icons.link,
    'chats-for-two': Icons.room,
    sealing: Icons.lock,
    'horse-financial': Icons.bond,
};

/// The unlock's name as the reader reads it: this table's, a colourway's own, else the node's
/// `fallback`.
export const unlockName = (id, fallback = '') => {
    const colorway = colorwayOf(id);
    if (colorway && COLORWAY_WORDS[colorway]) return COLORWAY_WORDS[colorway]();
    return NAMES[id] ? NAMES[id]() : fallback;
};

/// What the unlock opens, in a sentence or two; '' for one this table doesn't know.
export const unlockAbout = (id) =>
    colorwayOf(id)
        ? t(
              'unlocks.colorway-about',
              'A colorway for the whole app - and for your page, which everyone who visits sees in it.',
          )
        : ABOUT[id]
          ? ABOUT[id]()
          : '';

/// The unlock's warning, or null.
export const unlockWarning = (id) => (WARNINGS[id] ? WARNINGS[id]() : null);

/// The unlock's icon.
export const unlockIcon = (id) => ICONS[id] || Icons.lock;

/// What an app's address shows while the app isn't owned (UNLOCKS.md, "The gate"): which unlock
/// opens it, what that does, and the way to the Market - never a blank page. Before the node has
/// answered, nothing is known yet, and it says only that.
export const LockedApp = ({ id, known }) => {
    if (!known)
        return html`<div class="unlock-locked"><p class="null-sub">${t('unlocks.checking', 'checking…')}</p></div>`;
    const Icon = unlockIcon(id);
    return html`<div class="unlock-locked">
        <section class="unlock-locked-card">
            <h3 class="unlock-locked-name"><${Icon} /> ${unlockName(id, id)}</h3>
            <p>${unlockAbout(id)}</p>
            <p>${tNodes('unlocks.for-sale-in-the-market', 'For sale in the {market}.', {
                market: html`<a href=${appHref('bank')}>${t('unlocks.hrsebank-market', 'hrseBank™ market')}</a>`,
            })}</p>
        </section>
    </div>`;
};
