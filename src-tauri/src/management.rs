use crate::{
    authorize,
    model::{ForwardRule, HubError, Result, Server},
    panel, realm, remote, store, tunnel, writable, Hub,
};
use serde::Deserialize;
use tauri::{State, Webview};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Service {
    Sui,
    Realm,
}

async fn begin(hub: &Hub, id: &str) -> Result<Server> {
    let mut inner = hub.inner.lock().await;
    writable(&inner)?;
    if inner.remote_operations.contains(id) {
        return Err(HubError::new("busy", "此服务器正在执行远端操作"));
    }
    let server = inner
        .servers
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or_else(|| HubError::new("missing", "服务器不存在"))?;
    inner.remote_operations.insert(id.to_string());
    Ok(server)
}

async fn authenticate(hub: &Hub, server: &Server) -> Result<tunnel::SshConnection> {
    match tunnel::authenticate(server, store::secret(&server.id)?).await {
        Ok(handle) => Ok(handle),
        Err(error) => {
            if error.code == "host_key_unknown" {
                if let Some(key) = &error.fingerprint {
                    hub.inner
                        .lock()
                        .await
                        .pending_keys
                        .insert(server.id.clone(), key.clone());
                }
            }
            Err(error)
        }
    }
}

async fn persist(hub: &Hub, server: Server) -> Result<Server> {
    let mut inner = hub.inner.lock().await;
    let mut next = inner.servers.clone();
    let entry = next
        .iter_mut()
        .find(|s| s.id == server.id)
        .ok_or_else(|| HubError::new("missing", "服务器不存在"))?;
    *entry = server.clone();
    store::write(&hub.path, &next).map_err(|_| {
        HubError::new(
            "storage",
            "远端操作已完成，但本地保存失败；请检查存储空间后重新应用",
        )
    })?;
    inner.servers = next;
    Ok(server)
}

#[tauri::command]
pub async fn initialize_service(
    webview: Webview,
    hub: State<'_, Hub>,
    id: String,
    service: Service,
) -> Result<Server> {
    authorize(&webview)?;
    let mut server = begin(&hub, &id).await?;
    let result = async {
        let (script, input) = match service {
            Service::Realm => {
                if !server.realm_enabled {
                    return Err(HubError::new("realm", "请先启用 realm 端口转发管理"));
                }
                (realm::install_script(), Zeroizing::new(String::new()))
            }
            Service::Sui => {
                if !server.panel_enabled
                    || server.panel_scheme != "http"
                    || !["127.0.0.1", "localhost"].contains(&server.panel_host.as_str())
                {
                    return Err(HubError::new(
                        "validation",
                        "初始化 S-UI 需要启用面板，并使用本机 HTTP 地址 127.0.0.1 或 localhost",
                    ));
                }
                let password = store::secret(&format!("panel:{id}"))?.ok_or_else(|| {
                    HubError::new("credentials", "初始化 S-UI 前请保存面板账号和密码")
                })?;
                panel::validate_credentials(&server.panel_username, &password)?;
                (
                    format!(
                        "{}\n{}",
                        remote::COMMON,
                        include_str!("scripts/install-sui.sh")
                    ),
                    Zeroizing::new(format!(
                        "{}\n{}\n{}\n{}\n",
                        server.panel_port,
                        server.panel_path,
                        server.panel_username,
                        password.as_str()
                    )),
                )
            }
        };
        let handle = authenticate(&hub, &server).await?;
        let result = remote::run(&handle, &script, &input, 600).await;
        handle.close().await;
        result?;
        if matches!(service, Service::Realm) {
            server.realm_installed = true;
        }
        persist(&hub, server).await
    }
    .await;
    hub.inner.lock().await.remote_operations.remove(&id);
    result
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RuleChange {
    Save { rule: ForwardRule },
    Delete { id: String },
    Apply,
}

#[tauri::command]
pub async fn update_forwarding(
    webview: Webview,
    hub: State<'_, Hub>,
    id: String,
    change: RuleChange,
) -> Result<Server> {
    authorize(&webview)?;
    let mut server = begin(&hub, &id).await?;
    let result = async {
        if !server.realm_enabled || !server.realm_installed {
            return Err(HubError::new("realm", "请先在此服务器初始化 realm"));
        }
        match change {
            RuleChange::Save { rule } => {
                rule.validate()?;
                if let Some(existing) = server.forwarding_rules.iter_mut().find(|r| r.id == rule.id)
                {
                    *existing = rule;
                } else {
                    server.forwarding_rules.push(rule);
                }
            }
            RuleChange::Delete { id } => server.forwarding_rules.retain(|r| r.id != id),
            RuleChange::Apply => {}
        }
        let input = realm::payload(&server.forwarding_rules)?;
        if server.forwarding_rules.iter().any(|r| {
            r.enabled
                && (r.listen_port == server.port
                    || (server.panel_enabled && r.listen_port == server.panel_port))
        }) {
            return Err(HubError::new(
                "validation",
                "入站端口不能与此服务器的 SSH 或 S-UI 端口相同",
            ));
        }
        let handle = authenticate(&hub, &server).await?;
        let result = remote::run(&handle, &realm::apply_script(), &input, 45).await;
        handle.close().await;
        result?;
        persist(&hub, server).await
    }
    .await;
    hub.inner.lock().await.remote_operations.remove(&id);
    result
}
