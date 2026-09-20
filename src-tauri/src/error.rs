use serde::{Serialize, Serializer};

/// Command-facing error. Anything that reaches the frontend is a plain message string —
/// never a token, never a file path we would rather not leak.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
}

impl AppError {
    pub fn msg(value: impl Into<String>) -> Self {
        AppError::Message(value.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        AppError::Message(value.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        AppError::Message(value.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        AppError::Message(value.to_string())
    }
}

pub type CmdResult<T> = Result<T, AppError>;
