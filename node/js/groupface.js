// A group's face as any card may want it (plans/GROUPS.md, "The group's face"): asked of the
// node's face door once a page, shared by every card of the group's, and forgotten when an owner
// changes it here. Its own module so the card (postentry.js) and the group's page (groups.js)
// can both ask without importing each other.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';
import { identiconUri } from './pure/identicon.js';
import { personaHue } from './pure/person.js';

const html = htm.bind(h);

const asked = new Map(); // group id -> Promise of its face, or of null

const faceOf = (group) => {
    if (!asked.has(group)) {
        asked.set(
            group,
            api(`/api/groups/${group}/face`).catch(() => null),
        );
    }
    return asked.get(group);
};

/// Ask again next time: an owner just changed it.
export const forgetGroupFace = (group) => asked.delete(group);

/// The group's face, `{ name, description, picture, banner }`, or null until it lands (or if this
/// node can't say).
export function useGroupFace(group) {
    const [face, setFace] = useState(null);
    useEffect(() => {
        if (!group) return undefined;
        let live = true;
        faceOf(group).then((f) => live && setFace(f));
        return () => {
            live = false;
        };
    }, [group]);
    return group ? face : null;
}

/// A group's picture in its own shape (Curtis, 2026-10-16): the mighty triangle, point up, where a
/// person wears the heptagon - the same ring in the colour its id derives, and its picture, or the
/// pattern its id makes until an owner chooses one. `size` is mini, band (a public post's band) or
/// hero.
const TRI_SIZES = { mini: 'group-tri-mini', band: 'group-tri-band', hero: 'group-tri-hero' };
export const GroupMark = ({ group, picture, size = 'mini' }) => html`<span
    class="person-hex group-tri ${TRI_SIZES[size] || TRI_SIZES.mini}"
    style="background: hsl(${personaHue(group)}, 60%, 55%)"
>
    <img class="person-hex-img" src=${picture || identiconUri(group)} alt="" />
</span>`;

/// The head of each tab of a group's page (2026-10-17): its title, and beside it the way to add to
/// it - one element for the three, so each tab's top sits where the others' do.
export const GroupTabHead = ({ title, action = null }) => html`<div class="group-posts-head">
    <h3 class="group-posts-title">${title}</h3>
    ${action}
</div>`;

/// Which kind of group, at the top-left corner of its triangle (Curtis, 2026-10-17): a bullhorn for
/// a public group, a keyhole for a private one, in a small box, saying what that means in the
/// pop-over a person's chip says their name in (person.css `person-chip-label`) - on a point, or
/// on the keyboard's focus. The box draws a plain line, not the house jag's clip, which would cut
/// its own pop-over off.
export const GroupKind = ({ isPublic }) => {
    const words = isPublic
        ? t('publicgroup.a-public-group', "a public group: anybody can see who's in it")
        : t('publicgroup.a-private-group', "a private group: only its members can see who's in it");
    return html`<span class="group-kind" tabindex="0" aria-label=${words}>
        <${isPublic ? Icons.groupPublic : Icons.groupPrivate} />
        <span class="person-chip-label group-kind-label">${words}</span>
    </span>`;
};

/// The hero triangle with its kind at its corner.
export const GroupHeroMark = ({ group, picture, isPublic }) => html`<span class="group-hero-mark">
    <${GroupMark} group=${group} picture=${picture} size="hero" />
    <${GroupKind} isPublic=${isPublic} />
</span>`;
