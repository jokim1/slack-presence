use std::{collections::HashMap, process::Command, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use url::Url;
use uuid::Uuid;

use crate::{
    error::{CommandError, CommandResult},
    settings::Settings,
    slack, AppState,
};

const USER_SCOPES: &str = "users:read,channels:read,groups:read,im:read,mpim:read";
pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:53641/oauth/callback";
pub const DEFAULT_SLACK_CLIENT_ID: &str = "";
pub const DEFAULT_OAUTH_EXCHANGE_URL: &str =
    "https://presence-for-slack-oauth.workers.dev/oauth/exchange";

#[derive(Clone)]
pub struct OAuthConfig {
    client_id: String,
    client_secret: Option<String>,
    exchange_url: Option<String>,
    pub redirect_uri: String,
}

impl OAuthConfig {
    pub fn from_settings(settings: &Settings) -> Option<Self> {
        Self::from_values(
            first_filled([
                settings.slack_client_id.clone(),
                std::env::var("PRESENCE_SLACK_CLIENT_ID").ok(),
                Some(DEFAULT_SLACK_CLIENT_ID.to_owned()),
            ]),
            first_filled([
                settings.slack_client_secret.clone(),
                std::env::var("PRESENCE_SLACK_CLIENT_SECRET").ok(),
            ]),
            first_filled([
                settings.slack_oauth_exchange_url.clone(),
                std::env::var("PRESENCE_SLACK_OAUTH_EXCHANGE_URL").ok(),
                Some(DEFAULT_OAUTH_EXCHANGE_URL.to_owned()),
            ]),
            std::env::var("PRESENCE_SLACK_REDIRECT_URI")
                .ok()
                .and_then(nonempty)
                .unwrap_or_else(|| DEFAULT_REDIRECT_URI.to_owned()),
        )
    }

    pub fn from_values(
        client_id: Option<String>,
        client_secret: Option<String>,
        exchange_url: Option<String>,
        redirect_uri: String,
    ) -> Option<Self> {
        let client_id = client_id.filter(|value| !is_placeholder_client_id(value))?;
        let client_secret = client_secret.filter(|value| !is_placeholder_secret(value));
        let exchange_url = exchange_url.filter(|value| !value.trim().is_empty());
        if client_secret.is_none() && exchange_url.is_none() {
            return None;
        }
        Some(Self {
            client_id,
            client_secret,
            exchange_url,
            redirect_uri,
        })
    }

    pub fn uses_hosted_exchange(&self) -> bool {
        self.client_secret.is_none() && self.exchange_url.is_some()
    }

    pub fn public_client_id(&self) -> &str {
        &self.client_id
    }

    pub fn exchange_url(&self) -> Option<&str> {
        self.exchange_url.as_deref()
    }

    pub fn has_client_secret(&self) -> bool {
        self.client_secret.is_some()
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
    access_token: Option<String>,
    authed_user: Option<AuthedUser>,
}

#[derive(Deserialize)]
struct AuthedUser {
    access_token: Option<String>,
}

pub async fn start(app: AppHandle) -> CommandResult<()> {
    let state = app.state::<AppState>();
    let settings = state.settings.read()?;
    let config = OAuthConfig::from_settings(&settings).ok_or_else(|| {
        CommandError::message(
            "Slack is not configured. Add a Client ID and Secret in Settings to connect.",
        )
    })?;
    drop(settings);

    let redirect = validate_redirect(&config.redirect_uri)?;
    let port = redirect
        .port_or_known_default()
        .ok_or_else(|| CommandError::message("The OAuth callback needs a port"))?;
    {
        let abort = state
            .oauth_abort
            .lock()
            .map_err(|_| CommandError::message("Could not start Slack authorization"))?;
        if abort.is_some() {
            return Err(CommandError::message(
                "Authorization is already in progress. Finish it in your browser or cancel.",
            ));
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|_| {
            CommandError::message(
                "Authorization is already in progress, or the OAuth callback port is in use. Finish it in your browser, cancel, or try again shortly.",
            )
        })?;

    let state_token = Uuid::new_v4().to_string();
    let mut authorize = Url::parse("https://slack.com/oauth/v2/authorize")
        .map_err(|_| CommandError::message("Could not build the Slack authorization URL"))?;
    authorize.query_pairs_mut().extend_pairs([
        ("client_id", config.client_id.as_str()),
        ("user_scope", USER_SCOPES),
        ("redirect_uri", config.redirect_uri.as_str()),
        ("state", state_token.as_str()),
    ]);

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut abort = state
            .oauth_abort
            .lock()
            .map_err(|_| CommandError::message("Could not start Slack authorization"))?;
        if abort.is_some() {
            return Err(CommandError::message(
                "Authorization is already in progress. Finish it in your browser or cancel.",
            ));
        }
        *abort = Some(cancel_tx);
    }

    Command::new("open")
        .arg(authorize.as_str())
        .spawn()
        .map_err(|_| {
            let _ = take_oauth_abort(&app);
            CommandError::message("Could not open the authorization page")
        })?;

    tauri::async_runtime::spawn(async move {
        let result = complete(listener, &app, config, state_token, cancel_rx).await;
        let _ = take_oauth_abort(&app);
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

pub fn cancel(app: &AppHandle) -> CommandResult<()> {
    match take_oauth_abort(app) {
        Some(sender) => {
            let _ = sender.send(());
            Ok(())
        }
        None => Err(CommandError::message("No Slack authorization is in progress")),
    }
}

pub fn in_progress(state: &AppState) -> bool {
    state
        .oauth_abort
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

fn take_oauth_abort(app: &AppHandle) -> Option<oneshot::Sender<()>> {
    app.state::<AppState>()
        .oauth_abort
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

async fn complete(
    listener: TcpListener,
    app: &AppHandle,
    config: OAuthConfig,
    expected_state: String,
    mut cancel: oneshot::Receiver<()>,
) -> CommandResult<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(CommandError::message(
                "Slack authorization timed out. Try connecting again.",
            ));
        }
        let accepted = tokio::select! {
            _ = &mut cancel => {
                return Err(CommandError::message("Slack authorization was cancelled."));
            }
            accepted = tokio::time::timeout(deadline - now, listener.accept()) => accepted,
        };
        let (mut stream, _) = accepted
            .map_err(|_| {
                CommandError::message("Slack authorization timed out. Try connecting again.")
            })?
            .map_err(|_| CommandError::message("Could not receive the OAuth callback"))?;
        let callback = match read_callback(&mut stream).await {
            Ok(params) if is_oauth_callback(&params) => params,
            Ok(_) | Err(_) => continue,
        };
        let result = handle_callback(app, config, expected_state, callback).await;
        let _ = write_browser_response(&mut stream, result.is_ok()).await;
        return result;
    }
}

fn is_oauth_callback(callback: &HashMap<String, String>) -> bool {
    callback.contains_key("code")
        || callback.contains_key("error")
        || callback.contains_key("state")
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
    let token = exchange_code(&state.client, &state.exchange_client, &config, code).await?;
    let auth = slack::auth_test(&state.client, &token).await?;
    crate::adopt_workspace(&state, &auth.team_id, &auth.team, token).await?;
    Ok(auth.team)
}

pub(crate) async fn exchange_code(
    slack_client: &reqwest::Client,
    exchange_client: &reqwest::Client,
    config: &OAuthConfig,
    code: &str,
) -> CommandResult<String> {
    let oauth = if let Some(secret) = &config.client_secret {
        slack_client
            .post("https://slack.com/api/oauth.v2.access")
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("client_secret", secret.as_str()),
                ("code", code),
                ("redirect_uri", config.redirect_uri.as_str()),
            ])
            .send()
            .await
            .map_err(|_| CommandError::message("Could not exchange the Slack authorization code"))?
            .json()
            .await
            .map_err(|_| CommandError::message("Slack returned an unexpected OAuth response"))?
    } else {
        let exchange_url = config.exchange_url.as_deref().ok_or_else(|| {
            CommandError::message("Slack is not configured. Add credentials in Settings.")
        })?;
        validate_exchange_url(exchange_url)?;
        exchange_client
            .post(exchange_url)
            .json(&serde_json::json!({
                "code": code,
                "redirect_uri": config.redirect_uri,
            }))
            .send()
            .await
            .map_err(|_| {
                CommandError::message("Could not reach the Slack OAuth exchange service")
            })?
            .json()
            .await
            .map_err(|_| {
                CommandError::message("The Slack OAuth exchange service returned an unexpected response")
            })?
    };

    token_from_oauth(oauth)
}

fn token_from_oauth(oauth: OAuthResponse) -> CommandResult<String> {
    if !oauth.ok {
        return Err(CommandError::message(format!(
            "Slack OAuth error: {}",
            oauth.error.as_deref().unwrap_or("unknown_error")
        )));
    }
    oauth
        .access_token
        .filter(|token| token.starts_with("xoxp-"))
        .or_else(|| {
            oauth
                .authed_user
                .and_then(|user| user.access_token)
                .filter(|token| token.starts_with("xoxp-"))
        })
        .ok_or_else(|| CommandError::message("Slack did not return a user token"))
}

pub fn validate_redirect(redirect_uri: &str) -> CommandResult<Url> {
    let redirect = Url::parse(redirect_uri)
        .map_err(|_| CommandError::message("The OAuth callback URL is invalid"))?;
    if redirect.scheme() != "http" || redirect.host_str() != Some("127.0.0.1") {
        return Err(CommandError::message(
            "The OAuth callback must use http://127.0.0.1",
        ));
    }
    Ok(redirect)
}

pub fn validate_exchange_url(exchange_url: &str) -> CommandResult<Url> {
    let url = Url::parse(exchange_url)
        .map_err(|_| CommandError::message("The OAuth exchange URL is invalid"))?;
    let https = url.scheme() == "https";
    let loopback_http = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if !https && !loopback_http {
        return Err(CommandError::message(
            "The OAuth exchange URL must be https, or http on 127.0.0.1 for local development",
        ));
    }
    Ok(url)
}

async fn write_browser_response(stream: &mut TcpStream, success: bool) -> std::io::Result<()> {
    let (title, detail) = if success {
        (
            "Connected",
            "You can close this tab. Presence for Slack will finish connecting on its own.",
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

fn nonempty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn first_filled(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    values.into_iter().flatten().find_map(nonempty)
}

pub fn is_placeholder_client_id(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("your-client-id")
        || trimmed.eq_ignore_ascii_case("YOUR_SLACK_CLIENT_ID")
        || trimmed == "1234567890.1234567890"
        || trimmed.to_ascii_lowercase().contains("replace")
}

fn is_placeholder_secret(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty() || trimmed.to_ascii_lowercase().contains("replace")
}

pub fn exchange_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Presence-for-Slack/0.1.0")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("exchange HTTP client")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn ignores_stray_connections_without_oauth_params() {
        assert!(!is_oauth_callback(&HashMap::new()));
        assert!(!is_oauth_callback(&HashMap::from([(
            "unrelated".into(),
            "1".into()
        )])));
    }

    #[test]
    fn accepts_code_error_or_state() {
        assert!(is_oauth_callback(&HashMap::from([(
            "code".into(),
            "abc".into()
        )])));
        assert!(is_oauth_callback(&HashMap::from([(
            "error".into(),
            "access_denied".into()
        )])));
        assert!(is_oauth_callback(&HashMap::from([(
            "state".into(),
            "nonce".into()
        )])));
    }

    #[test]
    fn empty_default_client_id_is_not_configured() {
        assert!(OAuthConfig::from_values(
            Some(DEFAULT_SLACK_CLIENT_ID.to_owned()),
            None,
            Some(DEFAULT_OAUTH_EXCHANGE_URL.to_owned()),
            DEFAULT_REDIRECT_URI.to_owned(),
        )
        .is_none());
    }

    #[test]
    fn example_env_placeholders_are_not_configured() {
        assert!(OAuthConfig::from_values(
            Some("1234567890.1234567890".into()),
            Some("replace-with-your-client-secret".into()),
            None,
            DEFAULT_REDIRECT_URI.to_owned(),
        )
        .is_none());
    }

    #[test]
    fn hosted_path_needs_a_real_client_id_and_exchange_url() {
        let config = OAuthConfig::from_values(
            Some("1234567890.9876543210".into()),
            None,
            Some("https://presence-for-slack-oauth.example.workers.dev/oauth/exchange".into()),
            DEFAULT_REDIRECT_URI.to_owned(),
        )
        .expect("hosted config");
        assert!(config.uses_hosted_exchange());
        assert!(!config.has_client_secret());
        assert_eq!(config.public_client_id(), "1234567890.9876543210");
    }

    #[test]
    fn byo_secret_uses_direct_slack_exchange() {
        let config = OAuthConfig::from_values(
            Some("1234567890.9876543210".into()),
            Some("app-secret".into()),
            Some(DEFAULT_OAUTH_EXCHANGE_URL.to_owned()),
            DEFAULT_REDIRECT_URI.to_owned(),
        )
        .expect("byo config");
        assert!(!config.uses_hosted_exchange());
        assert!(config.has_client_secret());
    }

    #[test]
    fn exchange_url_must_be_https_or_loopback_http() {
        assert!(validate_exchange_url(
            "https://presence-for-slack-oauth.workers.dev/oauth/exchange"
        )
        .is_ok());
        assert!(validate_exchange_url("http://127.0.0.1:8787/oauth/exchange").is_ok());
        assert!(validate_exchange_url("http://example.com/oauth/exchange").is_err());
    }

    #[test]
    fn reads_token_from_worker_or_slack_shape() {
        let hosted = token_from_oauth(OAuthResponse {
            ok: true,
            error: None,
            access_token: Some("xoxp-hosted".into()),
            authed_user: None,
        })
        .expect("hosted token");
        assert_eq!(hosted, "xoxp-hosted");

        let slack = token_from_oauth(OAuthResponse {
            ok: true,
            error: None,
            access_token: None,
            authed_user: Some(AuthedUser {
                access_token: Some("xoxp-direct".into()),
            }),
        })
        .expect("slack token");
        assert_eq!(slack, "xoxp-direct");

        assert!(token_from_oauth(OAuthResponse {
            ok: true,
            error: None,
            access_token: Some("xoxb-bot".into()),
            authed_user: None,
        })
        .is_err());
    }

    #[test]
    fn hosted_exchange_talks_to_a_loopback_worker() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let port = listener.local_addr().expect("addr").port();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut buffer = vec![0_u8; 4096];
                let _ = stream.read(&mut buffer).await.expect("read");
                let request = String::from_utf8_lossy(&buffer);
                assert!(request.contains("POST"));
                assert!(request.contains("slack-code"));
                let body = r#"{"ok":true,"access_token":"xoxp-from-worker"}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).await.expect("write");
            });

            let config = OAuthConfig::from_values(
                Some("123.456".into()),
                None,
                Some(format!("http://127.0.0.1:{port}/oauth/exchange")),
                DEFAULT_REDIRECT_URI.to_owned(),
            )
            .expect("config");
            let slack_client = reqwest::Client::builder()
                .https_only(true)
                .build()
                .expect("slack client");
            let exchange_client = exchange_http_client();
            let token = exchange_code(&slack_client, &exchange_client, &config, "slack-code")
                .await
                .expect("exchange");
            assert_eq!(token, "xoxp-from-worker");
            server.await.expect("server");
        });
    }
}
