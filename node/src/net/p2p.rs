//! Iroh networking: the node's p2p endpoint and sync-frame IO.
//!
//! Every node owns one iroh endpoint under a persistent **node key** - the node's transport
//! identity, deliberately a different animal from any identity key (the protocol never treats a
//! signature from one as valid in the other's role; see PROJECT_PLAN, Signature domains).
//!
//! v1 runs `presets::Minimal`: no relays, no discovery, no external infrastructure. Peers are
//! reached by explicit addresses carried in the add-a-node codes. `presets::N0` (relays + pkarr
//! publishing) is the flagged upgrade path for when there is a public network to join.

use anyhow::{anyhow, Context, Result};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use ringtome_proto::sync::{SyncMessage, MAX_SYNC_FRAME_BYTES, SYNC_ALPN};

use crate::keystore::Keystore;

const NODE_KEY_NAME: &str = "node_iroh";

/// Every ALPN this node speaks, each with the short house name the test gate refuses it by
/// (`/test/unplug`). **One table, deliberately**: `build_endpoint` advertises exactly these and
/// [`Unplugged`] gates exactly these, and two lists of ALPNs would drift the day a sixth protocol
/// lands - leaving a gate that silently no longer covers the whole surface it claims to.
///
/// The names are spelled out rather than derived from the wire strings: the wire string is a
/// format (frozen on ship day), the short name is a test API, and they should be free to differ.
pub const ALPNS: [(&str, &[u8]); 5] = [
    ("sync", SYNC_ALPN),
    ("blob", crate::files::BLOB_ALPN),
    ("adopt", crate::net::adopt::ADOPT_ALPN),
    ("deliver", ringtome_proto::deliver::DELIVER_ALPN),
    ("fragment", ringtome_proto::fragment::FRAGMENT_ALPN),
];

/// The short house name for a wire ALPN; `None` for an ALPN this node does not speak (which the
/// endpoint cannot negotiate, since it advertises [`ALPNS`] and nothing else).
pub fn alpn_name(alpn: &[u8]) -> Option<&'static str> {
    ALPNS
        .iter()
        .find(|(_, wire)| *wire == alpn)
        .map(|(name, _)| *name)
}

/// Resolve a caller's spelling to the table's OWN `&'static str`, or `None` if this node speaks no
/// such protocol. Two jobs in one lookup: it turns a `/test/unplug` typo into a 400 rather than a
/// gate that quietly refuses nothing, and it means [`Refusals`] can only ever hold names that are
/// in [`ALPNS`] - there is no way to spell a refusal the accept loop will not recognise.
pub fn alpn_named(name: &str) -> Option<&'static str> {
    ALPNS
        .iter()
        .find(|(house, _)| *house == name)
        .map(|(house, _)| *house)
}

/// The test-only transport gate: which ALPNs this node is refusing right now, in which direction.
/// A cheaply-cloneable handle onto one shared truth (`AppState::unplugged`, and a clone held by
/// [`crate::files::FileStore`] so its own dials obey the same switch).
///
/// **Why it exists.** The integration suite needs to simulate a partition, and the shared four-node
/// rig cannot have nodes killed mid-run without breaking every other spec (NEXT_STEPS: the
/// rebroadcast node-death test). Unplugging is also the *sharper* instrument for most of those
/// tests - "this reader needed nobody" is a stronger claim than "the other processes had exited",
/// and it leaves the unplugged node's HTTP surface up so a test can still interrogate it.
///
/// **Why it is safe.** Two locks, because a node that silently stops talking to its peers while
/// `/health` stays green is about the worst thing this codebase could ship by accident:
///   1. the only caller that can arm it is `/test/unplug`, a route not *mounted* unless
///      `RINGTOME_LOCAL_TEST` is set (see [`crate::test_endpoints`]);
///   2. [`Unplugged::arm`] itself refuses in any other mode, so a future caller reaching for it
///      outside local test gets nothing.
///
/// A default-constructed handle refuses nothing, which is every real node's state forever.
///
/// **What it does not do.** It gates the *transport*, not the directory: an unplugged node still
/// resolves serving records and still knows where its peers live. A test that needs a node to
/// *forget* its peers wants different scissors. It also does not gate HTTP - `/health`, the API and
/// the SQL passthrough all keep answering, which is the point.
///
/// **The failure mode is a fast refusal, not silence.** Inbound, the connection is closed right
/// after the handshake; outbound, the dial never happens. A real partition usually looks like a
/// *timeout*, and iroh does offer the higher-fidelity door for that (`Incoming::ignore`, which
/// answers no packet at all) - but it can only be used before the handshake, i.e. before the ALPN
/// is known, so it cannot do per-ALPN work; and every test using it would pay a dial timeout in
/// wall-clock. Deterministic and fast beats realistic and slow here. If a code path ever needs the
/// timeout shape specifically, `Incoming::ignore` is the door, and it wants its own mode rather
/// than a change to this one.
#[derive(Clone, Default)]
pub struct Unplugged(std::sync::Arc<std::sync::Mutex<Refusals>>);

