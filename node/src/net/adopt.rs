//! One-trip adoption: grant delivery over its own ALPN.
//!
//! The ceremony's request code still travels by human courier (new computer → granting
//! computer), but the return leg goes over the wire: after authorizing, the granter dials the
//! requester (the request code carries its endpoint id and address hints) and hands the grant
//! code straight to the pending node, which completes on the spot. The channel is what makes
//! this safe without any bearer secret: iroh's connection is cryptographically pinned to the
//! exact endpoint the request code named, so the grant cannot be delivered to an impostor -
//! and the accept side only acts on grants whose leaf matches a *pending adoption it minted
//! itself* (a 32-byte unguessable), so strangers can't push personas onto a node unasked.
//!
//! Delivery is BEST-EFFORT, the code is the fallback: if the requester is unreachable
//! (asleep, NATed beyond the hints, gone), the granter simply shows the grant code and the
//! human carries it back - the offline ceremony survives as the rare path instead of the only
//! path. Wire format matches the codes themselves: these are node-level JSON artifacts
//! (versioned by their `v` field), one level above the entry conformance boundary - length-
//! prefixed JSON frames, deliberately NOT proto sync messages.

use anyhow::{anyhow, Context, Result};
use iroh::endpoint::{Connection, RecvStream, SendStream};

use crate::identity::adoption::{complete_delivered, GrantCode};
use crate::AppState;

pub const ADOPT_ALPN: &[u8] = b"ringtome/adopt/0";

/// A grant code is ~1 KiB of JSON; anything near this limit is not a grant code.
const MAX_ADOPT_FRAME: usize = 64 * 1024;

/// The requester's answer: did the grant land and complete? `message` is human-facing either
/// way ("moved in" / why not).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DeliveryAck {
    pub ok: bool,
    pub message: String,
}

async fn write_json<T: serde::Serialize>(send: &mut SendStream, value: &T) -> Result<()> {
    let body = serde_json::to_vec(value).context("encoding adopt frame")?;
    let len = u32::try_from(body.len()).map_err(|_| anyhow!("adopt frame too large"))?;
    send.write_all(&len.to_be_bytes()).await?;
    send.write_all(&body).await?;
    Ok(())
}

async fn read_json<T: serde::de::DeserializeOwned>(recv: &mut RecvStream) -> Result<T> {
    let mut len_bytes = [0u8; 4];
    recv.read_exact(&mut len_bytes)
        .await
        .context("reading adopt frame length")?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    if len > MAX_ADOPT_FRAME {
        return Err(anyhow!("adopt frame of {len} bytes exceeds limit"));
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .context("reading adopt frame body")?;
    serde_json::from_slice(&body).context("decoding adopt frame")
}

/// Granter side: dial the requester and hand over the grant; the ack arrives only after the
/// requester has run completion (or failed to), so `ok: true` means the persona has fully
/// moved in - syncs done, device named, ready to open. The caller wraps this in a timeout and
/// treats every failure identically: fall back to showing the code.
pub async fn deliver_grant(
    state: &AppState,
    requester_endpoint_id: &str,
    requester_addrs: &[String],
    grant: &GrantCode,
) -> Result<DeliveryAck> {
    let addr = crate::net::sync::endpoint_addr(requester_endpoint_id, requester_addrs)?;
    let conn = crate::net::p2p::dial(&state.unplugged, &state.endpoint, addr, ADOPT_ALPN)
        .await
        .context("dialing requester for grant delivery")?;
    let (mut send, mut recv) = conn.open_bi().await.context("opening adopt stream")?;
    write_json(&mut send, grant).await?;
    send.finish().context("finishing adopt stream")?;
    let ack: DeliveryAck = read_json(&mut recv).await?;
    conn.close(0u32.into(), b"done");
    Ok(ack)
}

/// Requester side: accept a delivered grant, complete the adoption it belongs to, and say how
/// it went. Errors inside completion become an honest `ok: false` ack rather than a dropped
/// connection - the granter shows the fallback code either way, and words beat resets.
pub async fn serve(conn: Connection, state: AppState) -> Result<()> {
    let (mut send, mut recv) = conn.accept_bi().await.context("accepting adopt stream")?;
    let grant: GrantCode = read_json(&mut recv).await?;

    let ack = match complete_delivered(&state, grant).await {
        Ok(()) => DeliveryAck {
            ok: true,
            message: "moved in".into(),
        },
        Err(e) => DeliveryAck {
            ok: false,
            message: e.to_string(),
        },
    };
    write_json(&mut send, &ack).await?;
    send.finish().context("finishing adopt ack")?;
    // Let the peer read the ack before the connection drops.
    conn.closed().await;
    Ok(())
}
