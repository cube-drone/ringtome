// A group's face as any card may want it (plans/GROUPS.md, "The group's face"): asked of the
// node's face door once a page, shared by every card of the group's, and forgotten when an owner
// changes it here. Its own module so the card (postentry.js) and the group's page (groups.js)
// can both ask without importing each other.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
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
/// pattern its id makes until an owner chooses one. `size` is mini or hero.
const TRI_SIZES = { mini: 'group-tri-mini', hero: 'group-tri-hero' };
export const GroupMark = ({ group, picture, size = 'mini' }) => html`<span
    class="person-hex group-tri ${TRI_SIZES[size] || TRI_SIZES.mini}"
    style="background: hsl(${personaHue(group)}, 60%, 55%)"
>
    <img class="person-hex-img" src=${picture || identiconUri(group)} alt="" />
</span>`;
