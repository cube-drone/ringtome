# Ringtome — Desktop Delivery (Electron)

**Status: a proposal to supersede PROJECT_PLAN's *Desktop mode: local server + system browser, NOT
Tauri*.** Written 2026-08-11. Not yet canon — PROJECT_PLAN is canon, and until that section is
amended, the tray-shell-opens-your-browser model is still what the plan says we ship. This document
is the argument for changing it, plus the plan we would follow if we do.

**The shell choice is argued, not sealed.** This document plans Electron and gives its reasons, but
*Electron and Tauri, compared* keeps the alternative live and names the one experiment that would
settle it. That experiment decides which shell, never whether to ship a desktop application.

The related documents: [MOBILE.md](MOBILE.md) (which reaches a *different* answer for phones, and
why that is coherent rather than contradictory) and [GODOT.md](GODOT.md) (which wants three of the
same node-side changes).

## What changed

PROJECT_PLAN rejects Tauri on the grounds that "the app is *already* a full HTTP server, so Tauri's
core value (bridging a webview to native Rust) is a bridge we do not need." **That rebuttal answers
the wrong question.** Nobody chooses a webview shell for the IPC bridge. They choose it for being an
application: one signed binary, its own icon, its own window and dock identity, its own alt-tab
entry, a tray, an updater, deep links. The plan answered "do we need IPC to Rust?" when the question
is "do we need to be an app?"

Three things push toward yes:

1. **The felt deficiency is real and it is not cosmetic.** A sidecar that opens your browser for all
   of its UI reads as a service with a config page. The plan's own floor case — *The Client Story*
   allows "just auto-open the system browser with no GUI at all" — is exactly that shape. An
   application that reads as a toy has an adoption problem, and adoption is load-bearing for the
   bootstrap argument in *Node-first as the bootstrap* and for the no-federation bet in
   [MOBILE.md](MOBILE.md). Legitimacy is a feature here, not a finish.
2. **The cited precedent drifted.** *Desktop mode* leans on "the Syncthing / Jupyter / Plex model,"
   and *The Client Story* adds Ollama as evidence that this is a normal consumer shape. But
   Syncthing is precisely the config-page feel we are complaining about, Plex ships native clients,
   and Ollama shipped a real desktop app. The pattern those projects demonstrate over time is
   "start with a localhost web UI, then build a shell once you care how it feels."
3. **Webview skew — the plan's strongest argument — is a reason to pick Electron, not a reason to
   ship no shell at all.** See below.

## Electron and Tauri, compared

**The trade in one line: Electron buys certainty, Tauri buys convergence.** Everything below is
detail hanging off that.

| | Electron | Tauri v2 |
|---|---|---|
| Engine | Bundled Chromium, one version, ours | OS webview: **WebView2 (Chromium) on Windows**, WKWebView on macOS, WebKitGTK on Linux |
| Skew exposure | None | macOS and Linux only; WebKitGTK on an old LTS is the scary one |
| Rust integration | Sidecar only | Sidecar **or** in-process — its backend *is* Rust |
| Rust changes needed | Zero | Zero (sidecar) or the `lib.rs` split (in-process) |
| Installer size | ~200MB | ~30–50MB, dominated by our own binary |
| Engine CVE duty | Ours, permanently | The OS's (evergreen WebView2, macOS updates, distro) |
| Stale-engine risk | None | Users on old OSes run engines we cannot patch |
| Mobile | None | iOS and Android |
| Shipped runtimes | Node **and** Rust | Rust only |
| Battle-testedness | A decade at VS Code / Slack / Figma scale | Mature-ish; smaller ecosystem, more undocumented corners |
| Signing cost | Apple plus Windows | Identical |
| Stable origin | A privileged custom scheme (see below) | A custom scheme is the default behaviour |

### Three shapes, not two

Naming these separately, because "Electron vs Tauri" hides the choice that actually matters:

1. **Electron plus sidecar** — what this document plans. The Node main process supervises the
   `ringtome` binary.
2. **Tauri plus sidecar** — structurally identical to (1), with first-class `externalBin` support.
   Same orphan concern, same readiness poll, same zero Rust changes, but one toolchain instead of
   two and a fifth of the download. Electron-shaped Tauri; it defers the in-process question
   entirely.
