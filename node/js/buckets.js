// Which notebook you are in, and how you move along the shelf.
//
// A documents app is a shelf of buckets ("notebooks" to the user), and exactly one is in view. The
// CHOICE is shell state, not app state - the header owns the switcher and every app reads the
// answer - so it lives here rather than in any one app, and the state machine that settles it is
// the fiddly part this module exists to hold:
//
//   - entering an app returns you to the bucket you last had open there (a session memory, like the
//     last-open document; forgotten on reload), or its home bucket when there is no memory;
//   - a COZY URL trumps the memory, because the address itself names the notebook - and resting on
//     one settles the memory too, so stepping back to an ordinary in-app route keeps you there
//     rather than bouncing home;
//   - switching buckets while resting on a cozy address first steps back to the app's own route, so
//     the URL stops overriding the choice;
//   - arriving on a deep document link, the in-memory choice is gone but the PAGE knows its
//     notebook, so once the mirror answers we correct the bucket to hold it - at most once per
//     document, so a deliberate later switch is never fought.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from './net.js';
import { openMirror, useLive } from './mirror.js';
import { appTypeOf, bucketsForApp } from './apps.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

// The bucket you last had open in each app, keyed `${root}:${app.id}`. In-memory on purpose: the
// same weight (and lifetime) as the last-open-document memory in doc/docapp.js.
const lastBucketMemory = new Map();

/**
 * The bucket in view, and the way to change it. See the module doc for the four rules it settles.
 *
 * @param appHere        the app the URL is showing, or null (persona/not-found routes have no bucket)
 * @param cozyBucketRow  the roster row a cozy first segment named, or null - the address naming a
 *                       notebook directly, which outranks the remembered pick
 * @param docSegment     the URL's document segment, if any: the deep-link correction's trigger
 */
