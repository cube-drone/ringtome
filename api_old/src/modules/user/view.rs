use std::sync::Arc;
use anyhow::{Result, anyhow};
use uuid::Uuid;
use serde::{Serialize, Deserialize};
use sha2::{Sha256, Digest};

use crate::modules::session::Session;

use super::UserService;
use super::VerificationCodeType;
use crate::event::{CommunityEventSender, Event};
use crate::modules::user::{User, InviteCodeUseType};
use crate::request_context::RequestContext;
use crate::service_registry::ServiceRegistry;
use crate::app_config::Config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiUser{
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub email: Option<String>,
    pub phone_number: Option<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_login: String,
}

// The API User is visible to the user, while the User struct is used internally.
// here's where we convert from internal to external representation
//  (however: this is still too much personal information to share with OTHER users)
//  (however howerver: the "internal community" context means that users should probably be able to see each other's information)
//  (maybe we'll have a toggle for this in the future)
impl From<User> for ApiUser {
    fn from(user: User) -> Self {
        ApiUser {
            id: user.id,
            slug: user.slug,
            name: user.name,
            email: user.email,
            phone_number: user.phone_number,
            tags: user.tags,
            created_at: user.created_at,
            updated_at: user.updated_at,
            last_login: user.last_login,
        }
    }
}

impl ApiUser {
    fn email_hash(&self) -> Option<String> {
        // sha256 hash of the email address, if it exists
        match &self.email {
            Some(email) => {
                let result = Sha256::digest(email.as_bytes());
                // convert the hash to a hex string
                let result = format!("{:x}", result);
                Some(result)
            },
            None => None,
        }
    }

    pub fn anonymize(&self) -> Self {
        ApiUser {
            id: self.id,
            slug: self.slug.clone(),
            name: self.name.clone(),
            email: self.email_hash(),
            phone_number: None,
            tags: self.tags.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            last_login: self.last_login.clone(),
        }
    }
}

#[derive(Clone)]
pub struct UserView {
    config: Config,
    community_slug: String,
    user_service: UserService,
    registry: Arc<dyn ServiceRegistry>,
    event_sender: CommunityEventSender,
}

impl UserView {
    pub fn new(
        config: Config,
        community_slug: String,
        user_service: UserService,
        registry: Arc<dyn ServiceRegistry>,
        event_sender: CommunityEventSender,
    ) -> Self {
        Self {
            config,
            user_service,
            registry,
            event_sender,
            community_slug,
        }
    }

    // this is a helper function that will take a community slug and a user id and return a session
    pub async fn create_session(&self, user_id: &Uuid) -> Result<Session> {
        let community_service = self.registry.community_service();
        let session_service = self.registry.session_service();
        let user_service = community_service.get_database(&self.community_slug).await?.user_service;

        let community = community_service.get_slug(&self.community_slug).await?.ok_or(anyhow!("404 community not found"))?;
        let user = user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;
        let session = session_service.create_session(&community, &user).await?;

        Ok(session)
    }

    // users from the "admin" community are special super-admin users
    //  they can do anything in any community, and when they log into a community, an "owner" copy of their user is created within that community
    pub async fn create_superadmin_user(&self, user: &User) -> Result<()> {
        let user_service = self.user_service.clone();

        user_service.create_superadmin_user(user).await?;

        Ok(())
    }

