//! Event system!
//!
//! So, every time something happens in the system, we create an EventEnvelope and run it through the event system.
//! This is a pipeline where hundreds of event_senders are passed hither and thither to every module and route
//! But there is one event receiver running in the background that listens to all events and processes them,
//! when they're processed, they're passed back through the gigantic State object, which means that every module
//! can both send and receive events.
//!
//! As an example of how this might be used, when a user is deleted, the "UserDeleted" event is sent.
//! Then, the session module listens for this event and deletes all sessions for that user.
//!
//! Because each module ALSO has a service registry, the User module could have just called the session service directly,
//! but hopefully this proves a more flexible and decoupled way for modules to react to things that have happened within one another.
//!
use uuid::Uuid;
use tokio::sync::mpsc;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use crate::request_context::RequestContext;


/// Because most Events have common fields, we define an EventEnvelope that wraps the Event,
/// so that we don't have to repeat those fields in every Event.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EventEnvelope {
    pub event: Event,
    pub community_slug: Option<String>,
    pub user_id: Option<Uuid>,
    pub timestamp: i64,
    pub correlation_id: Uuid,
    pub request_context: Option<crate::request_context::RequestContext>,
}

impl EventEnvelope {
    pub fn new(event: Event, user_id: Option<Uuid>, community_slug: Option<String>, request_context: Option<RequestContext>) -> Self {
        Self {
            event,
            community_slug,
            user_id,
            timestamp: chrono::Utc::now().timestamp_millis(),
            correlation_id: request_context.as_ref().map_or_else(Uuid::new_v4, |ctx| ctx.correlation_id),
            request_context,
        }
    }
}

/// The Event enum literally contains every single possible event that can happen in the system.
/// Ha ha, type safety!
#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum Event {
    FlushQueue {},
    Donk {},
    UserLogin {},
    UserLogout {},
    UserSendVerificationEmail {},
    UserSendVerificationSms {},
    UserSendLoginEmail {},
    UserSendLoginSms {},
    UserEmailVerified {},
    UserPhoneVerified {},
    UserCreateInviteCode {
        invite_code: Uuid,
        use_type: String,
    },
    UserDeleteInviteCode {
        invite_code: Uuid,
    },
    UserCreated {},
    UserDeleted {
        admin_user_id: Uuid,
    },
    UserPasswordChanged {},
    UserEmailChanged {},
    UserPhoneChanged {},
    UserNameChanged {
        new_name: String,
    },
    UserLocked {
        admin_user_id: Uuid,
    },
    UserUnlocked {
        admin_user_id: Uuid,
    },
    UserAdmined {
        admin_user_id: Uuid,
    },
    UserUnadmined {
        admin_user_id: Uuid,
    },
    UserTagAdded {
        tag: String,
    },
    UserTagRemoved {
        tag: String,
    },
    // MESSAGE BOYS
    UserSendMessage {
        to: Uuid,
        message_id: Uuid,
    },
    UserReceiveMessage {
        from: Option<Uuid>,
        message_id: Uuid,
    },
    UserDeleteMessage {
        message_id: Uuid,
    },
    UserSeeMessage {
        message_id: Uuid,
    },
    // LIVE SERVICES
    UserConnected {
        connection_id: Uuid,
    },
    // IMAGES
    UserImageUploaded {
        image_id: Uuid,
    },
    // TRAFFIC CONTROL FORM
    UserTrafficFormDeleted {
        form_id: Uuid,
    },
    UserTrafficFormStateChanged {
        form_id: Uuid,
        new_state: String,
    },
    // TIMING EVENTS
    Minutely {},
    FiveMinutely {},
    FifteenMinutely {},
    HalfHourly {},
    Hourly {},
    Daily {},
}

/// Something like 90% of events in our system are going to be community-specific, so we create a CommunityEventSender
/// with the community_slug baked in
/// to make it a tiny bit easier to send events that are specific to a community.
#[derive(Clone)]
pub struct CommunityEventSender {
    pub event_sender: mpsc::Sender<EventEnvelope>,
    pub community_slug: String,
}

impl CommunityEventSender {
    pub fn new(event_sender: mpsc::Sender<EventEnvelope>, community_slug: String) -> Self {
        Self {
            event_sender,
            community_slug,
        }
    }
    pub async fn send(&self,
        event: Event,
        user_id: Option<Uuid>,
        request_context: Option<RequestContext>) -> Result<()> {

        let envelope = EventEnvelope::new(
            event,
            user_id,
            Some(self.community_slug.clone()),
            request_context,
        );
        self.event_sender.send(envelope).await.map_err(|e| anyhow::anyhow!("Failed to send event: {}", e))?;
        Ok(())
    }
}

