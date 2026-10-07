use crate::model::{HubError, Result, Server};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    servers: Vec<Server>,
}

pub fn read(path: &Path) -> Result<Vec<Server>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = std::fs::File::open(path).map_err(|e| HubError::new("storage", e))?;
    let doc: Document = serde_json::from_reader(file)
        .map_err(|e| HubError::new("storage", format!("配置文件损坏，未覆盖原文件：{e}")))?;
    if doc.version != 1 {
        return Err(HubError::new("storage", "不支持的配置文件版本"));
    }
    let mut ids = std::collections::HashSet::new();
    for server in &doc.servers {
        server.validate()?;
        if !ids.insert(&server.id) {
            return Err(HubError::new("storage", "配置中存在重复 ID"));
        }
    }
    Ok(doc.servers)
}

pub fn write(path: &Path, servers: &[Server]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| HubError::new("storage", "无效的存储目录"))?;
    std::fs::create_dir_all(dir).map_err(|e| HubError::new("storage", e))?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| HubError::new("storage", e))?;
    serde_json::to_writer_pretty(
        &mut file,
        &Document {
            version: 1,
            servers: servers.to_vec(),
        },
    )
    .map_err(|e| HubError::new("storage", e))?;
    file.flush().map_err(|e| HubError::new("storage", e))?;
    file.as_file()
        .sync_all()
        .map_err(|e| HubError::new("storage", e))?;
    file.persist(path)
        .map_err(|e| HubError::new("storage", e))?;
    Ok(())
}

fn entry(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new("io.github.rzmy.s-ui-hub", id).map_err(|e| HubError::new("vault", e))
}
pub fn secret(id: &str) -> Result<Option<Zeroizing<String>>> {
    match entry(id)?.get_password() {
        Ok(s) => Ok(Some(Zeroizing::new(s))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(HubError::new("vault", format!("无法访问系统凭证库：{e}"))),
    }
}
pub fn set_secret(id: &str, value: Option<&str>) -> Result<()> {
    let entry = entry(id)?;
    match value {
        Some(s) => entry.set_password(s).map_err(|e| HubError::new("vault", e)),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(HubError::new("vault", e)),
        },
    }
}

pub fn commit(path: &Path, servers: &[Server], changes: &[(&str, Option<&str>)]) -> Result<()> {
    let previous: Vec<_> = changes
        .iter()
        .map(|(id, _)| secret(id))
        .collect::<Result<_>>()?;
    for (index, (id, value)) in changes.iter().enumerate() {
        if let Err(error) = set_secret(id, *value) {
            for rollback in (0..=index).rev() {
                set_secret(
                    changes[rollback].0,
                    previous[rollback].as_ref().map(|s| s.as_str()),
                )
                .map_err(|_| HubError::new("vault", "保存失败且凭证回滚失败，请检查系统凭证库"))?;
            }
            return Err(error);
        }
    }
    if let Err(error) = write(path, servers) {
        for (index, (id, _)) in changes.iter().enumerate().rev() {
            set_secret(id, previous[index].as_ref().map(|s| s.as_str())).map_err(|_| {
                HubError::new("vault", "配置写入失败且凭证回滚失败，请检查系统凭证库")
            })?;
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_roundtrip_and_corruption_guard() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("servers.json");
        assert!(read(&path).unwrap().is_empty());
        write(&path, &[]).unwrap();
        write(&path, &[]).unwrap();
        assert!(read(&path).unwrap().is_empty());
        std::fs::write(&path, "{ broken").unwrap();
        assert!(read(&path).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{ broken");
    }
    #[test]
    fn migrates_legacy_servers_and_roundtrips_independent_forwarding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("servers.json");
        let mut legacy = serde_json::to_value(crate::model::tests::server()).unwrap();
        for field in [
            "panelEnabled",
            "realmEnabled",
            "realmInstalled",
            "forwardingRules",
            "autoLogin",
        ] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        std::fs::write(
            &path,
            serde_json::json!({"version": 1, "servers": [legacy]}).to_string(),
        )
        .unwrap();
        let mut servers = read(&path).unwrap();
        assert!(servers[0].panel_enabled);
        assert!(servers[0].realm_enabled);
        assert!(!servers[0].auto_login);
        assert!(!servers[0].realm_installed);
        servers[0].panel_enabled = false;
        servers[0].panel_host.clear();
        servers[0].panel_path.clear();
        servers[0].panel_port = 0;
        servers[0].realm_installed = true;
        servers[0].forwarding_rules.push(crate::model::ForwardRule {
            id: uuid::Uuid::new_v4().to_string(),
            remark: "forward".into(),
            listen_port: 8080,
            remote_host: "example.com".into(),
            remote_port: 443,
            enabled: true,
        });
        write(&path, &servers).unwrap();
        let saved = read(&path).unwrap();
        assert!(!saved[0].panel_enabled);
        assert_eq!(saved[0].forwarding_rules, servers[0].forwarding_rules);
    }
}
