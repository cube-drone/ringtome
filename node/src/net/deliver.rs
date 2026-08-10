//! Knocking on a stranger's door: the delivery transport.
//!
//! One request, one answer, on its own ALPN ([`DELIVER_ALPN`]). The dialer is by definition
//! someone the recipient has no relationship with - that is the whole reason this channel
//! exists - so nothing here assumes a peer relationship, a member proof, or any prior
//! knowledge. The judgment lives in [`crate::inbox::accept`]; this module is the wire and the
//! address book.
//!
//! ## Words beat resets
//!
//! Doctrine (The Inbound Gate): *"A silent drop is the worst failure mode in messaging, so we
//! take the bit"* - a refused sender is told they were refused, and learns exactly that one
//! fact. The sync protocol cannot express this (its refusal is an empty Hello, deliberately
//! indistinguishable from holding nothing); the adoption protocol's spoken `ok:false` ack is
//! the sanctioned pattern, and this follows it with a typed [`refusal`] code.
//!
//! **The exception is a block** (2026-08-10). Words beat resets because a refusal tells the
//! sender about *themselves* - too little standing, too much traffic - which they are entitled
//! to know. A block is a fact about the *recipient*, and answering honestly would make the door
//! an oracle for it. So a blocked sender is told "accepted" and retries nothing, which is the
//! same silence they would get from a node that is merely offline. See [`wire_answer`].
//!
//! And the door speaks about **itself** too: a node that cannot judge an offer for reasons of
//! its own answers `Busy` rather than a refusal, because the sender's outbox retires a refusal
//! forever and our locked keystore is not their bad behaviour.
//!
//! ## One door
//!
//! The sender's job is to reach **one** node of the recipient's, ever. Fan-out across the
//! recipient's devices is their own chain sync, never the sender's problem - the sender
//! neither knows nor should know a stranger's device roster. So the dial ladder below stops at
//! the first node that answers, and "nobody answered" is the only outcome worth retrying.

use anyhow::{anyhow, Context, Result};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use ringtome_proto::deliver::{
    refusal, DeliverMessage, SignedEnvelope, DELIVER_ALPN, MAX_DELIVER_FRAME_BYTES,
};

use crate::AppState;

/// How long one delivery attempt may take, dial included. Short: a notice is not urgent, and a
/// node that cannot answer promptly is better retried later than waited on.
const DELIVER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// How many candidate addresses one delivery attempt will try before giving up for now.
const CANDIDATE_CAP: usize = 4;

/// What came of an attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// A node of theirs took it (or correctly discarded it). Done - never retry.
    Accepted,
    /// A node of theirs refused it. Also done: retrying a refusal is what a spammer does.
    Refused(u32),
    /// Nobody usable answered - no door opened, or every door that did said `Busy`. The only
    /// outcome worth trying again later, and the outbox's ladder is what tries.
    Unreachable,
}

// ---------------------------------------------------------------------------------------------
// Frame IO. Its own pair rather than `p2p::{write_frame, read_frame}` because those are typed
// to `SyncMessage`; the framing (4-byte big-endian length + canonical CBOR) is identical on
// purpose, so a reader who knows one knows both.

async fn write_frame(send: &mut SendStream, msg: &DeliverMessage) -> Result<()> {
    let body = msg.encode();
    let len = u32::try_from(body.len()).map_err(|_| anyhow!("delivery frame too large"))?;
    send.write_all(&len.to_be_bytes())
        .await
        .context("writing delivery frame length")?;
    send.write_all(&body)
        .await
        .context("writing delivery frame body")?;
    Ok(())
}