/// House ALPN names, by direction. Empty sets - the default - mean "plugged in".
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Refusals {
    pub inbound: std::collections::BTreeSet<&'static str>,
    pub outbound: std::collections::BTreeSet<&'static str>,
}

impl Unplugged {
    /// Replace the whole refusal set. **The call is the entire state** - nothing is merged with what
    /// a previous call left behind - so a test never has to reason backwards about what darkened a
    /// node. Passing an empty [`Refusals`] plugs the node back in.
    ///
    /// Refuses outside local-test mode; see the type doc for why that second lock is here at all.
    pub fn arm(&self, config: &crate::config::Config, refusals: Refusals) -> Result<()> {
        if !config.local_test {
            return Err(anyhow!(
                "the transport gate is a local-test affordance; this node is not in local-test mode"
            ));
        }
        *self.0.lock().expect("unplug gate poisoned") = refusals;
        Ok(())
    }

    /// What is refused right now, for `/test/unplug`'s answer and for diagnosing a rig that a dead
    /// spec left unplugged.
    pub fn refusals(&self) -> Refusals {
        self.0.lock().expect("unplug gate poisoned").clone()
    }

    /// Refuse an inbound connection on this ALPN? Called once per accepted connection.
    pub fn refuses_inbound(&self, alpn: &[u8]) -> bool {
        match alpn_name(alpn) {
            Some(name) => self
                .0
                .lock()
                .expect("unplug gate poisoned")
                .inbound
                .contains(name),
            None => false,
        }
    }

    /// Refuse to dial on this ALPN? Called once per outbound connection, from [`dial`].
    pub fn refuses_outbound(&self, alpn: &[u8]) -> bool {
        match alpn_name(alpn) {
            Some(name) => self
                .0
                .lock()
                .expect("unplug gate poisoned")
                .outbound
                .contains(name),
            None => false,
        }
    }
}

/// **Every outbound connection in the node goes through here**, which is what makes the test gate
/// total rather than approximate: five protocol callers plus the blob store's two. A dial that
/// bypassed this would leave `/test/unplug` quietly half-true, so
/// `node/tests/conventions.rs::every_outbound_dial_goes_through_the_gate` fails the build if
/// `endpoint.connect` is called anywhere else.
///
/// The error is deliberately plain-worded: it lands in a test's log when the gate is the reason
/// nothing happened, and "unplugged" beats a QUIC timeout for saying so.
pub async fn dial(
    unplugged: &Unplugged,
    endpoint: &Endpoint,
    addr: EndpointAddr,
    alpn: &'static [u8],
) -> Result<Connection> {
    if unplugged.refuses_outbound(alpn) {
        return Err(anyhow!(
            "unplugged: this node is refusing to dial on the {} protocol",
            alpn_name(alpn).unwrap_or("unknown")
        ));
    }
    let connect = endpoint.connect(addr, alpn);
    match dial_ceiling() {
        Some(limit) => match tokio::time::timeout(limit, connect).await {
            Ok(conn) => conn.map_err(|e| anyhow!("{e}")),
            Err(_) => Err(anyhow!(
                "dial timed out at the test ceiling ({}ms) on the {} protocol",
                limit.as_millis(),
                alpn_name(alpn).unwrap_or("unknown")
            )),
        },
        None => connect.await.map_err(|e| anyhow!("{e}")),
    }
}

