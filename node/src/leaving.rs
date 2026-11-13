//! Deleting yourself from this node (Curtis, 2026-11-01: "At the bottom of the hrseSettings,
//! "delete me", which opens up "delete persona" and "delete entire account" options").
//!
//! **Deleting a persona** is this computer leaving it, for good: its key retires (the
//! self-issued retirement of PROJECT_PLAN's _Retirement_ - everything it wrote stays good, and it
//! is left out of everything new), the retirement goes straight to the persona's other computers,
//! the persona is unlinked from the account (identity.rs `detach`, the farewell flow's own last
//! step), and this computer's key file is destroyed, so nobody who finds the disk later can speak
//! for the persona with it. What this node held of the persona becomes an ordinary mirror, which
//! the mirror sweep (eviction.rs) collects once nobody here wants it.
//!
//! **Deleting the account** is that for every persona it manages, then the account itself, with
//! the rows other modules keep for it - the administrator's eviction (accounts.rs), done by the
//! person, with a retirement signed for each persona.
//!
//! Neither reaches past this node: copies other computers and other people hold stay theirs, and
//! the screen says so. Both stay undoable the ordinary way - a persona another computer still
//! holds comes back here by adoption, which mints this computer a fresh key; the retired one is
//! never asked to speak again. A persona this was the only computer of has nothing left to come
//! back from (its spare key resets a password on an account, and the account is what's gone), and
//! the screen says that too, from `GET /leaving`.
//!
//! Both doors ask for the password again, and only from a signed-in browser - a session left open
//! on a borrowed computer, or a program holding an API key, must not be able to delete anybody.
//! A server's administrator can't delete their own account here: no server is ever left with
//! nobody to run it (accounts.rs's rule, from the other side). A device - the desktop or phone
//! app, `Tenancy::Single` - is different (Curtis, 2026-11-12): its administrator may delete their
//! account like anyone, since Google Play asks that every account can be deleted in the app, and
//! the next account made on the device becomes its administrator (auth.rs `inherit_device`).

use std::time::Duration;

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar};
use ringtome_proto::crown::KeyStatus;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Session;
use crate::error::AppError;
use crate::request_context::RequestContext;
use crate::AppState;

/// How long a deletion waits for the persona's other computers to take the retirement before it
/// goes on without them. Long enough for a computer that's on to answer; a computer that's off
/// learns of it from any other that heard, and this one's key is gone either way.
const DELIVERY_WAIT: Duration = Duration::from_secs(20);

/// Password tries at the deletion doors, per hour - the sign-in door's own allowance.
const CONFIRM_LIMIT: u32 = 20;
const HOUR_MS: i64 = 60 * 60 * 1000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/identity/{root}/leaving", get(leaving_handler))
        .route("/api/identity/{root}/delete", post(delete_persona_handler))
        .route("/api/auth/delete-account", post(delete_account_handler))
}

#[derive(Serialize)]
struct Leaving {
    /// The persona's other computers: active keys in its tree that aren't this computer's, nor
    /// its spare key. None means this is the only computer the persona lives on.
    other_computers: usize,
}

/// GET `/api/identity/{root}/leaving` - what deleting this persona here would leave behind.
async fn leaving_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<Leaving>, AppError> {
    crate::identity::require_owned(&state.node_db, &session.account.id, &root).await?;
    let signer = crate::identity::load_signing_key(
        &state.node_db,
        &state.keystore,
        &session.account.id,
        &root,
    )
    .await?;
    let me = signer.verifying_key().to_bytes();
    let db = state.user_dbs.held(&root).await.map_err(AppError::Internal)?;
    let tree = crate::record::imaol::load_key_tree(&db, &root).await?;
    let spare = crate::identity::designated_recovery(&tree);
    let other_computers = tree
        .members()
        .filter(|&(pk, status)| status == KeyStatus::Active && *pk != me && Some(*pk) != spare)
        .count();
    Ok(Json(Leaving { other_computers }))
}

#[derive(Deserialize)]
struct Confirm {
    password: String,
}

#[derive(Serialize)]
struct PersonaDeleted {
    /// The persona's other computers this one could reach with its retirement, and how many it
    /// tried - so the screen can say whether they've heard yet.
    told: usize,
    tried: usize,
}

/// POST `/api/identity/{root}/delete` - this computer leaves the persona, and the account lets
/// go of it.
async fn delete_persona_handler(
    session: Session,
    State(state): State<AppState>,
    ctx: RequestContext,
    Path(root): Path<String>,
    Json(req): Json<Confirm>,
) -> Result<Json<PersonaDeleted>, AppError> {
    confirm(&state, &ctx, &session, &req.password).await?;
    crate::identity::require_owned(&state.node_db, &session.account.id, &root).await?;
    let (told, tried) = leave(&state, &session.account.id, &root).await?;
    Ok(Json(PersonaDeleted { told, tried }))
}

