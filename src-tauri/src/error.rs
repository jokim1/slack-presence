use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommandError {
    Message {
        message: String,
    },
    RateLimited {
        #[serde(rename = "retryAfterSeconds")]
        retry_after_seconds: u64,
    },
    Reauth {
        message: String,
    },
}

impl CommandError {
    pub fn message(message: impl Into<String>) -> Self {
        Self::Message {
            message: message.into(),
        }
    }

    pub fn reauth(message: impl Into<String>) -> Self {
        Self::Reauth {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message { message } | Self::Reauth { message } => formatter.write_str(message),
            Self::RateLimited {
                retry_after_seconds,
            } => write!(
                formatter,
                "Slack asked us to retry in {retry_after_seconds} seconds"
            ),
        }
    }
}

impl std::error::Error for CommandError {}

pub type CommandResult<T> = Result<T, CommandError>;
