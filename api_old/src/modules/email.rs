//! Email service for sending emails using AWS SESv2
//!
//! This service is used to send emails for various purposes, such as user verification, notifications, etc.
//! It uses the AWS SDK for Rust to interact with AWS SESv2.
//! It also includes a test endpoint to send a test email and a dump endpoint to view sent emails in development mode.
//!

use aws_config::{defaults, BehaviorVersion};
use aws_sdk_sesv2::{Client, types::builders::{DestinationBuilder, EmailContentBuilder, MessageBuilder, ContentBuilder, BodyBuilder}};
use anyhow::{anyhow, Result};
use std::sync::Arc;
use uuid::Uuid;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use axum::extract::{Json, State};
use crate::{AppState, AppError};

#[derive(Debug, Clone)]
pub struct EmailService {
    client: Client,
    config: crate::app_config::Config,
    dump: Arc<Mutex<Vec<EmailDump>>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EmailDump{
    pub to: String,
    pub subject: String,
    pub message: String,
}

impl EmailService {
    pub async fn new(config: crate::app_config::Config) -> Self {
        let aws_config = defaults(BehaviorVersion::latest()).load().await;

        let client = Client::new(&aws_config);

        Self {
            client,
            config,
            dump: Arc::new(Mutex::new(Vec::new())),
        }
    }

    // TODO: before sending an email, check if the email address is a valid email address
    //  (does the domain exist, does it have an MX record, etc.)
    // https://docs.rs/trust-dns-resolver/latest/trust_dns_resolver/
    /*
    use trust_dns_resolver::Resolver;
    use trust_dns_resolver::config::*;
    fn check_mx_record(domain: &str) -> bool {
        let resolver = Resolver::new(ResolverConfig::default(), ResolverOpts::default()).unwrap();
        resolver.lookup_mx(domain).is_ok()
    }
     */

    pub async fn send_email(&self, email: &str, subject: &str, message: &str) -> Result<()> {

        if self.config.is_dev() {
            let mut dump = self.dump.lock().await;
            dump.push(EmailDump{
                to: email.to_string(),
                subject: subject.to_string(),
                message: message.to_string(),
            });
            // if this has made the dump longer than 10 items, remove the first item
            if dump.len() > 50 {
                dump.remove(0);
            }
            tracing::warn!("----------------------------");
            tracing::warn!("Email to: {}", email);
            tracing::warn!("Subject: {}", subject);
            tracing::warn!("Message: {}", message);
            tracing::warn!("----------------------------");
        }

        if self.config.is_email_enabled == false {
            return Ok(());
        }

        if email.contains("example.com") {
            return Ok(());
        }

        if email.starts_with("info@") ||
           email.starts_with("contact@") ||
           email.starts_with("support@") ||
           email.starts_with("admin@") ||
           email.starts_with("noreply@") ||
           email.starts_with("hello@") ||
           email.starts_with("webmaster@") ||
           email.starts_with("postmaster@") ||
           email.starts_with("abuse@") ||
           email.starts_with("security@") ||
           email.starts_with("contact-us@") ||
           email.starts_with("contactus@") ||
           email.starts_with("sales@") {
            // don't send automated emails to these addresses
            return Err(anyhow!("Email address is not allowed."));
        }

        let from_email = self.config.email_address.clone();

        let destination = DestinationBuilder::default()
            .to_addresses(email)
            .build();

        let subject = ContentBuilder::default()
            .data(subject)
            .build()?;

        let text = ContentBuilder::default()
            .data(message)
            .build()?;

        let body = BodyBuilder::default()
            .text(text)
            .build();

        let message = MessageBuilder::default()
            .subject(subject)
            .body(body)
            .build();

        let content = EmailContentBuilder::default()
            .simple(message)
            .build();

        self.client.send_email()
            .destination(destination)
            .content(content.clone())
            .from_email_address(from_email.clone())
            .send()
            .await?;

        // for every mail, ALSO send a copy to the personal email address, if set
        // (this serves 2 purposes, 1- debugging, and 2- it helps to maintain SES sending reputation)
        if let Some(personal_email) = &self.config.personal_email_address {
            if personal_email != email {
                let destination = DestinationBuilder::default()
                    .to_addresses(personal_email)
                    .build();

                self.client.send_email()
                    .destination(destination)
                    .content(content)
                    .from_email_address(from_email)
                    .send()
                    .await?;
            }
        }

        Ok(())
    }

    pub async fn dump(&self) -> Vec<EmailDump> {
        let dump = self.dump.lock().await;
        let dump = dump.clone();
        dump
    }

    pub async fn send_verification_email(&self, email: &str, community_slug: &str, user_id: &Uuid, verification_code: &str) -> Result<()> {
        let subject = "Verify your email address";

        let verification_link = format!("{}/community/{}/verify/link?user_id={}&code={}", self.config.site_url, community_slug, user_id, verification_code);
        let message = format!("Your verification code is: {}\nLink: {}", verification_code, verification_link);

        self.send_email(email, subject, &message).await
    }

}

// POST /test/email
pub async fn test_email(State(state): State<AppState>) -> Result<(), AppError> {
    let email_service = state.email_service;

    let to = state.config.personal_email_address.unwrap_or("demo@example.com".to_string());
    let subject = "Subject";
    let message = "Body: Hello, world!";

    email_service.send_email(&to, subject, message).await?;

    Ok(())
}

// GET /test/email
pub async fn dump_email(State(state): State<AppState>) -> Result<Json<Vec<EmailDump>>, AppError> {

    if state.config.is_prod() {
        return Err(AppError(anyhow!("This endpoint is not available in production.")));
    }

    let email_service = state.email_service;
    let dump = email_service.dump().await;

    Ok(Json(dump))
}