    pub async fn create_and_send_verification_code(&self,
        user_id: &Uuid,
        validation_type: VerificationCodeType,
        ctx: Option<&RequestContext>) -> Result<String> {
        let code = self.user_service.create_verification_code(user_id, validation_type.clone()).await?;
        let user = self.user_service.get_user(user_id).await?;

        if !ctx.is_none(){
            let ctx = ctx.unwrap();
            self.registry.rate_limiting_service().ctx_limit_per_minute("create_verification_code", ctx, 4).await?;
        }

        match user {
            Some(user) => {
                match validation_type {
                    VerificationCodeType::Email => {
                        if let Some(email) = user.prospective_email {
                            self.registry.email_service().send_verification_email(&email, &user.slug, &user.id, &code).await?;
                            self.event_sender.send(
                                Event::UserSendVerificationEmail {},
                                Some(user_id.clone()),
                                ctx.cloned()
                            ).await?;
                        } else {
                            return Err(anyhow!("400 No prospective email to send verification code to."));
                        }
                    },
                    VerificationCodeType::Login => {
                        if let Some(email) = user.email {
                            self.registry.email_service().send_verification_email(&email, &user.slug, &user.id, &code).await?;
                            self.event_sender.send(
                                Event::UserSendLoginEmail {},
                                Some(user_id.clone()),
                                ctx.cloned()
                            ).await?;
                        } else {
                            return Err(anyhow!("400 No email to send login code to."));
                        }
                    },
                    VerificationCodeType::Phone => {
                        if let Some(phone_number) = user.prospective_phone_number {
                            self.registry.sms_service().send_verification_sms(&phone_number, &code).await?;
                            self.event_sender.send(
                                Event::UserSendVerificationSms {},
                                Some(user_id.clone()),
                                ctx.cloned()
                            ).await?;
                        } else {
                            return Err(anyhow!("400 No prospective phone number to send verification code to."));
                        }
                    },
                    VerificationCodeType::LoginSMS => {
                        if let Some(phone_number) = user.phone_number {
                            self.registry.sms_service().send_verification_sms(&phone_number, &code).await?;
                            self.event_sender.send(
                                Event::UserSendLoginSms {},
                                Some(user_id.clone()),
                                ctx.cloned()
                            ).await?;
                        } else {
                            return Err(anyhow!("400 No prospective phone number to send verification code to."));
                        }
                    },
                }
            },
            None => return Err(anyhow!("404 User not found.")),
        }

        Ok(code)
    }

    pub async fn complete_verification(&self, user_id: &Uuid, code: &str, verification_type: VerificationCodeType, ctx: &RequestContext) -> Result<()> {
        let user = self.user_service.get_user(user_id).await?;
        if user.is_none() {
            return Err(anyhow!("404 User not found."));
        }
        let user = user.unwrap();

        self.registry.rate_limiting_service().ctx_limit_per_minute("complete_verification", ctx, 10).await?;

        // this will throw an error if the code is invalid or can't be found
        self.user_service.verify_code(user_id, code, verification_type).await?;

        match verification_type {
            VerificationCodeType::Email => {
                self.user_service.verify_email(user_id).await?;
                self.event_sender.send(Event::UserEmailVerified {}, Some(user_id.clone()), Some(ctx.clone())).await?;
            },
            VerificationCodeType::Phone => {
                self.user_service.verify_sms(user_id).await?;
                self.event_sender.send(Event::UserPhoneVerified {}, Some(user_id.clone()), Some(ctx.clone())).await?;
            },
            _ => {}
        }

        // if the owner verifies their email or phone, we can also mark the community as verified!
        if user.tags.contains(&"owner".to_string()){
            let community_service = self.registry.community_service();
            community_service.verify_slug(&self.community_slug).await?;
        }

        Ok(())
    }

