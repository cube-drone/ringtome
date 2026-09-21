# Ringtome for the desktop

One window, one process, the node inside it. [`../DESKTOP.md`](../DESKTOP.md) is the design and the
staging; this is how to run what exists.

```sh
cd ../node && just desktop        # builds the UI bundle, then runs the shell
```

That is the whole of it. There is no frontend build here and no `npm` step: the window opens at the
node's own loopback URL and the node serves the same bundle a browser gets, from one source of
truth (`node/src/ui.rs`).

## What this crate is, and is not

It is **an embedder**. It decides the three things that belong to whoever hosts a node - where the
data lives, which port to ask for, and that a window exists - and then calls
`ringtome_node::bind`. Everything about what a node *is* lives in the library, where `just ci`
tests it, and a cop (`the_binary_assembles_no_node_of_its_own`) keeps the other entry point honest
about the same rule. If this file ever grows an `AppState` or a route, there are two nodes.

It is **its own workspace**, deliberately, following the spike's precedent. Listed as a member of
the root workspace, Tauri and the webview stack would build on every `cargo test` and every
`just ci`, and Linux CI would grow GTK and WebKitGTK dev packages for a crate the gates do not
test. It joins CI at Stage 4, with the packaging matrix.

## The port, and why it is written down

`desktop-port`, beside the node's data. Browser storage is partitioned per ORIGIN, and
`http://127.0.0.1:5281` is not the same origin as `http://127.0.0.1:5282` - so a port that floats
between launches silently drops the mirror, the remembered columns, the open chat. The app picks
once, writes it down, and reuses it; if something else has taken it by the next launch, it picks
again and writes the new one down, and the mirror resnapshots, which is free by design.

This is DESKTOP.md's option **(a)** - same-origin page and API - which is also the arrangement the
spike validated and the one where the live-cache WebSocket needs nothing new.

## Where the data goes

The platform's application-data directory, named by the bundle identifier:
`~/Library/Application Support/net.lassam.ringtome` and its friends. Not the node's own `./data`
default, which is relative to the working directory an app launched from the dock does not have -
and not something a desktop build may move out from under an operator running the `ringtome`
binary. `RINGTOME_DATA_DIRECTORY` still wins when set, which is how you point this at a scratch
node:

```sh
RINGTOME_DATA_DIRECTORY=/tmp/ringtome-desktop RINGTOME_DISCOVERY=off cargo run
```

## Filling it with something to look at

```sh
cd ../node && just desktop-test-data          # 15 personas x 15 actions, as `just test-data` does
cd ../node && just desktop-test-data 3 4      # a smaller one
```

Plain `just test-data` will not find this app, and that is not a bug in either of them: the
generator drives whatever is answering on this checkout's DEV lane, and the desktop node is
deliberately not there - it picks an ephemeral port and writes it down, because a stable origin
matters more than a predictable number. `desktop-test-data` reads `desktop-port` and hands the
generator that. Everything else is the same generator, because it only ever wanted `/health` and
the ordinary API - no test endpoints, so a desktop node is as drivable as a dev one.

`RINGTOME_DATA_DIRECTORY` wins here too, which is how you seed a scratch desktop node rather than
your real one:

```sh
RINGTOME_DATA_DIRECTORY=/tmp/ringtome-desktop just desktop-test-data 3 4
```

One thing Stage 3 will have to answer: the generator registers an account per persona, and
`RINGTOME_TENANCY=single` plus the launch token is a node with no login at all. Whether seeding
then means "point it at a scratch node instead" or "single tenancy still takes registrations" is
not decided here.

## What is not here yet

Stage 2 is dev-only. No signing, no installer, no updater, no tray, no autostart, and no launch
token - so the app still shows the ordinary login screen, because Stage 3 is what removes it. The
environment is left to `RINGTOME_ENVIRONMENT`, which means a plain run is a **dev** node serving
the UI from disk: `just ui-watch` beside it and a reload in the window picks up an edit. A packaged
build will say `prod` and eat the bundle baked into the binary.