async fn read_frame(recv: &mut RecvStream) -> Result<Option<DeliverMessage>> {
    let mut len_bytes = [0u8; 4];
    if recv.read_exact(&mut len_bytes).await.is_err() {
        return Ok(None); // clean end of stream at a frame boundary
    }
    let len = u32::from_be_bytes(len_bytes) as usize;
    if len > MAX_DELIVER_FRAME_BYTES {
        return Err(anyhow!("delivery frame of {len} bytes exceeds limit"));
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .context("reading delivery frame body")?;
    Ok(Some(DeliverMessage::decode(&body).map_err(|e| {
        anyhow!("undecodable delivery frame: {e}")
    })?))
}

// ---------------------------------------------------------------------------------------------
// The door

/// Serve one delivery connection: read the offer, judge it, answer out loud.
pub async fn serve(conn: Connection, state: AppState) -> Result<()> {
    let (mut send, mut recv) = conn.accept_bi().await.context("accepting delivery stream")?;
    let Some(DeliverMessage::Offer(bytes)) = read_frame(&mut recv).await? else {
        return Err(anyhow!("expected an Offer"));
    };

    let answer = judge(&state, &bytes).await;
    write_frame(&mut send, &answer).await?;
    send.finish().ok();
    conn.closed().await;
    Ok(())
}

/// The gate's cheap half, in order: structure, then who it is for, then the claim, then the
/// recipient's own judgment. Everything before `inbox::accept` is pure CPU over bytes we were
/// handed - no fetches, ever, which is the property the envelope format exists to provide.
async fn judge(state: &AppState, bytes: &[u8]) -> DeliverMessage {
    // Size and structure. `decode` enforces MAX_ENVELOPE_BYTES before anything else.
    let Ok(signed) = SignedEnvelope::decode(bytes) else {
        return DeliverMessage::Refused(refusal::MALFORMED);
    };
    let recipient = hex::encode(signed.envelope().recipient_root);

    // Do we even speak for this persona? Not a secret - serving records are public - so this
    // refusal is allowed to be specific.
    match crate::identity::is_agented(&state.node_db, &recipient).await {
        Ok(true) => {}
        Ok(false) => return DeliverMessage::Refused(refusal::NOT_SERVED),
        Err(e) => {
            tracing::warn!(error = ?e, "delivery could not check hosting");
            return DeliverMessage::Refused(refusal::NOT_SERVED);
        }
    }

    // The claim: signature, delegation from the claimed root, and evidence that names this
    // recipient. A few ed25519 verifications over bytes already in hand.
    let claim = match ringtome_proto::deliver::verify_claim(&signed) {
        Ok(claim) => claim,
        Err(e) => {
            tracing::debug!(error = ?e, "delivery offered an unverifiable claim");
            return DeliverMessage::Refused(refusal::MALFORMED);
        }
    };

    match crate::inbox::accept(state, &recipient, &signed, &claim).await {
        Ok(verdict) => wire_answer(verdict),
        Err(e) => {
            // Our fault, not theirs - so `Busy`, never a refusal. A refusal is retired forever
            // by the sender's outbox (correctly: retrying a refusal is what a spammer does),
            // which meant a briefly-locked keystore here used to destroy a notice nobody had
            // refused. The detail goes to the operator's log; the sender gets "try again".
            tracing::warn!(error = ?e, recipient = %recipient, "transcription failed");
            DeliverMessage::Busy
        }
    }
}

/// What the sender is told, given what the gate actually did.
///
/// **Every verdict answers "accepted", and that is the point.** Two of the three did not
/// transcribe, but neither non-transcription may be visible: `AlreadyPulled` is genuinely done
/// (a truthful refusal would provoke a pointless retry for a notice the pull path already
/// carries), and `Blocked` must be indistinguishable from acceptance or the answer becomes a
/// block oracle - one envelope, one probe, and the sender knows. See [`crate::inbox::Verdict`]
/// for why the coarse `refusal::GATE` code stopped covering for it.
fn wire_answer(verdict: crate::inbox::Verdict) -> DeliverMessage {
    use crate::inbox::Verdict;
    match verdict {
        Verdict::Transcribed | Verdict::AlreadyPulled | Verdict::Blocked => DeliverMessage::Accepted,
    }
}

// ---------------------------------------------------------------------------------------------
// The knock

/// Try to hand one envelope to any node serving `recipient_root`.
///
/// The candidate ladder is the fetch path's, reused rather than reinvented (`idface`): whoever
/// last answered about them, then their root key (a founding node signs its serving record
/// with root-as-leaf), then any Active leaf of theirs we happen to hold. Each candidate is
/// resolved through a signed serving record whose `root` must match - so a serving record for
/// the wrong identity cannot redirect a delivery.
pub async fn deliver(state: &AppState, recipient_root: &str, envelope: &[u8]) -> Outcome {
    // Housemates: two personas on one node. Dialing ourselves would be theatre, and iroh has
    // no reason to make a self-connection work - so the same judgment runs in-process. The
    // recipient's gate is identical either way, which is the point.
    if crate::identity::is_agented(&state.node_db, recipient_root)
        .await
        .unwrap_or(false)
    {
        return match judge(state, envelope).await {
            DeliverMessage::Accepted => Outcome::Accepted,
            DeliverMessage::Refused(reason) => Outcome::Refused(reason),
            // Our own gate said Busy about our own node. `Offer` is not an answer and cannot
            // arrive here; both mean the notice is still waiting, which is what the outbox
            // needs to hear.
            DeliverMessage::Busy | DeliverMessage::Offer(_) => Outcome::Unreachable,
        };
    }
    for candidate in candidates(state, recipient_root).await {
        let endpoint_id = crate::idface::leaf_via_to_endpoint(state, recipient_root, &candidate).await;
        match tokio::time::timeout(DELIVER_TIMEOUT, knock(state, &endpoint_id, envelope)).await {
            // A busy door is a door that did not work, so the ladder continues rather than
            // spending the whole attempt on one unlucky machine - the sender needs *a* node of
            // theirs, not this one. Every candidate busy falls out of the loop as Unreachable.
            Ok(Ok(Outcome::Unreachable)) => {
                tracing::debug!(candidate = %endpoint_id, "delivery door was busy");
            }
            Ok(Ok(outcome)) => return outcome,
            Ok(Err(e)) => {
                tracing::debug!(candidate = %endpoint_id, error = ?e, "delivery attempt failed");
            }
            Err(_) => tracing::debug!(candidate = %endpoint_id, "delivery attempt timed out"),
        }
    }
    Outcome::Unreachable
}

async fn candidates(state: &AppState, recipient_root: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |key: String| {
        if !key.is_empty() && !out.contains(&key) && out.len() < CANDIDATE_CAP {
            out.push(key);
        }
    };
    if let Ok(Some(via)) = crate::idface::fetched_via(&state.node_db, recipient_root).await {
        push(via);
    }
    // The zeroth rung: a founding node signs with the root itself as its leaf.
    push(recipient_root.to_string());
    for leaf in crate::idface::stored_tree_leaves(state, recipient_root).await {
        push(leaf);
    }
    out
}

async fn knock(state: &AppState, endpoint_id: &str, envelope: &[u8]) -> Result<Outcome> {
    let addr = crate::net::sync::dial_addr(state, endpoint_id).await?;
    let conn = state
        .endpoint
        .connect(addr, DELIVER_ALPN)
        .await
        .map_err(|e| anyhow!("dialing {endpoint_id} for delivery: {e}"))?;
    let (mut send, mut recv) = conn.open_bi().await.context("opening delivery stream")?;
    write_frame(&mut send, &DeliverMessage::Offer(envelope.to_vec())).await?;
    send.finish().ok();
    let answer = read_frame(&mut recv).await?;
    conn.close(0u8.into(), b"done");
    match answer {
        Some(DeliverMessage::Accepted) => Ok(Outcome::Accepted),
        Some(DeliverMessage::Refused(reason)) => Ok(Outcome::Refused(reason)),
        // A door that admitted its own failure is worth exactly as much as a door that did not
        // open: the notice is undelivered and the attempt is worth making again.
        Some(DeliverMessage::Busy) => Ok(Outcome::Unreachable),
        other => Err(anyhow!("unexpected answer to a delivery: {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::Verdict;

    /// The anti-oracle invariant, stated as an equality rather than a mapping: whatever the
    /// gate decided, the sender must not be able to tell the cases apart. Written this way on
    /// purpose - asserting "Blocked maps to Accepted" would only restate the match arm, while
    /// this fails for any future verdict that leaks, including ones nobody has added yet.
    #[test]
    fn the_gate_never_tells_a_sender_which_verdict_they_got() {
        let transcribed = wire_answer(Verdict::Transcribed);
        for verdict in [Verdict::AlreadyPulled, Verdict::Blocked] {
            assert_eq!(
                wire_answer(verdict),
                transcribed,
                "{verdict:?} is distinguishable from acceptance on the wire"
            );
        }
    }

    /// A block must not be visible even by its retry shape: `Accepted` means done, so the
    /// sender stops. Anything that maps to `Refused` would also stop them, but tells them why.
    #[test]
    fn a_blocked_sender_is_told_the_word_accepted() {
        assert!(matches!(
            wire_answer(Verdict::Blocked),
            DeliverMessage::Accepted
        ));
    }
}
