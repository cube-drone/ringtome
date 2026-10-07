// The corner cloud (plans/SYNC_STATUS.md, piece 3): always in the task bar's corner, always a way to
// the sync page, wearing what the node is doing for this persona - an arrow down while it pulls
// something chunky from another of its computers, up while it serves one, a sun while the node is
// busy syncing for other people, and a plain cloud the rest of the time. The face is decided and
// debounced on the node (syncstatus.rs), so every tab agrees and none of them blinks; it arrives
// on the stream like the badges, and this only draws it.
import { h } from 'preact';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from './mirror.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// Where the cloud leads: the persona's computers, where the sync status lives.
export const SYNC_PAGE = '/ringtome/persona/computers';

const ICON = { down: Icons.syncDown, up: Icons.syncUp, sun: Icons.syncSun, idle: Icons.syncIdle };
/// Each face's classes, spelled out whole (the CSS conventions find a class by its name).
const CLASS = {
    down: 'quickbar-sync quickbar-sync-down',
    up: 'quickbar-sync quickbar-sync-up',
    sun: 'quickbar-sync',
    idle: 'quickbar-sync',
};

/// What the cloud says on hover, from what the node said.
export const cloudWords = (now) => {
    const face = (now && now.face) || 'idle';
    if (face === 'down')
        return now.moved > 0
            ? t(
                  'sync.cloud-down-moved',
                  'Bringing your things from your other computer - {n} so far',
                  {
                      n: now.moved.toLocaleString(),
                  },
              )
            : t('sync.cloud-down', 'Bringing your things from your other computer');
    if (face === 'up') return t('sync.cloud-up', 'Sending your things to your other computer');
    if (face === 'sun')
        return now.people === 1
            ? t('sync.cloud-sun-one', 'This server is busy syncing the network for 1 person')
            : t('sync.cloud-sun', 'This server is busy syncing the network for {n} people', {
                  n: now.people,
              });
    return t('sync.cloud-idle', 'Nothing syncing right now - see your computers');
};

export const SyncCloud = ({ root, narrow = false }) => {
    const { route } = useLocation();
    const row = useLive(() => (root ? openMirror(root).kv.get('sync_face') : null), [root]);
    const now = row && row.value;
    const face = (now && ICON[now.face] && now.face) || 'idle';
    const Icon = ICON[face];
    const words = cloudWords(now);
    return html`<button
        type="button"
        class=${narrow ? `${CLASS[face]} quickbar-sync-narrow` : CLASS[face]}
        title=${words}
        aria-label=${words}
        onClick=${() => route(SYNC_PAGE)}
    ><${Icon} /></button>`;
};
