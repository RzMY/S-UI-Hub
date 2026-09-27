use crate::model::{HubError, Result};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

#[derive(Clone, Default, Deserialize, Serialize)]
pub enum Language {
    #[default]
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub language: Language,
    pub theme: Theme,
}

pub fn read(path: &Path) -> Result<Preferences> {
    if !path.exists() {
        return Ok(Preferences::default());
    }
    let file = std::fs::File::open(path).map_err(|e| HubError::new("preferences", e))?;
    serde_json::from_reader(file)
        .map_err(|_| HubError::new("preferences", "偏好文件损坏，请检查 preferences.json"))
}
pub fn write(path: &Path, preferences: &Preferences) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| HubError::new("preferences", "无效的存储目录"))?;
    std::fs::create_dir_all(dir).map_err(|e| HubError::new("preferences", e))?;
    let mut file =
        tempfile::NamedTempFile::new_in(dir).map_err(|e| HubError::new("preferences", e))?;
    serde_json::to_writer_pretty(&mut file, preferences)
        .map_err(|e| HubError::new("preferences", e))?;
    file.flush().map_err(|e| HubError::new("preferences", e))?;
    file.as_file()
        .sync_all()
        .map_err(|e| HubError::new("preferences", e))?;
    file.persist(path)
        .map_err(|e| HubError::new("preferences", e))?;
    Ok(())
}

pub fn panel_script(preferences: &Preferences, url: &url::Url) -> String {
    format!(
        "({})({});",
        include_str!("panel_preferences.js"),
        serde_json::json!({
            "origin": url.origin().ascii_serialization(),
            "language": preferences.language,
            "theme": preferences.theme,
        })
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_global_preferences_and_rejects_invalid_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        write(
            &path,
            &Preferences {
                language: Language::English,
                theme: Theme::Dark,
            },
        )
        .unwrap();
        assert!(matches!(read(&path).unwrap().theme, Theme::Dark));
        assert!(
            serde_json::from_str::<Preferences>(r#"{"language":"invalid","theme":"dark"}"#)
                .is_err()
        );
    }
}
