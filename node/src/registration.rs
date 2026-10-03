//! Who may make an account here.
//!
//! **The policy** (Curtis, 2026-09-25) is one of three, chosen by a node administrator in the
//! Server app:
//!
//! - `open` - anyone who can reach the node may sign up (rate-limited per address, as before);
//! - `password` - sign-up asks for a password the administrator chose and shares by hand;
//! - `closed` - nobody new.
//!
//! No choice made means `open`, on every kind of node. A desktop app was `closed` until 2026-09-28,
//! when it was its owner's alone and signed them in by its launch token; now it is a localhost
//! multi-user server with the ordinary sign-in (Curtis), so its first person must be able to sign
//! up - and since it binds loopback, `open` there means open to whoever uses this computer. Its
//! owner has the same three choices in the Device app that a server's has in the Server app. This
//! is the simple, shippable form of PROJECT_PLAN's *Registration Modes*: `password` stands in for
//! invite tokens until those exist, and `trusted` waits for the trust layer.
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

fn default_mode(_state: &AppState) -> Mode {
    Mode::Open
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
            Some(
                crate::auth::hash_password(password, state.config.local_test)
                    .map_err(AppError::Internal)?,
            )
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

// ---------------------------------------------------------------------------------------------
// The limits (2026-10-02): beside the mode, set in the same Server app page.

/// The operator's limits on sign-ups, and the group a password sign-up joins - each `None` for
/// "no limit" or "no group".
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Limits {
    /// The most accounts this node may hold; a sign-up past it is refused.
    pub max_accounts: Option<i64>,
    /// The disk-use percentage (of the disk holding the node's data) past which sign-ups stop.
    pub disk_max_pct: Option<i64>,
    /// While sign-ups take a password, the group a newcomer's first persona joins (groups.rs).
    pub group_name: Option<String>,
}

pub async fn limits(state: &AppState) -> Result<Limits, AppError> {
    let row: Option<(Option<i64>, Option<i64>, Option<String>)> = state
        .node_db
        .fetch_optional(
            "SELECT max_accounts, disk_max_pct, group_name FROM registration_limits WHERE id = 1",
            (),
        )
        .await
        .context("reading the registration limits")
        .map_err(AppError::Internal)?;
    Ok(match row {
        Some((max_accounts, disk_max_pct, group_name)) => Limits {
            max_accounts,
            disk_max_pct,
            group_name: group_name.filter(|g| !g.trim().is_empty()),
        },
        None => Limits::default(),
    })
}

/// The group a sign-up offering the right password joins right now: the group name, only while
/// the mode is `password` (Curtis, 2026-10-02: having the password means you were invited).
pub async fn group_now(state: &AppState) -> Result<Option<String>, AppError> {
    if policy(state).await?.mode != Mode::Password {
        return Ok(None);
    }
    Ok(limits(state).await?.group_name)
}

pub async fn set_limits(state: &AppState, limits: &Limits) -> Result<(), AppError> {
    if limits.max_accounts.is_some_and(|n| n < 1) {
        return Err(AppError::BadRequest(crate::msg!(
            "registration.max-accounts-at-least-one",
            "a limit on accounts is at least one"
        )));
    }
    if limits.disk_max_pct.is_some_and(|p| !(1..=100).contains(&p)) {
        return Err(AppError::BadRequest(crate::msg!(
            "registration.disk-pct-range",
            "a disk limit is a percentage, 1 to 100"
        )));
    }
    let group = limits.group_name.as_deref().map(str::trim).filter(|g| !g.is_empty());
    // A group's name is the tag it wears in everyone's People list, so it is a tag's length.
    if group.is_some_and(|g| g.chars().count() > crate::groups::TAG_MAX) {
        return Err(AppError::BadRequest(crate::msg!(
            "registration.group-name-too-long",
            "a group's name is at most 32 letters"
        )));
    }
    state
        .node_db
        .execute(
            "INSERT INTO registration_limits (id, max_accounts, disk_max_pct, group_name, updated_ms) VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET max_accounts = excluded.max_accounts, disk_max_pct = excluded.disk_max_pct,
                 group_name = excluded.group_name, updated_ms = excluded.updated_ms",
            (limits.max_accounts, limits.disk_max_pct, group, crate::clock::now_ms()),
        )
        .await
        .context("writing the registration limits")
        .map_err(AppError::Internal)?;
    tracing::info!(?limits, "registration limits changed");
    Ok(())
}

/// How full the disk holding the node's data is, as a whole percentage - `None` when it can't be
/// read (then no disk limit refuses anyone: a sensor failing must not close the door).
pub fn disk_used_pct(state: &AppState) -> Option<i64> {
    let stats = fs4::statvfs(&state.config.data_directory).ok()?;
    let total = stats.total_space();
    if total == 0 {
        return None;
    }
    Some(((total - stats.available_space().min(total)) * 100 / total) as i64)
}

/// May somebody make an account right now, offering this sign-up password (if any)?
pub async fn admit(state: &AppState, offered: Option<&str>) -> Result<(), AppError> {
    admit_mode(state, offered).await?;
    let limits = limits(state).await?;
    if let Some(max) = limits.max_accounts {
        if crate::auth::account_count(&state.node_db).await? >= max {
            return Err(AppError::Forbidden(crate::msg!(
                "registration.this-place-is-full",
                "this place is full - it isn't taking new sign-ups"
            )));
        }
    }
    if let (Some(max), Some(used)) = (limits.disk_max_pct, disk_used_pct(state)) {
        if used > max {
            return Err(AppError::Forbidden(crate::msg!(
                "registration.out-of-room",
                "this place is running out of room - it isn't taking new sign-ups"
            )));
        }
    }
    Ok(())
}

async fn admit_mode(state: &AppState, offered: Option<&str>) -> Result<(), AppError> {
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
