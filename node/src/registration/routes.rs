//! The doors for registration.rs: the policy as a signup screen needs it, as an administrator
//! changes it, and a desktop app's multi-user switch.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::{is_device, listening_on_network, network_addresses, policy, Mode, NETWORK_PASSWORD_MIN};
use crate::auth::NodeAdminSession;
use crate::error::AppError;
use crate::shell::ShellRequest;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/registration", get(public_handler))
        .route("/api/admin/registration", get(status_handler).put(set_handler))
        .route("/api/admin/device/multi-user", post(multi_user_on_handler).delete(multi_user_off_handler))
}

/// What a signup screen needs to know: whether to offer signing up, and whether to ask for the
/// sign-up password. Public - a stranger at the door is exactly who reads it.
#[derive(Serialize)]
struct PublicPolicy {
    mode: &'static str,
}

async fn public_handler(State(state): State<AppState>) -> Result<Json<PublicPolicy>, AppError> {
    Ok(Json(PublicPolicy { mode: policy(&state).await?.mode.as_str() }))
}

/// Everything the Registration page shows.
#[derive(Serialize)]
struct Status {
    mode: &'static str,
    /// False while the node runs on its kind's default (open server, closed device).
    chosen: bool,
    has_password: bool,
    /// A desktop app rather than a server: the page offers multi-user mode.
    device: bool,
    /// Listening beyond this computer (a server's usual state; a device in multi-user mode).
    listening: bool,
    /// Where people on the local network reach it, when it is listening.
    addresses: Vec<String>,
    /// The administrator's own sign-in name - `me` on a device nobody has opened up yet.
    username: String,
}

async fn status_handler(State(state): State<AppState>, admin: NodeAdminSession) -> Result<Json<Status>, AppError> {
    let policy = policy(&state).await?;
    let listening = listening_on_network(&state);
    Ok(Json(Status {
        mode: policy.mode.as_str(),
        chosen: policy.chosen,
        has_password: policy.has_password(),
        device: is_device(&state),
        listening,
        addresses: if listening { network_addresses(&state) } else { Vec::new() },
        username: admin.account.username.clone(),
    }))
}

#[derive(Deserialize)]
struct SetPolicy {
    mode: String,
    /// The sign-up password: required the first time `password` is chosen, optional after.
    #[serde(default)]
    password: Option<String>,
}

fn mode_from(s: &str) -> Result<Mode, AppError> {
    Mode::parse(s).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("registration.routes.unknown-mode", "sign-ups are open, password, or closed"))
    })
}

async fn set_handler(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
    Json(req): Json<SetPolicy>,
) -> Result<Json<PublicPolicy>, AppError> {
    let policy = super::set(&state, mode_from(&req.mode)?, req.password.as_deref()).await?;
    Ok(Json(PublicPolicy { mode: policy.mode.as_str() }))
}

#[derive(Deserialize)]
struct MultiUserOn {
    /// The owner's sign-in name from now on.
    username: String,
    /// ...and password: this computer's account becomes one a browser can sign in to.
    password: String,
    /// Who else may sign up.
    mode: String,
    #[serde(default)]
    registration_password: Option<String>,
}

#[derive(Serialize)]
struct Switched {
    /// Whether the app heard the request to restart listening differently. False only on a node
    /// with no shell around it, which a device never is outside the test rig.
    restarting: bool,
}

fn device_only(state: &AppState) -> Result<(), AppError> {
    if is_device(state) {
        Ok(())
    } else {
        Err(AppError::NotFound(crate::msg!(
            "registration.routes.only-in-the-desktop-app",
            "multi-user mode is for the desktop app; a server already hosts other people"
        )))
    }
}

/// Turn multi-user mode on. Everything is checked before anything is written, so a refusal leaves
/// the app exactly as it was.
async fn multi_user_on_handler(
    State(state): State<AppState>,
    admin: NodeAdminSession,
    Json(req): Json<MultiUserOn>,
) -> Result<Json<Switched>, AppError> {
    device_only(&state)?;
    let mode = mode_from(&req.mode)?;
    let username = crate::auth::normalize_username(&req.username)?;
    if username != admin.account.username && crate::auth::is_username_taken(&state.node_db, &username).await? {
        return Err(AppError::BadRequest(crate::msg!(
            "auth.username-username-is-taken",
            "username \"{username}\" is taken",
            username = username
        )));
    }
    // The floor a network-facing node keeps (config.rs), applied now: from the next start, it is one.
    crate::auth::check_password_len(&req.password, NETWORK_PASSWORD_MIN)?;
    let offered = req.registration_password.as_deref().filter(|p| !p.is_empty());
    match offered {
        Some(p) => crate::auth::check_password_len(p, NETWORK_PASSWORD_MIN)?,
        None if mode == Mode::Password && !policy(&state).await?.has_password() => {
            return Err(AppError::BadRequest(crate::msg!(
                "registration.choose-a-sign-up-password",
                "choose a sign-up password to share with the people you invite"
            )));
        }
        None => {}
    }

    let id = admin.account.id.to_string();
    if username != admin.account.username {
        crate::auth::rename_account(&state.node_db, &id, &username).await?;
    }
    crate::auth::set_password(&state.node_db, &id, &req.password, NETWORK_PASSWORD_MIN, state.config.local_test).await?;
    super::set(&state, mode, offered).await?;
    let restarting = state.shell.ask(ShellRequest::ListenOnNetwork { on: true });
    tracing::info!(username = %username, mode = mode.as_str(), "multi-user mode on");
    Ok(Json(Switched { restarting }))
}

/// Turn it off: nobody new, and this computer only from the next start.
async fn multi_user_off_handler(State(state): State<AppState>, _admin: NodeAdminSession) -> Result<Json<Switched>, AppError> {
    device_only(&state)?;
    super::set(&state, Mode::Closed, None).await?;
    let restarting = state.shell.ask(ShellRequest::ListenOnNetwork { on: false });
    tracing::info!("multi-user mode off");
    Ok(Json(Switched { restarting }))
}
