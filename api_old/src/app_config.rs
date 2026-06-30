use std::env;
use std::path::PathBuf;
use serde::Serialize;

use crate::semver::semver_to_comparable_integer;

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub enum Environment{
    Prod,
    Dev,
}

#[derive(Debug, Clone)]
pub struct Config{
    pub app_version: String,                        // the current version of the app, e.g. "0.0.1"
    pub app_version_integer: u128,                  // a comparable integer version of the app version (for easy comparisons)
    pub max_files_open: u32,                        // max number of files we can have open at once (set this low on dev machines, high in prod)
                                                    //      remember to set your ulimits high in prod!
    pub port: u16,                                  // the port to listen on (default 5281)
    pub site_url: String,                           // the base URL for the site, e.g. "https://www.groovelet.com"
    pub data_directory: PathBuf,                    // where to store user and community data
    pub email_address: String,                      // the "from" address for emails sent by the system
    pub environment: Environment,                   // are we in prod or dev mode?
    pub personal_phone_number: Option<String>,      // if set, we can send error notifications to this number
    pub personal_email_address: Option<String>,     // if set, we can send error notifications to this address
    pub is_email_enabled: bool,                     // are we able to send email messages (i.e. are AWS keys set)
    pub is_sms_enabled: bool,                       // are we able to send SMS messages (i.e. are AWS keys set)
    pub audit_max_logs: u32,                        // max number of audit logs to keep per user
    pub rate_limiting_cache_size: u64,              // max number of entries to keep in the rate limiting cache
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicConfig{
    pub app_version: String,
    pub site_url: String,
    pub environment: Environment,
    pub data_directory: PathBuf,
    pub is_email_enabled: bool,
    pub is_sms_enabled: bool,
}

impl From<Config> for PublicConfig{
    fn from(config: Config) -> Self{
        Self{
            app_version: config.app_version,
            site_url: config.site_url,
            environment: config.environment,
            data_directory: config.data_directory,
            is_email_enabled: config.is_email_enabled,
            is_sms_enabled: config.is_sms_enabled,
        }
    }
}


impl Config {
    pub fn new() -> Self {

        let app_version = env::var("GROOVELET_APP_VERSION").unwrap_or_else(|_| "0.0.1".to_string());
        let app_version_integer = semver_to_comparable_integer(&app_version).unwrap();

        let port = env::var("GROOVELET_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(3000);

        // IN PRODUCTION WE CAN AND SHOULD SET THIS SUPER HIGH
        // but on macOS the default max files open is 256, which is not a lot
        // especially if we're testing a lot of communities and they each open a handful of files
        // (honestly, to make testing non-insane you should just fix the damn ulimits on your mac, but it's maybe good to
        //   have a lower default here anyway so that we CAN have some safety against runaway file usage)
        let max_files_open = env::var("GROOVELET_MAX_FILES_OPEN")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(1024);

        let data_directory = env::var("GROOVELET_DATA_DIRECTORY").unwrap_or_else(|_| "./data".to_string());
        let data_directory = PathBuf::from(data_directory);

        let email_address = env::var("GROOVELET_EMAIL_ADDRESS").unwrap_or_else(|_| "noreply@mail.groovelet.com".to_string());

        let site_url = env::var("GROOVELET_SITE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());

        let environment = match env::var("GROOVELET_ENVIRONMENT").unwrap_or_else(|_| "dev".to_string()).as_str() {
            "prod" => Environment::Prod,
            _ => Environment::Dev,
        };

        let personal_phone_number = env::var("GROOVELET_PERSONAL_PHONE_NUMBER").ok();
        let personal_email_address = env::var("GROOVELET_PERSONAL_EMAIL_ADDRESS").ok();

        // checking if AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set
        let is_email_enabled = env::var("AWS_ACCESS_KEY_ID").is_ok() && env::var("AWS_SECRET_ACCESS_KEY").is_ok();
        let is_sms_enabled = env::var("AWS_ACCESS_KEY_ID").is_ok() && env::var("AWS_SECRET_ACCESS_KEY").is_ok();

        let audit_max_logs = env::var("GROOVELET_AUDIT_MAX_LOGS")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(5000);

        Self {
            app_version,
            app_version_integer,
            max_files_open,
            port,
            site_url,
            data_directory,
            email_address,
            environment,
            personal_email_address,
            personal_phone_number,
            is_email_enabled,
            is_sms_enabled,
            audit_max_logs,
            rate_limiting_cache_size: 100000,
        }
    }

    pub fn is_dev(&self) -> bool {
        self.environment == Environment::Dev
    }
    pub fn is_prod(&self) -> bool {
        self.environment == Environment::Prod
    }
}