use std::sync::Arc;
use std::fmt::{self, Display, Formatter};
use anyhow::{Result, anyhow};
use slugify::slugify;
use sqlx::{SqlitePool, Row};
use argon2::{
    password_hash::{
        rand_core::OsRng,
        PasswordHash,
        PasswordHasher,
        PasswordVerifier
    },
    Argon2,
};
use uuid::Uuid;
use serde::{Serialize, Deserialize};

use super::user::routes::NewUser;
use crate::event::{Event, CommunityEventSender};
use crate::service_registry::ServiceRegistry;

pub mod routes;
pub mod view;

#[derive(Clone)]
pub struct UserService {
    pool: SqlitePool,
    config: crate::app_config::Config,
    event_sender: CommunityEventSender,
    registry: Arc<dyn ServiceRegistry>,
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub prospective_email: Option<String>,
    pub email: Option<String>,
    pub prospective_phone_number: Option<String>,
    pub phone_number: Option<String>,
    pub password_hash: Option<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub created_at_int: i64,
    pub updated_at: String,
    pub updated_at_int: i64,
    pub last_login: String,
    pub last_login_int: i64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum VerificationCodeType {
    Email,
    Phone,
    Login,
    LoginSMS,
}

impl Display for VerificationCodeType {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        match self {
            VerificationCodeType::Email => write!(f, "email"),
            VerificationCodeType::Phone => write!(f, "phone"),
            VerificationCodeType::Login => write!(f, "login"),
            VerificationCodeType::LoginSMS => write!(f, "login_sms"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum InviteCodeUseType{
    Once,
    Unlimited
}

impl Display for InviteCodeUseType {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        match self {
            InviteCodeUseType::Once => write!(f, "once"),
            InviteCodeUseType::Unlimited => write!(f, "unlimited"),
        }
    }
}
// turn a string into an InviteCodeUseType
impl From<&str> for InviteCodeUseType {
    fn from(s: &str) -> Self {
        match s {
            "once" => InviteCodeUseType::Once,
            "unlimited" => InviteCodeUseType::Unlimited,
            _ => InviteCodeUseType::Once,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InviteCode {
    pub invite_code: Uuid,
    pub created_by: Uuid,
    pub use_type: InviteCodeUseType,
    pub created_at: String,
    pub created_at_int: i64,
}

const CREATE_USER_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    prospective_email TEXT,
    email TEXT,
    prospective_phone TEXT,
    phone TEXT,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_at_int INTEGER NOT NULL,
    last_login TEXT NOT NULL,
    last_login_int INTEGER NOT NULL
)
"#;

const CREATE_TAGS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS tags (
    tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    tag TEXT NOT NULL
)
"#;

const CREATE_VERIFICATION_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS verification_code (
    code_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL
)
"#;

const CREATE_INVITE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS invite (
    invite_code TEXT PRIMARY KEY,
    use_type TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL
)"#;

// we want to track invite chains: who invited whom?
const CREATE_INVITE_CHAIN_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS invite_chain (
    chain_id INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_source_user_id TEXT NOT NULL,
    invite_target_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL
)"#;

const USER_INDEX_SLUG_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS user_slug_index ON user(slug);
"#;

const USER_INDEX_EMAIL_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS user_email_index ON user(email);
"#;

const USER_INDEX_PHONE_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS user_phone_index ON user(phone);
"#;

const USER_INDEX_CREATED_AT_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS user_created_at_index ON user(created_at_int);
"#;

const USER_TAG_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS user_tag_index ON tags(user_id);
"#;

const INVITE_TABLE_INDEX: &str = r#"
CREATE INDEX IF NOT EXISTS invite_code_index ON invite(created_by);
"#;

const VERIFICATION_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS verification_code_index ON verification_code(user_id, code);
"#;

const VERIFICATION_INDEX_CREATED_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS verification_code_created_index ON verification_code(created_at_int);
"#;

const CHAIN_INDEX_SQL : &str = r#"
CREATE INDEX IF NOT EXISTS invite_chain_source_index ON invite_chain(invite_source_user_id);
"#;

const CHAIN_INDEX_2_SQL : &str = r#"
CREATE INDEX IF NOT EXISTS invite_chain_target_index ON invite_chain(invite_target_user_id);
"#;

impl UserService {
    pub async fn new(
            config: crate::app_config::Config,
            pool: SqlitePool,
            registry: Arc<dyn ServiceRegistry>,
            event_sender: CommunityEventSender) -> Result<Self> {
        // Create the tables.
        // Create the indexes.
        for index_sql in vec![
            CREATE_USER_TABLE,
            CREATE_TAGS_TABLE,
            CREATE_INVITE_TABLE,
            CREATE_INVITE_CHAIN_TABLE,
            CREATE_VERIFICATION_TABLE,
            USER_INDEX_SLUG_SQL,
            USER_INDEX_EMAIL_SQL,
            USER_INDEX_PHONE_SQL,
            USER_INDEX_CREATED_AT_SQL,
            USER_TAG_INDEX_SQL,
            INVITE_TABLE_INDEX,
            VERIFICATION_INDEX_SQL,
            VERIFICATION_INDEX_CREATED_SQL,
            CHAIN_INDEX_SQL,
            CHAIN_INDEX_2_SQL,
        ] {
            match sqlx::query(index_sql).execute(&pool).await {
                Ok(_) => {},
                Err(e) => return Err(anyhow!(format!("Error creating table: {} - {}", index_sql, e))),
            };
        }

        Ok(Self {
            config,
            pool,
            event_sender,
            registry,
        })
    }

    fn hash_password(&self, password: &str) -> Result<String> {
        if self.config.is_dev() {
            // the simplest hashing method of all
            // storing the password in plaintext (do not do this in production)
            return Ok(password.to_string());
        }
        else{
            let argon2 = Argon2::default();
            let salt = argon2::password_hash::SaltString::generate(&mut OsRng);
            let password_hash = argon2.hash_password(password.as_bytes(), &salt)
                .map_err(|err| anyhow!(format!("Argon2 error: {}", err)))?;
            Ok(password_hash.to_string())
        }
    }

    fn verify_password(&self, password: &str, password_hash: &str) -> Result<()> {
        if self.config.is_dev() {
            // the simplest hashing method of all
            // storing the password in plaintext (do not do this in production)
            if password != password_hash {
                return Err(anyhow!("400 Error verifying password"));
            }
            Ok(())
        }
        else{
            let parsed_hash = PasswordHash::new(password_hash)
                .map_err(|_err| anyhow!(format!("400 Error parsing password hash")))?;

            Argon2::default().verify_password(password.as_bytes(), &parsed_hash)
                .map_err(|_err| anyhow!(format!("400 Error verifying password")))?;
            Ok(())
        }
    }

    /// Checks if a community slug exists in the database.
    pub async fn slug_exists(&self, slug: &str) -> Result<bool> {
        let row: Option<(String,)> = sqlx::query_as("SELECT id FROM user WHERE slug = ?1")
            .bind(slug)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    /// Returns a valid, unique slug for the user.
    pub async fn get_valid_slug(&self, name: &str) -> Result<String> {
        let original_slug = slugify!(name);
        let mut slug = original_slug.clone();
        let mut i = 1;
        while self.slug_exists(&slug).await? {
            slug = format!("{}-{}", original_slug, i);
            i += 1;
        }
        Ok(slug)
    }

    pub async fn create_user(&self, new_user: NewUser, is_owner: bool) -> Result<User> {
        let now = chrono::Utc::now();
        let now_int = now.timestamp_micros();

        let email = new_user.email.clone();
        if let Some(email) = &email {
            let existing_user_with_email = self.get_user_by_email(email).await?;
            if existing_user_with_email.is_some() {
                return Err(anyhow!("400 User with that email already exists in this community."));
            }
            else{
                tracing::info!("No existing user with email: {}", email);
            }

        }

        let normalized_phone_number: Option<String> = match &new_user.phone_number {
            Some(phone_number) => Some(normalize_phone_number(phone_number)?),
            None => None,
        };

        if let Some(phone_number) = normalized_phone_number.clone() {
            let existing_user_with_phone = self.get_user_by_phone_number(&phone_number).await?;
            if existing_user_with_phone.is_some() {
                return Err(anyhow!("400 User with that phone number already exists in this community."));
            }
            else{
                tracing::info!("No existing user with phone number: {}", phone_number);
            }
        }

        let mut password_hash = "".to_string();
        if let Some(ref password) = new_user.password {
            password_hash = self.hash_password(password)?;
        }

        let id = Uuid::new_v4();
        let slug = self.get_valid_slug(&new_user.name).await?;
        let new_user_copy = new_user.clone();

        // Insert into the user table.
        sqlx::query(
            "INSERT INTO user (
                id,
                slug,
                name,
                prospective_email,
                prospective_phone,
                password_hash,
                created_at,
                created_at_int,
                updated_at,
                updated_at_int,
                last_login,
                last_login_int
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&id.to_string())
        .bind(&slug)
        .bind(&new_user.name)
        .bind(&new_user.email.unwrap_or_default())
        .bind(&normalized_phone_number.clone().unwrap_or_default())
        .bind(&password_hash)
        .bind(&now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(now_int)
        .bind(&now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(now_int)
        .bind(&now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(now_int)
        .execute(&self.pool)
        .await?;

        let mut tags = vec![];
        if is_owner {
            self.add_tag(&id, "owner").await?;
            tags.push("owner".to_string());
        }
        if new_user.password.is_some() {
            self.add_tag(&id, "has_password").await?;
            tags.push("has_password".to_string());
        }
        if new_user_copy.email.is_some() {
            self.add_tag(&id, "has_email").await?;
            tags.push("has_email".to_string());
        }
        if new_user_copy.phone_number.is_some() {
            self.add_tag(&id, "has_phone").await?;
            tags.push("has_phone".to_string());
        }

        let user = User {
            id,
            slug,
            name: new_user.name,
            prospective_email: new_user_copy.email,
            email: None,
            prospective_phone_number: normalized_phone_number,
            phone_number: None,
            tags,
            password_hash: if new_user_copy.password.is_some() { Some(password_hash) } else { None },
            created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            created_at_int: now_int,
            updated_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            updated_at_int: now_int,
            last_login: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            last_login_int: now_int,
        };

        Ok(user)
    }

    // So, if a user logs into this community, but they have a session from the "Admin" community,
    //  they're going to have a session with a user_id, but that user_id isn't going to point to any record!
    // So, we copy that user record into THIS community, and give it owner powers.
    pub async fn create_superadmin_user(&self, user: &User) -> Result<()> {
        let now = chrono::Utc::now();
        let now_int = now.timestamp_micros();

        let email = user.email.clone();
        if let Some(email) = &email {
            let existing_user_with_email = self.get_user_by_email(email).await?;
            if existing_user_with_email.is_some() {
                return Err(anyhow!("400 User with that email already exists in this community."));
            }
            else{
                tracing::info!("No existing user with email: {}", email);
            }
        }

        let normalized_phone_number: Option<String> = match &user.phone_number {
            Some(phone_number) => Some(normalize_phone_number(phone_number)?),
            None => None,
        };

        if let Some(phone_number) = normalized_phone_number.clone() {
            let existing_user_with_phone = self.get_user_by_phone_number(&phone_number).await?;
            if existing_user_with_phone.is_some() {
                return Err(anyhow!("400 User with that phone number already exists in this community."));
            }
            else{
                tracing::info!("No existing user with phone number: {}", phone_number);
            }
        }

        let password_hash = "n/a".to_string();

        // Insert into the user table.
        sqlx::query(
            "INSERT INTO user (
                id,
                slug,
                name,
                email,
                phone,
                password_hash,
                created_at,
                created_at_int,
                updated_at,
                updated_at_int,
                last_login,
                last_login_int
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&user.id.to_string())
        .bind(&user.slug)
        .bind(&user.name)
        .bind(&user.email)
        .bind(&normalized_phone_number.clone().unwrap_or_default())
        .bind(&password_hash)
        .bind(&now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(now_int)
        .bind(&now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(now_int)
        .bind(&now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(now_int)
        .execute(&self.pool)
        .await?;

        let id = user.id;

        self.add_tag(&id, "super_admin").await?;
        self.add_tag(&id, "owner").await?;
        self.add_tag(&id, "has_password").await?;
        self.add_tag(&id, "has_email").await?;
        self.add_tag(&id, "has_phone").await?;
        self.add_tag(&id, "email_verified").await?;
        self.add_tag(&id, "phone_verified").await?;

        Ok(())
    }

    pub async fn create_invite_chain(&self, source_user_id: &Uuid, target_user_id: &Uuid) -> Result<()> {
        let now = chrono::Utc::now();
        let now_int = now.timestamp_micros();

        sqlx::query("INSERT INTO invite_chain (invite_source_user_id, invite_target_user_id, created_at, created_at_int) VALUES (?, ?, ?, ?)")
            .bind(&source_user_id.to_string())
            .bind(&target_user_id.to_string())
            .bind(&now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .bind(now_int)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    pub async fn delete_user(&self, user_id: &Uuid) -> Result<()> {
        sqlx::query("DELETE FROM user WHERE id = ?")
            .bind(&user_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_user(&self, user_id: &Uuid) -> Result<Option<User>> {
        tracing::info!("[UserService] Getting user with ID: {}", user_id);
        let result = sqlx::query("
            SELECT
                id,
                slug,
                name,
                prospective_email,
                email,
                prospective_phone,
                phone,
                password_hash,
                created_at,
                created_at_int,
                updated_at,
                updated_at_int,
                last_login,
                last_login_int
            FROM user
            WHERE id = ?
            LIMIT 1")
            .bind(&user_id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        let row = match result {
            Some(row) => row,
            None => return Ok(None),
        };

        let tag_rows = sqlx::query("SELECT tag FROM tags WHERE user_id = ?")
            .bind(&user_id.to_string())
            .fetch_all(&self.pool)
            .await?;

        let mut tags = vec![];
        for tag_row in tag_rows {
            tags.push(tag_row.try_get(0)?);
        }

        let mut prospective_email: Option<String> = row.try_get(3)?;
        if prospective_email.is_some() && prospective_email.clone().unwrap().is_empty() {
            prospective_email = None;
        }
        let mut email: Option<String> = row.try_get(4)?;
        if email.is_some() && email.clone().unwrap().is_empty() {
            email = None;
        }
        let mut prospective_phone_number: Option<String> = row.try_get(5)?;
        if prospective_phone_number.is_some() && prospective_phone_number.clone().unwrap().is_empty() {
            prospective_phone_number = None;
        }
        let mut phone_number: Option<String> = row.try_get(6)?;
        if phone_number.is_some() && phone_number.clone().unwrap().is_empty() {
            phone_number = None;
        }

        let user = User {
            id: Uuid::parse_str(row.get::<String, _>("id").as_str())?,
            slug: row.try_get(1)?,
            name: row.try_get(2)?,
            prospective_email,
            email,
            prospective_phone_number,
            phone_number,
            password_hash: row.try_get(7)?,
            created_at: row.try_get(8)?,
            created_at_int: row.try_get(9)?,
            updated_at: row.try_get(10)?,
            updated_at_int: row.try_get(11)?,
            last_login: row.try_get(12)?,
            last_login_int: row.try_get(13)?,
            tags: tags,
        };

        Ok(Some(user))
    }

    pub async fn get_user_by_phone_number(&self, phone_number: &str) -> Result<Option<User>> {
        let normalized_phone_number = normalize_phone_number(phone_number)?;

        tracing::warn!("Looking for user by phone number: {}", normalized_phone_number);

        let result = sqlx::query("SELECT id FROM user WHERE phone = ? LIMIT 1")
            .bind(normalized_phone_number)
            .fetch_optional(&self.pool)
            .await?;

        let row = match result {
            Some(row) => row,
            None => return Ok(None),
        };

        tracing::warn!("Found row for user by phone number");

        let user_id: Uuid = Uuid::parse_str(row.try_get(0)?)?;
        tracing::warn!("Found user by phone number: {}", user_id);
        Ok(self.get_user(&user_id).await?)
    }

    pub async fn get_user_by_email(&self, email: &str) -> Result<Option<User>> {
        let result = sqlx::query("SELECT id FROM user WHERE email = ? LIMIT 1")
            .bind(email)
            .fetch_optional(&self.pool)
            .await?;

        tracing::warn!("Looking for user by email: {}", email);

        let row = match result {
            Some(row) => row,
            None => return Ok(None),
        };

        tracing::warn!("Found row for user by email");

        let user_id: Uuid = Uuid::parse_str(row.try_get(0)?)?;
        Ok(self.get_user(&user_id).await?)
    }

    pub async fn get_user_by_slug(&self, slug: &str) -> Result<Option<User>> {
        let result = sqlx::query("SELECT id FROM user WHERE slug = ? LIMIT 1")
            .bind(slug)
            .fetch_optional(&self.pool)
            .await?;

        let row = match result {
            Some(row) => row,
            None => return Ok(None),
        };

        let user_id: Uuid = Uuid::parse_str(row.try_get(0)?)?;
        Ok(self.get_user(&user_id).await?)
    }

    pub async fn get_users(&self) -> Result<Vec<User>> {
        let result = sqlx::query("SELECT id FROM user")
            .fetch_all(&self.pool)
            .await?;

        let mut users = vec![];
        for row in result {
            let user_id: Uuid = Uuid::parse_str(&row.try_get::<String, _>(0)?)?;
            let user = self.get_user(&user_id).await?;
            match user {
                Some(user) => users.push(user),
                None => (),
            }
        }

        Ok(users)
    }

    pub async fn get_admin_users(&self) -> Result<Vec<User>> {
        let result = sqlx::query("
            SELECT DISTINCT user.id
            FROM user
            JOIN tags ON user.id = tags.user_id
            WHERE
                tags.tag = 'owner'
            OR
                tags.tag = 'admin'
        ")
        .fetch_all(&self.pool)
        .await?;

        let mut users = vec![];
        for row in result {
            let user_id: Uuid = Uuid::parse_str(row.try_get(0)?)?;
            let user = self.get_user(&user_id).await?;
            match user {
                Some(user) => users.push(user),
                None => (),
            }
        }

        Ok(users)
    }

    pub async fn authenticate_phone_number(&self, phone_number: &str, password: &str) -> Result<User>{
        let user = self.get_user_by_phone_number(phone_number).await?;

        match user {
            Some(user) => {
                // no logging in if the user is locked
                if self.has_tag(&user.id, "locked").await? {
                    return Err(anyhow!("400 User is locked."));
                }

                match &user.password_hash{
                    Some(password_hash) => {
                        self.verify_password(password, password_hash)?;
                        Ok(user)
                    },
                    None => Err(anyhow!("404 User not found.")),
                }
            },
            None => Err(anyhow!("404 User not found.")),
        }
    }

    pub async fn authenticate_email(&self, email: &str, password: &str) -> Result<User>{
        let user = self.get_user_by_email(email).await?;

        match user {
            Some(user) => {
                // no logging in if the user is locked
                if self.has_tag(&user.id, "locked").await? {
                    return Err(anyhow!("400 User is locked."));
                }
                match &user.password_hash{
                    Some(password_hash) => {
                        self.verify_password(password, password_hash)?;
                        Ok(user)
                    },
                    None => Err(anyhow!("404 User not found.")),
                }
            },
            None => Err(anyhow!("404 User not found.")),
        }
    }

    pub async fn add_tag(&self, user_id: &Uuid, tag: &str) -> Result<()> {
        sqlx::query("INSERT INTO tags (user_id, tag) VALUES (?, ?)")
            .bind(&user_id.to_string())
            .bind(tag)
            .execute(&self.pool)
            .await?;

        self.event_sender.send(
            Event::UserTagAdded {
                tag: tag.to_string(),
            },
            Some(*user_id),
            None,
        ).await.map_err(|e| anyhow::anyhow!("Failed to send event: {}", e))?;

        Ok(())
    }

    pub async fn remove_tag(&self, user_id: &Uuid, tag: &str) -> Result<()> {
        sqlx::query("DELETE FROM tags WHERE user_id = ? AND tag = ?")
            .bind(&user_id.to_string())
            .bind(tag)
            .execute(&self.pool)
            .await?;

        self.event_sender.send(
            Event::UserTagRemoved {
                tag: tag.to_string(),
            },
            Some(*user_id),
            None,
        ).await.map_err(|e| anyhow::anyhow!("Failed to send event: {}", e))?;

        Ok(())
    }

    pub async fn has_tag(&self, user_id: &Uuid, tag: &str) -> Result<bool> {
        let result = sqlx::query("SELECT tag FROM tags WHERE user_id = ? AND tag = ? LIMIT 1")
            .bind(&user_id.to_string())
            .bind(tag)
            .fetch_optional(&self.pool)
            .await?;

        Ok(result.is_some())
    }

    pub async fn verify_sms(&self, user_id: &Uuid) -> Result<()> {

        match self.get_user(user_id).await?{
            Some(user) => {
                match user.prospective_phone_number{
                    Some(phone_number) => {
                        // check if the phone number already exists
                        match self.get_user_by_phone_number(&phone_number).await?{
                            Some(_existing_user) => {
                                return Err(anyhow!("400 Phone number already in use."));
                            },
                            None => (),
                        }
                        // add the phone_verified tag
                        self.add_tag(user_id, "phone_verified").await?;

                        // move the phone number from prospective to actual
                        sqlx::query("
                            UPDATE user
                            SET
                                phone = ?,
                                prospective_phone = NULL,
                                updated_at = ?,
                                updated_at_int = ?
                            WHERE id = ?")
                            .bind(&phone_number)
                            .bind(&chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                            .bind(chrono::Utc::now().timestamp_micros())
                            .bind(&user_id.to_string())
                            .execute(&self.pool)
                            .await?;

                            Ok(())
                    },
                    None => Err(anyhow!("400 No prospective phone number to verify.")),
                }
            },
            None => Err(anyhow!("404 User not found.")),
        }

    }

    pub async fn verify_email(&self, user_id: &Uuid) -> Result<()> {
        match self.get_user(user_id).await?{
            Some(user) => {
                tracing::info!("Verifying email for user: {}", user_id);
                match user.prospective_email{
                    Some(email) => {
                        // check if the email already exists
                        match self.get_user_by_email(&email).await?{
                            Some(_existing_user) => {
                                return Err(anyhow!("400 Email already in use."));
                            },
                            None => (),
                        }
                        // add the email_verified tag
                        self.add_tag(user_id, "email_verified").await?;

                        // move the email from prospective to actual
                        sqlx::query("
                            UPDATE user
                            SET
                                email = ?,
                                prospective_email = NULL,
                                updated_at = ?,
                                updated_at_int = ?
                            WHERE id = ?")
                            .bind(&email)
                            .bind(&chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true ))
                            .bind(chrono::Utc::now().timestamp_micros())
                            .bind(&user_id.to_string())
                            .execute(&self.pool)
                            .await?;

                            Ok(())
                    },
                    None => Err(anyhow!("400 No prospective email to verify.")),
                }
            },
            None => Err(anyhow!("404 User not found.")),
        }
    }

    // Create a verification code for a user. This will be used to verify their email or phone number, for example.
    pub async fn create_verification_code(&self, user_id: &Uuid, validation_type: VerificationCodeType) -> Result<String> {
        let six_digit_code = rand::random::<u32>() % 1_000_000;
        let code = format!("{:06}", six_digit_code);

        let now = chrono::Utc::now();
        let now_int = now.timestamp_micros();

        // no verification codes if the user is locked
        if self.has_tag(&user_id, "locked").await? {
            return Err(anyhow!("400 User is locked."));
        }

        sqlx::query("INSERT INTO verification_code (user_id, code, type, created_at, created_at_int) VALUES (?, ?, ?, ?, ?)")
            .bind(&user_id.to_string())
            .bind(code.clone())
            .bind(validation_type.to_string())
            .bind("email")
            .bind(now)
            .bind(now_int)
            .execute(&self.pool)
            .await?;

        self.clean_up_expired_verification_codes().await?;

        Ok(code.to_string())
    }

    // Clean up any verification codes that are older than an hour.
    async fn clean_up_expired_verification_codes(&self) -> Result<()> {

        let one_hour_in_micros = 3600 * 1_000_000; // 1 hour in microseconds
        let one_hour_ago_int = chrono::Utc::now().timestamp_micros() - one_hour_in_micros;

        sqlx::query("DELETE FROM verification_code WHERE created_at_int < ?")
            .bind(one_hour_ago_int)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    // Verify a code for a user. Returns an error if the code is invalid.
    pub async fn verify_code(&self, user_id: &Uuid, code: &str, validation_type: VerificationCodeType) -> Result<()> {

        let one_hour_in_micros = 3600 * 1_000_000; // 1 hour in microseconds
        let one_hour_ago_int = chrono::Utc::now().timestamp_micros() - one_hour_in_micros;

        // Do not allow verification codes if the user is locked
        if self.has_tag(&user_id, "locked").await? {
            return Err(anyhow!("400 User is locked."));
        }

        let result = sqlx::query("
            SELECT
                code FROM verification_code
            WHERE
                user_id = ?
                AND code = ?
                AND type = ?
                AND created_at_int > ?
            ORDER BY created_at_int DESC
            LIMIT 1")
            .bind(&user_id.to_string())
            .bind(code)
            .bind(validation_type.to_string())
            .bind(one_hour_ago_int)
            .fetch_optional(&self.pool)
            .await?;

        match result {
            Some(_) => {
                sqlx::query("DELETE FROM verification_code WHERE user_id = ? AND code = ? AND type = ?")
                    .bind(&user_id.to_string())
                    .bind(code)
                    .bind(validation_type.to_string())
                    .execute(&self.pool)
                    .await?;
                Ok(())
            },
            None => Err(anyhow!("400 Invalid code.")),
        }
    }


    pub async fn create_invite_code(&self, created_by: &Uuid, use_type: InviteCodeUseType) -> Result<Uuid> {
        let uuid = Uuid::new_v4();

        let now = chrono::Utc::now();
        let now_int = now.timestamp_micros();

        sqlx::query("INSERT INTO invite (
            invite_code,
            use_type,
            created_by,
            created_at,
            created_at_int)
            VALUES
            (?, ?, ?, ?, ?)")
            .bind(&uuid.to_string())
            .bind(use_type.to_string())
            .bind(&created_by.to_string())
            .bind(now)
            .bind(now_int)
            .execute(&self.pool)
            .await?;

        Ok(uuid)
    }

    pub async fn get_invite_code(&self, invite_code: &Uuid) -> Result<Option<InviteCode>> {
        let result = sqlx::query("
            SELECT
                use_type,
                created_by,
                created_at,
                created_at_int
            FROM
                invite
            WHERE
                invite_code = ?
            LIMIT 1")
            .bind(&invite_code.to_string())
            .fetch_optional(&self.pool)
            .await?;

        match result {
            Some(row) => {
                let use_type_string: String = row.try_get(0)?;
                let use_type_string: &str = &use_type_string;
                let use_type = InviteCodeUseType::from(use_type_string);
                Ok(Some(InviteCode {
                    invite_code: invite_code.clone(),
                    created_by: Uuid::parse_str(row.try_get(1)?)?,
                    use_type,
                    created_at: row.try_get(2)?,
                    created_at_int: row.try_get(3)?,
                }))
            },
            None => Ok(None),
        }
    }

    pub async fn get_invite_codes(&self) -> Result<Vec<InviteCode>> {
        // order these by created_at_int descending (newest first)
        let result = sqlx::query("
            SELECT
                invite_code,
                use_type,
                created_by,
                created_at,
                created_at_int
            FROM
                invite
            ORDER BY
                created_at_int
            DESC")
            .fetch_all(&self.pool)
            .await?;

        let mut invite_codes = vec![];
        for row in result {
            let invite_code: Uuid = Uuid::parse_str(row.try_get(0)?)?;
            let use_type_string: String = row.try_get(1)?;
            let use_type_string: &str = &use_type_string;
            let use_type = InviteCodeUseType::from(use_type_string);
            invite_codes.push(InviteCode {
                invite_code,
                use_type,
                created_by: Uuid::parse_str(row.try_get(2)?)?,
                created_at: row.try_get(3)?,
                created_at_int: row.try_get(4)?,
            });
        }

        Ok(invite_codes)
    }

    pub async fn get_invite_codes_for_user(&self, user_id: &Uuid) -> Result<Vec<InviteCode>> {
        // order these by created_at_int descending (newest first)
        let result = sqlx::query("
            SELECT
                invite_code,
                use_type,
                created_by,
                created_at,
                created_at_int
            FROM
                invite
            WHERE
                created_by = ?
            ORDER BY
                created_at_int
            DESC")
            .bind(&user_id.to_string())
            .fetch_all(&self.pool)
            .await?;

        let mut invite_codes = vec![];
        for row in result {
            let invite_code: Uuid = Uuid::parse_str(row.try_get(0)?)?;
            let use_type_string: String = row.try_get(1)?;
            let use_type_string: &str = &use_type_string;
            let use_type = InviteCodeUseType::from(use_type_string);
            invite_codes.push(InviteCode {
                invite_code,
                use_type,
                created_by: Uuid::parse_str(row.try_get(2)?)?,
                created_at: row.try_get(3)?,
                created_at_int: row.try_get(4)?,
            });
        }

        Ok(invite_codes)
    }

    pub async fn delete_invite_code(&self, invite_code: &Uuid) -> Result<()> {
        sqlx::query("DELETE FROM invite WHERE invite_code = ?")
            .bind(&invite_code.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn change_password(&self, user_id: &Uuid, new_password: &str) -> Result<()> {
        let password_hash = self.hash_password(new_password)?;

        tracing::info!("Changing password for user: {}", user_id);

        sqlx::query("
            UPDATE user
            SET
                password_hash = ?,
                updated_at = ?,
                updated_at_int = ?
            WHERE id = ?")
            .bind(&password_hash)
            .bind(&chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .bind(chrono::Utc::now().timestamp_micros())
            .bind(&user_id.to_string())
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    pub async fn change_email(&self, user_id: &Uuid, new_email: &str) -> Result<()> {
        let user = self.get_user(user_id).await?;
        let user_by_email = self.get_user_by_email(new_email).await?;

        match (user, user_by_email){
            (Some(_), Some(_)) => {
                return Err(anyhow!("400 Email already in use."));
            },
            (Some(_user), None) => {
                sqlx::query("
                    UPDATE user
                    SET
                        prospective_email = ?,
                        updated_at = ?,
                        updated_at_int = ?
                    WHERE id = ?")
                    .bind(&new_email)
                    .bind(&chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .bind(chrono::Utc::now().timestamp_micros())
                    .bind(&user_id.to_string())
                    .execute(&self.pool)
                    .await?;
                    Ok(())
            },
            (None, _) => Err(anyhow!("404 User not found.")),
        }
    }

    pub async fn change_phone(&self, user_id: &Uuid, new_phone: &str) -> Result<()> {
        let user = self.get_user(user_id).await?;
        let new_phone = normalize_phone_number(new_phone)?;
        let user_by_phone = self.get_user_by_phone_number(&new_phone).await?;


        match (user, user_by_phone){
            (Some(_), Some(_)) => {
                return Err(anyhow!("400 Phone number already in use."));
            },
            (Some(_user), None) => {
                sqlx::query("
                    UPDATE user
                    SET
                        prospective_phone = ?,
                        updated_at = ?,
                        updated_at_int = ?
                    WHERE id = ?")
                    .bind(&new_phone)
                    .bind(&chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true ))
                    .bind(chrono::Utc::now().timestamp_micros())
                    .bind(&user_id.to_string())
                    .execute(&self.pool)
                    .await?;
                    Ok(())
            },
            (None, _) => Err(anyhow!("404 User not found.")),
        }
    }

    pub async fn change_name(&self, user_id: &Uuid, new_name: &str) -> Result<()> {
        let user = self.get_user(user_id).await?;

        match user{
            Some(_user) => {
                let slug = self.get_valid_slug(new_name).await?;
                sqlx::query("
                    UPDATE user
                    SET
                        name = ?,
                        slug = ?,
                        updated_at = ?,
                        updated_at_int = ?
                    WHERE id = ?")
                    .bind(&new_name)
                    .bind(&slug)
                    .bind(&chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .bind(chrono::Utc::now().timestamp_micros())
                    .bind(&user_id.to_string())
                    .execute(&self.pool)
                    .await?;
                    Ok(())
            },
            None => Err(anyhow!("404 User not found.")),
        }
    }

    pub async fn update_last_login(&self, user_id: &Uuid) -> Result<()> {
        let now = chrono::Utc::now();
        let now_int = now.timestamp_micros();

        sqlx::query("UPDATE user SET last_login = ?, last_login_int = ? WHERE id = ?")
            .bind(&now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .bind(now_int)
            .bind(&user_id.to_string())
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    pub async fn lock_user(&self, user_id: &Uuid) -> Result<()> {
        // when a user is locked, we apply a tag to them that indicates they are locked
        self.add_tag(user_id, "locked").await?;

        // so long as they have that tag, they cannot log in
        // (we also, in a separate function, remove them from the session table, so they cannot use any existing sessions)
        Ok(())
    }

    pub async fn unlock_user(&self, user_id: &Uuid) -> Result<()> {
        // when a user is unlocked, we remove the locked tag
        self.remove_tag(user_id, "locked").await?;
        Ok(())
    }

    pub async fn admin_user(&self, user_id: &Uuid) -> Result<()> {
        // when a user is made an admin, we add the admin tag
        self.add_tag(user_id, "admin").await?;
        Ok(())
    }

    pub async fn remove_admin(&self, user_id: &Uuid) -> Result<()> {
        // when a user is removed as an admin, we remove the admin tag
        self.remove_tag(user_id, "admin").await?;
        Ok(())
    }

}

impl crate::event::EventListener for UserService {
    async fn on_event(&self, event: crate::event::EventEnvelope) -> Result<()> {
        // Handle events related to users here if needed.

        match event.event {
            Event::UserLogin {} => {
                if let Some(user_id) = event.user_id {
                    tracing::info!("User logged in: {}", user_id);
                    self.update_last_login(&user_id).await?;
                }
            },
            // when the user receives a message, send them an email notification
            Event::UserReceiveMessage { from, message_id } => {
                tracing::info!("User received message: {}", message_id);
                // get the services we need to send the email
                let email_service = self.registry.email_service();
                let community_service = self.registry.community_service();
                let community_slug = event.community_slug.ok_or_else(|| anyhow!("Event does not have a community slug"))?;
                let community_db = community_service.get_database(&community_slug).await?;
                let message_service = community_db.message_service;
                let message = message_service.get_message(&message_id).await?;
                let message = message.ok_or_else(|| anyhow!("Message not found"))?;
                let message_text = message.message.to_text();

                if let (Some(user_id), Some(from_user_id)) = (event.user_id, from) {
                    let user = self.get_user(&user_id).await?;
                    let from_user = self.get_user(&from_user_id).await?;
                    if let (Some(user), Some(from_user)) = (user, from_user) {
                        if let Some(email) = &user.email {
                            let subject = format!("New message from {}", from_user.name);
                            let message = format!("You have received a new message from {}:\n {}", from_user.name, message_text);
                            email_service.send_email(email, &subject, &message).await?;
                        }
                    }
                }
            },
            _ => {
                // we don't have any specific user-related events to handle yet
            },
        }

        Ok(())
    }
}

/*
    You might notice that this function is only valid for 10-digit phone numbers.
    This is because, for now, we are only supporting Canadian phone numbers.
*/
pub fn normalize_phone_number(phone_number: &str) -> Result<String> {

    // first, remove everything that's not a number:
    let mut normalized_phone_number = phone_number.chars().filter(|c| c.is_digit(10)).collect::<String>();

    // if the number is 11 digits long and starts with a 1, remove the 1
    if normalized_phone_number.len() == 11 && normalized_phone_number.starts_with("1") {
        normalized_phone_number = normalized_phone_number.chars().skip(1).collect();
    }

    // if the number is < 10 digits long, return an error
    if normalized_phone_number.len() < 10 {
        return Err(anyhow!("400 Invalid phone number."));
    }

    // if the number is > 10 digits long, return an error
    if normalized_phone_number.len() > 10 {
        return Err(anyhow!("400 Invalid phone number."));
    }

    Ok(normalized_phone_number)
}