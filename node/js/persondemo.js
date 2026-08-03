// The Person widget gallery, at /id/<persona>/ui-demo: every shape the family renders,
// one after another, against a real persona. A workbench, not a product surface - it is how
// you look at all four sizes at once while tuning them, and how a new shape proves it sits
// beside the old ones before any page adopts it. Member-only by inheritance (the /id route
// hands anonymous visitors the static face and never boots the SPA).
import { h } from 'preact';
import htm from 'htm';

import { parseSpeakable } from './speakable.js';
import { PERSON_SIZES } from './pure/person.js';
import { usePerson, PersonChip, PersonBanner, PersonCard } from './person.js';

const html = htm.bind(h);

const Sample = ({ title, note, children }) => html`
    <section class="demo-sample">
        <h2 class="demo-title">${title}</h2>
        <p class="demo-note">${note}</p>
        <div class="demo-stage">${children}</div>
    </section>
`;

export const PersonDemo = ({ seg, current }) => {
    const parsed = parseSpeakable(decodeURIComponent(seg || ''));
    const root = parsed && parsed.ok ? parsed.root : null;
    const person = usePerson(root, { current });

    if (!root) {
        return html`<div class="persona-page">
            <h1 class="persona-page-title">the gallery needs a persona</h1>
            <p>Visit this page under someone's address - <code>/id/&lt;address&gt;/ui-demo</code>.</p>
        </div>`;
    }

    return html`
        <div class="persona-page person-demo">
            <p class="demo-lede">
                every Person shape, rendered against
                <strong>${person.primary || person.words}</strong>. One hook feeds them all
                (<code>usePerson</code>); the shapes are their own components.
            </p>

            <${Sample}
                title="chip - mini"
                note="inline, sits in a line of prose. Point at it for the name; click for their page."
            >
                <p class="demo-prose">
                    So <${PersonChip} root=${root} current=${current} size="mini" /> said the
                    thing about the boat, and then
                    <${PersonChip} root=${root} current=${current} size="mini" /> agreed, which
                    settled it.
                </p>
            <//>

            <${Sample} title="chip - small" note="the same shape, bigger: list rows, comment gutters.">
                <${PersonChip} root=${root} current=${current} size="small" />
                <${PersonChip} root=${root} current=${current} size="small" />
                <${PersonChip} root=${root} current=${current} size="small" />
            <//>

            <${Sample}
                title="banner"
                note="the inline header: face, names, and room for actions - what a page about this person wears at the top."
            >
                <${PersonBanner} root=${root} current=${current} />
            <//>

            <${Sample}
                title="card"
                note="everything: face, names, the shareable address, their bio, and your relationship with them."
            >
                <${PersonCard} root=${root} current=${current} />
            <//>

            <p class="demo-note">
                sizes the chip offers: ${PERSON_SIZES.join(', ')}
            </p>
        </div>
    `;
};
