mod error;
mod oauth;
mod settings;
mod slack;

use std::{
    collections::HashMap,
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
};

use error::{CommandError, CommandResult};
use keyring::Entry;
use serde::Serialize;
use settings::{SettingsStore, WorkspaceSettings};
use slack::ProfileCache;
use tauri::{
    image::Image,
    menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Position, State, WindowEvent,
};
use tokio::sync::{oneshot, RwLock};

const KEYCHAIN_SERVICE: &str = "com.josephkim.presence-for-slack";
const LEGACY_KEYCHAIN_ACCOUNT: &str = "slack-user-token";
const TRAY_ID: &str = "main";

pub(crate) struct WorkspaceSession {
    pub token: String,
    pub profiles: RwLock<ProfileCache>,
}

impl WorkspaceSession {
    pub fn new(token: String) -> Arc<Self> {
        Arc::new(Self {
            token,
            profiles: RwLock::new(ProfileCache::default()),
        })
    }
}

pub(crate) struct AppState {
    pub client: reqwest::Client,
    pub exchange_client: reqwest::Client,
    pub sessions: RwLock<HashMap<String, Arc<WorkspaceSession>>>,
    pub settings: SettingsStore,
    pub oauth_abort: Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStatus {
    team_id: String,
    team_name: String,
    connected: bool,
    selected_channel_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    credentials_configured: bool,
    hosted_oauth_ready: bool,
    client_id: String,
    has_client_secret: bool,
    exchange_url: String,
    oauth_in_progress: bool,
    workspaces: Vec<WorkspaceStatus>,
    active_team_id: Option<String>,
    always_on_top: bool,
    redirect_uri: String,
}

#[derive(Clone, Serialize)]
struct PanelVisibility {
    visible: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct TrayMenuModel {
    connect_label: &'static str,
    workspace_labels: Vec<String>,
}

#[tauri::command]
async fn get_app_status(state: State<'_, AppState>) -> CommandResult<AppStatus> {
    let settings = state.settings.read()?;
    let sessions = state.sessions.read().await;
    let oauth_config = oauth::OAuthConfig::from_settings(&settings);
    let hosted_oauth_ready = oauth_config
        .as_ref()
        .is_some_and(oauth::OAuthConfig::uses_hosted_exchange);
    Ok(AppStatus {
        credentials_configured: oauth_config.is_some(),
        hosted_oauth_ready,
        client_id: oauth_config
            .as_ref()
            .map(oauth::OAuthConfig::public_client_id)
            .unwrap_or_default()
            .to_owned(),
        has_client_secret: oauth_config
            .as_ref()
            .is_some_and(oauth::OAuthConfig::has_client_secret),
        exchange_url: oauth_config
            .as_ref()
            .and_then(oauth::OAuthConfig::exchange_url)
            .unwrap_or(oauth::DEFAULT_OAUTH_EXCHANGE_URL)
            .to_owned(),
        oauth_in_progress: oauth::in_progress(&state),
        workspaces: settings
            .workspaces
            .iter()
            .map(|workspace| WorkspaceStatus {
                team_id: workspace.team_id.clone(),
                team_name: workspace.team_name.clone(),
                connected: sessions.contains_key(&workspace.team_id),
                selected_channel_id: workspace.selected_channel_id.clone(),
            })
            .collect(),
        active_team_id: settings.active_team_id,
        always_on_top: settings.always_on_top,
        redirect_uri: oauth_config
            .map(|config| config.redirect_uri)
            .unwrap_or_else(|| oauth::DEFAULT_REDIRECT_URI.to_owned()),
    })
}

#[tauri::command]
async fn list_channels(
    team_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<slack::Channel>> {
    let session = session_for(&state, &team_id).await?;
    slack::list_channels(&state.client, &session.token).await
}

#[tauri::command]
async fn get_channel_members(
    team_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<slack::Member>> {
    validate_slack_id(&channel_id, &['C', 'G'])?;
    let session = session_for(&state, &team_id).await?;
    slack::channel_members(&state.client, &session.token, &channel_id, &session.profiles).await
}

#[tauri::command]
async fn get_presence(
    team_id: String,
    user_id: String,
    state: State<'_, AppState>,
) -> CommandResult<slack::PresenceReply> {
    validate_slack_id(&user_id, &['U', 'W'])?;
    let session = session_for(&state, &team_id).await?;
    slack::get_presence(&state.client, &session.token, user_id).await
}

#[tauri::command]
async fn start_oauth(app: AppHandle) -> CommandResult<()> {
    oauth::start(app).await
}

#[tauri::command]
fn cancel_oauth(app: AppHandle) -> CommandResult<()> {
    oauth::cancel(&app)
}

#[tauri::command]
fn save_slack_credentials(
    client_id: String,
    client_secret: Option<String>,
    exchange_url: Option<String>,
    clear_secret: Option<bool>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let client_id = client_id.trim().to_owned();
    let exchange = exchange_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if let Some(url) = exchange.as_deref() {
        oauth::validate_exchange_url(url)?;
    }
    let secret = client_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let clear_secret = clear_secret.unwrap_or(false);

    state.settings.update(|settings| {
        settings.slack_client_id = if client_id.is_empty() {
            None
        } else {
            Some(client_id.clone())
        };
        if secret.is_some() {
            settings.slack_client_secret = secret.clone();
        } else if clear_secret {
            settings.slack_client_secret = None;
        }
        settings.slack_oauth_exchange_url = exchange.clone();
    })
}

#[tauri::command]
async fn set_active_workspace(team_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    validate_slack_id(&team_id, &['T', 'E'])?;
    let known = state
        .settings
        .read()?
        .workspaces
        .iter()
        .any(|workspace| workspace.team_id == team_id);
    if !known {
        return Err(CommandError::message("That workspace is not connected"));
    }
    state
        .settings
        .update(|settings| settings.active_team_id = Some(team_id))
}

#[tauri::command]
async fn save_selected_channel(
    team_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    validate_slack_id(&channel_id, &['C', 'G'])?;
    state.settings.update(|settings| {
        if let Some(workspace) = settings
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.team_id == team_id)
        {
            workspace.selected_channel_id = Some(channel_id);
        }
    })
}

#[tauri::command]
fn set_always_on_top(
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| CommandError::message("The people panel is unavailable"))?;
    window
        .set_always_on_top(enabled)
        .map_err(|_| CommandError::message("Could not update the panel window"))?;
    state
        .settings
        .update(|settings| settings.always_on_top = enabled)
}

#[tauri::command]
fn open_dm(team_id: String, user_id: String) -> CommandResult<()> {
    validate_slack_id(&team_id, &['T', 'E'])?;
    validate_slack_id(&user_id, &['U', 'W'])?;
    Command::new("open")
        .arg(format!("slack://user?team={team_id}&id={user_id}"))
        .spawn()
        .map_err(|_| CommandError::message("Could not open the Slack desktop app"))?;
    Ok(())
}

#[tauri::command]
fn hide_panel(app: AppHandle) -> CommandResult<()> {
    set_panel_visibility(&app, false)
}

#[tauri::command]
async fn disconnect_workspace(
    team_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    validate_slack_id(&team_id, &['T', 'E'])?;
    delete_token_from_keychain(&team_id)?;
    state.sessions.write().await.remove(&team_id);
    state.settings.update(|settings| {
        settings
            .workspaces
            .retain(|workspace| workspace.team_id != team_id);
        if settings.active_team_id.as_deref() == Some(team_id.as_str()) {
            settings.active_team_id = settings
                .workspaces
                .first()
                .map(|workspace| workspace.team_id.clone());
        }
    })?;
    refresh_tray_menu(&app)
}

pub(crate) async fn adopt_workspace(
    app: &AppHandle,
    state: &AppState,
    team_id: &str,
    team_name: &str,
    token: String,
) -> CommandResult<()> {
    save_token_to_keychain(team_id, &token)?;
    state
        .sessions
        .write()
        .await
        .insert(team_id.to_owned(), WorkspaceSession::new(token));
    state.settings.update(|settings| {
        if let Some(workspace) = settings
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.team_id == team_id)
        {
            workspace.team_name = team_name.to_owned();
        } else {
            settings.workspaces.push(WorkspaceSettings {
                team_id: team_id.to_owned(),
                team_name: team_name.to_owned(),
                selected_channel_id: None,
            });
        }
        settings.active_team_id = Some(team_id.to_owned());
    })?;
    refresh_tray_menu(app)
}

async fn session_for(
    state: &State<'_, AppState>,
    team_id: &str,
) -> CommandResult<Arc<WorkspaceSession>> {
    validate_slack_id(team_id, &['T', 'E'])?;
    state
        .sessions
        .read()
        .await
        .get(team_id)
        .cloned()
        .ok_or_else(|| CommandError::reauth("Reconnect this Slack workspace to load live data"))
}

fn validate_slack_id(value: &str, expected_prefixes: &[char]) -> CommandResult<()> {
    let first = value.chars().next();
    if value.len() < 2
        || !first.is_some_and(|prefix| expected_prefixes.contains(&prefix))
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(CommandError::message("A Slack identifier was invalid"));
    }
    Ok(())
}

