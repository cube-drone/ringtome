# Horse Drawing Tycoon 2 — Desktop Delivery (Tauri, with the Ringtome node embedded)

**The shape: one binary.** Tauri v2 for the window, the node linked in as a library and running on the
same tokio runtime — no child process, no sidecar, no second executable. In-process from the start
rather than as a later optimization, because the sidecar's problems (orphans, port collisions,
readiness races) are all problems it does not have, and because the `lib.rs` split it requires is the
same one [MOBILE.md](MOBILE.md) and [GODOT.md](GODOT.md) need anyway.

Related: [MOBILE.md](MOBILE.md) — which this now **converges with** rather than diverging from, since
Tauri v2 targets iOS and Android — and [GODOT.md](GODOT.md), which wants two of the same node-side
changes.

## What changed

PROJECT_PLAN *used to* reject Tauri on the grounds that "the app is *already* a full HTTP server, so
Tauri's core value (bridging a webview to native Rust) is a bridge we do not need." **That rebuttal
answered the wrong question**, and this section is why canon now reads the other way. Nobody chooses a
webview shell for the IPC bridge. They choose it for being an
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
2. **The cited precedent drifted.** The old section leaned on "the Syncthing / Jupyter / Plex
   model," and *The Client Story* added Ollama as evidence that this is a normal consumer shape. But
   Syncthing is precisely the config-page feel we are complaining about, Plex ships native clients,
   and Ollama shipped a real desktop app. The pattern those projects demonstrate over time is
   "start with a localhost web UI, then build a shell once you care how it feels."
3. **Webview skew — the plan's strongest argument — was tested and did not hold.** It was the one
   thing that could have ruled Tauri out. It didn't.

## Electron and Tauri, compared

Kept as the record of a decision, not as an open question. **The trade in one line: Electron buys
certainty, Tauri buys convergence** — and the certainty turned out to be available on both sides.

| | Electron | Tauri v2 *(chosen)* |
|---|---|---|
| Engine | Bundled Chromium, one version, ours | OS webview: **WebView2 (Chromium) on Windows**, WKWebView on macOS, WebKitGTK on Linux |
| Skew exposure | None | macOS and Linux — **both since tested, both pass** |
| Rust integration | Sidecar only | Sidecar **or** in-process — its backend *is* Rust |
| Rust changes needed | Zero | The `lib.rs` split (in-process) |
| Installer size | ~200MB | ~30–50MB, dominated by our own binary |
| Engine CVE duty | Ours, permanently | The OS's (evergreen WebView2, macOS updates, distro) |
| Stale-engine risk | None | Users on old OSes run engines we cannot patch |
| Mobile | None | iOS and Android |
| Shipped runtimes | Node **and** Rust | Rust only |
| Battle-testedness | A decade at VS Code / Slack / Figma scale | Mature-ish; smaller ecosystem, more undocumented corners |
| Signing cost | Apple plus Windows | Identical |
| Stable origin | A privileged custom scheme | A custom scheme is the default behaviour |

### Three shapes, and why the third one

"Electron vs Tauri" hides the choice that actually matters:

1. **Electron plus sidecar** — a Node main process supervising the `ringtome` binary.
2. **Tauri plus sidecar** — structurally identical, with first-class `externalBin` support. Same
   orphan concern, same readiness poll, zero Rust changes, but one toolchain and a fifth of the
   download.
3. **Tauri plus in-process — chosen.** The node linked in, axum on Tauri's own tokio runtime.
   **Qualitatively different, not merely smaller**: no child process, so nothing to orphan and no
   watchdog to write; no readiness race, because we start the server and know when it is up; the
   launch token never leaves the process; one Mach-O to notarize. Several of the fiddliest items in
   the Electron version of this plan do not exist here rather than being solved.

Shape (3) is also the `lib.rs` split that [MOBILE.md](MOBILE.md) and [GODOT.md](GODOT.md) both need,
so it turns mobile into a port rather than a separate project and retires MOBILE's "two shells against
one UI" residual outright. One shell, three platforms, one toolchain that already has `just` recipes
and `cargo test` around it.

### Where the comparison was narrower than it first looked

