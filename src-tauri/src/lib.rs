mod error;
mod oauth;
mod settings;
mod slack;

use std::{collections::HashMap, path::PathBuf, process::Command, sync::Arc};

use error::{CommandError, CommandResult};
use keyring::Entry;
use serde::Serialize;
use settings::{SettingsStore, WorkspaceSettings};
use slack::ProfileCache;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Position, State, WindowEvent,
};
use tokio::sync::RwLock;

const KEYCHAIN_SERVICE: &str = "com.josephkim.presence-for-slack";
const LEGACY_KEYCHAIN_ACCOUNT: &str = "slack-user-token";

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
    pub sessions: RwLock<HashMap<String, Arc<WorkspaceSession>>>,
    pub settings: SettingsStore,
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
    workspaces: Vec<WorkspaceStatus>,
    active_team_id: Option<String>,
    always_on_top: bool,
    redirect_uri: String,
}

#[derive(Clone, Serialize)]
struct PanelVisibility {
    visible: bool,
}

#[tauri::command]
async fn get_app_status(state: State<'_, AppState>) -> CommandResult<AppStatus> {
    let settings = state.settings.read()?;
    let sessions = state.sessions.read().await;
    let oauth_config = oauth::OAuthConfig::from_env();
    Ok(AppStatus {
        credentials_configured: oauth_config.is_some(),
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
            .unwrap_or_else(|| "http://127.0.0.1:53641/oauth/callback".to_owned()),
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
async fn disconnect_workspace(team_id: String, state: State<'_, AppState>) -> CommandResult<()> {
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
    })
}

pub(crate) async fn adopt_workspace(
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
    })
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

fn toggle_panel(app: &AppHandle) {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let _ = set_panel_visibility(app, !visible);
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
                sessions: RwLock::new(sessions),
                settings,
            });

            if let Some(window) = app.get_webview_window("main") {
                window.set_always_on_top(saved.always_on_top)?;
                if let (Some(x), Some(y)) = (saved.window_x, saved.window_y) {
                    window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
                }
            }

            // Accessory apps have no Dock icon / app menu bar; the tray menu is
            // the quit affordance. Left-click still toggles the panel.
            let show_hide =
                MenuItem::with_id(app, "show_hide", "Show / Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &quit])?;
            TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
                .icon_as_template(false)
                .tooltip("Presence for Slack")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_hide" => toggle_panel(app),
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        toggle_panel(tray.app_handle());
                    }
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