3. **Tauri plus in-process** — the node linked in, axum on Tauri's own tokio runtime. This one is
   **qualitatively different, not merely smaller**: no child process, so no orphan watchdog; no port
   collision, because nothing else can claim it; no readiness race, because we start the server and
   know when it is up; the launch token passes in memory rather than through the environment. Three
   of the fiddliest items in this plan stop existing, and there is one Mach-O to notarize instead of
   a nested binary.

Shape (3) is also the `lib.rs` split that [MOBILE.md](MOBILE.md) and [GODOT.md](GODOT.md) both need,
so it converts mobile from a separate project into a port and retires MOBILE's "two shells against
one UI" residual outright. One shell, three platforms, one toolchain that already has `just` recipes
and `cargo test` around it.

### Where the comparison is narrower than it first looks

Two corrections to the case as originally written here (2026-08-11), both in Tauri's favour:

- **Windows under Tauri is Chromium**, since WebView2 is Chromium-based and evergreen. The skew
  exposure is macOS and Linux, not all three platforms.
- **"We develop against real browsers and that is what ships" splits in half.** Because the node
  serves the UI over HTTP, day-to-day development is identical under either shell — Chrome pointed
  at localhost, the shell only involved at package time. What Tauri costs is the *second* half of
  that sentence: what ships is not what we developed against. A real cost, but a narrower one than
  "Tauri costs us this principle" implies.

What Electron gives up, stated plainly: **mobile, completely.** No phone story exists, so the
convergence [MOBILE.md](MOBILE.md) describes — one decision buying the desktop shell *and* mobile
*and* the in-process node — does not happen. That is the true price of shape (1), and it is why the
two documents land in different places.

They are not exclusive, though. Because Electron asks nothing of the Rust side, shipping it forecloses
nothing; it only means the `lib.rs` split gets paid for once on its own account rather than obtained
as a side effect.

### The deciding experiment

Everything above reduces to one empirical question: **does the Dexie mirror survive WKWebView and
WebKitGTK?**

The plan calls cross-platform webview skew "a documented misery," which is true in general and vague
in particular. For *this* codebase it has a specific address: **the mirror is Dexie, and
IndexedDB-on-WebKit is the most notorious compatibility surface on the web platform.** Not CSS, not
layout — what would break is `js/mirror.js` and the live-cache stream feeding it. CodeMirror 6,
Preact, and WebSocket are all safe across the three engines; IndexedDB is the only component
genuinely at risk, which is what makes the test narrow enough to be worth running.

The spike, about a day: load the existing UI in a WKWebView and a WebKitGTK view, then hammer the
mirror — bulk writes, the live-cache stream, a reload against a warm cache, `doccache` with a
large body.

If the mirror survives both, shape (3) is the better application for this project, because the costs
it removes (orphans, port collisions, two toolchains, a separate mobile project, the CVE treadmill)
are precisely the ones that fall hardest on a solo developer with no budget — and the size
difference is a real download-abandonment factor for an unknown app. If the mirror fails on either,
Electron is the answer and nothing further needs weighing.

**This experiment decides the shell, never whether to ship a desktop application** — both branches
build one. It is therefore not a rollout stage, and it is only worth running while the choice is
open; it has to precede Stage 1, which commits the shell.

### Why this document plans Electron anyway

Because the choice is not only technical. **"When something breaks at 11pm, somebody has already hit
it and written it down"** is the strongest single argument on the list for a one-person project, and
it belongs to Electron by a wide margin. Bundled Chromium also keeps Dexie working unexamined, and
the whole plan asks nothing of the Rust codebase, so it can be executed without touching anything
load-bearing.

The recorded risk of proceeding this way: committing to Electron *without* running the spike leaves
the mobile story permanently more expensive on the strength of an assumption about WebKit we would be
guessing at. That is an acceptable trade to make deliberately. It is a bad one to make by default,
which is why it is written down here.

## The architecture

The main process does four things, and never builds UI:

1. Pick a port (see the stable-origin trick — it can float).
2. Spawn `ringtome` as a child with `RINGTOME_TENANCY=single`, a per-launch token, a real data
   directory, and stdin piped.
3. Poll `/health` until it answers — it touches the node database rather than only proving HTTP
   responds, so it is a true readiness gate.
4. Open a `BrowserWindow`.

That is roughly 150 lines. Everything else is the app we already have.

**The renderer loads the UI from the node's own HTTP server, not from files in the asar.** `ui.rs`
keeps its job, the bundle stays baked into the binary, and the hosted-browser path and the desktop
path serve byte-identical UI from one source of truth. PROJECT_PLAN's client-agnostic rule survives
intact, and there is no second build pipeline to drift.

