# Sounds

The app's sound effects. Each is baked into the node binary (`src/ui.rs`,
`EMBEDDED_SOUNDS`), served at `/sounds/<file>`, and played by `js/sound.js`.

Every sound is kept twice: the Ogg Vorbis file as it came, and an MP3 made from
it for the web views that cannot decode Ogg (Safari before 18.4, which is also
the desktop and iOS apps on an older system).

## Adding one

1. Put the `.ogg` here, and make its MP3:
   `ffmpeg -i name.ogg -codec:a libmp3lame -q:a 4 -map_metadata -1 name.mp3`
2. Add both files to `EMBEDDED_SOUNDS` in `src/ui.rs`.
3. Play it by its name without the ending: `playSound(['name'])`.

## Where they came from

`dice-throw-*`, `die-throw-*`, `dice-grab-*` and `card-place-*` are from
Kenney's _Casino Audio_ (1.1), by Kenney Vleugels (kenney.nl), under Creative
Commons Zero (CC0): http://creativecommons.org/publicdomain/zero/1.0/
