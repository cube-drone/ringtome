use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use anyhow::{Result};
use uuid::Uuid;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::{Serialize, Deserialize};

use super::{LiveService, LiveEvent};

use crate::event::{CommunityEventSender, Event};
use crate::request_context::RequestContext;
use crate::service_registry::ServiceRegistry;
use crate::app_config::Config;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HelloMessage {
    pub message: String,
    pub connection_id: Uuid,
}

#[derive(Clone)]
pub struct LiveView {
    _config: Config,
    _community_slug: String,
    live_service: LiveService,
    _registry: Arc<dyn ServiceRegistry>,
    event_sender: CommunityEventSender,
}

impl LiveView {
    pub fn new(
        config: Config,
        community_slug: String,
        live_service: LiveService,
        registry: Arc<dyn ServiceRegistry>,
        event_sender: CommunityEventSender,
    ) -> Self {
        Self {
            _config: config,
            live_service,
            _registry: registry,
            event_sender,
            _community_slug: community_slug,
        }
    }

    pub async fn create_connection(&self, user_id: &Uuid, ctx: &RequestContext) -> Result<Uuid> {
        let connection_id = self.live_service.create_connection(&user_id).await?;

        self.event_sender.send(
            Event::UserConnected {
                connection_id: connection_id.clone(),
            },
            Some(user_id.clone()),
            Some(ctx.clone()),
        ).await?;

        Ok(connection_id)
    }

    pub async fn get_events_for_connection(&self, connection_id: &Uuid) -> Result<Vec<LiveEvent>> {
        let events = self.live_service.get_and_clear_events(connection_id).await?;
        Ok(events)
    }

    pub async fn handle_websocket_connection(
        &self,
        socket: WebSocket,
        user_id: &Uuid,
        ctx: &RequestContext,
    ) -> Result<()> {
        tracing::info!("Handling websocket connection for user_id: {}", user_id);

        let user_id = user_id.clone();
        let ping_interval = tokio::time::interval(std::time::Duration::from_secs(20));
        let timeout_interval = tokio::time::interval(std::time::Duration::from_secs(60));
        let live_check_interval = tokio::time::interval(std::time::Duration::from_millis(300));

        let connection_id = self.create_connection(&user_id, ctx).await?;
        let (mut sender, mut receiver) = socket.split();

        let pong_received = Arc::new(AtomicBool::new(true));

        let ponk_received = pong_received.clone();
        let reader = tokio::spawn(async move {
            // in general, we don't actually expect to receive messages from the client
            // so all we do here is log
            // although we do ping and pong to keep the connection alive
            while let Some(msg) = receiver.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        tracing::info!("Received text message from user {}: {}", user_id, text);
                        // Handle incoming text messages if needed
                    }
                    Ok(Message::Binary(bin)) => {
                        tracing::info!("Received binary message from user {}: {:?}", user_id, bin);
                        // Handle incoming binary messages if needed
                    }
                    Ok(Message::Close(_)) => {
                        tracing::info!("WebSocket connection closed for user {}", user_id);
                        break;
                    }
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                        ponk_received.store(true, Ordering::Relaxed);
                    }
                    Err(e) => {
                        tracing::error!("WebSocket error for user {}: {:?}", user_id, e);
                        break;
                    }
                }
            }
        });

        let this = self.clone();
        let pong_received = pong_received.clone();
        let writer = tokio::spawn(async move {
            let mut ping_interval = ping_interval;
            let mut live_check_interval = live_check_interval;
            let mut timeout_interval = timeout_interval;
            let mut missed_pongs = 0;

            // Send a hello message upon connection
            let hello_message = HelloMessage {
                message: "Hello!".to_string(),
                connection_id,
            };
            let hello_json = serde_json::to_string(&hello_message).unwrap_or_default();
            if sender.send(Message::Text(hello_json.into())).await.is_err() {
                tracing::info!("Failed to send hello message, closing connection for user {}", user_id);
                return;
            }

            loop {
                tokio::select! {
                    _ = live_check_interval.tick() => {
                        let events = this.get_events_for_connection(&connection_id).await.unwrap_or_default();
                        for event in events {
                            let msg = Message::Text(serde_json::to_string(&event).unwrap_or_default().into());
                            if sender.send(msg).await.is_err() {
                                tracing::info!("Failed to send event, closing connection for user {}", user_id);
                                return;
                            }
                        }
                    }
                    _ = ping_interval.tick() => {
                        let empty_bytes = vec![];
                        let ping = Message::Ping(empty_bytes.into());
                        pong_received.store(false, Ordering::Relaxed);
                        if sender.send(ping).await.is_err() {
                            tracing::info!("Failed to send ping, closing connection for user {}", user_id);
                            break;
                        }
                    }
                    _ = timeout_interval.tick() => {
                        let pong_received = pong_received.load(Ordering::Relaxed);
                        if !pong_received {
                            if missed_pongs >= 5 {
                                tracing::info!("No pong received after multiple attempts, closing connection for user {}", user_id);
                                break;
                            }
                            else{
                                missed_pongs += 1;
                            }
                        }
                        else{
                            missed_pongs = 0; // reset on successful pong
                        }
                    }
                }
            }
        });

        // TODO: I'm not sure exactly what's happening here with pinning and select, need to review
        tokio::pin!(reader);
        tokio::pin!(writer);

        tokio::select! {
            res = &mut reader => {
                // one finished first
                if let Err(e) = res { tracing::debug!("reader ended: {e}"); }
                writer.abort();                  // ok: &self method on pinned handle is fine
                let _ = (&mut writer).await;     // optional: drain it after abort
            }
            res = &mut writer => {
                if let Err(e) = res { tracing::debug!("writer ended: {e}"); }
                reader.abort();
                let _ = (&mut reader).await;     // optional
            }
        }

        Ok(())
    }

}