Renderer security posture: `contextIsolation: true`, `nodeIntegration: false`. The preload exposes
only the port and the launch token, so the UI stays a plain web app with no privileged surface.

## The stable-origin trick

*Caveats that apply to desktop mode regardless* warns: use a stable port, not a floating one,
because the browser treats `localhost:3000` and `:3001` as different origins and a shifting port
silently logs the user out and drops per-origin state. Under Electron that concern can be retired
outright rather than managed:

- `protocol.registerSchemesAsPrivileged({ scheme: 'app', privileges: { standard: true, secure:
  true, supportFetchAPI: true, stream: true } })`
- then `protocol.handle('app', …)` forwarding to whatever port the node actually bound.

The renderer always sees `app://ringtome/…`, so **the port can float freely and IndexedDB never
notices** — which also makes port collisions and multiple instances non-issues. `standard: true`
and `secure: true` are both load-bearing; without them there is no real origin and IndexedDB does
not work at all.

**The wrinkle, recorded honestly: WebSocket upgrades do not route through `protocol.handle`.** The
live-cache stream still needs a real `ws://127.0.0.1:<port>` URL handed to the renderer via
preload, which means the socket's origin differs from the page's. That is fine for WebSocket, but it
means the node should check `Origin` deliberately rather than by accident. **This specific
interaction is the thing to spike first** — it is the one place this plan could be wrong in a way
that changes the design.

## Two changes on the node side, both of which earn their keep elsewhere

**A stdin-EOF watchdog.** Killing the child on `before-quit` handles the normal path, but an
Electron main crash orphans the node, which then holds the port and the database. The fix: pipe
stdin and have the node shut down gracefully on EOF, which happens automatically when the parent
dies. Portable to Windows, and it makes orphans structurally impossible rather than best-effort.
[GODOT.md](GODOT.md) wants the same thing.

**A per-launch token.** The main process generates a secret, passes it to the node by env and to the
renderer by preload, and the node requires it as a header. This kills three birds:

