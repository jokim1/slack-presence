mod error;
mod oauth;
mod settings;
mod slack;

use std::{path::PathBuf, process::Command};

use error::{CommandError, CommandResult};
use keyring::Entry;
use serde::Serialize;
use settings::SettingsStore;
use slack::ProfileCache;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Position, State, WindowEvent,
};
use tokio::sync::RwLock;

const KEYCHAIN_SERVICE: &str = "com.josephkim.presence-for-slack";
const KEYCHAIN_ACCOUNT: &str = "slack-user-token";

pub(crate) struct AppState {
    pub client: reqwest::Client,
    pub token: RwLock<Option<String>>,
    pub profiles: RwLock<ProfileCache>,
    pub settings: SettingsStore,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    credentials_configured: bool,
    authenticated: bool,
    team_id: Option<String>,
    team_name: Option<String>,
    selected_channel_id: Option<String>,
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
    let oauth_config = oauth::OAuthConfig::from_env();
    Ok(AppStatus {
        credentials_configured: oauth_config.is_some(),
        authenticated: state.token.read().await.is_some(),
        team_id: settings.team_id,
        team_name: settings.team_name,
        selected_channel_id: settings.selected_channel_id,
        always_on_top: settings.always_on_top,
        redirect_uri: oauth_config
            .map(|config| config.redirect_uri)
            .unwrap_or_else(|| "http://127.0.0.1:53641/oauth/callback".to_owned()),
    })
}

#[tauri::command]
async fn list_channels(state: State<'_, AppState>) -> CommandResult<Vec<slack::Channel>> {
    let token = require_token(&state).await?;
    slack::list_channels(&state.client, &token).await
}

#[tauri::command]
async fn get_channel_members(
    channel_id: String,
    state: State<'_, AppState>,
) -> CommandResult<Vec<slack::Member>> {
    validate_slack_id(&channel_id, &['C', 'G'])?;
    let token = require_token(&state).await?;
    slack::channel_members(&state.client, &token, &channel_id, &state.profiles).await
}

#[tauri::command]
async fn get_presence(
    user_id: String,
    state: State<'_, AppState>,
) -> CommandResult<slack::PresenceReply> {
    validate_slack_id(&user_id, &['U', 'W'])?;
    let token = require_token(&state).await?;
    slack::get_presence(&state.client, &token, user_id).await
}

#[tauri::command]
async fn start_oauth(app: AppHandle) -> CommandResult<()> {
    oauth::start(app).await
}

#[tauri::command]
async fn save_selected_channel(
    channel_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    validate_slack_id(&channel_id, &['C', 'G'])?;
    state
        .settings
        .update(|settings| settings.selected_channel_id = Some(channel_id))
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
    validate_slack_id(&team_id, &['T'])?;
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
async fn logout(state: State<'_, AppState>) -> CommandResult<()> {
    delete_token_from_keychain()?;
    *state.token.write().await = None;
    *state.profiles.write().await = ProfileCache::default();
    state.settings.update(|settings| {
        settings.team_id = None;
        settings.team_name = None;
        settings.selected_channel_id = None;
    })
}

async fn require_token(state: &State<'_, AppState>) -> CommandResult<String> {
    state
        .token
        .read()
        .await
        .clone()
        .ok_or_else(|| CommandError::reauth("Connect Slack to use the live workspace"))
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

fn keychain_entry() -> CommandResult<Entry> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|_| CommandError::message("macOS Keychain is unavailable"))
}

fn load_token_from_keychain() -> CommandResult<Option<String>> {
    match keychain_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(CommandError::message(
            "Could not read the Slack token from Keychain",
        )),
    }
}

pub(crate) fn save_token_to_keychain(token: &str) -> CommandResult<()> {
    keychain_entry()?
        .set_password(token)
        .map_err(|_| CommandError::message("Could not save the Slack token to Keychain"))
}

fn delete_token_from_keychain() -> CommandResult<()> {
    match keychain_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(CommandError::message(
            "Could not remove the Slack token from Keychain",
        )),
    }
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
            let token = load_token_from_keychain()?;
            let client = reqwest::Client::builder()
                .user_agent("Presence-for-Slack/0.1.0")
                .https_only(true)
                .build()?;
            app.manage(AppState {
                client,
                token: RwLock::new(token),
                profiles: RwLock::new(ProfileCache::default()),
                settings,
            });

            if let Some(window) = app.get_webview_window("main") {
                window.set_always_on_top(saved.always_on_top)?;
                if let (Some(x), Some(y)) = (saved.window_x, saved.window_y) {
                    window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
                }
            }

            let quit = MenuItem::with_id(app, "quit", "Quit Presence", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or("The app icon is unavailable")?
                        .clone(),
                )
                .tooltip("Presence for Slack")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
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
            save_selected_channel,
            set_always_on_top,
            open_dm,
            hide_panel,
            logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Presence for Slack");
}
