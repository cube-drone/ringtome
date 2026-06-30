
use std::sync::Arc;
use tokio::sync::mpsc;
use crate::AppState;
use crate::modules;
use crate::modules::{sms, email};

pub trait ServiceRegistry: Send + Sync {
    fn admin_service(&self) -> Arc<modules::admin::AdminService>;
    fn community_service(&self) -> Arc<modules::community::CommunityService>;
    fn session_service(&self) -> Arc<modules::session::SessionService>;
    fn sms_service(&self) -> Arc<sms::SmsService>;
    fn email_service(&self) -> Arc<email::EmailService>;
    fn scheduling_service(&self) -> Arc<modules::scheduler::ScheduleService>;
    fn rate_limiting_service(&self) -> Arc<modules::rate_limiting::RateLimitingService>;
    fn event_sender(&self) -> mpsc::Sender<crate::event::EventEnvelope>;
}

impl ServiceRegistry for AppState {
    fn admin_service(&self) -> Arc<modules::admin::AdminService> {
        Arc::new(self.admin_service.clone())
    }
    fn community_service(&self) -> Arc<modules::community::CommunityService> {
        Arc::new(self.community_service.clone())
    }
    fn session_service(&self) -> Arc<modules::session::SessionService> {
        Arc::new(self.session_service.clone())
    }
    fn sms_service(&self) -> Arc<sms::SmsService> {
        Arc::new(self.sms_service.clone())
    }
    fn email_service(&self) -> Arc<email::EmailService> {
        Arc::new(self.email_service.clone())
    }
    fn scheduling_service(&self) -> Arc<modules::scheduler::ScheduleService> {
        Arc::new(self.scheduling_service.clone())
    }
    fn rate_limiting_service(&self) -> Arc<modules::rate_limiting::RateLimitingService> {
        Arc::new(self.rate_limiting_service.clone())
    }
    fn event_sender(&self) -> mpsc::Sender<crate::event::EventEnvelope> {
        self.event_sender.clone()
    }
}
