use std::sync::Arc;
use anyhow::{Result, anyhow};
use uuid::Uuid;

use super::{MessageService, MessageEnvelope, Message};
use super::PagingOptions;
use crate::event::{CommunityEventSender, Event};
use crate::request_context::RequestContext;
use crate::service_registry::ServiceRegistry;
use crate::app_config::Config;

#[derive(Clone)]
pub struct MessageView {
    _config: Config,
    community_slug: String,
    message_service: MessageService,
    registry: Arc<dyn ServiceRegistry>,
    event_sender: CommunityEventSender,
}

impl MessageView {
    pub fn new(
        config: Config,
        community_slug: String,
        message_service: MessageService,
        registry: Arc<dyn ServiceRegistry>,
        event_sender: CommunityEventSender,
    ) -> Self {
        Self {
            _config: config,
            message_service,
            registry,
            event_sender,
            community_slug,
        }
    }

    pub async fn send_message(
        &self,
        envelope: MessageEnvelope,
        is_admin: bool,
        ctx: Option<&RequestContext>,
    ) -> Result<()> {

        // Ensure the target user exists
        let community_service = self.registry.community_service();
        let user_service = community_service.get_database(&self.community_slug).await?.user_service.clone();
        let target_user = user_service.get_user(&envelope.user_id).await?;

        if target_user.is_none() {
            return Err(anyhow!("400 Target user does not exist"));
        }
        if !is_admin && !envelope.message.can_user_send() {
            return Err(anyhow!("400 User cannot send this type of message"));
        }

        self.message_service.send_message(envelope.clone()).await?;

        let envelope = envelope.clone();
        self.event_sender.send(
            Event::UserSendMessage {
                to: envelope.user_id.clone(),
                message_id: envelope.id.clone(),
            },
            envelope.source_user_id,
            ctx.cloned()
        ).await?;

        let envelope = envelope;
        self.event_sender.send(
            Event::UserReceiveMessage {
                from: envelope.source_user_id,
                message_id: envelope.id,
            },
            Some(envelope.clone().user_id),
            ctx.cloned()
        ).await?;

        Ok(())
    }

    pub async fn quick_message(
        &self,
        to_user_id: &Uuid,
        from_user_id: &Uuid,
        message: String,
        ctx: Option<&RequestContext>,
    ) -> Result<()> {
        let envelope = MessageEnvelope {
            id: Uuid::new_v4(),
            seen: false,
            user_id: to_user_id.clone(),
            source_user_id: Some(from_user_id.clone()),
            message: Message::Text { message },
            created_at: chrono::Utc::now().to_rfc3339(),
            created_at_int: chrono::Utc::now().timestamp_millis(),
        };
        self.send_message(envelope, false, ctx).await
    }

    pub async fn quick_link(
        &self,
        to_user_id: &Uuid,
        from_user_id: &Uuid,
        title: String,
        url: String,
        ctx: Option<&RequestContext>,
    ) -> Result<()> {
        let envelope = MessageEnvelope {
            id: Uuid::new_v4(),
            seen: false,
            user_id: to_user_id.clone(),
            source_user_id: Some(from_user_id.clone()),
            message: Message::Link {
                title: Some(title),
                url
            },
            created_at: chrono::Utc::now().to_rfc3339(),
            created_at_int: chrono::Utc::now().timestamp_millis(),
        };
        self.send_message(envelope, false, ctx).await
    }

    pub async fn get_message(
        &self,
        user_id: &Uuid,
        message_id: &Uuid,
    ) -> Result<Option<MessageEnvelope>> {
        let message_result = self.message_service.get_message(message_id).await;
        if let Ok(Some(msg)) = &message_result {
            if msg.user_id != *user_id {
                return Err(anyhow!("400 Message does not belong to the user"));
            }
        }
        message_result
    }

    pub async fn get_messages(
        &self,
        user_id: &Uuid,
        options: PagingOptions,
    ) -> Result<Vec<MessageEnvelope>> {
        self.message_service.get_messages(user_id, options).await
    }

    pub async fn get_messages_after(
        &self,
        user_id: &Uuid,
        after: i64,
        options: PagingOptions,
    ) -> Result<Vec<MessageEnvelope>> {
        self.message_service.get_messages_after(user_id, after, options).await
    }

    pub async fn get_message_history_between_users(
        &self,
        user_id: &Uuid,
        other_user_id: &Uuid,
        options: PagingOptions,
    ) -> Result<Vec<MessageEnvelope>> {
        self.message_service.get_message_history_between_users(user_id, other_user_id, options).await
    }

    pub async fn get_message_history_after(
        &self,
        user_id: &Uuid,
        other_user_id: &Uuid,
        after: i64,
        options: PagingOptions,
    ) -> Result<Vec<MessageEnvelope>> {
        self.message_service.get_message_history_after(user_id, other_user_id, after, options).await
    }

    pub async fn mark_message_as_seen(
        &self,
        message_id: &Uuid,
        user_id: &Uuid,
        ctx: Option<&RequestContext>,
    ) -> Result<()> {

        // Check if the message exists and belongs to the user
        let message = self.message_service.get_message(message_id).await?
            .ok_or(anyhow!("Message not found"))?;
        if message.user_id != *user_id {
            return Err(anyhow!("Message does not belong to the user"));
        }

        // Mark the message as seen in the database
        self.message_service.mark_message_as_seen(message_id).await?;

        // Send an event for the seen message
        self.event_sender.send(
            Event::UserSeeMessage {
                message_id: message_id.clone(),
            },
            Some(user_id.clone()),
            ctx.cloned()
        ).await?;

        Ok(())
    }

    pub async fn delete_message(
        &self,
        message_id: &Uuid,
        user_id: &Uuid,
        ctx: Option<&RequestContext>,
    ) -> Result<()> {

        // Check if the message exists and belongs to the user
        let envelope = self.message_service.get_message(message_id).await?
            .ok_or(anyhow!("Message not found"))?;
        if envelope.user_id != *user_id {
            return Err(anyhow!("Message does not belong to the user"));
        }

        // Delete the message from the database
        self.message_service.delete_message(message_id).await?;

        self.event_sender.send(
            Event::UserDeleteMessage {
                message_id: message_id.clone(),
            },
            Some(user_id.clone()),
            ctx.cloned()
        ).await?;

        Ok(())
    }

    pub async fn count_unseen_messages(
        &self,
        user_id: &Uuid,
    ) -> Result<i64> {
        self.message_service.count_unseen_messages(user_id).await
    }

    pub async fn count_unseen_messages_from_user(
        &self,
        user_id: &Uuid,
        other_user_id: &Uuid,
    ) -> Result<i64> {
        self.message_service.count_unseen_messages_from_user(user_id, other_user_id).await
    }
}