fn keychain_entry(account: &str) -> CommandResult<Entry> {
    Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|_| CommandError::message("macOS Keychain is unavailable"))
}

fn workspace_keychain_account(team_id: &str) -> String {
    format!("{LEGACY_KEYCHAIN_ACCOUNT}-{team_id}")
}

fn load_token_from_keychain(account: &str) -> CommandResult<Option<String>> {
    match keychain_entry(account)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(CommandError::message(
            "Could not read the Slack token from Keychain",
        )),
    }
}

pub(crate) fn save_token_to_keychain(team_id: &str, token: &str) -> CommandResult<()> {
    keychain_entry(&workspace_keychain_account(team_id))?
        .set_password(token)
        .map_err(|_| CommandError::message("Could not save the Slack token to Keychain"))
}

fn delete_token_from_keychain(team_id: &str) -> CommandResult<()> {
    match keychain_entry(&workspace_keychain_account(team_id))?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(CommandError::message(
            "Could not remove the Slack token from Keychain",
        )),
    }
}

/// Load a token for every workspace in settings. The MVP stored a single token
/// under a fixed account name; when a workspace has no per-team entry yet, move
/// that legacy token into one.
fn load_sessions(
    workspaces: &[WorkspaceSettings],
) -> CommandResult<HashMap<String, Arc<WorkspaceSession>>> {
    let mut sessions = HashMap::new();
    let mut legacy_token = load_token_from_keychain(LEGACY_KEYCHAIN_ACCOUNT)?;
    for workspace in workspaces {
        let token = match load_token_from_keychain(&workspace_keychain_account(&workspace.team_id))?
        {
            Some(token) => Some(token),
            None => match legacy_token.take() {
                Some(token) => {
                    save_token_to_keychain(&workspace.team_id, &token)?;
                    let _ = keychain_entry(LEGACY_KEYCHAIN_ACCOUNT)?.delete_credential();
                    Some(token)
                }
                None => None,
            },
        };
        if let Some(token) = token {
            sessions.insert(workspace.team_id.clone(), WorkspaceSession::new(token));
        }
    }
    Ok(sessions)
}

