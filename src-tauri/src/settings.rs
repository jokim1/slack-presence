use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use crate::error::{CommandError, CommandResult};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub selected_channel_id: Option<String>,
    pub always_on_top: bool,
    pub team_id: Option<String>,
    pub team_name: Option<String>,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
}

pub struct SettingsStore {
    path: PathBuf,
    value: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let value = fs::read(&path)
            .ok()
            .and_then(|contents| serde_json::from_slice(&contents).ok())
            .unwrap_or_default();
        Self {
            path,
            value: Mutex::new(value),
        }
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
