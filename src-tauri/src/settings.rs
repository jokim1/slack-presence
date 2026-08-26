use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use crate::error::{CommandError, CommandResult};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    pub team_id: String,
    pub team_name: String,
    #[serde(default)]
    pub selected_channel_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub workspaces: Vec<WorkspaceSettings>,
    pub active_team_id: Option<String>,
    pub always_on_top: bool,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    // Single-workspace fields from the MVP settings file, kept only so an old
    // settings.json can be migrated on load. Never written back.
    #[serde(skip_serializing)]
    team_id: Option<String>,
    #[serde(skip_serializing)]
    team_name: Option<String>,
    #[serde(skip_serializing)]
    selected_channel_id: Option<String>,
}

impl Settings {
    /// Fold the MVP's single-workspace fields into the workspace list and make
    /// sure the active team refers to a workspace that exists. Returns true
    /// when anything changed and the file should be rewritten.
    fn migrate(&mut self) -> bool {
        let mut changed = false;
        if self.workspaces.is_empty() {
            if let (Some(team_id), Some(team_name)) = (self.team_id.take(), self.team_name.take()) {
                self.workspaces.push(WorkspaceSettings {
                    team_id: team_id.clone(),
                    team_name,
                    selected_channel_id: self.selected_channel_id.take(),
                });
                self.active_team_id = Some(team_id);
                changed = true;
            }
        }
        self.team_id = None;
        self.team_name = None;
        self.selected_channel_id = None;

        let active_is_known = self
            .active_team_id
            .as_ref()
            .is_none_or(|active| self.workspaces.iter().any(|w| &w.team_id == active));
        if !active_is_known {
            self.active_team_id = self.workspaces.first().map(|w| w.team_id.clone());
            changed = true;
        }
        if self.active_team_id.is_none() && !self.workspaces.is_empty() {
            self.active_team_id = Some(self.workspaces[0].team_id.clone());
            changed = true;
        }
        changed
    }
}

pub struct SettingsStore {
    path: PathBuf,
    value: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let mut value: Settings = fs::read(&path)
            .ok()
            .and_then(|contents| serde_json::from_slice(&contents).ok())
            .unwrap_or_default();
        let migrated = value.migrate();
        let store = Self {
            path,
            value: Mutex::new(value),
        };
        if migrated {
            if let Ok(settings) = store.read() {
                let _ = store.persist(&settings);
            }
        }
        store
    }

    pub fn read(&self) -> CommandResult<Settings> {
        Ok(self.lock()?.clone())
    }

    pub fn update(&self, mutate: impl FnOnce(&mut Settings)) -> CommandResult<()> {
        let mut settings = self.lock()?;
        mutate(&mut settings);
        self.persist(&settings)
    }

    fn lock(&self) -> CommandResult<MutexGuard<'_, Settings>> {
        self.value
            .lock()
            .map_err(|_| CommandError::message("Local settings are unavailable"))
    }

    fn persist(&self, settings: &Settings) -> CommandResult<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| CommandError::message("Settings path is invalid"))?;
        fs::create_dir_all(parent)
            .map_err(|_| CommandError::message("Could not create the app settings directory"))?;

        let contents = serde_json::to_vec_pretty(settings)
            .map_err(|_| CommandError::message("Could not encode app settings"))?;
        let temporary_path = self.path.with_extension("json.tmp");
        fs::write(&temporary_path, contents)
            .map_err(|_| CommandError::message("Could not write app settings"))?;
        fs::rename(temporary_path, &self.path)
            .map_err(|_| CommandError::message("Could not save app settings"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn migrates_mvp_single_workspace_settings() {
        let mut settings: Settings = serde_json::from_str(
            r#"{
                "selectedChannelId": "C123ABC",
                "alwaysOnTop": true,
                "teamId": "T123ABC",
                "teamName": "Acme",
                "windowX": 10,
                "windowY": 20
            }"#,
        )
        .expect("legacy settings parse");

        assert!(settings.migrate());
        assert_eq!(settings.workspaces.len(), 1);
        assert_eq!(settings.workspaces[0].team_id, "T123ABC");
        assert_eq!(settings.workspaces[0].team_name, "Acme");
        assert_eq!(
            settings.workspaces[0].selected_channel_id.as_deref(),
            Some("C123ABC")
        );
        assert_eq!(settings.active_team_id.as_deref(), Some("T123ABC"));
        assert!(settings.always_on_top);

        let serialized: serde_json::Value =
            serde_json::to_value(&settings).expect("serialize settings");
        assert!(serialized.get("teamId").is_none());
        assert!(serialized.get("teamName").is_none());
        assert!(serialized.get("selectedChannelId").is_none());
    }

    #[test]
    fn resets_unknown_active_team_to_first_workspace() {
        let mut settings: Settings = serde_json::from_str(
            r#"{
                "workspaces": [
                    { "teamId": "T1AAAAAA", "teamName": "One" },
                    { "teamId": "T2BBBBBB", "teamName": "Two" }
                ],
                "activeTeamId": "T9GONE"
            }"#,
        )
        .expect("settings parse");

        assert!(settings.migrate());
        assert_eq!(settings.active_team_id.as_deref(), Some("T1AAAAAA"));
    }

    #[test]
    fn keeps_valid_multi_workspace_settings_unchanged() {
        let mut settings: Settings = serde_json::from_str(
            r#"{
                "workspaces": [{ "teamId": "T1AAAAAA", "teamName": "One", "selectedChannelId": "C1" }],
                "activeTeamId": "T1AAAAAA",
                "alwaysOnTop": false
            }"#,
        )
        .expect("settings parse");

        assert!(!settings.migrate());
        assert_eq!(settings.active_team_id.as_deref(), Some("T1AAAAAA"));
    }
}
