# Ringtome — The Game-Engine Client

**Status: exploratory. Nothing here is planned, scheduled, or started.** PROJECT_PLAN's *The Client
Story: one client, carried by the web* strikes this idea outright — "Game-engine client (Godot):
struck from the roadmap" — and that strike is still canon. This document does not overturn it.

It exists because the idea keeps coming back, and because when we costed it properly (2026-08-11)
the estimate inside the strike turned out to be *right about the renderer and wrong about the
editor* — in the direction that makes a Godot client cheaper than the strike assumes. The strike's
own escape clause ("justified only if a genuinely gamey product layer someday demands one") is the
door this document furnishes: if that day arrives, the argument starts here instead of from
scratch.

Read alongside [DESKTOP.md](DESKTOP.md) and [MOBILE.md](MOBILE.md) — all three are about the same
question (what shape is the application?) and they constrain each other.

## Why this keeps coming back

Godot unlocks things a browser fights us on, and some of them are close to the project's stated
aesthetic rather than decoration on top of it: unrestricted audio (PROJECT_PLAN's *The Client
Story* already concedes the browser tax here, and answers it with a period-authentic "click the
speaker icon to enable sound" ritual — a ritual we only need because the browser forced it),
spatiality, direct manipulation of the cozy objects, and shader-level control of the retro look.

The honest counter-pressure is that a social network is mostly data-bound, text-heavy, accessible
UI, which is what engine toolkits are worst at. That is the strike's core argument and it survives
everything below. What follows is only about *how much* it would cost, and where the cost actually
sits — because the strike locates it in the wrong place.

## The two integration shapes

**Sidecar.** Ship the `ringtome` binary beside the game, spawn it, talk to `127.0.0.1`. Requires
nothing from the Rust codebase. Barely requires godot-rust either — `OS.create_process` plus
`HTTPRequest` plus `WebSocketPeer` covers it — though a small gdext extension owning a `reqwest`
client is far nicer to write game code against, because Godot's `HTTPRequest` is one-request-per-node,
callback-shaped, and has no cookie jar.

**In-process.** Link the node into the GDExtension cdylib and run axum on a tokio runtime inside
the game. Better lifecycle, one binary, no orphan problem. `node/Cargo.toml` declares only
`[[bin]]`, so this needs the composition root in `src/main.rs` split into a `lib.rs` first — a
mechanical change, since that file is already a tidy `AppState` + router + loop-registry assembly
that implements nothing. **This is the same split [MOBILE.md](MOBILE.md) needs**, so whichever of
the two happens first pays for the other.

Sidecar is right for a desktop spike; in-process is right for anything shipped, and mandatory on
phones (iOS permits one process per app, full stop).

## What the markup layer actually costs

Less than the strike assumes, because **the parser is already ours and already Rust.**
`record/bake.rs` parses Marquee with `cube-drone-marquee-parser` for the publication media
pre-pass, so a gdext client links the same crate and gets the AST for free. The strike's own cost
model — "a renderer for a few dozen tags, not a browser" — is therefore literally true.

Better than that: it would be the *second* implementation of the grammar in the tree, not the
third. The web client renders through `@cube-drone/marquee-codemirror`; a Godot client would
render from the same Rust parser the node already uses, which is the cleaner factoring of the two.

Display: `RichTextLabel` with BBCode covers inline styles, links, and images — a meaningful
fraction of the vocabulary — and the tags it handles badly fall back to a custom `Control` drawing
through TextServer. Tedious and bounded. No novelty.

## The editor is not the wall it looks like

This is the correction worth recording. The intuitive objection is that a rich-text authoring
surface on `TextEdit` is a multi-month project whose best outcome is worse than the web one. That
objection aims at a problem **this design does not have.**

`js/doc/livemarquee.js` states the reason in its header: the document never stops being plain
Marquee source, styling is *projected onto* the text as CodeMirror decorations, and "the editor's
save machinery sees exactly the same thing a textarea would: a string." There is no rich-text
model anywhere in the system. The save contract is *produce a string*, which ports to anything.

`js/doc/editor.js` offers four view modes — `interactive` (the live-preview projection), `side`
(source pane plus rendered pane), `plain`, and `read`. Only the first is expensive to reproduce.
**Side-by-side is a renderer plus a code editor with highlighting**, and Godot's `CodeEdit` is
built for precisely that:

- `SyntaxHighlighter` is a subclassable resource with a per-line hook, so Marquee highlighting is
  a day's work against an AST we already have.
- The code-completion popup is built in, with an insert callback — which covers what
  `js/doc/completions.js` does for crosslinks, and that is one of the fiddlier things to build
  from scratch on the web.
- Gutters, delimiters, undo, multi-caret, clipboard, and selection all come along.

And because per-line decoration is the shape `SyntaxHighlighter` already has, a partial
`interactive` mode is reachable later rather than foreclosed. What it would lose is inline *block*
rendering — images and tables opening in place under the cursor. The gap is quantitative, not
architectural.

Side-by-side is also not a degraded mode users never see: it is a mode that ships today, which
matters for whether a Godot client feels second-class.

## What doesn't get cheaper

**Accessibility is the residual that does not shrink**, and it is awkward precisely because
PROJECT_PLAN's strike names accessible UI as the engine's weakness. A browser textarea is
accessible by default; Godot's screen-reader support arrived recently and is young by comparison.
Anything we ship on an engine owes this an explicit answer rather than an assumption.

**IME and mobile on-screen keyboards** in `TextEdit` are the other soft spot — workable,
historically janky, and worse the further from Latin text you go.

## The cost is diffuse, which is the real problem

Once the editor stops being the wall, no single hard component is left. What remains is feeds,
trees, taxonomies, contacts, settings, adoption ceremonies, key management, node admin — the long
tail of ordinary data-bound screens where the web is not 20% faster to build but several times
faster.

**Concentrated cost is the kind a solo project can beat with one good decision. Diffuse cost can
only be declined.** That is the whole strategic content of this document: a complete second client
is not the shape to attempt. A *narrow additive surface* is — consumption and play in the engine,
authoring in the browser, linked rather than duplicated. PROJECT_PLAN's client-agnostic API rule
(*The Client Story*: "no web-UI-private endpoints") is what makes that legitimate rather than a
hack, and it is already policy.

## Talking to the node from Godot: the practical inventory

Collected while reading the HTTP surface on 2026-08-11. Each of these is a small change with
value beyond Godot; three of them are the same changes [DESKTOP.md](DESKTOP.md) wants.

- **Auth is cookie-only.** `auth/extractor.rs` requires a cookie named `ringtome_session_<port>`
  (the port suffix exists because browsers scope cookies by host, never by port). There is no
  bearer-header path. A client can capture `Set-Cookie` from `/api/auth/login` and replay it, but
  a header path is a handful of lines and makes every non-browser client saner.
- **Single-tenant auto-session is a live TODO.** `auth/extractor.rs` documents the intent and
  falls through to cookie auth anyway, so even `RINGTOME_TENANCY=single` requires a
  register-then-login dance. On loopback the password floor relaxes to one character
  (`config.rs::password_min_len`), which is the posture this mode was designed for.
- **There is no port discovery.** The port comes from `RINGTOME_PORT` and the bound address
  appears only in a log line from `main.rs`. A shipped game cannot hardcode 5281 — a second copy
  or a dev node collides. Either pick a free port in the extension and pass it down, or have the
  node write its bound port into the data directory at boot. The latter is the honest fix.
- **`/health` is a real readiness probe** — it touches the node database rather than only proving
  HTTP answers, so it is the right thing to poll before showing UI.
- **The live-cache WebSocket is the right subscription model for a game.**
  `/api/identity/{root}/stream` (`identity/routes.rs::stream_handler`) gates before upgrading and
  then ships view-row deltas against a cursor. Godot's `WebSocketPeer` supports handshake headers,
  so the credential rides in. Do not poll.
- **Lifecycle is on us.** Killing the game does not kill a child process on any desktop. A
  stdin-EOF watchdog in the node (shut down gracefully when the parent's pipe closes) makes
  orphans structurally impossible instead of best-effort; see [DESKTOP.md](DESKTOP.md), which
  wants the same thing.
- **The data directory defaults to `./data`** (CWD), which is wrong for a shipped game.
- **The whole Preact UI is baked into the binary** (`ui.rs`). Harmless, and arguably useful: point
  a real browser at the node for account and identity ceremonies rather than rebuilding them in
  Godot.

## What "gamier" would actually unlock

Naming this concretely, because "gamier" carries a lot of weight in the argument and deserves to
be inspectable:

- **Spatiality.** The monkeysphere as a place — rooms, a house you decorate, a street of
  neighbours' pages. This maps onto the trust graph unusually well, because *Trust, Credibility,
  Interest, and Taste* already makes trust a distance metric with bands. The graph is a topology
  we currently render as lists.
- **Co-presence.** Avatars, who-is-here, synchronous encounter. See the tension below.
- **Audio without the browser's permission model** — which is the tax *The Client Story* already
  pays for with the speaker-icon ritual. MIDI, trackers, chiptune, ambient rooms.
- **Direct manipulation of the cozy objects.** A guestbook you open, a hit counter that is a
  physical thing, decorations you drag. *Cozy Aesthetic // Hidden Internals* argues for this
  aesthetic; an engine is where it stops being a metaphor.

One note on the strike's reasoning: it is a **novelty-budget** argument ("a solo project's novelty
budget is already fully spent on the protocol layer"), and budgets depend on who is spending.
Spatial social with user-generated content may be a *lower*-novelty area for this project's author
than the protocol layer ever was, which is not how the strike reads it.

## The tension a gamey layer introduces, and its resolution

**A gamey layer inverts the availability requirement the protocol was designed around.** The cozy
asynchronous model tolerates days of staleness by construction — *Rebroadcast: Pointer Plus Pinned
Replica* makes popularity into replication, *silence preserves, speech deletes* keeps an offline
author's content alive through replicas, and anti-entropy converges eventually. Co-presence
tolerates none of that: it needs two people awake at once. The gamier the surface, the more it
wants exactly the always-on infrastructure that [MOBILE.md](MOBILE.md) is trying to stop needing.

The way out is probably that **presence should not be chain content at all** — ephemeral, unsigned,
direct iroh connections, nothing durable, nothing replicated, nothing to validate at the sync
gate. And then the tension dissolves for a good reason: *synchronous features do not need
availability guarantees, because their failure mode is "nobody is around right now", which is a
legible social fact rather than a broken feature.* Empty rooms are fine. Empty rooms are
period-accurate.

This is the load-bearing design question a gamey product layer would have to answer first, and it
is answerable without writing any Godot.

## Where this would have to start

Not with a client. With a reason — a gamey product layer that wants the engine for something the
browser cannot do, specified well enough to say what it needs. Then, in order:

1. The presence question above, on paper: ephemeral tier or chain content.
2. The node-side ergonomics in the inventory (bearer auth, bound-port report, single-tenant
   auto-session, stdin watchdog) — all of which [DESKTOP.md](DESKTOP.md) also wants, so they are
   not speculative spend.
3. A sidecar spike: spawn, authenticate, subscribe to the stream, render one document from the
   Rust AST. A day, and it settles the renderer estimate with evidence.
4. Only then the question of whether the surface is additive or a client.

Until a product layer names its need, the strike stands.
