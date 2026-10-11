## 2026-10-11 (cont.): a sound's fields, shown

The last entry on a sound's tags left them kept but unseen. Curtis: in Files, an
open sound's player should take the column's whole width - "the maximum
reasonable tracking space" - and under it, after a rule, the sound's tags,
editable, in a description list. So: doc/reader.js draws a sound as the player
(`.reader-sound-player`, `width: 100%`), an `<hr>`, and doc/soundtags.js's
`<dl>` - track, artist, album, album artist, composer, genre, year and track
number, in media/audio.rs `TAG_FIELDS`'s order, every one shown so an empty one
can be filled, each value an input saved the way the description is
(annotations.js `useField`, now exported, its field name URL-encoded since two
of these have spaces). A term and its value are a `<div>` in the list, laid out
as two cells of its grid. Seen on a scratch node with the sample MP3 in headless
Chrome at 1280 and 400 wide: the four fields its ID3 carried filled in, a year
typed into the page saved and read back, and "album artist" set and read through
the field door by name.