Two corrections to the case as originally written here, both in Tauri's favour:

- **Windows under Tauri is Chromium**, since WebView2 is Chromium-based and evergreen. The skew
  exposure was always macOS and Linux, never all three platforms.
- **"We develop against real browsers and that is what ships" splits in half.** Because the node
  serves the UI over HTTP, day-to-day development is identical under either shell — Chrome pointed
  at localhost, the shell involved only at package time. What Tauri costs is the *second* half of
  that sentence: what ships is not what we developed against. That cost is real and it is the main
  thing we are accepting; it is narrower than "Tauri costs us this principle" implied.

### The deciding experiment — run, and it came back yes (2026-08-11)

[`spike-tauri/`](spike-tauri/README.md) was built to answer one question — **does the Dexie mirror
survive WKWebView and WebKitGTK?** — because for *this* codebase "webview skew" has a specific
address: IndexedDB-on-WebKit is the most notorious compatibility surface on the web platform, and
`js/mirror.js` is the whole read path. CodeMirror 6, Preact and WebSocket were never at risk.

**It passes on both.** WKWebView (WebKit 21624.4.5.11.5, macOS 26.6.1) and WebKitGTK 2.52.3 on
Ubuntu 26.04: `liveQuery` fired and reacted on both — the disqualifying row — and the 8MB Blob and
ArrayBuffer round-trips came back byte-identical on both, which was the specific worry. Dexie stays;
the memory-mirror workaround is not needed for desktop.