export function useBucketChoice({ root, appHere, roster, cozyBucketRow, docSegment }) {
    const loc = useLocation();
    const [bucketPick, setBucketPick] = useState(null);

    const switchBucket = (name) => {
        setBucketPick(name);
        if (root && appHere) lastBucketMemory.set(`${root}:${appHere.id}`, name);
        if (cozyBucketRow) loc.route(`/home/${appHere.id}`);
    };

    useEffect(() => {
        setBucketPick((root && appHere && lastBucketMemory.get(`${root}:${appHere.id}`)) || null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [appHere && appHere.id]);

    useEffect(() => {
        if (cozyBucketRow && appHere) {
            setBucketPick(cozyBucketRow.name);
            if (root) lastBucketMemory.set(`${root}:${appHere.id}`, cozyBucketRow.name);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cozyBucketRow && cozyBucketRow.name, appHere && appHere.id]);

    const bucket =
        (cozyBucketRow && cozyBucketRow.name) || bucketPick || (appHere && appHere.style) || '';

    const deepDoc = (appHere && appHere.style && docSegment) || null;
    const docsRows = useLive(() => (root ? openMirror(root).docs.toArray() : []), [root]);
    const correctedFor = useRef(null);
    useEffect(() => {
        if (!deepDoc || correctedFor.current === deepDoc) return;
        if (!docsRows || !roster) return; // wait for the mirror before judging membership
        const row = docsRows.find((d) => d.doc_id === deepDoc);
        if (!row) return; // not mirrored (yet) - leave the bucket alone
        correctedFor.current = deepDoc;
        const names = row.buckets || [];
        if (names.includes(bucket)) return; // the current bucket already holds it
        if (!names.length) return; // unbucketed: the default app's home gathers it
        const target = names.find((n) => appTypeOf(n, roster) === appHere.style);
        if (target) switchBucket(target);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deepDoc, docsRows, roster, bucket, appHere && appHere.id]);

    return { bucket, switchBucket };
}

// The bucket switcher: a doc-app is a shelf of notebooks (buckets), and this is how you move
// along the shelf. It sits in the app header next to the title: a plus (bind a fresh, empty
// notebook of this app's type), arrows that page left/right along the rail (wrapping), and the
// current bucket's name - click it for the full list, where the current one can also be deleted.
// Deleting is the heavy hammer: every document inside is tombstoned, then the bucket itself is
// undefined - hence the BIG confirm. The home bucket (the eponymous one) can't be deleted.
export const BucketSwitcher = ({ root, app, roster, bucket, onSwitch }) => {
    const [menu, setMenu] = useState(false);
    const boxRef = useRef(null);

    // The menu closes on any press outside it (the usual dropdown contract).
    useEffect(() => {
        if (!menu) return;
        const onDown = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target)) setMenu(false);
        };
        document.addEventListener('pointerdown', onDown);
        return () => document.removeEventListener('pointerdown', onDown);
    }, [menu]);

    const names = bucketsForApp(app, roster);
    const at = Math.max(0, names.indexOf(bucket));
    const step = (d) => onSwitch(names[(at + d + names.length) % names.length]);
    const isHome = bucket === app.style;
    const membersOf = (name) => {
        const row = (roster || []).find((b) => b.name === name);
        return row ? row.members : 0;
    };

    const create = async () => {
        const name = (prompt(`A name for the new ${app.bucketNoun}:`) || '').trim();
        if (!name) return;
        try {
            await api(`/api/identity/${root}/buckets`, {
                method: 'POST',
                body: JSON.stringify({ name, app: app.style }),
            });
            onSwitch(name); // it exists empty right away; the roster row follows via the stream
        } catch (e) {
            alert(`couldn't create it: ${e.message}`);
        }
    };

    const destroy = async () => {
        // Count from the mirror, not the roster row - same docs the view shows.
        const docs = await openMirror(root).docs.toArray();
        const members = docs.filter((d) => (d.buckets || []).includes(bucket));
        const inside =
            members.length === 0
                ? 'It is empty - nothing else is lost.'
                : `EVERY DOCUMENT INSIDE IT - all ${members.length} of ${
                      members.length === 1 ? 'it' : 'them'
                  } - GOES TOO.`;
        if (
            !confirm(
                `DELETE THE ${app.bucketNoun.toUpperCase()} “${bucket}”?\n\n${inside}\n\n` +
                    `This is the big one. Are you sure?`
            )
        )
            return;
        setMenu(false);
        try {
            for (const d of members) {
                await api(`/api/identity/${root}/docs/${d.doc_id}`, { method: 'DELETE' });
            }
            await api(`/api/identity/${root}/buckets/${encodeURIComponent(bucket)}`, {
                method: 'DELETE',
            });
            onSwitch(app.style); // land back on the shelf's home notebook
        } catch (e) {
            alert(`couldn't delete it: ${e.message}`);
        }
    };

    return html`
        <span class="bucket-switch" ref=${boxRef}>
            <button class="bucket-btn" title="New ${app.bucketNoun}" onClick=${create}>
                <${Icons.plus} />
            </button>
            <button
                class="bucket-btn"
                title="the previous ${app.bucketNoun}"
                disabled=${names.length < 2}
                onClick=${() => step(-1)}
            ><${Icons.back} /></button>
            <button
                class="bucket-name"
                title="all of your notebooks"
                onClick=${() => setMenu((m) => !m)}
            >${bucket}</button>
            <button
                class="bucket-btn"
                title="the next ${app.bucketNoun}"
                disabled=${names.length < 2}
                onClick=${() => step(1)}
            ><${Icons.forward} /></button>
            ${menu &&
            html`<div class="bucket-menu">
                ${names.map(
                    (name) => html`<button
                        key=${name}
                        class=${name === bucket ? 'bucket-menu-item current' : 'bucket-menu-item'}
                        onClick=${() => {
                            onSwitch(name);
                            setMenu(false);
                        }}
                    >
                        <span>${name}</span>
                        <span class="bucket-menu-count">${membersOf(name)}</span>
                    </button>`
                )}
                ${!isHome &&
                html`<button class="bucket-menu-item bucket-menu-delete" onClick=${destroy}>
                    Delete this ${app.bucketNoun}…
                </button>`}
            </div>`}
        </span>
    `;
};