/// Test-mode ceiling on CONNECT alone, exchange ceilings untouched. On a test rig the other
/// side of a dial is either on this machine (answers in ms) or not going to answer at all -
/// and QUIC is UDP, so "not going to answer" is silence, not refusal: a killed node or a
/// stale endpoint id waits out the full handshake ladder even on loopback (the 2026-08-21
/// garbage-dial physics). Production keeps its patience: unset means no ceiling, and only the
/// test recipes set it. The whole-exchange timeouts at the call sites stay as they are
/// because a same-machine peer can still be CPU-starved into finishing slowly (five rig nodes
/// on four CI vCPUs) - there-or-not applies to connecting, not to completing.
/// Env read once (the `files::recent_grace` idiom, hoisted to a static because this is on
/// every dial's path).
fn dial_ceiling() -> Option<std::time::Duration> {
    static CEILING: std::sync::OnceLock<Option<std::time::Duration>> = std::sync::OnceLock::new();
    *CEILING.get_or_init(|| {
        std::env::var("RINGTOME_TEST_DIAL_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
    })
}

/// Load (or first-boot-generate) the node's iroh secret key, sealed at rest like every other
/// key. A key file that exists but fails to open is a hard error - silently regenerating would
/// silently change the node's network identity.
fn load_or_create_node_key(keystore: &Keystore) -> Result<SecretKey> {
    if keystore.contains(NODE_KEY_NAME) {
        let bytes = keystore
            .load_key(NODE_KEY_NAME, NODE_KEY_NAME.as_bytes())
            .context("opening node key")?;
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("node key has wrong length"))?;
        Ok(SecretKey::from_bytes(&arr))
    } else {
        let secret = SecretKey::generate();
        keystore
            .store(NODE_KEY_NAME, &secret.to_bytes(), NODE_KEY_NAME.as_bytes())
            .context("sealing node key")?;
        tracing::info!(endpoint_id = %secret.public(), "generated new iroh node key");
        Ok(secret)
    }
}

/// Bind the node's iroh endpoint with the sync ALPN. The discovery mode picks the preset:
/// mainline gets `N0` (relays + iroh's own pkarr/DNS discovery, so dial-by-id works globally);
/// everything else gets `Minimal` (no external infrastructure; addresses come from our own
/// directory or from adoption codes).
pub async fn build_endpoint(
    keystore: &Keystore,
    mode: &crate::net::discovery::DiscoveryMode,
) -> Result<Endpoint> {
    let secret = load_or_create_node_key(keystore)?;
    let builder = match mode {
        crate::net::discovery::DiscoveryMode::Mainline => Endpoint::builder(presets::N0),
        _ => Endpoint::builder(presets::Minimal),
    };
    // Transport limits set by us, not left to the library (PEEK.md ruling 14): a connection
    // that goes quiet is gone in thirty seconds, a keep-alive keeps a long validate from
    // reading as quiet, and one connection may not fan out into unbounded streams.
    let transport = iroh::endpoint::QuicTransportConfig::builder()
        .max_idle_timeout(Some(
            std::time::Duration::from_secs(30)
                .try_into()
                .map_err(|e| anyhow!("idle timeout: {e}"))?,
        ))
        .keep_alive_interval(std::time::Duration::from_secs(10))
        .max_concurrent_bidi_streams(iroh::endpoint::VarInt::from(16u32))
        .build();
    let endpoint = builder
        .secret_key(secret)
        .transport_config(transport)
        .alpns(ALPNS.iter().map(|(_, wire)| wire.to_vec()).collect())
        .bind()
        .await
        .map_err(|e| anyhow!("binding iroh endpoint: {e}"))?;
    tracing::info!(
        endpoint_id = %endpoint.id(),
        sockets = ?endpoint.bound_sockets(),
        "iroh endpoint online"
    );
    Ok(endpoint)
}

