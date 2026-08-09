// The Person widget gallery, at /id/<persona>/ui-demo: every shape the family renders,
// one after another, against a real persona. A workbench, not a product surface - it is how
// you look at all four sizes at once while tuning them, and how a new shape proves it sits
// beside the old ones before any page adopts it. Member-only by inheritance (the /id route
// hands anonymous visitors the static face and never boots the SPA).
import { h } from 'preact';
import htm from 'htm';

import { parseSpeakable } from './speakable.js';
import { PERSON_SIZES } from './pure/person.js';
import { usePerson, PersonChip, PersonBanner, PersonRow, PersonCard } from './person.js';
import { t } from './i18n.js';

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
            <h1 class="persona-page-title">${t('persondemo.the-gallery-needs-a-persona', 'the gallery needs a persona')}</h1>
            <p>${t('persondemo.visit-this-page-under-someones', "Visit this page under someone's address -")} <code>/id/&lt;address&gt;/ui-demo</code>.</p>
        </div>`;
    }

    return html`
        <div class="persona-page person-demo">
            <p class="demo-lede">
                ${t('persondemo.every-person-shape-rendered-against', 'every Person shape, rendered against')}
                <strong>${person.primary || person.words}</strong>${t('persondemo.one-hook-feeds-them-all', '. One hook feeds them all (')}<code>usePerson</code>${t('persondemo.the-shapes-are-their-own', '); the shapes are their own components.')}
            </p>

            <${Sample}
                title=${t('persondemo.chip---mini', 'chip - mini')}
                note="inline, sits in a line of prose. Point at it for the name; click for their page."
            >
                <p class="demo-prose">
                    ${t('persondemo.so', 'So')} <${PersonChip} root=${root} current=${current} size="mini" /> ${t('persondemo.said-the-thing-about-the', 'said the thing about the boat, and then')}
                    <${PersonChip} root=${root} current=${current} size="mini" /> ${t('persondemo.agreed-which-settled-it', 'agreed, which settled it.')}
                </p>
            <//>

            <${Sample} title=${t('persondemo.chip---small', 'chip - small')} note="the same shape, bigger: list rows, comment gutters.">
                <${PersonChip} root=${root} current=${current} size="small" />
                <${PersonChip} root=${root} current=${current} size="small" />
                <${PersonChip} root=${root} current=${current} size="small" />
            <//>

            <${Sample}
                title=${t('persondemo.banner', 'banner')}
                note="the inline header: face, names, and room for actions - what a page about this person wears at the top."
            >
                <${PersonBanner} root=${root} current=${current} />
            <//>

            <${Sample}
                title=${t('persondemo.row', 'row')}
                note="the banner's roster form: the whole row links, and your relationship rides on the right. What People is made of."
            >
                <div class="demo-rows">
                    <${PersonRow} root=${root} current=${current} />
                    <${PersonRow} root=${root} current=${current} />
                </div>
            <//>

            <${Sample}
                title=${t('persondemo.card', 'card')}
                note="everything: face, names, the shareable address, their bio, and your relationship with them."
            >
                <${PersonCard} root=${root} current=${current} />
            <//>

            <p class="demo-note">
                ${t('persondemo.sizes-the-chip-offers', 'sizes the chip offers: {p0}', { p0: PERSON_SIZES.join(', ') })}
            </p>
        </div>
    `;
};
