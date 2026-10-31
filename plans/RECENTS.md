# Recents: the dock and the launcher in order of use

Curtis, 2026-10-31: "at the browser level, we keep track of the last apps you
had open and which documents you saved or interacted with in those apps. Using
that data, we re-order the apps in the app window and the desktop taskbar, with
apps displayed in order-of-last-use. The first three slots in the app/taskbar
are reserved: not for apps, but for a different-colored thing: your last three
interactions."

## Rulings

1. **The browser's, never the persona's chain.** Like a tucked column, what you
   last touched is a gesture of this browser (per persona), kept in the mirror's
   `recents` table (`mirror/recents.js` owns it). It is never synced, and
   logging out forgets it with the rest of the mirror.
2. **The persona tile stays first.** It wears your face and holds the persona
   switcher; it doesn't move. In the desktop dock a home tile comes second,
   always (Curtis, 2026-10-31), as on the phone's bar. Then the three recent
   things, then every other app, most recently used first. Apps never used here
   keep the registry's order, after the used ones.
3. **The phone's bar is unchanged.** Its three tiles (bell, home, chat) stay.
   The launcher grid gets the recents and the ordering at every width.
4. **A recent thing's face is its picture when it has one**: a drawing's kept
   thumbnail, the other person's face for an IM; otherwise its app's icon. Its
   rim is its own colour (`--recent-rim`), so it reads as a thing, not an app.
   Its name is on hover, and on the launcher's nameplate.

## What counts as an interaction

One record per thing, the newest touch moving it to the front:

- **A saved document** - every surface that saves through `doc/session.js`
  (Writer's notes, a drawing, a feed draft). The thing is the document; its app
  is the document's home app. A feed draft's tile opens the feed itself with its
  Writer column open (`/ringtome/feed?compose=1`), not the draft as a document.
- **A line said in a chat** - the room.
- **A published post or reply** (`doc/publish.js` `publishTo`) - the post, at
  its public (or group) address. Making a room or opening an IM isn't one; the
  first line said in it is.

- **An hrseAmp playlist saved, changed, or played from** (Curtis, 2026-10-31) -
  a filter saved; a mixtape made, added to, taken from or reordered; a radio
  station made or changed; a song played from a saved filter or a mixtape, or a
  station played. Its address is `/ringtome/amp?mixtape=<id>` (or `station=`,
  `filter=`), which hrseAmp opens and then sets back to its own.

A document deleted, or a playlist forgotten, leaves the recents. Opening an app
counts as using it; only the interactions above make a recent thing.

## Bounds

The table keeps the newest dozen things and one row per app; the dock and the
launcher show three.