    pub async fn create_invite_code(&self, creator: &Uuid, use_type: InviteCodeUseType, ctx: &RequestContext) -> Result<Uuid> {
        let result_uuid = self.user_service.create_invite_code(creator, use_type).await?;

        self.event_sender.send(
            Event::UserCreateInviteCode {
                invite_code: result_uuid,
                use_type: use_type.to_string(),
            },
            Some(creator.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(result_uuid)
    }

    pub async fn delete_invite_code(&self, creator: &Uuid, invite_code: &Uuid, ctx: &RequestContext) -> Result<()> {
        self.user_service.delete_invite_code(invite_code).await?;

        self.event_sender.send(
            Event::UserDeleteInviteCode { invite_code: invite_code.clone() },
            Some(creator.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(())
    }

    pub async fn create_user(&self, invite_code: &Uuid, new_user: super::NewUser, ctx: &RequestContext) -> Result<Uuid> {
        let invite = self.user_service.get_invite_code(&invite_code).await?.ok_or(anyhow!("404 invite not found"))?;

        let user = self.user_service.create_user(new_user, false).await?;

        self.registry.rate_limiting_service().ctx_limit_per_minute("create", ctx, 1).await?;
        self.registry.rate_limiting_service().ctx_limit_per_day("create", ctx, 20).await?;

        if invite.use_type == InviteCodeUseType::Once {
            // once the invite is used, it's gone
            self.user_service.delete_invite_code(&invite_code).await?;
        }

        // check if the community is locked: if it is, throw an error
        let community_config = self.registry.community_service()
            .get_database(&self.community_slug).await?
            .community_settings_service.get_config().await?;

        println!("lock community: {}", community_config.lock_community.to_string());
        if community_config.lock_community {
            return Err(anyhow!("403 Community is locked, cannot create new users."));
        }

        // whoever was responsible for the invite, we want to track that they created this user
        // (later, we can use this to track invite chains)
        let source_user_id = invite.created_by.clone();
        let target_user_id = user.id.clone();
        self.user_service.create_invite_chain(&source_user_id, &target_user_id).await?;

        self.event_sender.send(
            Event::UserCreated {},
            Some(user.id.clone()),
            Some(ctx.clone())
        ).await?;

        // send the user who created this user a message
        let message_view = self.registry.community_service().get_database(&self.community_slug).await?.message_view;
        message_view.quick_link(
            &source_user_id,
            &target_user_id,
            "A user you invited to the community has signed up!".to_string(),
            format!("{}/community/{}/users/{}",
                    self.config.site_url,
                    self.community_slug,
                    user.slug).to_string(),
            Some(ctx)).await?;

        Ok(user.id)
    }

    pub async fn get_user(&self, user_id: &Uuid, session_user_id: &Uuid) -> Result<ApiUser> {
        let user = self.user_service.get_user(&user_id).await?;
        let user = user.ok_or(anyhow!("404 user not found"))?;
        let api_user: ApiUser = user.into();

        if session_user_id != user_id {
            Ok(api_user.anonymize())
        } else {
            Ok(api_user)
        }
    }

    pub async fn get_user_by_slug(&self, slug: &str, session_user_id: &Uuid) -> Result<ApiUser> {
        let user = self.user_service.get_user_by_slug(slug).await?;
        let user = user.ok_or(anyhow!("404 user not found"))?;
        let api_user: ApiUser = user.clone().into();

        if session_user_id != &user.id {
            Ok(api_user.anonymize())
        } else {
            Ok(api_user)
        }
    }

    pub async fn get_users(&self, session_user_id: &Uuid) -> Result<Vec<ApiUser>> {
        let users = self.user_service.get_users().await?;
        let mut api_users = Vec::new();

        for user in users {
            let api_user: ApiUser = user.into();
            if api_user.id != *session_user_id {
                api_users.push(api_user.anonymize());
            } else {
                api_users.push(api_user);
            }
        }

        Ok(api_users)
    }

    pub async fn get_admin_users(&self, session_user_id: &Uuid) -> Result<Vec<ApiUser>> {
        let users = self.user_service.get_admin_users().await?;
        let mut api_users = Vec::new();

        for user in users {
            let api_user: ApiUser = user.into();
            if api_user.id != *session_user_id {
                api_users.push(api_user.anonymize());
            } else {
                api_users.push(api_user);
            }
        }

        Ok(api_users)
    }

    pub async fn login(&self, email: Option<String>, phone_number: Option<String>, password: Option<String>, ctx: &RequestContext) -> Result<Session> {

        if email.is_none() && phone_number.is_none() {
            return Err(anyhow!("400 Must provide email or phone number to login."));
        }

        if password.is_none() {
            return Err(anyhow!("400 Must provide password to login."));
        }
        let password = password.unwrap();

        self.registry.rate_limiting_service().ctx_limit_per_minute("login", ctx, 5).await?;

        let user:User;
        if email.is_some() {
            let email = email.unwrap().to_lowercase();
            user = self.user_service.authenticate_email(&email, &password).await?;
        } else {
            let phone_number = phone_number.unwrap();
            user = self.user_service.authenticate_phone_number(&phone_number, &password).await?;
        }

        self.user_service.update_last_login(&user.id).await?;

        let session = self.create_session(&user.id).await?;

        self.event_sender.send(
            Event::UserLogin {},
            Some(user.id.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(session)
    }

    pub async fn logout(&self, session_key: &str, user_id: &Uuid, ctx: &RequestContext) -> Result<()> {
        let session_service = self.registry.session_service();

        session_service.delete_session(&session_key).await?;

        self.event_sender.send(
            Event::UserLogout { },
            Some(user_id.clone()),
            Some(ctx.clone())
        ).await?;
        Ok(())
    }

    pub async fn complete_token_login(&self, user_id: &Uuid, code: &str, ctx: &RequestContext) -> Result<Session> {
        let user = self.user_service.get_user(&user_id).await?;
        let user = match user{
            Some(user) => {
                user
            },
            None => {
                return Err(anyhow!("404 user not found"));
            }
        };

        self.registry.rate_limiting_service().ctx_limit_per_minute("token", ctx, 20).await?;

        // this will throw an error if the code is invalid or can't be found
        let resp1 = self.user_service.verify_code(&user_id, &code, VerificationCodeType::Login).await;
        let resp2 = self.user_service.verify_code(&user_id, &code, VerificationCodeType::LoginSMS).await;
        // if both fail, we return an error
        if resp1.is_err() && resp2.is_err() {
            return Err(anyhow!("400 Invalid code"));
        }
        let email_verified = resp1.is_ok();
        let phone_verified = resp2.is_ok();

        self.event_sender.send(
            Event::UserLogin {},
            Some(user_id.clone()),
            Some(ctx.clone())
        ).await?;

        if email_verified{
            self.event_sender.send(
                Event::UserEmailVerified {},
                Some(user_id.clone()),
                Some(ctx.clone())
            ).await?;
        }
        if phone_verified{
            self.event_sender.send(
                Event::UserPhoneVerified {},
                Some(user_id.clone()),
                Some(ctx.clone())
            ).await?;
        }

        // we don't mark the user as verified, that's not a part of this flow
        // but we do log the user in
        let session = self.create_session(&user_id).await?;

        if user.tags.contains(&"owner".to_string()){
            // if the owner verifies their phone, we can also mark the community as verified!
            let community_service = self.registry.community_service();
            community_service.verify(&session.community_id).await?;
        }

        Ok(session)
    }

    pub async fn delete_user(&self, deleted_by: &Uuid, user_id: &Uuid, ctx: &RequestContext) -> Result<()> {
        let user = self.user_service.get_user(user_id).await?.ok_or(anyhow!("404 user not found"))?;

        if user.tags.contains(&"owner".to_string()) {
            return Err(anyhow!("400 Cannot delete an owner."));
        }

        self.user_service.delete_user(user_id).await?;

        self.event_sender.send(
            Event::UserDeleted {
                admin_user_id: deleted_by.clone()
            },
            Some(user.id.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(())
    }

    pub async fn change_password(&self, user_id: &Uuid, new_password: &str, ctx: &RequestContext) -> Result<()> {
        self.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

        self.user_service.change_password(user_id, new_password).await?;

        self.event_sender.send(
            Event::UserPasswordChanged {},
            Some(user_id.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(())
    }

    pub async fn change_email(&self, user_id: &Uuid, new_email: &str, ctx: &RequestContext) -> Result<()> {
        let user = self.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

        self.user_service.change_email(user_id, new_email).await?;

        self.registry.rate_limiting_service().ctx_limit_per_minute("change_email", ctx, 4).await?;

        self.event_sender.send(
            Event::UserEmailChanged {},
            Some(user_id.clone()),
            Some(ctx.clone())
        ).await?;

        // When we change the email, we must also send a verification email to the new email address
        //  (it's just a "prospective" email until the user verifies it)
        let verification_code = self.user_service.create_verification_code(&user.id, VerificationCodeType::Email).await?;
        self.registry.email_service().send_verification_email(&new_email, &user.slug, &user.id, &verification_code).await?;

        Ok(())
    }

    pub async fn change_phone_number(&self, user_id: &Uuid, new_phone_number: &str, ctx: &RequestContext) -> Result<()> {
        let user = self.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

        self.user_service.change_phone(user_id, new_phone_number).await?;

        self.registry.rate_limiting_service().ctx_limit_per_minute("change_phone", ctx, 4).await?;
        self.registry.rate_limiting_service().ctx_limit_per_day("change_phone", ctx, 10).await?;

        self.event_sender.send(
            Event::UserPhoneChanged {},
            Some(user_id.clone()),
            Some(ctx.clone())
        ).await?;

        // When we change the phone number, we must also send a verification SMS to the new phone number
        //  (it's just a "prospective" phone number until the user verifies it)
        let verification_code = self.user_service.create_verification_code(&user.id, VerificationCodeType::Phone).await?;
        self.registry.sms_service().send_verification_sms(new_phone_number, &verification_code).await?;

        Ok(())
    }

    pub async fn change_name(&self, user_id: &Uuid, new_name: &str, ctx: &RequestContext) -> Result<()> {
        let _user = self.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

        self.user_service.change_name(user_id, new_name).await?;

        self.event_sender.send(
            Event::UserNameChanged {
                new_name: new_name.to_string(),
            },
            Some(user_id.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(())
    }

    pub async fn lock_user(&self, triggered_by: &Uuid, user_id: &Uuid, ctx: &RequestContext) -> Result<()> {
        let user = self.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

        if user.tags.contains(&"owner".to_string()) {
            return Err(anyhow!("400 Cannot lock an owner."));
        }

        self.user_service.lock_user(user_id).await?;

        self.event_sender.send(
            Event::UserLocked {
                admin_user_id: triggered_by.clone(),
            },
            Some(user.id.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(())
    }

    pub async fn unlock_user(&self, triggered_by: &Uuid, user_id: &Uuid, ctx: &RequestContext) -> Result<()> {
        let user = self.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

        self.user_service.unlock_user(user_id).await?;

        self.event_sender.send(
            Event::UserUnlocked {
                admin_user_id: triggered_by.clone(),
            },
            Some(user.id.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(())
    }

    pub async fn admin_user(&self, triggered_by: &Uuid, user_id: &Uuid, ctx: &RequestContext) -> Result<()> {
        let user = self.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

        if user.tags.contains(&"owner".to_string()) {
            return Err(anyhow!("400 Cannot admin an owner."));
        }

        self.user_service.admin_user(user_id).await?;

        self.event_sender.send(
            Event::UserAdmined {
                admin_user_id: triggered_by.clone(),
            },
            Some(user.id.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(())
    }

    pub async fn unadmin_user(&self, triggered_by: &Uuid, user_id: &Uuid, ctx: &RequestContext) -> Result<()> {
        let user = self.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

        if user.tags.contains(&"owner".to_string()) {
            return Err(anyhow!("400 Cannot unadmin an owner."));
        }

        self.user_service.remove_admin(user_id).await?;

        self.event_sender.send(
            Event::UserUnadmined {
                admin_user_id: triggered_by.clone(),
            },
            Some(user.id.clone()),
            Some(ctx.clone())
        ).await?;

        Ok(())
    }

}