- It answers the localhost-CSRF hazard *Caveats that apply to desktop mode regardless* already
  flags ("a malicious web page you visit can make requests to `localhost:PORT` … Syncthing shipped
  exactly this bug"). A page in the user's real browser cannot guess the token.
- It is the bearer-auth path every non-browser client wants (see [GODOT.md](GODOT.md)'s inventory).
- Combined with `RINGTOME_TENANCY=single` it finally implements the TODO in `auth/extractor.rs`:
  **the desktop app has no login screen at all**, because possession of the token is the proof. On
  loopback the password floor is already relaxed to one character
  (`config.rs::password_min_len`), which shows this posture was anticipated.

## What Dexie is buying here

Recorded because it came up and the answer is counterintuitive: under Electron, **less than it
looks like, and we keep it anyway.**

*The Browser Is a View: The Live Cache* claims five benefits. In a single-window app talking to a
node zero hops away: reactive views survive (but that is `liveQuery` as a *reactivity* engine, not
storage — one call site, `js/mirror.js`); offline reads are near-worthless (if the node is down the
app is down); instant-boot-from-cache saves node-side snapshot assembly rather than network time;
multi-tab coherence evaporates entirely; and near-zero growth in bespoke read endpoints survives
completely, because it belongs to the stream protocol rather than to Dexie.

So the persistence tier is mostly earning its keep for the *hosted browser* and the *mobile PWA*,
not for this. But Electron removes any pressure to act: Chromium's IndexedDB is what we develop
against, so Dexie stays, unchanged, and the full ledger plus the memory-mirror alternative lives in
[MOBILE.md](MOBILE.md), where it is load-bearing.

## Packaging

- The Rust binary ships in `extraResources` (or `asarUnpack`) — **you cannot exec from inside an
  asar archive.**
- The CI matrix becomes {macOS arm64, macOS x64, Windows x64, Linux x64} × {cargo build,
  electron-builder}. macOS either gets a `lipo` universal binary or two builds.
- Installer size lands around 200MB (Electron ~150MB plus the node binary, which is tens of MB
  stripped — the debug build is 120MB). Normal for the category.
- `just ui-check` and `just ci` remain the gates; nothing about the Electron shell changes them,
  because the UI and the node are unchanged.

## Signing, and the money

This is the line item to plan around, since it is recurring cash rather than effort:

- **macOS:** Apple Developer Program (~$99/yr). Every Mach-O in the bundle must be signed —
  including the Rust binary — with the hardened runtime, then notarized. electron-builder automates
  the mechanics (nested-binary signing plus an `afterSign` notarization hook) once the certificate
  exists.
- **Windows:** a signing story is needed or users hit SmartScreen. Azure Trusted Signing (~$10/mo)
  has become the practical answer versus a several-hundred-a-year OV certificate.
- **Unsigned is not an option for a consumer app**: Gatekeeper blocks on macOS, SmartScreen warns
  on Windows. *Caveats that apply to desktop mode regardless* already states this and notes it is
  an equal cost across every packaging approach — which is true, and it is a cost the
  open-your-browser model was quietly deferring rather than avoiding.

## What doesn't go away

- **The Windows firewall prompt.** `net/p2p.rs` binds the iroh endpoint with no explicit address,
  so it takes ephemeral UDP on all interfaces and Defender asks. A signed binary carrying the app's
  name is less alarming than a bare `ringtome.exe`; the dialog remains.
- **The Chromium release treadmill.** Bundling Chromium means owning its CVEs: we can never stop
  cutting releases. Tooled rather than heroic (electron-updater plus GitHub Releases as a static
  host makes each one a version bump, and the Rust binary rides along in the same package — one
  version number, one update stream), but permanent.
- **Autostart is still the real work of the shell**, exactly as the caveats section says — launchd,
  Task Scheduler, XDG autostart. And it matters more than it looks: see below.

## Autostart is the availability story

Worth stating in this document rather than leaving it in [MOBILE.md](MOBILE.md), because it is what
makes the desktop app strategically important rather than merely nicer.

*Always-on nodes are needed either way* argues that p2p social content needs someone awake to serve
it, and concludes we run server nodes regardless. The escape from that conclusion is not
federation and not asking users to configure servers: **it is that the user's own desktop, running
the app with autostart at login, IS their always-on node.** Not infrastructure anyone sets up — the
app they installed, running while their computer is on. No domain, no TLS, no VPS, no operator
liability for us.

That reframing is what lets the federated half of the design become opt-in rather than required,
and it makes "the status light and the tray icon are trivial; keeping the node running is the real
work" the most consequential sentence in the caveats section.

## Rollout

Stages are ordered by dependency. Each names what it delivers and what it settles, so a reader
picking this up cold can tell where the line is without trusting a status note.

**Stage 1 — the dev shell (settles the one technical unknown).** Main process: pick port, spawn,
poll `/health`, open a window. No signing, no updater, no installer. The deliverable is a running
app on the developer's machine; the *point* is validating the `protocol.handle` + WebSocket
interaction described above, which is the only place this plan might be wrong structurally. About a
day.

**Stage 2 — the node-side changes.** The stdin-EOF watchdog and the launch token, plus
single-tenant no-login built on the token. These are the only Rust changes the whole plan needs,
they are independently useful to every non-browser client, and they close a live TODO and a known
CSRF hazard. Gate: `cargo test -p ringtome-node`, then full `just ci` — the token touches the auth
extractor, which is the HTTP surface.

**Stage 3 — packaging and signing.** electron-builder configuration, `extraResources`, the four-way
CI matrix, certificates, notarization. Mostly bureaucracy rather than code: annoying once, then it
stays done. This is the stage with the recurring cash cost, so it is the decision point for
committing money.

**Stage 4 — autostart and the tray.** Per-OS autostart, tray with status light and quit. Per the
section above, this is where the desktop app starts doing work for the *network* rather than only
for its user.

**Stage 5 — auto-update and a release channel.** electron-updater against GitHub Releases. After
this, the Chromium treadmill is a routine we can actually keep.

**Ongoing after Stage 5:** Electron version bumps as Chromium CVEs land. Not a stage; a standing
obligation, and the reason Stage 5 precedes any public availability.

## Residuals

- The `Origin`-checking question on the WebSocket path, once Stage 1 settles what the browser
  actually sends.
- `mirror/prefs.js` and `mirror/doccache.js` behaviour under a floating port is *fine* with the
  custom scheme, but that is a claim Stage 1 should verify rather than assume.
- The hosted-node browser path keeps every constraint it has today. Electron changes the desktop
  client only; nothing here narrows the reference-client property.
- If [MOBILE.md](MOBILE.md)'s Tauri direction is ever taken, we will be running two shells against
  one UI. That is a maintenance cost to accept knowingly, and the mitigation is the same
  client-agnostic API rule that makes both possible.
