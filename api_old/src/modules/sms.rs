use aws_config::{defaults, BehaviorVersion};
use aws_sdk_sns::Client;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use anyhow::{anyhow, Result};
use axum::extract::{Json, State};
use crate::AppState;
use crate::app_error::AppError;

#[derive(Debug, Clone)]
pub struct SmsService {
    client: Client,
    config: crate::app_config::Config,
    dump: Arc<Mutex<Vec<SmsDump>>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmsDump{
    pub phone_number: String,
    pub message: String,
}

impl SmsService {
    pub async fn new(config: crate::app_config::Config) -> Self {
        let aws_config = defaults(BehaviorVersion::latest()).load().await;

        let client = Client::new(&aws_config);

        Self {
            client,
            config,
            dump: Arc::new(Mutex::new(Vec::new())),
        }
    }

    // TODO:
    /*
TODO: the list of Canadian area codes is quite short, actually, so we can test a phone number's Canadian-ness
      by checking if the area code is in this list:

Alberta	403, 825, 780, 368, 587
British Columbia	250, 672, 604, 778, 236
Manitoba	431, 204, 584
New Brunswick	506, 428
Newfoundland	879, 709
Northwest Territories	867
Nova Scotia	902, 782
Nunavut	867
Ontario	548, 753, 683, 437, 365, 226, 613, 416, 289, 705, 905, 249, 647, 519, 343, 742, 382, 807
Prince Edward Island	902, 782
Quebec	354, 819, 263, 579, 581, 438, 367, 514, 418, 450, 873, 468
Saskatchewan	474, 639, 306
Yukon	867
     */

    pub async fn send_sms(&self, phone_number: &str, message: &str) -> Result<()> {

        // 7781234567 -> 17781234567
        // if the phone number is only 10 digits, assume it's a Canadian 10-digit number missing the country code and prepend 1
        let phone_number = if phone_number.len() == 10 && phone_number.chars().all(|c| c.is_digit(10)) {
            format!("1{}", phone_number)
        } else {
            phone_number.to_string()
        };

        if self.config.is_dev() {
            let mut dump = self.dump.lock().await;
            dump.push(SmsDump{
                phone_number: phone_number.to_string(),
                message: message.to_string(),
            });
            // if this has made the dump longer than 10 items, remove the first item
            if dump.len() > 50 {
                dump.remove(0);
            }
        }
        tracing::warn!("----------------------------");
        tracing::warn!("SMS to: {}", phone_number);
        tracing::warn!("Message: {}", message);
        tracing::warn!("----------------------------");

        if self.config.is_sms_enabled == false {
            return Ok(());
        }

        if phone_number.contains("8675309") ||
            phone_number.contains("7762323") ||
            phone_number.contains("2441139") ||
            phone_number.contains("123456") ||
            phone_number.contains("234567") ||
            phone_number.contains("345678") ||
            phone_number.contains("456789") ||
            phone_number.starts_with("1800") {
            // don't actually send the SMS if it's going to the example phone number
            return Ok(());
        }

        let request = self.client.publish()
            .phone_number(phone_number)
            .message(message)
            .send()
            .await?;

        match request.message_id {
            Some(_) => tracing::info!("Sent SMS with message ID: {}", request.message_id.unwrap()),
            None => tracing::info!("Sent SMS with no message ID"),
        }

        Ok(())
    }

    pub async fn send_verification_sms(&self, phone_number: &str, code: &str) -> Result<()> {
        let message = format!("Your verification code is: {}", code);

        self.send_sms(phone_number, &message).await
    }

    pub async fn dump(&self) -> Vec<SmsDump> {
        self.dump.lock().await.clone()
    }
}

// POST /test/sms
pub async fn test_sms(State(state): State<AppState>) -> Result<(), AppError> {
    let sms_service = state.sms_service;

    let to = state.config.personal_phone_number.unwrap_or("16048675309".to_string());
    let message = "Body: Hello, world!";

    sms_service.send_sms(&to, message).await?;

    Ok(())
}

// GET /test/sms
pub async fn dump_sms(State(state): State<AppState>) -> Result<Json<Vec<SmsDump>>, AppError> {

    if state.config.is_prod() {
        return Err(AppError(anyhow!("This endpoint is not available in production.")));
    }

    let sms_service = state.sms_service;
    let dump = sms_service.dump().await;

    Ok(Json(dump))
}