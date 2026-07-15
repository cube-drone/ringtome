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
use iroh::endpoint::{presets, RecvStream, SendStream};
use iroh::{Endpoint, SecretKey};
use ringtome_proto::sync::{SyncMessage, MAX_SYNC_FRAME_BYTES, SYNC_ALPN};

use crate::keystore::Keystore;

const NODE_KEY_NAME: &str = "node_iroh";

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
    mode: &crate::discovery::DiscoveryMode,
) -> Result<Endpoint> {
    let secret = load_or_create_node_key(keystore)?;
    let builder = match mode {
        crate::discovery::DiscoveryMode::Mainline => Endpoint::builder(presets::N0),
        _ => Endpoint::builder(presets::Minimal),
    };
    let endpoint = builder
        .secret_key(secret)
        .alpns(vec![
            SYNC_ALPN.to_vec(),
            crate::files::BLOB_ALPN.to_vec(),
        ])
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
                        if conn.alpn() == crate::files::BLOB_ALPN {
                            if let Err(e) =
                                iroh::protocol::ProtocolHandler::accept(&blobs, conn).await
                            {
                                tracing::warn!(%remote, "blob connection ended with error: {e}");
                            }
                        } else if let Err(e) = crate::sync::serve(conn, state).await {
                            tracing::warn!(%remote, "sync connection ended with error: {e:#}");
                        }
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
