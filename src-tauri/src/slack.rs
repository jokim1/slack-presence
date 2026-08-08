use std::{collections::HashMap, time::Duration};

use futures_util::{stream, StreamExt};
use reqwest::{header::RETRY_AFTER, Client};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::error::{CommandError, CommandResult};

const SLACK_API_ROOT: &str = "https://slack.com/api";
const PROFILE_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, Deserialize)]
pub struct SlackUser {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub is_bot: bool,
    #[serde(default)]
    pub is_app_user: bool,
    #[serde(default)]
    pub profile: SlackProfile,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct SlackProfile {
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub real_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub image_72: String,
}

#[derive(Default)]
pub struct ProfileCache {
    fetched_at: Option<std::time::Instant>,
    users: HashMap<String, SlackUser>,
}

impl ProfileCache {
    fn is_fresh(&self) -> bool {
        self.fetched_at
            .is_some_and(|fetched_at| fetched_at.elapsed() < PROFILE_CACHE_TTL)
            && !self.users.is_empty()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub is_private: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub display_name: String,
    pub title: String,
    pub avatar_url: String,
    pub presence: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceReply {
    pub user_id: String,
    pub presence: String,
}

#[derive(Debug, Deserialize)]
pub struct AuthTest {
    pub team_id: String,
    pub team: String,
}

#[derive(Deserialize)]
struct SlackEnvelope {
    ok: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ResponseMetadata {
    #[serde(default)]
    next_cursor: String,
}

#[derive(Deserialize)]
struct ChannelsResponse {
    channels: Vec<RawChannel>,
    response_metadata: Option<ResponseMetadata>,
}

#[derive(Deserialize)]
struct RawChannel {
    id: String,
    name: String,
    #[serde(default)]
    is_private: bool,
}

#[derive(Deserialize)]
struct MembersResponse {
    members: Vec<String>,
    response_metadata: Option<ResponseMetadata>,
}

#[derive(Deserialize)]
struct UsersResponse {
    members: Vec<SlackUser>,
    response_metadata: Option<ResponseMetadata>,
}

#[derive(Deserialize)]
struct UserInfoResponse {
    user: SlackUser,
}

#[derive(Deserialize)]
struct PresenceResponse {
    presence: String,
}

pub async fn list_channels(client: &Client, token: &str) -> CommandResult<Vec<Channel>> {
    let mut channels = Vec::new();
    let mut cursor = String::new();

    loop {
        let query = [
            ("types", "public_channel,private_channel".to_owned()),
            ("exclude_archived", "true".to_owned()),
            ("limit", "200".to_owned()),
            ("cursor", cursor.clone()),
        ];
        let response: ChannelsResponse =
            slack_get(client, token, "users.conversations", &query).await?;
        channels.extend(response.channels.into_iter().map(|channel| Channel {
            id: channel.id,
            name: channel.name,
            is_private: channel.is_private,
        }));
        cursor = next_cursor(response.response_metadata);
        if cursor.is_empty() {
            break;
        }
    }

    channels.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(channels)
}

pub async fn channel_members(
    client: &Client,
    token: &str,
    channel_id: &str,
    profile_cache: &RwLock<ProfileCache>,
) -> CommandResult<Vec<Member>> {
    let member_ids = list_member_ids(client, token, channel_id).await?;
    ensure_profiles(client, token, profile_cache).await?;

    let cached = profile_cache.read().await;
    let mut profiles = member_ids
        .iter()
        .filter_map(|id| cached.users.get(id).cloned().map(|user| (id.clone(), user)))
        .collect::<HashMap<_, _>>();
    drop(cached);

    let missing = member_ids
        .iter()
        .filter(|id| !profiles.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    let fetched = stream::iter(missing.into_iter().map(|id| async move {
        let user = user_info(client, token, &id).await?;
        Ok::<_, CommandError>((id, user))
    }))
    .buffer_unordered(5)
    .collect::<Vec<_>>()
    .await;

    let mut new_profiles = Vec::new();
    for result in fetched {
        let (id, user) = result?;
        profiles.insert(id.clone(), user.clone());
        new_profiles.push((id, user));
    }
    if !new_profiles.is_empty() {
        let mut cache = profile_cache.write().await;
        cache.users.extend(new_profiles);
    }

    let mut members = member_ids
        .into_iter()
        .filter_map(|id| profiles.remove(&id))
        .filter(|user| !user.deleted && !user.is_bot && !user.is_app_user)
        .map(|user| {
            let display_name = if !user.profile.display_name.trim().is_empty() {
                user.profile.display_name.clone()
            } else if !user.profile.real_name.trim().is_empty() {
                user.profile.real_name.clone()
            } else {
                user.name.clone()
            };
            Member {
                id: user.id,
                display_name,
                title: user.profile.title,
                avatar_url: user.profile.image_72,
                presence: "away",
            }
        })
        .collect::<Vec<_>>();
    members.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });
    Ok(members)
}

pub async fn get_presence(
    client: &Client,
    token: &str,
    user_id: String,
) -> CommandResult<PresenceReply> {
    let query = [("user", user_id.clone())];
    let response: PresenceResponse = slack_get(client, token, "users.getPresence", &query).await?;
    let presence = match response.presence.as_str() {
        "active" => "active",
        _ => "away",
    };
    Ok(PresenceReply {
        user_id,
        presence: presence.to_owned(),
    })
}

pub async fn auth_test(client: &Client, token: &str) -> CommandResult<AuthTest> {
    slack_get(client, token, "auth.test", &[]).await
}

async fn list_member_ids(
    client: &Client,
    token: &str,
    channel_id: &str,
) -> CommandResult<Vec<String>> {
    let mut members = Vec::new();
    let mut cursor = String::new();

    loop {
        let query = [
            ("channel", channel_id.to_owned()),
            ("limit", "200".to_owned()),
            ("cursor", cursor.clone()),
        ];
        let response: MembersResponse =
            slack_get(client, token, "conversations.members", &query).await?;
        members.extend(response.members);
        cursor = next_cursor(response.response_metadata);
        if cursor.is_empty() {
            return Ok(members);
        }
    }
}

async fn ensure_profiles(
    client: &Client,
    token: &str,
    cache: &RwLock<ProfileCache>,
) -> CommandResult<()> {
    if cache.read().await.is_fresh() {
        return Ok(());
    }

    let mut users = HashMap::new();
    let mut cursor = String::new();
    loop {
        let query = [("limit", "200".to_owned()), ("cursor", cursor.clone())];
        let response: UsersResponse = slack_get(client, token, "users.list", &query).await?;
        users.extend(
            response
                .members
                .into_iter()
                .map(|user| (user.id.clone(), user)),
        );
        cursor = next_cursor(response.response_metadata);
        if cursor.is_empty() {
            break;
        }
    }

    let mut cache = cache.write().await;
    cache.fetched_at = Some(std::time::Instant::now());
    cache.users = users;
    Ok(())
}

async fn user_info(client: &Client, token: &str, user_id: &str) -> CommandResult<SlackUser> {
    let query = [("user", user_id.to_owned())];
    let response: UserInfoResponse = slack_get(client, token, "users.info", &query).await?;
    Ok(response.user)
}

fn next_cursor(metadata: Option<ResponseMetadata>) -> String {
    metadata
        .map(|value| value.next_cursor)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

async fn slack_get<T: DeserializeOwned>(
    client: &Client,
    token: &str,
    method: &str,
    query: &[(&str, String)],
) -> CommandResult<T> {
    let response = client
        .get(format!("{SLACK_API_ROOT}/{method}"))
        .bearer_auth(token)
        .query(query)
        .send()
        .await
        .map_err(|_| CommandError::message("Could not reach Slack"))?;

    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after_seconds = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .unwrap_or(60);
        return Err(CommandError::RateLimited {
            retry_after_seconds,
        });
    }
    if !response.status().is_success() {
        return Err(CommandError::message(format!(
            "Slack returned HTTP {}",
            response.status().as_u16()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|_| CommandError::message("Slack returned an unreadable response"))?;
    let envelope: SlackEnvelope = serde_json::from_slice(&bytes)
        .map_err(|_| CommandError::message("Slack returned an unexpected response"))?;
    if !envelope.ok {
        return Err(slack_error(
            envelope.error.as_deref().unwrap_or("unknown_error"),
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| CommandError::message("Slack returned incomplete data"))
}

fn slack_error(code: &str) -> CommandError {
    match code {
        "invalid_auth" | "token_revoked" | "account_inactive" => {
            CommandError::reauth("Slack authorization expired. Reconnect the workspace.")
        }
        "missing_scope" => CommandError::message(
            "The Slack app is missing a required user scope. Update it and reconnect.",
        ),
        "channel_not_found" | "not_in_channel" => CommandError::message(
            "This channel is unavailable or you are no longer a member. Choose another channel.",
        ),
        _ => CommandError::message(format!("Slack API error: {code}")),
    }
}