fn set_panel_visibility(app: &AppHandle, visible: bool) -> CommandResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| CommandError::message("The people panel is unavailable"))?;
    if visible {
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|_| CommandError::message("Could not show the people panel"))?;
    } else {
        window
            .hide()
            .map_err(|_| CommandError::message("Could not hide the people panel"))?;
    }
    let _ = app.emit("panel://visibility", PanelVisibility { visible });
    Ok(())
}

fn tray_menu_model(
    settings: &[WorkspaceSettings],
    sessions: &HashMap<String, Arc<WorkspaceSession>>,
) -> TrayMenuModel {
    let workspace_labels = settings
        .iter()
        .filter(|workspace| sessions.contains_key(&workspace.team_id))
        .map(|workspace| workspace.team_name.clone())
        .collect::<Vec<_>>();

    TrayMenuModel {
        connect_label: if workspace_labels.is_empty() {
            "Connect..."
        } else {
            "Reconnect..."
        },
        workspace_labels: if workspace_labels.is_empty() {
            vec!["Not connected".to_owned()]
        } else {
            workspace_labels
        },
    }
}

fn build_tray_menu(app: &AppHandle) -> CommandResult<Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let settings = state.settings.read()?;
    let sessions = state
        .sessions
        .try_read()
        .map_err(|_| CommandError::message("Could not read connected workspaces"))?;
    let model = tray_menu_model(&settings.workspaces, &sessions);

    let connect = MenuItem::with_id(app, "connect", model.connect_label, true, None::<&str>)
        .map_err(|_| CommandError::message("Could not build the menu-bar menu"))?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)
        .map_err(|_| CommandError::message("Could not build the menu-bar menu"))?;
    let show_hide = MenuItem::with_id(app, "show_hide", "Show / Hide", true, None::<&str>)
        .map_err(|_| CommandError::message("Could not build the menu-bar menu"))?;
    let first_separator = PredefinedMenuItem::separator(app)
        .map_err(|_| CommandError::message("Could not build the menu-bar menu"))?;
    let about = PredefinedMenuItem::about(
        app,
        Some("About Presence for Slack"),
        Some(AboutMetadata {
            name: Some("Presence for Slack".to_owned()),
            version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            ..Default::default()
        }),
    )
    .map_err(|_| CommandError::message("Could not build the menu-bar menu"))?;
    let second_separator = PredefinedMenuItem::separator(app)
        .map_err(|_| CommandError::message("Could not build the menu-bar menu"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|_| CommandError::message("Could not build the menu-bar menu"))?;

    let workspace_items = model
        .workspace_labels
        .iter()
        .enumerate()
        .map(|(index, label)| {
            MenuItem::with_id(
                app,
                format!("workspace_{index}"),
                label,
                false,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()
        .map_err(|_| CommandError::message("Could not build the menu-bar menu"))?;

    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
    items.push(&connect);
    for item in &workspace_items {
        items.push(item);
    }
    items.push(&settings_item);
    items.push(&show_hide);
    items.push(&first_separator);
    items.push(&about);
    items.push(&second_separator);
    items.push(&quit);

    Menu::with_items(app, &items)
        .map_err(|_| CommandError::message("Could not build the menu-bar menu"))
}

pub(crate) fn refresh_tray_menu(app: &AppHandle) -> CommandResult<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let menu = build_tray_menu(app)?;
    tray.set_menu(Some(menu))
        .map_err(|_| CommandError::message("Could not update the menu-bar menu"))
}

fn toggle_panel(app: &AppHandle) {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let _ = set_panel_visibility(app, !visible);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(team_id: &str, team_name: &str) -> WorkspaceSettings {
        WorkspaceSettings {
            team_id: team_id.to_owned(),
            team_name: team_name.to_owned(),
            selected_channel_id: None,
        }
    }

    #[test]
    fn tray_menu_model_shows_connect_when_no_workspace_is_live() {
        let settings = vec![workspace("T1AAAAAA", "Acme")];
        let sessions = HashMap::new();

        assert_eq!(
            tray_menu_model(&settings, &sessions),
            TrayMenuModel {
                connect_label: "Connect...",
                workspace_labels: vec!["Not connected".to_owned()],
            }
        );
    }

    #[test]
    fn tray_menu_model_shows_connected_workspace_names() {
        let settings = vec![
            workspace("T1AAAAAA", "Acme"),
            workspace("T2BBBBBB", "Beta"),
            workspace("T3CCCCCC", "Stale"),
        ];
        let sessions = HashMap::from([
            (
                "T1AAAAAA".to_owned(),
                WorkspaceSession::new("token-1".to_owned()),
            ),
            (
                "T2BBBBBB".to_owned(),
                WorkspaceSession::new("token-2".to_owned()),
            ),
        ]);

        assert_eq!(
            tray_menu_model(&settings, &sessions),
            TrayMenuModel {
                connect_label: "Reconnect...",
                workspace_labels: vec!["Acme".to_owned(), "Beta".to_owned()],
            }
        );
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let settings = SettingsStore::load(settings_path(app.handle())?);
            let saved = settings.read()?;
            let sessions = load_sessions(&saved.workspaces)?;
            let client = reqwest::Client::builder()
                .user_agent("Presence-for-Slack/0.1.0")
                .https_only(true)
                .build()?;
            app.manage(AppState {
                client,
                exchange_client: oauth::exchange_http_client(),
                sessions: RwLock::new(sessions),
                settings,
                oauth_abort: Mutex::new(None),
            });

            if let Some(window) = app.get_webview_window("main") {
                window.set_always_on_top(saved.always_on_top)?;
                if let (Some(x), Some(y)) = (saved.window_x, saved.window_y) {
                    window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
                }
            }

            let menu = build_tray_menu(app.handle())?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
                .icon_as_template(false)
                .tooltip("Presence for Slack")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "connect" => {
                        let _ = set_panel_visibility(app, true);
                        let _ = app.emit("tray://connect", ());
                    }
                    "settings" => {
                        let _ = set_panel_visibility(app, true);
                        let _ = app.emit("tray://settings", ());
                    }
                    "show_hide" => toggle_panel(app),
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        toggle_panel(tray.app_handle());
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Moved(position) = event {
                let state = window.state::<AppState>();
                let _ = state.settings.update(|settings| {
                    settings.window_x = Some(position.x);
                    settings.window_y = Some(position.y);
                });
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = set_panel_visibility(window.app_handle(), false);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_status,
            list_channels,
            get_channel_members,
            get_presence,
            start_oauth,
            cancel_oauth,
            save_slack_credentials,
            set_active_workspace,
            save_selected_channel,
            set_always_on_top,
            open_dm,
            hide_panel,
            disconnect_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Presence for Slack");
}