/// Connectable addresses for this endpoint: discovered direct addresses, plus bound sockets
/// with unspecified IPs rewritten to loopback (good enough for same-host use; real discovery
/// supersedes this).
pub fn addr_strings(endpoint: &Endpoint) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for ta in &endpoint.addr().addrs {
        if let iroh::TransportAddr::Ip(sock) = ta {
            out.push(sock.to_string());
        }
    }
    for mut sock in endpoint.bound_sockets() {
        if sock.ip().is_unspecified() {
            sock.set_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        }
        let s = sock.to_string();
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// Accept loop: one task per incoming connection, routed by negotiated ALPN - the blob ALPN goes
/// to iroh-blobs' handler, everything else (i.e. the sync ALPN, the only other one we advertise)
/// to the sync engine's serve path.
pub fn spawn_accept_loop(endpoint: Endpoint, state: crate::AppState) {
    // One blobs handler for the endpoint's lifetime, cloned cheaply into each connection task.
    let blobs = state.files.protocol();
    tokio::spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            let state = state.clone();
            let blobs = blobs.clone();
            tokio::spawn(async move {
                match incoming.await {
                    Ok(conn) => {
                        let remote = conn.remote_id();
                        // Admission (PEEK.md ruling 14), before any dispatch so it covers every
                        // ALPN: over a ceiling the connection is closed now, never parked. The
                        // blob ALPN is proven at birth - hash-capability over public bytes; the
                        // rest start unproven and the sync serve promotes its own once the
                        // consent gate passes. The permit lives as long as the task.
                        let Some(mut permit) = state
                            .admission
                            .try_admit(*remote.as_bytes(), conn.alpn() == crate::files::BLOB_ALPN)
                        else {
                            tracing::info!(
                                %remote,
                                alpn = alpn_name(conn.alpn()).unwrap_or("unknown"),
                                "admission: refusing an inbound connection at the ceiling"
                            );
                            conn.close(1u8.into(), b"busy");
                            return;
                        };
                        // The inbound half of the test gate, before any dispatch, so it covers
                        // every ALPN by construction rather than per handler (see `Unplugged`).
                        if state.unplugged.refuses_inbound(conn.alpn()) {
                            tracing::info!(
                                %remote,
                                alpn = alpn_name(conn.alpn()).unwrap_or("unknown"),
                                "unplugged: refusing an inbound connection"
                            );
                            conn.close(0u32.into(), b"unplugged");
                            return;
                        }
                        if conn.alpn() == crate::files::BLOB_ALPN {
                            if let Err(e) =
                                iroh::protocol::ProtocolHandler::accept(&blobs, conn).await
                            {
                                tracing::warn!(%remote, "blob connection ended with error: {e}");
                            }
                        } else if conn.alpn() == crate::net::adopt::ADOPT_ALPN {
                            if let Err(e) = crate::net::adopt::serve(conn, state).await {
                                tracing::warn!(%remote, "adopt connection ended with error: {e:#}");
                            }
                        } else if conn.alpn() == ringtome_proto::deliver::DELIVER_ALPN {
                            if let Err(e) = crate::net::deliver::serve(conn, state).await {
                                tracing::warn!(%remote, "delivery connection ended with error: {e:#}");
                            }
                        } else if conn.alpn() == ringtome_proto::fragment::FRAGMENT_ALPN {
                            if let Err(e) = crate::net::fragment::serve(conn, state).await {
                                tracing::warn!(%remote, "fragment connection ended with error: {e:#}");
                            }
                        } else if let Err(e) = crate::net::sync::serve(conn, state, &mut permit).await {
                            tracing::warn!(%remote, "sync connection ended with error: {e:#}");
                        }
                        drop(permit);
                    }
                    Err(e) => tracing::warn!("incoming connection failed: {e}"),
                }
            });
        }
        tracing::info!("iroh accept loop stopped (endpoint closed)");
    });
}

// ---------------------------------------------------------------------------------------------
// Frame IO: 4-byte big-endian length prefix + canonical CBOR message body.

pub async fn write_frame(send: &mut SendStream, msg: &SyncMessage) -> Result<()> {
    let body = msg
        .encode()
        .map_err(|e| anyhow!("encoding sync frame: {e}"))?;
    let len = u32::try_from(body.len()).map_err(|_| anyhow!("frame too large"))?;
    send.write_all(&len.to_be_bytes())
        .await
        .context("writing frame length")?;
    send.write_all(&body).await.context("writing frame body")?;
    Ok(())
}

/// Read one frame; `Ok(None)` on a clean end-of-stream at a frame boundary.
pub async fn read_frame(recv: &mut RecvStream) -> Result<Option<SyncMessage>> {
    let mut len_bytes = [0u8; 4];
    match recv.read_exact(&mut len_bytes).await {
        Ok(()) => {}
        // The peer finishing the stream before/at a length prefix is the normal end.
        Err(_) => return Ok(None),
    }
    let len = u32::from_be_bytes(len_bytes) as usize;
    if len > MAX_SYNC_FRAME_BYTES {
        return Err(anyhow!("sync frame of {len} bytes exceeds limit"));
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .context("reading frame body")?;
    let msg = SyncMessage::decode(&body).map_err(|e| anyhow!("undecodable sync frame: {e}"))?;
    Ok(Some(msg))
}