Video, the half this document originally failed to consider, is also not blocking: neither engine
failed to decode, both have `AudioEncoder`, and Ubuntu reached the *compact* `av1` lane that macOS
cannot. Two caveats live in the spike's README and are not resolved by this decision — **no
end-to-end ingest has been run on either platform** (so "video works" is an inference from a
capability matrix, and video-ingest's own history contains a case where that inference was wrong),
and WebKitGTK's AV1 support is a property of the GStreamer plugins a given install ships rather than
of the engine.

Two predictions in this document were wrong and are corrected rather than dropped: **Linux was
expected to be the dangerous engine and was the best one**, and **the mirror was expected to be the
risk and never was**.

### What choosing Tauri costs us

Stated plainly, because it is the argument that lost and it deserves to stay legible:

**"When something breaks at 11pm, somebody has already hit it and written it down."** That belongs to
Electron by a wide margin and it is the strongest single argument for a one-person project. We are
trading it for a smaller download, one toolchain, no Chromium CVE duty, and a mobile story that comes
for free rather than as a second project. If Tauri's thinner ecosystem costs a week somewhere
unexpected, this paragraph is where that was foreseen.

The other real cost is **stale engines**: a user on an old OS runs a webview we cannot patch, and the
spike's own finding that WebKitGTK's capabilities vary by install is the shape that problem takes. We
degrade per machine rather than requiring a platform, which `pickLane()` already does for video.

## The architecture

One process. The composition root moves out of `src/main.rs` into a `lib.rs` (see *Rollout* Stage 1),
and the Tauri app calls it:

1. **Build the node** — the same `AppState` assembly `main.rs` performs today: config, keystore,
   databases, iroh endpoint, discovery, file store, ingest, then the background loop registry.
2. **Serve axum on a loopback listener** on the same tokio runtime the shell is already using.
3. **Open the window** at the node's own URL.

The node's `ringtome` binary keeps existing — it is what a hosted operator runs, and what
`just start` runs in development — so after the split there are two thin entry points over one
library, rather than one binary and one shell that talks to it.

**The window loads the UI from the node's own HTTP server.** `ui.rs` keeps its job, the bundle stays
baked into the binary, and the hosted-browser path and the desktop path serve byte-identical UI from
one source of truth. PROJECT_PLAN's client-agnostic rule survives intact and there is no second build
pipeline to drift.

### Origin, and the port

The one genuinely open design question, because *Caveats that apply to desktop mode regardless* warns
that a shifting port silently drops per-origin state — and under Tauri there are three ways to answer
it:

- **(a) A persisted fixed port, page and API same-origin.** The node picks a port on first run, writes
  it into the data directory, and reuses it forever; a collision picks a new one and the mirror
  resnapshots, which is free because the mirror is disposable. **Recommended**, for two reasons: it is
  the configuration the spike actually validated (`http` origin mode, both engines), and it keeps the
  node's HTTP surface free of CORS.
- **(b) Tauri's custom scheme for the page, API cross-origin to `127.0.0.1`.** Permanently stable
  origin regardless of port, at the cost of teaching the node CORS — a new security surface on the
  door we are otherwise keeping shut — and the spike has *not* tested `scheme` mode.
- **(c) Serve HTTP through Tauri's scheme handler directly into the axum `Router`**, with no TCP at
  all for ordinary requests. Elegant, and it retires the port question outright, but the WebSocket
  cannot go that way (upgrades do not route through a scheme handler) so a loopback listener comes
  back for the stream alone — and the whole arrangement is unvalidated.

Take (a) now. Record (b) and (c) so that a future port complaint has somewhere to start.

**The WebSocket wrinkle disappears under (a)** and only under (a): page and stream share an origin, so
there is no cross-origin socket and nothing new for the node to check. Under (b) or (c) the
`Origin`-checking question returns.

## Two changes on the node side, both of which earn their keep elsewhere

The Electron version of this plan wanted a third — a stdin-EOF watchdog against orphaned children.
**In-process deletes that requirement**, which is the clearest single illustration of why shape (3)
is worth the split.

**The `lib.rs` split.** `node/Cargo.toml` declares only `[[bin]]`, so the node cannot be linked today.
Concretely: add a `[lib]` beside the existing `[[bin]]`; make `src/lib.rs` the crate root holding the
~40 `mod` declarations, `AppState`, `ActivityMarks`, `ViewEpochs`, the handlers and the router
assembly; and leave `src/main.rs` as ~60 lines — the `inspect` subcommand dispatch and a call into
the library.

Mechanical rather than delicate, and the reason is worth knowing: **inside the library `crate::` still
resolves to the library root**, so all 49 files that use `crate::` paths keep working untouched. The
diff is one new file, one shrunken file, and a Cargo stanza.

The design content is not the file movement. It is that the library must expose **one**
`run(config)`-shaped entry that builds the state, registers the loops and serves, with both the
binary and the shell calling it. If the shell reimplements the assembly, the two drift and `just ci`
begins testing a node the desktop app does not build.

Bonus, independent of any shell: `tests/*.rs` can only `use` a library, never a binary, so today the
composition root is unreachable from integration tests. After the split the boot sequence is
importable — testable rather than merely observable.

**A per-launch token.** The shell generates a secret in memory, hands it to the node directly (no
environment variable, because there is no second process), and injects it into the webview with
Tauri's initialization script — not the query string, so it never lands in a URL that could leak
into history or a log. The node then requires it as a header. Three birds:

- It answers the localhost-CSRF hazard *Caveats that apply to desktop mode regardless* already flags
  ("a malicious web page you visit can make requests to `localhost:PORT` … Syncthing shipped exactly
  this bug"). A page in the user's real browser cannot guess the token. **This matters more under
  option (a) above, not less** — a fixed port is a predictable target, and the token is what makes it
  a useless one.
- It is the bearer-auth path every non-browser client wants (see [GODOT.md](GODOT.md)'s inventory).
- Combined with `RINGTOME_TENANCY=single` it finally implements the TODO in `auth/extractor.rs`:
  **the desktop app has no login screen at all**, because possession of the token is the proof. On
  loopback the password floor is already relaxed to one character (`config.rs::password_min_len`),
  which shows this posture was anticipated.

## What Dexie is buying here

*The Browser Is a View: The Live Cache* claims five benefits. In a single-window app talking to a node
in the same process: reactive views survive (but that is `liveQuery` as a *reactivity* engine, not
storage — one call site, `js/mirror.js`); offline reads are near-worthless (if the node is down the
app is down); instant-boot-from-cache saves node-side snapshot assembly rather than network time;
multi-tab coherence evaporates entirely; and near-zero growth in bespoke read endpoints survives
completely, because it belongs to the stream protocol rather than to Dexie.

So the persistence tier mostly earns its keep for the *hosted browser* and the *mobile PWA*, not for
this. **Dexie stays anyway, and now on evidence rather than convenience**: it was measured working on
both WebKit engines, so there is nothing to fix and no reason to spend the change. The full ledger and
the memory-mirror alternative live in [MOBILE.md](MOBILE.md), where they are still load-bearing.

One engine fact worth carrying: **WebKitGTK 2.52.3 has no StorageManager at all**, so persistence
cannot even be requested there and the mirror is fully evictable. Tolerable by design — the mirror is
disposable and any doubt sends a full snapshot — and one more reason the persistence tier is worth
less than it looks.

## Packaging

- **Nothing to place beside the executable.** No `extraResources`, no asar, no nested binary — the
  node is *in* the binary. This is where the in-process choice pays off most visibly.
- The CI matrix becomes {macOS arm64, macOS x64, Windows x64, Linux x64} × `cargo tauri build`.
  macOS gets a universal binary or two builds.
- Installer size lands around 30–50MB, dominated by our own code rather than by a bundled engine.
- `just ui-check` and `just ci` remain the gates. **Stage 1 is the one that can disturb them**,
  though checked on 2026-08-11 the risk is narrower than first written: `tests/conventions.rs` walks
  `src/` from disk and greps text rather than importing the crate, so `lib.rs` is one more file to
  scan and will hold no SQL and no `.connect(` — it should pass untouched. The real Stage 1 hazard is
  quieter: **`init_tracing` builds its default filter from `env!("CARGO_CRATE_NAME")`**, and tracing
  targets follow the module path, so code living in the library logs under `ringtome_node::*` while a
  filter built in the binary says `ringtome=debug` and matches nothing. No error — just silence. Move
  `init_tracing` into the library.

## Signing, and the money

Unchanged by the shell choice; recurring cash rather than effort:

- **macOS:** Apple Developer Program (~$99/yr), hardened runtime, notarization. Simpler here than
  under Electron — one Mach-O, no nested binaries to sign.
- **Windows:** a signing story or users hit SmartScreen. Azure Trusted Signing (~$10/mo) versus a
  several-hundred-a-year OV certificate.
- **Tauri's updater signs its own manifests** with a keypair we generate and must not lose. A second
  secret to store properly, distinct from the platform certificates.
- **Unsigned is not an option for a consumer app.** *Caveats that apply to desktop mode regardless*
  already says so, and notes it is an equal cost across every packaging approach — true, and a cost
  the open-your-browser model was deferring rather than avoiding.

## What doesn't go away

- **The Windows firewall prompt.** `net/p2p.rs` binds the iroh endpoint with no explicit address, so
  it takes ephemeral UDP on all interfaces and Defender asks. A signed binary carrying the app's name
  is less alarming; the dialog remains.
- **WebView2 is a runtime dependency on Windows.** It ships with Windows 11 and current Windows 10,
  but an older or stripped install needs the bootstrapper, so the installer must detect and fetch it.
  The Fixed Version mode — bundling a pinned WebView2 — would reimport Electron's problem, so prefer
  Evergreen and handle the absent case in the installer.
- **Autostart is still the real work of the shell** — launchd, Task Scheduler, XDG autostart. It
  matters more than it looks: see below.

**What does go away:** the Chromium CVE treadmill. Engine patching becomes the OS's job, and what we
own is Tauri and wry — a far smaller surface. Releases stop being obligatory and become discretionary.

## Autostart is the availability story

Worth stating here rather than in [MOBILE.md](MOBILE.md), because it is what makes the desktop app
strategically important rather than merely nicer.

*Always-on nodes are needed either way* argues that p2p social content needs someone awake to serve
it, and concludes we run server nodes regardless. The escape from that conclusion is not federation
and not asking users to configure servers: **it is that the user's own desktop, running the app with
autostart at login, IS their always-on node.** Not infrastructure anyone sets up — the app they
installed, running while their computer is on. No domain, no TLS, no VPS, no operator liability for
us.

That reframing is what lets the federated half of the design become opt-in rather than required, and
it makes "the status light and the tray icon are trivial; keeping the node running is the real work"
the most consequential sentence in the caveats section.

## Rollout

Stages are ordered by dependency. Each names what it delivers and what it settles, so a reader
picking this up cold can tell where the line is without trusting a status note.

**Stage 1 — the `lib.rs` split. Built 2026-09-21.** Move the composition root out of `src/main.rs`
into a library, leave a thin binary over it, and prove the two entry points build the same node. The
foundational stage: mobile and any Godot client need it too, so it is never throwaway. **This is the
stage that can break the gates** — it touches the composition root and the architecture cop reasons
by file path. Gate: full `just ci`, not a subset.

*What landed:* `[lib] name = "ringtome_node"` beside the existing `[[bin]]`; `src/lib.rs` holds the
module tree, `AppState`, `ActivityMarks`, `ViewEpochs`, the four root handlers, the router assembly
and `init_tracing`; `src/main.rs` is 29 lines — the `inspect` subcommand, `Config::from_env`, the
subscriber, and a call into `run(config)`. The predicted hazards behaved as predicted: `crate::`
paths resolve to the library root, so no module changed; the conventions cop reads `src/` from disk
and passed untouched; `init_tracing` moved into the library, where `env!("CARGO_CRATE_NAME")`
expands to the crate that actually logs. Two things the plan did not foresee, both small: the module
tree had to go `pub` (`AppState`'s public fields name types from a dozen modules, and every item in
this crate was written as a binary's innards where `pub` meant nothing), and the strings catalogue
groups by source file, so the one `msg!` that moved was re-keyed `lib.*`. "The two entry points build
the same node" is now a cop rather than a promise: `the_binary_assembles_no_node_of_its_own` fails if
`main.rs` grows an `AppState`, a `Router`, a route or a listener, because a second assembly is one
the shell would never run.

**Stage 2 — the shell, in-process, dev only. Built 2026-09-21.** Tauri window, node built and served
on a loopback listener, page loaded from it. No signing, no updater, no installer. Deliverable: a
running app on the developer's machine. Settles option (a) above in practice — including that the
live-cache WebSocket is same-origin and needs nothing new.

*What landed:* [`desktop/`](desktop/README.md) — its own workspace, by the spike's precedent, so the
gates never build Tauri; `just desktop` builds the UI bundle and runs it. The shell decides three
things and no more: the data directory (the platform's app-data dir, `RINGTOME_DATA_DIRECTORY` still
winning), the port, and that a window exists. Everything else is `ringtome_node::bind`.

Two things the stage taught, both about the *order* of a boot. The library now **binds its listener
before it assembles anything** — the loops are registered with clones of the state as it is built, so
a bind that failed after that would leave a half-dead node's background tasks running inside the
caller's process; the binary never noticed, because a failed bind exits it. And `init_tracing` grew
`init_tracing_with(config, also)`, because the Stage 1 hazard has a floor above it: the default
filter is built from the *library's* crate name, so the shell's own lines went to nobody, and the
first smoke run lost its "the remembered port is taken" warning that way.

Option (a) is settled by running it rather than by argument: a launch picks a free port, writes
`desktop-port` beside the node's data, and the next launch comes up on the same origin. A port taken
since last launch costs one warning, one new port written down, and **one** assembly.

**Stage 3 — the token and no-login. Built 2026-09-21.** Per-launch secret, initialization-script
injection, header requirement on the node, single-tenant auto-session on top of it. Closes a live
TODO and a known CSRF hazard, and is independently useful to every non-browser client. Gate:
`cargo test -p ringtome-node` then full `just ci` — the token touches the auth extractor, which is
the HTTP surface.

*The justification, restated more honestly than this document first had it (Curtis, 2026-09-21):*
the Tauri webview has its own cookie jar, so for a desktop-only user a page in their browser has no
session to borrow and the CSRF vectors do not fire. The token is not mainly a patch for a live hole
— it is **the precondition for removing the login screen safely.** Auto-minting a cookie instead
would hand a session to anything that reaches loopback, including another OS account on a family
computer, which is strictly worse than today. A header can only be set by code that can set one.

*What landed:* `Config::launch_token`, set by the embedder (and by `RINGTOME_LAUNCH_TOKEN` in
local-test mode only, where there is no shell to mint one). Under `Tenancy::Single` a matching token
IS the session: `auth::local_account` returns this machine's one account, minting it on first ask
with a random password nobody is ever told, and the person at the machine is its `node_admin`. The
comparison is constant-time. The shell mints the secret with `auth::mint_launch_token`, sets it on
the config, and injects it with `initialization_script` — not the query string, because a URL lands
in history, in a log and in a screenshot.

*Two spellings, because a browser cannot set a header on everything it does.* Ordinary calls carry
`Authorization: Bearer`; the live-cache WebSocket, whose constructor has no header argument, carries
the token as the `ringtome.token.<secret>` subprotocol, which the stream door echoes — a server that
does not echo makes the browser fail the connection. Both are set by code in the shell's own window,
and neither can be attached by a navigation, which is the point.

*And the belt, which protects the browser-based dev path the token cannot:* a request whose
`Sec-Fetch-Site` says `cross-site` is **anonymous**, whatever cookie rode along. That is the exact
shape `SameSite=Lax` still permits — a page navigating itself at a GET door with a side effect, of
which this node has two (a foreign profile fetch dials the endpoints its query names; entering a
room joins it). `Origin` would not have caught it, since browsers do not send `Origin` on GET
navigations. Unauthorized rather than Forbidden, so the public `/id/` surfaces still answer a
stranger from another site anonymously, which is what they are.

*Proved:* unit claims for the one-account rule and the constant-time compare; an integration claim
that a cookie labelled cross-site is nobody while the public doors stay open to it; and a run of the
app itself — the first request it made minted the account and there was no login screen, while
`curl` with no key and `curl` with the wrong key both got 401 and the public door still answered.
The rig cannot cover the token path itself: it needs single tenancy, and the rig's nodes are
multi-tenant by design.

**Stage 4 — packaging and signing.** `cargo tauri build`, the four-way CI matrix, certificates,
notarization, the updater keypair. Mostly bureaucracy: annoying once, then done. The stage with the
recurring cash cost, so it is the decision point for committing money.

*How a release is cut (settled 2026-09-22).* **A tag, made by hand, by `just release-*`.** Not a
push to main - a release is a full optimized build of four targets, signed, notarized, and handed to
every installed copy as a whole new application, which is far more than any commit should set off.
Not a release branch either: that is machinery for maintaining several lines at once, and there is
one. `just release` is the minor bump, with `release-major`, `release-micro` and `release-dry`
beside it; the recipe bumps all five files that spell the version, writes the notes from the commit
subjects since the last tag ("initial", the first time), commits, tags and pushes, and asks before
it does any of it.

**Every release has a name as well as a number** - `0.1.0-swear-slick` - drawn from the same pinned
wordlist as speakable addresses and test-data personas, so the system sounds like one thing. The
name is DERIVED from the number rather than stored, so it is the same on every machine forever; and
the number itself stays strict semver everywhere a toolchain reads it, because `0.1.0-swear-slick`
is a semver *prerelease* that sorts before `0.1.0`, and because macOS wants at most three integers
in `CFBundleShortVersionString`. The name rides in the tag, the title and the notes.
`every_file_that_spells_the_version_agrees` is the cop that keeps the five files in step - it caught
`node/js/package.json` sitting at 1.0.0 within a minute of being written.

*The pipeline (built 2026-09-22).* `.github/workflows/release.yml`: a `v*` tag builds macOS
(universal), Linux (on 22.04, so the AppImage runs on more than the newest glibc) and Windows,
signs and notarizes the Mac with the `deploy` environment's secrets, and publishes a GitHub Release
carrying the installers, the updater artifacts and `latest.json` - **all or nothing** (2026-09-25):
the builds only stash their artifacts, and one last `publish` job, which runs only when every other
job succeeded, checks the set is whole (`node/tools/release-assemble.mjs`), writes `latest.json`,
and turns a draft into the release. A failed platform ships nothing, anywhere; "Re-run failed jobs"
finishes it. `workflow_dispatch` does the same build and publishes nothing, for when the packaging
itself is what changed. It degrades rather than
fails when a secret is missing (Windows signing landed by OIDC on 2026-09-23, SIGNING.md §2), and a half-signed
release beats a red run. Bundling is on, the updater's public key and the `releases/latest/download`
endpoint are in `tauri.conf.json`, and a packaged build runs as a PROD node - decided by the build
profile rather than by a preference, since a dev node serves the UI from an absolute path that
exists only on the machine that compiled it.

*Split in two (2026-09-22), because the halves have different clocks.* The paperwork — Apple's $99/yr
program and Azure Artifact Signing at ~$10/mo — involves identity verification that takes days to
weeks of real-world waiting, and it is Curtis's to do: [SIGNING.md](SIGNING.md) is the running order,
the eligibility traps (Azure's individual validation is US/Canada only and reads its identity from
the billing account) and where each secret lands. Everything else proceeds unsigned in the meantime -
bundle configuration, icons, a launchable `.dmg`, the four-target CI matrix and the updater end to
end - because signing is environment variables bolted onto a pipeline that already exists, not a
different pipeline.

*The Windows money, examined (2026-09-22).* Cheaper paths than a commercial certificate exist and
were checked rather than assumed: SignPath Foundation is free for open-source projects, Certum's
open-source certificate is €69 but ships a physical crypto card that CI cannot use and was out of
stock, the Microsoft Store signs for a one-time $19 but does not take a Tauri bundle without an MSIX
step and would own updates. Azure is the cheapest thing that signs from CI without hardware. The
detail that decides how much any of it is worth: an OV certificate - which is all of these - earns
SmartScreen's trust over downloads rather than arriving with it, so only EV (hardware, several
hundred a year) silences the warning from the first install, and that is not what we are buying.

**Stage 5 — autostart and the tray.** Per-OS autostart, tray with status light and quit. Per the
section above, this is where the desktop app starts doing work for the *network* rather than only for
its user.

*Built 2026-09-24, `desktop/src/tray.rs`.* Close hides the window and the node runs on; the tray's
Quit is the one act that stops it. Start at login is on by default - enabled once, on a packaged
build's first launch, through the platform's own mechanism (a Launch Agent, a Run key, an XDG
autostart entry), and the tray's toggle owns it from then on; a login launch starts hidden, and on
macOS a hidden Horse Drawing Tycoon 2 leaves the dock. A second launch focuses the running window instead of
building a second node against the same data directory. The tray's status line is the version and
the node's address for now; a real status light (peers, syncing) is a later refinement. Stage 6 is
amended to match: a node that is never quit would never update, so a pending update installs and
restarts on its own once the window has been hidden fifteen minutes. On Linux the tray is a
runtime library (libayatana-appindicator, `dlopen`ed by the tray crate) plus a panel that renders
StatusNotifierItems: the `.deb` declares the library as a dependency, the AppImage cannot carry it,
and a machine without it gets no tray - in which case close quits rather than hides, and a hidden
launch shows itself, because a hidden window with no way back is a node nobody can reach. Stock
GNOME additionally needs the AppIndicator extension to render any tray at all.

*Notifications (2026-09-25, `desktop/src/alerts.rs` over `node/src/attention.rs`).* Whenever a
badge in the app would light, the OS says so - unless the window is visible and focused, where
the badge itself is the notice. The node decides and words every alert from exactly the rows the
two dock badges count (the bell's list, the chat badge's rooms), announcing each unseen item once
and never the backlog present at launch; the shell only decides whether anyone needs telling.
Clicking one lands in the room or the bell it is about: the shell calls `notify-rust` directly
(the Tauri plugin's desktop `show()` discarded the handle that reports the click, on every
platform), brings the window forward, and hands the alert's route to the UI's router through the
page history - no reload.

**Stage 6 — auto-update and a release channel.** Tauri's updater against a static host. No longer
load-bearing for security the way electron-updater would have been, which is a reason it comes last
rather than a reason to skip it.

*Built 2026-09-23, `desktop/src/update.rs`.* A packaged build checks `latest.json` on the newest
GitHub Release thirty seconds after launch and every ten minutes after (a cadence for a product
changing daily; raise it when releases slow), downloads a newer release in
the background (the plugin verifies the minisign signature before handing over the bytes), and
installs it as the app exits - update-on-quit, per the consequences below - with one dialog per
version offering "restart now". Driven from Rust, so the webview gets no capability. A dev build never
checks: it has no bundle to replace. The residual is the `.deb` on Linux, which the updater cannot
touch; the AppImage is the Linux artifact that self-updates.

*How it interacts with signing, since the two are easy to conflate (Curtis, 2026-09-22).* On macOS
an update is a **whole-bundle replacement**: the artifact is a `.app.tar.gz`, there are no binary
deltas, and the `.dmg` is for first installs only. The running app verifies the archive's **minisign**
signature - our updater key, against the public half baked into the running binary - before it
unpacks anything, then swaps the `.app` and relaunches. Apple's signature and notarization do a
different job: they are what the SYSTEM checks afterwards, at every launch of the replaced bundle.

Both are load-bearing and neither substitutes for the other. Two consequences to carry:

- **The signing identity must stay consistent across releases.** macOS keys keychain ACLs, TCC grants
  and the incoming-connection firewall approval to the bundle id *and* the signature; an update
  signed by a different Team ID can read as a different app, and permissions reset. This node binds a
  UDP socket, so that firewall grant is not one to make people give twice.
- **Every update is the whole app to every user** - tens of megabytes each, every version - and it
  **restarts the node**, which after Stage 5 is somebody's always-on presence on the network. Both
  argue for deliberate releases and for update-on-quit as the default rather than update-now.

## Multi-user mode (2026-09-25)

The app's owner is its `node_admin`, so they see a **Device** app (the same app a server's
administrator sees as **Server**, `node/js/apps/device.js`). Its Registration page carries the switch
Curtis asked for: *let other people have accounts on this computer*. Turning it on:

- gives the owner's account - `me`, with a random password nobody was told (Stage 3) - a sign-in name
  and a password they choose, at the network's 8-character floor, so they can sign in from another
  device's browser too;
- sets who else may sign up (a shared sign-up password, or open); a device's default is `closed`;
- asks the shell to **listen on the local network** from the next start and restarts the app
  (`node/src/shell.rs` asks, `desktop/src/requests.rs` does it). The choice is the `desktop-network`
  file beside `desktop-port`, because the bind is decided before the node exists. The window itself
  stays on `127.0.0.1`: its URL is its origin, and the mirror lives in that origin.

Turning it off closes sign-ups and goes back to this computer only; the accounts made meanwhile stay,
reachable from this computer's browser. The Device app's Backups page shows an archive in the file
manager instead of downloading it - it is already on this disk.

*The honest cost:* another device reaches this app over **plain HTTP** on the LAN. Passwords cross the
network unencrypted, and a browser treats `http://192.168.x.x` as an insecure context, so the web
client there loses what needs one (notifications, the service worker). The switch says "at home, not
on a café's wifi"; HTTPS on a LAN is its own project.

*Proved:* `device.cjs` starts a single-tenant node the way the app runs one and drives the switch:
refused switches change nothing, the owner signs in by their new name, the policy holds at the
signup door, and the node asks its shell for exactly the right thing. *Not proved:* the shell's half -
writing the file, restarting, and binding `0.0.0.0` - which only a run of the real app shows.

## Residuals

- **The spike's two open items**, which this decision does not close: no end-to-end video ingest run
  on any engine, and the reload/persistence check unrun on both. Neither blocks the shell; the first
  should be closed before video upload ships.
- **Options (b) and (c)** in *Origin, and the port* are recorded but untested. If a port complaint
  ever arrives, start there.
- The hosted-node browser path keeps every constraint it has today. This changes the desktop client
  only; nothing here narrows the reference-client property.
- **Canon is amended** (2026-08-11): PROJECT_PLAN now reads *Desktop mode: Tauri, with the node
  embedded*, and the two consequential bullets in *The Client Story* and the preamble to *Caveats that
  apply to desktop mode regardless* were brought along with it. Two sections still predate this
  decision and want revisiting on their own terms: ***Phones: deferred, by design*** (whose
  no-sidecar-on-iOS premise [MOBILE.md](MOBILE.md) corrects, and whose cost estimate this decision
  materially lowers) and ***Always-on nodes are needed either way*** (against the autostart argument
  above).