/// Enums are all well and good, but sometimes we want string representations of the events.
/// Also, the triggered_by field is only relevant for some events, so we can get triggered_by _optionally_ from those events.
impl Event {
    pub fn event_type(&self) -> &str {
        match self {
            Event::FlushQueue { .. } => "FlushQueue",
            Event::Donk { .. } => "Donk!",
            Event::UserLogin { .. } => "UserLogin",
            Event::UserLogout { .. } => "UserLogout",
            Event::UserSendVerificationEmail { .. } => "UserSendVerificationEmail",
            Event::UserSendVerificationSms { .. } => "UserSendVerificationSms",
            Event::UserSendLoginEmail { .. } => "UserSendLoginEmail",
            Event::UserSendLoginSms { .. } => "UserSendLoginSms",
            Event::UserPhoneVerified { .. } => "UserPhoneVerified",
            Event::UserEmailVerified { .. } => "UserEmailVerified",
            Event::UserCreateInviteCode { .. } => "UserCreateInviteCode",
            Event::UserDeleteInviteCode { .. } => "UserDeleteInviteCode",
            Event::UserCreated { .. } => "UserCreated",
            Event::UserDeleted { .. } => "UserDeleted",
            Event::UserPasswordChanged { .. } => "UserPasswordChanged",
            Event::UserEmailChanged { .. } => "UserEmailChanged",
            Event::UserPhoneChanged { .. } => "UserPhoneChanged",
            Event::UserNameChanged { .. } => "UserNameChanged",
            Event::UserLocked { .. } => "UserLocked",
            Event::UserUnlocked { .. } => "UserUnlocked",
            Event::UserAdmined { .. } => "UserAdmined",
            Event::UserUnadmined { .. } => "UserUnadmined",
            Event::UserTagAdded { .. } => "UserTagAdded",
            Event::UserTagRemoved { .. } => "UserTagRemoved",
            Event::UserSendMessage { .. } => "UserSendMessage",
            Event::UserReceiveMessage { .. } => "UserReceiveMessage",
            Event::UserDeleteMessage { .. } => "UserDeleteMessage",
            Event::UserSeeMessage { .. } => "UserSeeMessage",
            Event::UserConnected { .. } => "UserConnected",
            Event::UserImageUploaded { .. } => "UserImageUploaded",
            Event::UserTrafficFormDeleted { .. } => "UserTrafficFormDeleted",
            Event::UserTrafficFormStateChanged { .. } => "UserTrafficFormStateChanged",
            Event::Minutely { .. } => "Minutely",
            Event::FiveMinutely { .. } => "FiveMinutely",
            Event::FifteenMinutely { .. } => "FifteenMinutely",
            Event::HalfHourly { .. } => "HalfHourly",
            Event::Hourly { .. } => "Hourly",
            Event::Daily { .. } => "Daily",
        }
    }
    pub fn event_description(&self) -> &str {
        match self {
            Event::FlushQueue { .. } => "Flushed the event queue",
            Event::Donk { .. } => "DONK!",
            Event::UserLogin { .. } => "User logged in",
            Event::UserLogout { .. } => "User logged out",
            Event::UserSendVerificationEmail { .. } => "Sent verification email",
            Event::UserSendVerificationSms { .. } => "Sent verification SMS",
            Event::UserSendLoginEmail { .. } => "Sent login email",
            Event::UserSendLoginSms { .. } => "Sent login SMS",
            Event::UserPhoneVerified { .. } => "Verified phone number",
            Event::UserEmailVerified { .. } => "Verified email address",
            Event::UserCreateInviteCode { .. } => "Created invite code",
            Event::UserDeleteInviteCode { .. } => "Deleted invite code",
            Event::UserCreated { .. } => "Created user",
            Event::UserDeleted { .. } => "Deleted user",
            Event::UserPasswordChanged { .. } => "Changed password",
            Event::UserEmailChanged { .. } => "Changed email address",
            Event::UserPhoneChanged { .. } => "Changed phone number",
            Event::UserNameChanged { .. } => "Changed name",
            Event::UserLocked { .. } => "Locked user account",
            Event::UserUnlocked { .. } => "Unlocked user account",
            Event::UserAdmined { .. } => "Granted admin privileges",
            Event::UserUnadmined { .. } => "Revoked admin privileges",
            Event::UserTagAdded { .. } => "Added user tag",
            Event::UserTagRemoved { .. } => "Removed user tag",
            Event::UserSendMessage { .. } => "Sent message to user",
            Event::UserReceiveMessage { .. } => "Received message from user",
            Event::UserDeleteMessage { .. } => "Deleted message",
            Event::UserSeeMessage { .. } => "Marked message as seen",
            Event::UserConnected { .. } => "User connected to live service",
            Event::UserImageUploaded { .. } => "Uploaded image",
            Event::UserTrafficFormDeleted { .. } => "Deleted traffic control form",
            Event::UserTrafficFormStateChanged { .. } => "Changed traffic control form state",
            Event::Minutely { .. } => "Minutely scheduled event",
            Event::FiveMinutely { .. } => "Five-minute scheduled event",
            Event::FifteenMinutely { .. } => "Fifteen-minute scheduled event",
            Event::HalfHourly { .. } => "Half-hourly scheduled event",
            Event::Hourly { .. } => "Hourly scheduled event",
            Event::Daily { .. } => "Daily scheduled event",
        }
    }
    pub fn event_system(&self) -> &str {
        match self {
            Event::FlushQueue { .. } => "system",
            Event::Donk { .. } => "system",
            Event::UserLogin { .. } => "user",
            Event::UserLogout { .. } => "user",
            Event::UserSendVerificationEmail { .. } => "user",
            Event::UserSendVerificationSms { .. } => "user",
            Event::UserSendLoginEmail { .. } => "user",
            Event::UserSendLoginSms { .. } => "user",
            Event::UserPhoneVerified { .. } => "user",
            Event::UserEmailVerified { .. } => "user",
            Event::UserCreateInviteCode { .. } => "user",
            Event::UserDeleteInviteCode { .. } => "user",
            Event::UserCreated { .. } => "user",
            Event::UserDeleted { .. } => "user",
            Event::UserPasswordChanged { .. } => "user",
            Event::UserEmailChanged { .. } => "user",
            Event::UserPhoneChanged { .. } => "user",
            Event::UserNameChanged { .. } => "user",
            Event::UserLocked { .. } => "user",
            Event::UserUnlocked { .. } => "user",
            Event::UserAdmined { .. } => "user",
            Event::UserUnadmined { .. } => "user",
            Event::UserTagAdded { .. } => "user",
            Event::UserTagRemoved { .. } => "user",
            Event::UserSendMessage { .. } => "message",
            Event::UserReceiveMessage { .. } => "message",
            Event::UserDeleteMessage { .. } => "message",
            Event::UserSeeMessage { .. } => "message",
            Event::UserConnected { .. } => "live",
            Event::UserImageUploaded { .. } => "image",
            Event::UserTrafficFormDeleted { .. } => "traffic_control_form",
            Event::UserTrafficFormStateChanged { .. } => "traffic_control_form",
            Event::Minutely { .. } => "scheduler",
            Event::FiveMinutely { .. } => "scheduler",
            Event::FifteenMinutely { .. } => "scheduler",
            Event::HalfHourly { .. } => "scheduler",
            Event::Hourly { .. } => "scheduler",
            Event::Daily { .. } => "scheduler",
        }
    }
    pub fn triggered_by(&self) -> Option<Uuid> {
        // some events are triggered by an admin user, we can return that user_id
        match self {
            Event::UserDeleted { admin_user_id } => Some(*admin_user_id),
            Event::UserLocked { admin_user_id } => Some(*admin_user_id),
            Event::UserUnlocked { admin_user_id } => Some(*admin_user_id),
            Event::UserAdmined { admin_user_id } => Some(*admin_user_id),
            Event::UserUnadmined { admin_user_id } => Some(*admin_user_id),
            _ => None,
        }
    }
    pub fn should_audit(&self) -> bool {
        // Some events are not logged, like FlushQueue and Donk
        match self {
            Event::FlushQueue { .. } => false,
            Event::Donk { .. } => false,
            Event::UserReceiveMessage { .. } => false,
            Event::UserSendMessage { .. } => false,
            Event::UserDeleteMessage { .. } => false,
            Event::UserSeeMessage { .. } => false,
            Event::UserConnected { .. } => false,
            Event::UserImageUploaded { .. } => false,
            Event::Minutely { .. } => false,
            Event::FiveMinutely { .. } => false,
            Event::FifteenMinutely { .. } => false,
            Event::HalfHourly { .. } => false,
            Event::Hourly { .. } => false,
            Event::Daily { .. } => false,
            _ => true,
        }
    }
}

pub trait EventListener {
    async fn on_event(&self, event: EventEnvelope) -> Result<()>;
}
