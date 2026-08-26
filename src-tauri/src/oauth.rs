use std::{collections::HashMap, process::Command, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use url::Url;
use uuid::Uuid;

use crate::{
    error::{CommandError, CommandResult},
    slack, AppState,
};

const USER_SCOPES: &str = "users:read,channels:read,groups:read,im:read,mpim:read";

#[derive(Clone)]
pub struct OAuthConfig {
    client_id: String,
    client_secret: String,
    pub redirect_uri: String,
}

impl OAuthConfig {
    pub fn from_env() -> Option<Self> {
        let client_id = std::env::var("PRESENCE_SLACK_CLIENT_ID").ok()?;
        let client_secret = std::env::var("PRESENCE_SLACK_CLIENT_SECRET").ok()?;
        let redirect_uri = std::env::var("PRESENCE_SLACK_REDIRECT_URI")
            .unwrap_or_else(|_| "http://127.0.0.1:53641/oauth/callback".to_owned());
        if client_id.trim().is_empty() || client_secret.trim().is_empty() {
            return None;
        }
        Some(Self {
            client_id,
            client_secret,
            redirect_uri,
        })
    }
}

#[derive(Clone, Serialize)]
struct OAuthEvent {
    ok: bool,
    message: String,
}

#[derive(Deserialize)]
struct OAuthResponse {
    ok: bool,
    error: Option<String>,
    authed_user: Option<AuthedUser>,
}

#[derive(Deserialize)]
struct AuthedUser {
    access_token: Option<String>,
}

pub async fn start(app: AppHandle) -> CommandResult<()> {
    let config = OAuthConfig::from_env().ok_or_else(|| {
        CommandError::message("Slack Client ID and Secret are not configured. See SETUP.md.")
    })?;
    let redirect = validate_redirect(&config.redirect_uri)?;
    let port = redirect
        .port_or_known_default()
        .ok_or_else(|| CommandError::message("The OAuth callback needs a port"))?;
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|_| CommandError::message("The OAuth callback port is already in use"))?;

    let state = Uuid::new_v4().to_string();
    let mut authorize = Url::parse("https://slack.com/oauth/v2/authorize")
        .map_err(|_| CommandError::message("Could not build the Slack authorization URL"))?;
    authorize.query_pairs_mut().extend_pairs([
        ("client_id", config.client_id.as_str()),
        ("user_scope", USER_SCOPES),
        ("redirect_uri", config.redirect_uri.as_str()),
        ("state", state.as_str()),
    ]);

    Command::new("open")
        .arg(authorize.as_str())
        .spawn()
        .map_err(|_| CommandError::message("Could not open the authorization page"))?;

    tauri::async_runtime::spawn(async move {
        let result = complete(listener, &app, config, state).await;
        let payload = match result {
            Ok(team_name) => OAuthEvent {
                ok: true,
                message: format!("Connected to {team_name}"),
            },
            Err(error) => OAuthEvent {
                ok: false,
                message: error.to_string(),
            },
        };
        let _ = app.emit("oauth://complete", payload);
    });
    Ok(())
}

async fn complete(
    listener: TcpListener,
    app: &AppHandle,
    config: OAuthConfig,
    expected_state: String,
) -> CommandResult<String> {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(180), listener.accept())
        .await
        .map_err(|_| CommandError::message("Slack authorization timed out. Try connecting again."))?
        .map_err(|_| CommandError::message("Could not receive the OAuth callback"))?;
    let callback = read_callback(&mut stream).await?;
    let result = handle_callback(app, config, expected_state, callback).await;
    let _ = write_browser_response(&mut stream, result.is_ok()).await;
    result
}

async fn read_callback(stream: &mut TcpStream) -> CommandResult<HashMap<String, String>> {
    let mut buffer = vec![0_u8; 16 * 1024];
    let bytes_read = stream
        .read(&mut buffer)
        .await
        .map_err(|_| CommandError::message("Could not read the OAuth callback"))?;
    let request = std::str::from_utf8(&buffer[..bytes_read])
        .map_err(|_| CommandError::message("The OAuth callback was invalid"))?;
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| CommandError::message("The OAuth callback was incomplete"))?;
    let callback = Url::parse(&format!("http://127.0.0.1{path}"))
        .map_err(|_| CommandError::message("The OAuth callback URL was invalid"))?;
    Ok(callback.query_pairs().into_owned().collect())
}

async fn handle_callback(
    app: &AppHandle,
    config: OAuthConfig,
    expected_state: String,
    callback: HashMap<String, String>,
) -> CommandResult<String> {
    if let Some(error) = callback.get("error") {
        return Err(CommandError::message(format!(
            "Slack authorization was not completed: {error}"
        )));
    }
    if callback.get("state") != Some(&expected_state) {
        return Err(CommandError::message(
            "OAuth state did not match. Start the connection again.",
        ));
    }
    let code = callback
        .get("code")
        .ok_or_else(|| CommandError::message("Slack did not return an authorization code"))?;

    let state = app.state::<AppState>();
    let oauth: OAuthResponse = state
        .client
        .post("https://slack.com/api/oauth.v2.access")
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", config.redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|_| CommandError::message("Could not exchange the Slack authorization code"))?
        .json()
        .await
        .map_err(|_| CommandError::message("Slack returned an unexpected OAuth response"))?;
    if !oauth.ok {
        return Err(CommandError::message(format!(
            "Slack OAuth error: {}",
            oauth.error.as_deref().unwrap_or("unknown_error")
        )));
    }
    let token = oauth
        .authed_user
        .and_then(|user| user.access_token)
        .filter(|token| token.starts_with("xoxp-"))
        .ok_or_else(|| CommandError::message("Slack did not return a user token"))?;

    let auth = slack::auth_test(&state.client, &token).await?;
    crate::adopt_workspace(&state, &auth.team_id, &auth.team, token).await?;
    Ok(auth.team)
}

fn validate_redirect(redirect_uri: &str) -> CommandResult<Url> {
    let redirect = Url::parse(redirect_uri)
        .map_err(|_| CommandError::message("PRESENCE_SLACK_REDIRECT_URI is invalid"))?;
    if redirect.scheme() != "http" || redirect.host_str() != Some("127.0.0.1") {
        return Err(CommandError::message(
            "The OAuth callback must use http://127.0.0.1",
        ));
    }
    Ok(redirect)
}

async fn write_browser_response(stream: &mut TcpStream, success: bool) -> std::io::Result<()> {
    let (title, detail) = if success {
        (
            "Connected",
            "You can close this tab and return to Presence for Slack.",
        )
    } else {
        (
            "Connection failed",
            "Return to Presence for Slack for details and try again.",
        )
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{margin:0;display:grid;place-items:center;min-height:100vh;background:#17181d;color:#f4f4f7;font:16px -apple-system,BlinkMacSystemFont,sans-serif}}main{{max-width:440px;padding:40px;text-align:center}}i{{display:inline-block;width:42px;height:42px;border-radius:14px;background:#7163df;margin-bottom:18px}}h1{{font-size:24px}}p{{color:#aaaab3;line-height:1.5}}</style><main><i></i><h1>{title}</h1><p>{detail}</p></main>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await
}
