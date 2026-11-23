// A published mixtape on a card (plans/MIXTAPES.md): the post's body is its tracklist (amp.rs
// `TapeBody`), drawn as a cassette with the mixtape's name on its label - its look the post's own,
// the same wherever it is seen (pure/cassette.js) - then the tracks in order, and "play now".
//
// "Play now" plays, hrseAmp bought or not (ruling 5: "Play anyways"): the songs go to the app-wide
// player in the mixtape's order from the first, and a reader who owns hrseAmp is taken there.
//
// The card lives here, with the other cards a post's words can be (wordagacard.js), because the
// feed's card needs it and an app's file may not be imported from outside the app.
import { h } from 'preact';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { AMP_PATH, CassetteArt, usePlayer } from '../player.js';
import { clock, rowKey } from '../pure/amp.js';
import { useUnlocked } from '../unlocks.js';

const html = htm.bind(h);

/// A post's words read as a tracklist, or null where they aren't one.
export const parseTape = (words) => {
    try {
        const body = JSON.parse(words);
        return body && Array.isArray(body.tracks) ? body : null;
    } catch {
        return null;
    }
};

/// A track as the player takes a song (apps/amp.js's rows): somebody's public sound.
const song = (author, track) => ({
    key: rowKey(author, track.doc),
    own: false,
    author,
    doc: track.doc,
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    lengthMs: track.ms || 0,
    thumb: false,
});

export const MixtapeCard = ({ tape, author, post, title, viewer = null }) => {
    const player = usePlayer();
    const loc = useLocation();
    const hasAmp = useUnlocked(viewer, 'music');
    if (!tape)
        return html`<p class="null-sub">${t('mixtape.cannot-read', 'a mixtape this computer cannot read yet')}</p>`;
    const songs = tape.tracks.map((track) => song(author, track));
    const playing = !!player && !!player.current && songs.some((s) => s.key === player.current.key);
    const play = () => {
        if (!player || !songs.length) return;
        player.play(songs, songs[0], { kind: 'mixtape', name: title || '' });
        // To this mixtape in the reader's own hrseAmp (apps/amp.js reads `?tape=`).
        if (hasAmp) loc.route(`${AMP_PATH}?tape=${author}/${post}`);
    };
    return html`<div class="mixtape-card">
        <div class="mixtape-card-cassette">
            <${CassetteArt}
                tapeKey=${`${author}/${post}`}
                title=${title}
                artist=${
                    tape.tracks.length === 1
                        ? t('mixtape.one-track', '1 track')
                        : t('mixtape.n-tracks', '{n} tracks', { n: tape.tracks.length })
                }
                playing=${playing && player.playing}
            />
        </div>
        <ol class="mixtape-card-tracks">
            ${tape.tracks.map(
                (track) => html`<li class="mixtape-card-track" key=${track.doc}>
                    <span class="mixtape-card-title">${track.title || t('mixtape.untitled', 'untitled')}</span>
                    ${track.artist && html`<span class="mixtape-card-artist">${track.artist}</span>`}
                    <span class="mixtape-card-length">${track.ms ? clock(track.ms) : ''}</span>
                </li>`,
            )}
        </ol>
        <button class="mixtape-card-play jag-line" disabled=${!player || !songs.length} onClick=${play}>
            <${Icons.play} /> ${t('mixtape.play-now', 'play now')}
        </button>
    </div>`;
};