#[derive(Serialize)]
struct AccountDeleted {
    /// The personas that left this node with it.
    personas: Vec<String>,
}

/// POST `/api/auth/delete-account` - every persona leaves, then the account goes, and with it
/// this session.
async fn delete_account_handler(
    session: Session,
    State(state): State<AppState>,
    ctx: RequestContext,
    jar: CookieJar,
    Json(req): Json<Confirm>,
) -> Result<(CookieJar, Json<AccountDeleted>), AppError> {
    confirm(&state, &ctx, &session, &req.password).await?;
    let account = session.account.id;
    // A server is never left with nobody to run it. A device is its owner's to walk away from:
    // its administrator may go, and the next account made there takes it on (auth.rs
    // `inherit_device`).
    let device = state.config.tenancy == crate::config::Tenancy::Single;
    if !device
        && crate::auth::has_tag(&state.node_db, &account, crate::auth::TAG_NODE_ADMIN).await?
    {
        return Err(AppError::BadRequest(crate::msg!(
            "leaving.you-run-this-server",
            "you run this server - hand that to someone else before deleting your account"
        )));
    }
    let mut personas = Vec::new();
    // one at a time: each persona's leaving is its own retirement, delivery and unlink, and an
    // account holds a handful - a failure stops here with the rest still whole, never half-gone.
    for persona in crate::identity::list_for_account(&state.node_db, &account).await? {
        leave(&state, &account, &persona.root_pubkey).await?;
        personas.push(persona.root_pubkey);
    }
    let id = account.to_string();
    crate::auth::keys::forget_account(&state.node_db, &id).await?;
    crate::identity::adoption::forget_account(&state, &id).await?;
    crate::frontmatter::forget_account(&state.node_db, &id).await?;
    crate::auth::remove_account(&state.node_db, &id).await?;
    tracing::info!(account = %id, personas = personas.len(), "an account deleted itself");
    let name = crate::auth::session_cookie_name(state.config.port);
    Ok((jar.remove(Cookie::from(name)), Json(AccountDeleted { personas })))
}

/// The password, asked again, from a signed-in browser.
async fn confirm(
    state: &AppState,
    ctx: &RequestContext,
    session: &Session,
    password: &str,
) -> Result<(), AppError> {
    crate::auth::keys::identity_by_browser(session)?;
    state.rate_limiter.check_ctx("delete", ctx, CONFIRM_LIMIT, HOUR_MS).await?;
    if !crate::auth::password_is(&state.node_db, &session.account.id, password).await? {
        return Err(AppError::Unauthorized(crate::msg!(
            "leaving.thats-not-your-password",
            "that's not your password"
        )));
    }
    Ok(())
}

/// This computer leaves one persona: its key retires (unless it already has), the retirement is
/// handed to the persona's other computers, the account lets go of it, and the key file goes.
/// Returns how many of its other computers took the retirement, of how many were tried.
async fn leave(state: &AppState, account: &Uuid, root: &str) -> Result<(usize, usize), AppError> {
    let signer =
        crate::identity::load_signing_key(&state.node_db, &state.keystore, account, root).await?;
    let me = hex::encode(signer.verifying_key().to_bytes());
    let db = state.user_dbs.held(root).await.map_err(AppError::Internal)?;
    let tree = crate::record::imaol::load_key_tree(&db, root).await?;
    if tree.status(&signer.verifying_key().to_bytes()) == KeyStatus::Active {
        crate::identity::revoke_key(
            state,
            account,
            root,
            &me,
            ringtome_proto::Disposition::Retirement,
            crate::identity::Cut::Now,
        )
        .await?;
    }

    // Straight to the other computers, before the unlink: once this node no longer agents the
    // persona, its eager push passes it by, and the retirement would wait on whoever next pulls
    // from this mirror. Bounded - a computer that's off hears it from one that's on.
    let peers =
        crate::net::sync::peers_for(&state.node_db, root).await.map_err(AppError::Internal)?;
    let tried = peers.len();
    let told = if peers.is_empty() {
        0
    } else {
        match tokio::time::timeout(DELIVERY_WAIT, crate::net::sync::sync_peers(state, root, &peers))
            .await
        {
            Ok(Ok(results)) => results.iter().filter(|r| r.ok).count(),
            Ok(Err(e)) => {
                tracing::warn!(root = %root, "could not hand a retirement to its computers: {e:#}");
                0
            }
            Err(_) => {
                tracing::warn!(root = %root, "handing a retirement to its computers ran out of time");
                0
            }
        }
    };

    crate::identity::detach(&state.node_db, account, root).await?;
    if let Err(e) = crate::webpush::forget_persona(state, root).await {
        tracing::warn!(root = %root, error = ?e, "could not drop a deleted persona's push subscriptions");
    }
    // The key last: everything above that signs or proves membership needed it.
    state.keystore.remove(&me).map_err(AppError::Internal)?;
    tracing::info!(root = %root, told, tried, "a persona was deleted from this computer");
    Ok((told, tried))
}
