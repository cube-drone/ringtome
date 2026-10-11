# Toasts

Short messages that appear for a moment and go away by themselves: "moved to
recipes · open it", "couldn't rename the section: …", "bea in # the kitchen: is
the oven on". Before this the app had none (Curtis, 2026-10-11: "an utterly
toastless system"). Its errors were `alert()` boxes that stopped the page until
dismissed, its own news only lit a badge, and every confirmation was put
together by hand where it was needed.

## What a toast is

- **A line of words, maybe one action.** `toast(text, { kind, action, key })` in
  `node/js/toasts.js`, callable from anywhere. `action` is `{ label, href }`:
  "open it", "go to the room". A toast holds no form and asks nothing - a
  question that needs an answer stays a `confirm()` (deleting a notebook,
  logging out, revoking a key).
- **Two kinds, `info` and `error`.** Both fade. An error stays longer and wears
  the angry colour (Curtis, 2026-10-11: "errors fade like everything else, but
  slower and an angrier color"): `info` 5 s, `error` 10 s.
- **Hovering holds it.** The countdown stops while the pointer is over a toast,
  and restarts in full when it leaves; the × closes one at once.
- **Three at most.** A fourth pushes the oldest out.
- **A repeat is not a second toast.** Two toasts with the same `key` are one:
  the newer words replace the older, a count says how many ("×3"), and the
  countdown restarts. With no `key`, the text is the key, so the same error
  three times is one error ×3.

The rules - adding, merging, the cap, expiry, pausing - are values in, values
out, in `node/js/pure/toasts.js`, tested in
`node/integration/test/pure/toasts.cjs`. `toasts.js` holds the store, the timers
and the drawing, the store in the module-level listener idiom of `warnings.js`.

## Where they sit

The quickbar runs along the bottom at every width and owns the bottom-right
corner on a desktop (the clock and HorseBucks), so toasts stand above it, never
over it:

- **Wide** (more than 900 px, `panes.js`'s `NARROW_QUERY`): a column at the
  right, its foot above the quickbar, newest at the bottom, at most 22rem wide.
- **Narrow**: across the width with a margin, in the lower third, above the
  quickbar.

Both clear the quickbar's height and the phone's home bar (`--safe-bottom`).
Toasts are drawn above everything but tooltips and the CRT overlay, modals
included: an error from inside a modal must not hide behind it. `tokens.css`
gains the first shared layer value, `--layer-toast`.

For screen readers the stack is a live region: `role="status"` for info,
`role="alert"` for an error.

## Who raises them

1. **Errors that were `alert()`s**: "couldn't create / delete / rename …" in
   `buckets.js`, `doc/tree.js`, `doc/session.js`, `doc/reader.js`,
   `apps/notes.js` and `apps/feed.js`. The `confirm()`s and `prompt()`s beside
   them stay.
2. **A document moved to another notebook** (`doc/annotations.js`): "moved to X
   · open it". This replaces the line under the notebook switcher that the first
   cut of the move put there.
3. **Chat and the bell, while you're in the app.** The node's attention watcher
   (`attention.rs`, PROJECT_PLAN's _Saying it out loud_) already decides when a
   badge lights and words an alert for it: the desktop app and Web Push hear
   them. The live stream becomes a third listener. While a page holds a
   persona's stream, that persona is watched, and each alert for it rides down
   the socket (`alerts` on a stream frame). The page shows it as a toast, so a
   toast says what the operating system's notification would have, and can never
   disagree with the badge.

## Chat and the bell: when a toast is not raised

Off-screen the operating system speaks. The service worker shows no push while
one of our tabs is focused and visible (`sw.js`), and the desktop app shows no
notification while its window is in front, so a toast covers exactly the case
they leave out. A toast is not raised:

- **When you're already looking at it**: the alert's route is the page you're
  on - the room, or the bell's list.
- **When the page is hidden.** The badge, Web Push or the OS notification has
  it.
- **More than once per room until you look** (Curtis, 2026-10-11: "one per room
  sounds about right"). The first unseen line from a room raises a toast. Later
  lines update that toast while it's up, and say nothing once it has gone. The
  room speaks again only after you've been in it, meaning the page's route has
  been the room's. This memory is the tab's own, in memory, forgotten on reload.
  The bell keeps its per-item toasts, merged by key while one is up, because its
  rows are separate events: a mention, a reply, a contract.

## Watching while the stream is open

`Attention` gains a fourth reason to watch a persona, beside the recorder, the
desktop window and Web Push: a count of open stream sockets per persona.
`serve_stream` takes a guard as it opens, which counts up, and the guard's drop
counts down, so a socket that dies any way at all stops being counted.

The watcher's _first look announces nothing_ rule needs one change to hold here.
A persona nobody is watching any more has its "already seen" set dropped, so
being watched again starts with a silent first look. Without that, closing the
app for an hour and opening it would replay the hour as toasts, from a stale
set. That is the backlog the rule exists to keep quiet, and the badge already
shows it.
