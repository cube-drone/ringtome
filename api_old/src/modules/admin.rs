//! The Admin Service provides some useful admin/debug functionality
//!
//! The most obvious one is the ability to flush the event queue:
//!  when we're testing, sometimes we want to ensure that all events have been processed before we continue.
//!  that's what "flush_event_queue" does: it won't return until every event that was in the queue before it was called has been processed.

use tokio::sync::mpsc;
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::event::{EventEnvelope, Event, EventListener};

pub mod routes;

#[derive(Clone)]
pub struct AdminService {
    pub config: crate::app_config::Config,
    pub event_sender: mpsc::Sender<EventEnvelope>,
    pub flushed: Arc<Mutex<bool>>,
    pub donk_count: Arc<Mutex<u32>>,
}

impl AdminService {
    pub fn new(config: crate::app_config::Config, event_sender: mpsc::Sender<EventEnvelope>) -> Self {
        AdminService {
            config,
            event_sender,
            flushed: Arc::new(Mutex::new(true)),
            donk_count: Arc::new(Mutex::new(0))
        }
    }

    /// Most of the functions in the admin service are for testing and would not be good to make available to users.
    pub async fn bounce_if_production(&self) -> Result<()> {
        if self.config.is_prod() {
            tracing::warn!("Hit a local-only endpoint!");
            return Err(anyhow::anyhow!("This endpoint is not available in production"));
        }
        Ok(())
    }

    async fn begin_waiting_for_flush(&self) -> Result<()> {
        // This function can be used to wait for the event queue to be flushed
        let mut flushed = self.flushed.lock().await;
        *flushed = false;

        Ok(())
    }

    async fn successfully_flushed(&self) -> Result<()> {
        // This function can be used to signal that the event queue has been flushed
        let mut flushed = self.flushed.lock().await;
        *flushed = true;

        Ok(())
    }

    async fn is_flushed(&self) -> Result<bool> {
        // This function can be used to check if the event queue has been flushed
        let flushed = self.flushed.lock().await;
        Ok(*flushed)
    }

    async fn increment_donk_count(&self) -> Result<u32> {
        self.bounce_if_production().await?;
        // This function can be used to increment the donk count
        let mut count = self.donk_count.lock().await;
        *count += 1;
        Ok(*count)
    }

    pub async fn get_donk_count(&self) -> Result<u32> {
        self.bounce_if_production().await?;
        // This function can be used to get the current donk count
        let count = self.donk_count.lock().await;
        Ok(*count)
    }

    pub async fn reset_donk_count(&self) -> Result<()> {
        self.bounce_if_production().await?;
        // This function can be used to reset the donk count
        let mut count = self.donk_count.lock().await;
        *count = 0;
        Ok(())
    }

    pub async fn donk(&self) -> Result<()> {
        self.bounce_if_production().await?;
        // This function can be used to perform a "donk" action
        self.event_sender.send(EventEnvelope::new(
            Event::Donk {},
            None,
            None,
            None,
        )).await?;

        Ok(())
    }

    pub async fn flush_event_queue(&self) -> Result<()> {
        self.bounce_if_production().await?;
        // This function can be used to flush the event queue if needed
        tracing::info!("Flushing the event queue...");
        self.event_sender.send(EventEnvelope::new(
            Event::FlushQueue {},
            None,
            None,
            None,
        )).await?;

        // this puts a message in the event queue to flush it
        self.begin_waiting_for_flush().await?;
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

        // but now we refuse to return until the on_event method has been called
        // with a flush event (once that happens, everything that was in the event loop before we called this will have been processed)
        while !self.is_flushed().await? {
            tracing::info!("Waiting for event queue to be flushed...");
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }

        Ok(())
    }

    pub async fn start_test(&self, name: &str) -> Result<()> {
        self.bounce_if_production().await?;
        // This function can be used to start a test
        println!("------------------------------------------------------------------------------");
        println!("STARTING TEST: {}", name);
        println!("------------------------------------------------------------------------------");
        Ok(())
    }
}


impl EventListener for AdminService {
    async fn on_event(&self, event: EventEnvelope) -> Result<()> {
        // Handle events if necessary
        match event.event {
            Event::FlushQueue {} => {
                tracing::info!("Successfully flushed the event queue!");
                self.successfully_flushed().await?;
            }
            Event::Donk {} => {
                let count = self.increment_donk_count().await?;
                tracing::info!("Donk! Count: {}", count);
            }
            _ => {}
        }
        Ok(())
    }
}