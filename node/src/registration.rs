//! Who may make an account here.
//!
//! **The policy** (Curtis, 2026-09-25) is one of three, chosen by a node administrator in the
//! Server app:
//!
//! - `open` - anyone who can reach the node may sign up (rate-limited per address, as before);
//! - `password` - sign-up asks for a password the administrator chose and shares by hand;
//! - `closed` - nobody new.
//!
//! No choice made means the default for the kind of node: `open` for a server, which is what every
//! server did before this existed, and `closed` for a device - a desktop app is its owner's alone,
//! and its sign-up door otherwise stands open to anything else on the same computer that finds the
//! port. This is the simple, shippable form of PROJECT_PLAN's *Registration Modes*: `password`
//! stands in for invite tokens until those exist, and `trusted` waits for the trust layer.
//!
//! A desktop app's owner has no page for this: a device hosting other people - on one shared
//! computer, say - is a shape not settled yet (NEXT_STEPS), so the Device app shows only Backups.
//!
//! Enforcement is in the one door that makes accounts from outside: `/api/auth/register` asks
//! [`admit`] first.

pub mod routes;

use anyhow::Context;

use crate::config::Tenancy;
use crate::db::Db;
use crate::error::AppError;
use crate::AppState;

/// The sign-up password's floor: the node's own floor for a network-facing bind (config.rs,
/// `password_min_len`), since a password shared among strangers had better not be short.
const SIGNUP_PASSWORD_MIN: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Open,
    Password,
    Closed,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Open => "open",
            Mode::Password => "password",
            Mode::Closed => "closed",
        }
    }

    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "open" => Some(Mode::Open),
            "password" => Some(Mode::Password),
            "closed" => Some(Mode::Closed),
            _ => None,
        }
    }
}

/// The policy in force. The sign-up password's hash stays inside this module.
#[derive(Clone, Debug)]
pub struct Policy {
    pub mode: Mode,
    /// Whether the administrator chose it, or it is the default for this kind of node.
    pub chosen: bool,
    password_hash: Option<String>,
}

impl Policy {
    pub fn has_password(&self) -> bool {
        self.password_hash.is_some()
    }
}

/// A desktop app, as opposed to a server: the single-tenant node a shell embeds.
pub fn is_device(state: &AppState) -> bool {
    state.config.tenancy == Tenancy::Single
}

fn default_mode(state: &AppState) -> Mode {
    if is_device(state) {
        Mode::Closed
    } else {
        Mode::Open
    }
}

// ---------------------------------------------------------------------------------------------
// Changing it.

/// Set the policy. `password` is the sign-up password: required to enter `password` mode the first
/// time, optional after (None keeps the one already set), and ignored by the other modes - though
/// a stored one is kept, so switching back does not ask for it again.
pub async fn set(state: &AppState, mode: Mode, password: Option<&str>) -> Result<Policy, AppError> {
    let current = policy(state).await?;
    let password_hash = match (mode, password.filter(|p| !p.is_empty())) {
        (_, Some(password)) => {
            crate::auth::check_password_len(password, SIGNUP_PASSWORD_MIN)?;
            Some(crate::auth::hash_password(password, state.config.local_test).map_err(AppError::Internal)?)
        }
        (Mode::Password, None) if !current.has_password() => {
            return Err(AppError::BadRequest(crate::msg!(
                "registration.choose-a-sign-up-password",
                "choose a sign-up password to share with the people you invite"
            )));
        }
        (_, None) => current.password_hash,
    };
    write(&state.node_db, mode, password_hash.as_deref()).await?;
    tracing::info!(mode = mode.as_str(), "registration policy changed");
    policy(state).await
}

async fn write(db: &Db, mode: Mode, password_hash: Option<&str>) -> Result<(), AppError> {
    db.execute(
        "INSERT INTO registration_policy (id, mode, password_hash, updated_ms) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, password_hash = excluded.password_hash,
             updated_ms = excluded.updated_ms",
        (mode.as_str(), password_hash, crate::clock::now_ms()),
    )
    .await
    .context("writing the registration policy")
    .map_err(AppError::Internal)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Reading it.

pub async fn policy(state: &AppState) -> Result<Policy, AppError> {
    let row: Option<(String, Option<String>)> = state
        .node_db
        .fetch_optional("SELECT mode, password_hash FROM registration_policy WHERE id = 1", ())
        .await
        .context("reading the registration policy")
        .map_err(AppError::Internal)?;
    Ok(match row {
        Some((mode, password_hash)) => Policy {
            // An unreadable mode fails closed: nobody new, rather than everybody.
            mode: Mode::parse(&mode).unwrap_or(Mode::Closed),
            chosen: true,
            password_hash,
        },
        None => Policy { mode: default_mode(state), chosen: false, password_hash: None },
    })
}

/// May somebody make an account right now, offering this sign-up password (if any)?
pub async fn admit(state: &AppState, offered: Option<&str>) -> Result<(), AppError> {
    let policy = policy(state).await?;
    match policy.mode {
        Mode::Open => Ok(()),
        Mode::Closed => Err(AppError::Forbidden(crate::msg!(
            "registration.sign-ups-are-closed",
            "this place isn't taking new sign-ups"
        ))),
        Mode::Password => {
            let right = match (offered, policy.password_hash.as_deref()) {
                (Some(offered), Some(hash)) => crate::auth::verify_password(offered, hash),
                _ => false,
            };
            if right {
                Ok(())
            } else {
                Err(AppError::Forbidden(crate::msg!(
                    "registration.that-sign-up-password-isnt-right",
                    "that sign-up password isn't right"
                )))
            }
        }
    }
}
