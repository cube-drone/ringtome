use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PagingOptions {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}
