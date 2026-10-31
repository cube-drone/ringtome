// Recent things as tiles (plans/RECENTS.md): the three newest things this browser saved, said or
// published, heading the dock (index.js) and the launcher (console.js) in a rim of their own colour.
// A tile's face is the thing's picture when it has one - a drawing's kept thumbnail, the other
// person's face for an IM - and its app's icon otherwise; its name is on hover, and on the
// launcher's nameplate. The rows and their rules are mirror/recents.js's and pure/recents.js's.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { appById, appLabel } from './pure/apps.js';
import { iconFor } from './icons.js';
import { isDevice } from './net.js';
import { usePerson } from './person.js';
import { latestThumb } from './mirror/thumbcache.js';
import { tileLabel } from './pure/tilelabel.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// A thing's picture, or '': its drawing's newest kept thumbnail, else the other person's face.
function useThingPicture(root, thing, current) {
    const person = usePerson(thing.person || null, { current });
    const [drawn, setDrawn] = useState('');
    useEffect(() => {
        if (!thing.drawing) return undefined;
        let live = true;
        latestThumb(root, thing.drawing).then((url) => live && setDrawn(url || ''));
        return () => {
            live = false;
        };
    }, [root, thing.drawing, thing.at]);
    return drawn || (thing.person ? person.avatarUrl : '');
}

/// What a tile's tooltip says: the thing, and the app it is in.
const tipOf = (thing, app) =>
    `${thing.title || t('recents.untitled', 'untitled')}\n${appLabel(app, '', isDevice()) || ''}`;

/// One recent thing in the dock: a heptagon like an app's, in the recents' rim.
export const RecentDockTile = ({ root, current, thing }) => {
    const loc = useLocation();
    const app = appById(thing.app);
    const picture = useThingPicture(root, thing, current);
    const Icon = iconFor(app, isDevice());
    const here = loc.path === thing.href.split('?')[0];
    return html`<span class="quickbar-slot">
        <button
            class=${here ? 'quickbar-hex quickbar-hex-recent active' : 'quickbar-hex quickbar-hex-recent'}
            title=${tipOf(thing, app)}
            aria-label=${thing.title || appLabel(app, '', isDevice())}
            onClick=${() => loc.route(thing.href)}
        ><span class="quickbar-hex-face">${
            picture
                ? html`<img class="quickbar-hex-img" src=${picture} alt="" />`
                : html`<${Icon} />`
        }</span></button>
    </span>`;
};

/// One recent thing in the launcher's honeycomb: an app tile's heptagon in the recents' rim, the
/// thing's name on the nameplate.
export const RecentHex = ({ root, current, thing }) => {
    const loc = useLocation();
    const app = appById(thing.app);
    const picture = useThingPicture(root, thing, current);
    const Icon = iconFor(app, isDevice());
    const { text, scale } = tileLabel(thing.title || t('recents.untitled', 'untitled'));
    return html`<button
        class="app-tile app-tile-recent"
        title=${tipOf(thing, app)}
        onClick=${() => loc.route(thing.href)}
    >
        <span class="hex-mid"><span class="hex-face">
            ${
                picture
                    ? html`<img class="app-tile-face" src=${picture} alt="" />`
                    : html`<span class="app-tile-icon"><${Icon} /></span>`
            }
            <span class="app-tile-name" style=${scale === 1 ? undefined : `font-size: ${scale}rem`}>${text}</span>
        </span></span>
    </button>`;
};
