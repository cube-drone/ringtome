// Contract names, in the reader's language (Curtis, 2026-10-04). The node keeps the contracts -
// what each is worth, and whether it's done (bank.rs `CONTRACTS`) - and names them in English; the
// words a person reads come from here, by the contract's id, so a translation reaches the
// Contracts column, the ledger's line and the hrseMsg message alike. One literal `t()` per
// contract, never a key built from the id (STYLE: never assemble a name at runtime) - the strings
// tool reads them. A contract the node knows and this table doesn't yet wears the node's English.
import { t } from './i18n.js';
import { appHref, personaPageHref } from './links.js';

const NAMES = {
    'draw-a-horse': () => t('contracts.draw-a-horse', 'Draw a horse in hrseDrawing™'),
    'post-a-horse': () => t('contracts.post-a-horse', 'Post your horse to the hrseFeed™'),
    'follow-a-stranger': () => t('contracts.follow-a-stranger', 'Follow a stranger'),
    'get-a-follower': () => t('contracts.get-a-follower', 'Get a follower'),
    'write-a-note': () => t('contracts.write-a-note', 'Create a private note in hrseWriter™'),
    'upload-an-image': () => t('contracts.upload-an-image', 'Upload an image to hrseFiles™'),
    'set-a-profile-picture': () => t('contracts.set-a-profile-picture', 'Set your profile picture'),
    'choose-a-colorway': () => t('contracts.choose-a-colorway', 'Customize your Colorway'),
    'say-hello': () => t('contracts.say-hello', 'Say hello in a hrseChat™ room'),
    'tag-a-public-post': () => t('contracts.tag-a-public-post', 'Tag a public post'),
    'tag-a-private-note': () => t('contracts.tag-a-private-note', 'Tag a private note'),
    'react-to-a-post': () => t('contracts.react-to-a-post', "React to someone else's post"),
    'link-two-notes': () => t('contracts.link-two-notes', 'Link one private note to another'),
    'organize-a-note': () => t('contracts.organize-a-note', 'Organize a note into a tree section'),
    'start-a-room': () => t('contracts.start-a-room', 'Start a chat room'),
    'buy-a-horsebond': () => t('contracts.buy-a-horsebond', 'Buy a hrseBond'),
};

/// The fine print (Curtis, 2026-10-04): exactly what reaching the goal takes, said on hover over a
/// small link - which goes where the work is done.
const FINE_PRINT = {
    'draw-a-horse': () => ({
        text: t(
            'contracts.draw-a-horse-fine-print',
            'Please open the hrseDrawing™ application and draw anything you like. It must contain at least three brush-strokes to qualify.',
        ),
        href: appHref('drawing'),
    }),
    'post-a-horse': () => ({
        text: t(
            'contracts.post-a-horse-fine-print',
            'Open the hrseFeed™ application, and create and share a post containing any drawing.',
        ),
        href: appHref('feed'),
    }),
    'follow-a-stranger': () => ({
        text: t(
            'contracts.follow-a-stranger-fine-print',
            "Use the hrsePeople™ application to find someone else who plays Horse Drawing Tycoon 2, and set some interest in them. The people you were following from the start don't count - only someone you've never followed before.",
        ),
        href: appHref('people'),
    }),
    'get-a-follower': () => ({
        text: t(
            'contracts.get-a-follower-fine-print',
            "Get someone else who plays Horse Drawing Tycoon 2 to set some interest in you. The people who were following you from the start don't count, and neither do your own other personas.",
        ),
        href: appHref('people'),
    }),
    'write-a-note': () => ({
        text: t(
            'contracts.write-a-note-fine-print',
            'Open the hrseWriter™ application and make a new note. It stays private - only you can see it.',
        ),
        href: appHref('notes'),
    }),
    'upload-an-image': () => ({
        text: t(
            'contracts.upload-an-image-fine-print',
            "Open the hrseFiles™ application and upload a picture of your own - a photo, a GIF, anything. A copy of one of your drawings doesn't count.",
        ),
        href: appHref('lost-found'),
    }),
    'set-a-profile-picture': () => ({
        text: t(
            'contracts.set-a-profile-picture-fine-print',
            'Open your profile and choose a picture of yourself - upload one, or use one of your drawings.',
        ),
        href: personaPageHref('profile'),
    }),
    'choose-a-colorway': () => ({
        text: t(
            'contracts.choose-a-colorway-fine-print',
            'Open your profile and choose a colorway - the colors the whole app wears, for you and for everyone who visits your page.',
        ),
        href: personaPageHref('profile'),
    }),
    'say-hello': () => ({
        text: t(
            'contracts.say-hello-fine-print',
            'Open the hrseChat™ application, go into any room, and say something.',
        ),
        href: appHref('chat'),
    }),
    'tag-a-public-post': () => ({
        text: t(
            'contracts.tag-a-public-post-fine-print',
            "Put a tag on any post in the hrseFeed™ - one of yours, or someone else's.",
        ),
        href: appHref('feed'),
    }),
    'tag-a-private-note': () => ({
        text: t(
            'contracts.tag-a-private-note-fine-print',
            'Open a note in hrseWriter™ and give it a tag.',
        ),
        href: appHref('notes'),
    }),
    'react-to-a-post': () => ({
        text: t(
            'contracts.react-to-a-post-fine-print',
            "React to someone else's post in the hrseFeed™ with an emoji.",
        ),
        href: appHref('feed'),
    }),
    'link-two-notes': () => ({
        text: t(
            'contracts.link-two-notes-fine-print',
            'In hrseWriter™, write a link in one of your notes that points to another of your notes.',
        ),
        href: appHref('notes'),
    }),
    'organize-a-note': () => ({
        text: t(
            'contracts.organize-a-note-fine-print',
            "In hrseWriter™, open a notebook's tree, make a section, and put a note in it.",
        ),
        href: appHref('notes'),
    }),
    'start-a-room': () => ({
        text: t(
            'contracts.start-a-room-fine-print',
            'Open the hrseChat™ application and start a room of your own.',
        ),
        href: appHref('chat'),
    }),
    'buy-a-horsebond': () => ({
        text: t(
            'contracts.buy-a-horsebond-fine-print',
            'Open the market in hrseBank™ and buy a hrseBond.',
        ),
        href: appHref('bank'),
    }),
};

/// The contract's name as the reader reads it: this table's, else the node's `fallback`.
export const contractName = (id, fallback = '') => (NAMES[id] ? NAMES[id]() : fallback);

/// The contract's fine print - `{ text, href }` - or null for a contract that has none.
export const contractFinePrint = (id) => (FINE_PRINT[id] ? FINE_PRINT[id]() : null);
