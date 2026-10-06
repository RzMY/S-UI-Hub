mod management;
mod model;
mod panel;
mod preferences;
mod realm;
mod remote;
mod ssh_transport;
mod store;
mod tunnel;
#[cfg(test)]
mod tunnel_tests;

use model::{HubError, PanelBounds, Result, Server, SessionInfo};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager, State, Webview};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

struct Connection {
    info: SessionInfo,
    cancel: CancellationToken,
    stopped: CancellationToken,
}
struct Inner {
    servers: Vec<Server>,
    connections: HashMap<String, Connection>,
    pending_keys: HashMap<String, String>,
    load_error: Option<String>,
    remote_operations: std::collections::HashSet<String>,
}
struct Hub {
    path: PathBuf,
    inner: Arc<Mutex<Inner>>,
    preferences_lock: Mutex<()>,
}

fn authorize(webview: &Webview) -> Result<()> {
    if webview.label() != "main" {
        return Err(HubError::new("forbidden", "此页面无权访问应用接口"));
    }
    let url = webview.url().map_err(|e| HubError::new("forbidden", e))?;
    let trusted = url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || (cfg!(debug_assertions)
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(15420));
    if !trusted {
        return Err(HubError::new("forbidden", "不受信任的页面来源"));
    }
    Ok(())
}
fn writable(inner: &Inner) -> Result<()> {
    if let Some(error) = &inner.load_error {
        return Err(HubError::new("storage", error));
    }
    Ok(())
}
fn idle(inner: &Inner, id: &str) -> Result<()> {
    if inner.remote_operations.contains(id) {
        return Err(HubError::new("busy", "此服务器正在执行远端操作"));
    }
    if inner.connections.contains_key(id) {
        return Err(HubError::new("busy", "请先断开此服务器"));
    }
    Ok(())
}

#[tauri::command]
async fn open_repository(webview: Webview) -> Result<()> {
    authorize(&webview)?;
    open::that("https://github.com/RzMY/S-UI-Hub").map_err(|e| HubError::new("open_repository", e))
}

#[tauri::command]
async fn list_servers(webview: Webview, hub: State<'_, Hub>) -> Result<Vec<Server>> {
    authorize(&webview)?;
    let inner = hub.inner.lock().await;
    writable(&inner)?;
    Ok(inner.servers.clone())
}

#[tauri::command]
async fn save_server(
    webview: Webview,
    hub: State<'_, Hub>,
    mut server: Server,
    secret: Option<String>,
    clear_secret: bool,
    panel_secret: Option<String>,
    clear_panel_secret: bool,
) -> Result<Server> {
    authorize(&webview)?;
    server.validate()?;
    let mut inner = hub.inner.lock().await;
    writable(&inner)?;
    idle(&inner, &server.id)?;
    let old = inner.servers.iter().find(|s| s.id == server.id);
    let same_identity = old.is_some_and(|s| s.host == server.host && s.port == server.port);
    let same_auth = old.is_some_and(|s| s.auth_type == server.auth_type);
    if !same_identity && old.is_some_and(|s| !s.forwarding_rules.is_empty()) {
        return Err(HubError::new(
            "realm",
            "更改 SSH 地址前请先删除此服务器的转发规则",
        ));
    }
    server.forwarding_rules = old.map(|s| s.forwarding_rules.clone()).unwrap_or_default();
    server.realm_installed = same_identity && old.is_some_and(|s| s.realm_installed);
    if !server.panel_enabled {
        server.auto_login = false;
    }
    server.host_fingerprint = if same_identity {
        old.and_then(|s| s.host_fingerprint.clone())
    } else {
        None
    };
    server.has_secret = old.is_some_and(|s| s.has_secret);
    server.has_panel_secret = old.is_some_and(|s| s.has_panel_secret);
    let mut next = inner.servers.clone();
    let secret = secret.map(Zeroizing::new);
    let panel_secret = panel_secret.map(Zeroizing::new);
    let change_secret = clear_secret || secret.is_some() || (!same_auth && old.is_some());
    let panel_key = format!("panel:{}", server.id);
    let mut changes = Vec::new();
    if change_secret {
        let value = if clear_secret {
            None
        } else {
            secret.as_ref().map(|s| s.as_str())
        };
        changes.push((server.id.as_str(), value));
        server.has_secret = value.is_some();
    }
    if clear_panel_secret || panel_secret.is_some() {
        let value = if clear_panel_secret {
            None
        } else {
            panel_secret.as_ref().map(|s| s.as_str())
        };
        if let Some(password) = value {
            panel::validate_credentials(&server.panel_username, password)?;
        }
        changes.push((panel_key.as_str(), value));
        server.has_panel_secret = value.is_some();
    }
    if server.auto_login && (server.panel_username.trim().is_empty() || !server.has_panel_secret) {
        return Err(HubError::new(
            "credentials",
            "开启自动登录需要面板账号和密码",
        ));
    }
    match next.iter_mut().find(|s| s.id == server.id) {
        Some(s) => *s = server.clone(),
        None => next.push(server.clone()),
    }
    store::commit(&hub.path, &next, &changes)?;
    inner.pending_keys.remove(&server.id);
    inner.servers = next;
    Ok(server)
}

#[tauri::command]
async fn delete_server(webview: Webview, hub: State<'_, Hub>, id: String) -> Result<()> {
    authorize(&webview)?;
    let mut inner = hub.inner.lock().await;
    writable(&inner)?;
    idle(&inner, &id)?;
    if !inner.servers.iter().any(|s| s.id == id) {
        return Err(HubError::new("missing", "服务器不存在"));
    }
    if inner
        .servers
        .iter()
        .any(|s| s.id == id && !s.forwarding_rules.is_empty())
    {
        return Err(HubError::new(
            "realm",
            "请先在端口转发模块删除此服务器的规则，再删除服务器",
        ));
    }
    let next: Vec<_> = inner
        .servers
        .iter()
        .filter(|s| s.id != id)
        .cloned()
        .collect();
    let panel_key = format!("panel:{id}");
    store::commit(&hub.path, &next, &[(&id, None), (&panel_key, None)])?;
    inner.servers = next;
    inner.pending_keys.remove(&id);
    Ok(())
}

#[tauri::command]
async fn trust_host(
    webview: Webview,
    hub: State<'_, Hub>,
    id: String,
    fingerprint: String,
) -> Result<()> {
    authorize(&webview)?;
    let mut inner = hub.inner.lock().await;
    writable(&inner)?;
    idle(&inner, &id)?;
    if inner.pending_keys.get(&id) != Some(&fingerprint) {
        return Err(HubError::new("trust", "指纹已过期，请重新连接"));
    }
    let mut next = inner.servers.clone();
    let server = next
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| HubError::new("missing", "服务器不存在"))?;
    if server.host_fingerprint.is_some() {
        return Err(HubError::new("trust", "请先核验并重置已有指纹"));
    }
    server.host_fingerprint = Some(fingerprint);
    store::write(&hub.path, &next)?;
    inner.servers = next;
    inner.pending_keys.remove(&id);
    Ok(())
}

#[tauri::command]
async fn reset_host(webview: Webview, hub: State<'_, Hub>, id: String) -> Result<()> {
    authorize(&webview)?;
    let mut inner = hub.inner.lock().await;
    writable(&inner)?;
    idle(&inner, &id)?;
    let mut next = inner.servers.clone();
    let server = next
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| HubError::new("missing", "服务器不存在"))?;
    server.host_fingerprint = None;
    store::write(&hub.path, &next)?;
    inner.servers = next;
    inner.pending_keys.remove(&id);
    Ok(())
}

#[tauri::command]
async fn connect_server(
    app: tauri::AppHandle,
    webview: Webview,
    hub: State<'_, Hub>,
    id: String,
) -> Result<SessionInfo> {
    authorize(&webview)?;
    let cancel = CancellationToken::new();
    let stopped = CancellationToken::new();
    let stopped_guard = stopped.clone().drop_guard();
    let server = {
        let mut inner = hub.inner.lock().await;
        writable(&inner)?;
        idle(&inner, &id)?;
        let server = inner
            .servers
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| HubError::new("missing", "服务器不存在"))?;
        if !server.panel_enabled {
            return Err(HubError::new("panel", "此服务器未启用 S-UI 面板"));
        }
        inner.connections.insert(
            id.clone(),
            Connection {
                info: SessionInfo {
                    id: id.clone(),
                    status: "connecting".into(),
                    local_url: String::new(),
                    message: None,
                },
                cancel: cancel.clone(),
                stopped,
            },
        );
        server
    };
    let operation = async {
        let key_id = id.clone();
        let secret = tokio::task::spawn_blocking(move || store::secret(&key_id))
            .await
            .map_err(|e| HubError::new("vault", e))??;
        tunnel::establish(&server, secret).await
    };
    let established = tokio::select! { _ = cancel.cancelled() => Err(HubError::new("cancelled", "连接已取消")), result = operation => result };
    let established = match established {
        Ok(value) => value,
        Err(error) => {
            let mut inner = hub.inner.lock().await;
            if !cancel.is_cancelled() {
                inner.connections.remove(&id);
                if let Some(fingerprint) = &error.fingerprint {
                    inner.pending_keys.insert(id, fingerprint.clone());
                }
            }
            return Err(error);
        }
    };
    let info = SessionInfo {
        id: id.clone(),
        status: "connected".into(),
        local_url: established.url.clone(),
        message: None,
    };
    {
        let mut inner = hub.inner.lock().await;
        if cancel.is_cancelled() {
            return Err(HubError::new("cancelled", "连接已取消"));
        }
        if let Some(connection) = inner.connections.get_mut(&id) {
            connection.info = info.clone();
        }
    }
    let state = hub.inner.clone();
    let returned = info.clone();
    tauri::async_runtime::spawn(async move {
        let _stopped_guard = stopped_guard;
        let result = tunnel::run(established, server, cancel.clone()).await;
        let mut inner = state.lock().await;
        if !cancel.is_cancelled() {
            inner.connections.remove(&id);
            if let Some(panel) = app.get_webview(&format!("panel-{id}")) {
                let _ = panel.close();
            }
            let _ = app.emit_to(
                "main",
                "session-changed",
                SessionInfo {
                    status: "error".into(),
                    message: Some(
                        result
                            .err()
                            .map(|e| e.message)
                            .unwrap_or_else(|| "连接已关闭".into()),
                    ),
                    ..info
                },
            );
        }
    });
    Ok(returned)
}

#[tauri::command]
async fn disconnect_server(
    app: tauri::AppHandle,
    webview: Webview,
    hub: State<'_, Hub>,
    id: String,
) -> Result<()> {
    authorize(&webview)?;
    let (connection, closed) = {
        // Serialize view removal with sync_panels so an in-flight layout cannot
        // recreate a view after disconnect has already closed it.
        let mut inner = hub.inner.lock().await;
        let connection = inner.connections.remove(&id);
        if let Some(connection) = &connection {
            connection.cancel.cancel();
        }
        let closed = app
            .get_webview(&format!("panel-{id}"))
            .map(|panel| panel.close())
            .transpose()
            .map_err(|e| HubError::new("webview", e));
        (connection, closed)
    };
    if let Some(connection) = connection {
        connection.stopped.cancelled().await;
    }
    closed.map(|_| ())
}

#[tauri::command]
async fn list_sessions(webview: Webview, hub: State<'_, Hub>) -> Result<Vec<SessionInfo>> {
    authorize(&webview)?;
    Ok(hub
        .inner
        .lock()
        .await
        .connections
        .values()
        .map(|s| s.info.clone())
        .collect())
}

// Async commands avoid a WebView2 deadlock when creating child views from the UI thread.
#[tauri::command]
async fn sync_panels(
    app: tauri::AppHandle,
    webview: Webview,
    hub: State<'_, Hub>,
    panels: Vec<PanelBounds>,
) -> Result<()> {
    authorize(&webview)?;
    if panels.len() > 4 {
        return Err(HubError::new("layout", "最多同时显示四个面板"));
    }
    let inner = hub.inner.lock().await;
    for panel in app
        .webviews()
        .values()
        .filter(|v| v.label().starts_with("panel-"))
    {
        if !panels
            .iter()
            .any(|p| format!("panel-{}", p.id) == panel.label())
        {
            panel.hide().map_err(|e| HubError::new("webview", e))?;
        }
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| HubError::new("window", "找不到主窗口"))?;
    let size = window
        .inner_size()
        .map_err(|e| HubError::new("window", e))?
        .to_logical::<f64>(
            window
                .scale_factor()
                .map_err(|e| HubError::new("window", e))?,
        );
    for bounds in panels {
        if ![bounds.x, bounds.y, bounds.width, bounds.height]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.0)
            || bounds.width < 1.0
            || bounds.height < 1.0
            || bounds.x + bounds.width > size.width + 1.0
            || bounds.y + bounds.height > size.height + 1.0
        {
            continue;
        }
        let Some(connection) = inner
            .connections
            .get(&bounds.id)
            .filter(|s| s.info.status == "connected")
        else {
            continue;
        };
        let label = format!("panel-{}", bounds.id);
        let position = tauri::LogicalPosition::new(bounds.x, bounds.y);
        let dimensions = tauri::LogicalSize::new(bounds.width, bounds.height);
        let panel = if let Some(panel) = app.get_webview(&label) {
            panel
        } else {
            let url: url::Url = connection
                .info
                .local_url
                .parse()
                .map_err(|e| HubError::new("url", e))?;
            let origin = url.origin();
            let login_url = url.to_string();
            let login_server = inner
                .servers
                .iter()
                .find(|s| s.id == bounds.id)
                .cloned()
                .ok_or_else(|| HubError::new("missing", "服务器不存在"))?;
            let login_attempted = std::sync::atomic::AtomicBool::new(false);
            let preference_path = hub.path.with_file_name("preferences.json");
            let profile = app
                .path()
                .app_data_dir()
                .map_err(|e| HubError::new("storage", e))?
                .join("profiles")
                .join(&bounds.id);
            let builder =
                tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(url))
                    .data_directory(profile)
                    .on_navigation(move |url| url.origin() == origin)
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_page_load(move |webview, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            if let Ok(prefs) = preferences::read(&preference_path) {
                                let _ =
                                    webview.eval(preferences::panel_script(&prefs, payload.url()));
                            }
                        }
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                            && login_server.auto_login
                            && payload.url().path().trim_end_matches('/')
                                == format!(
                                    "{}/login",
                                    login_server.panel_path.trim_end_matches('/')
                                )
                            && !login_attempted.swap(true, std::sync::atomic::Ordering::SeqCst)
                        {
                            let server = login_server.clone();
                            let url = login_url.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                if let Err(error) = submit_panel_login(&webview, &server, &url) {
                                    let _ = webview.app_handle().emit_to(
                                        "main",
                                        "panel-feedback",
                                        format!("{}：{}", server.name, error.message),
                                    );
                                }
                            });
                        }
                    });
            #[cfg(target_os = "macos")]
            let builder = builder.data_store_identifier(
                *uuid::Uuid::parse_str(&bounds.id)
                    .map_err(|e| HubError::new("id", e))?
                    .as_bytes(),
            );
            window
                .add_child(builder, position, dimensions)
                .map_err(|e| HubError::new("webview", e))?
        };
        panel
            .set_bounds(tauri::Rect {
                position: position.into(),
                size: dimensions.into(),
            })
            .map_err(|e| HubError::new("webview", e))?;
        panel.show().map_err(|e| HubError::new("webview", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn reload_panel(app: tauri::AppHandle, webview: Webview, id: String) -> Result<()> {
    authorize(&webview)?;
    let panel = app
        .get_webview(&format!("panel-{id}"))
        .ok_or_else(|| HubError::new("missing", "面板尚未打开"))?;
    panel.reload().map_err(|e| HubError::new("webview", e))
}

fn submit_panel_login(webview: &Webview, server: &Server, url: &str) -> Result<()> {
    let current = webview.url().map_err(|e| HubError::new("webview", e))?;
    let target: url::Url = url
        .parse()
        .map_err(|_| HubError::new("url", "面板地址无效"))?;
    let login_path = format!("{}/login", server.panel_path.trim_end_matches('/'));
    if current.origin() != target.origin() || current.path().trim_end_matches('/') != login_path {
        return Err(HubError::new("login", "面板当前不在登录页"));
    }
    let password = store::secret(&format!("panel:{}", server.id))?
        .ok_or_else(|| HubError::new("credentials", "请先保存面板账号密码"))?;
    let script = Zeroizing::new(panel::login_script(server, url, &password)?);
    webview
        .eval(script.as_str())
        .map_err(|e| HubError::new("webview", e))
}

#[tauri::command]
async fn login_panel(
    app: tauri::AppHandle,
    webview: Webview,
    hub: State<'_, Hub>,
    id: String,
) -> Result<()> {
    authorize(&webview)?;
    let inner = hub.inner.lock().await;
    let server = inner
        .servers
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| HubError::new("missing", "服务器不存在"))?;
    let connection = inner
        .connections
        .get(&id)
        .ok_or_else(|| HubError::new("missing", "服务器未连接"))?;
    let panel = app
        .get_webview(&format!("panel-{id}"))
        .ok_or_else(|| HubError::new("missing", "面板未打开"))?;
    submit_panel_login(&panel, server, &connection.info.local_url)
}

#[tauri::command]
async fn reveal_panel_password(
    webview: Webview,
    hub: State<'_, Hub>,
    id: String,
) -> Result<String> {
    authorize(&webview)?;
    if !hub.inner.lock().await.servers.iter().any(|s| s.id == id) {
        return Err(HubError::new("missing", "服务器不存在"));
    }
    store::secret(&format!("panel:{id}"))?
        .map(|password| password.to_string())
        .ok_or_else(|| HubError::new("credentials", "尚未保存面板密码"))
}

#[tauri::command]
async fn reset_panel_credentials(
    webview: Webview,
    hub: State<'_, Hub>,
    id: String,
    confirmed_host: String,
) -> Result<()> {
    authorize(&webview)?;
    let mut inner = hub.inner.lock().await;
    writable(&inner)?;
    idle(&inner, &id)?;
    let server = inner
        .servers
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or_else(|| HubError::new("missing", "服务器不存在"))?;
    if confirmed_host != format!("{}:{}", server.host, server.port) {
        return Err(HubError::new("reset", "请确认当前目标服务器"));
    }
    if !["127.0.0.1", "localhost", "::1"].contains(&server.panel_host.as_str()) {
        return Err(HubError::new(
            "reset",
            "仅支持重置 SSH 服务器本机的 S-UI，内网转发目标请手动管理",
        ));
    }
    let password = store::secret(&format!("panel:{id}"))?
        .ok_or_else(|| HubError::new("credentials", "请先保存新的面板账号密码"))?;
    panel::validate_credentials(&server.panel_username, &password)?;
    let handle = match tunnel::authenticate(&server, store::secret(&id)?).await {
        Ok(h) => h,
        Err(error) => {
            if let Some(fingerprint) = &error.fingerprint {
                inner.pending_keys.insert(id, fingerprint.clone());
            }
            return Err(error);
        }
    };
    let result = panel::reset(&handle, &server.panel_username, &password).await;
    handle.close().await;
    result
}

#[tauri::command]
async fn read_preferences(
    webview: Webview,
    hub: State<'_, Hub>,
) -> Result<preferences::Preferences> {
    authorize(&webview)?;
    let _lock = hub.preferences_lock.lock().await;
    preferences::read(&hub.path.with_file_name("preferences.json"))
}

#[tauri::command]
async fn save_preferences(
    app: tauri::AppHandle,
    webview: Webview,
    hub: State<'_, Hub>,
    preferences: preferences::Preferences,
) -> Result<()> {
    authorize(&webview)?;
    let _lock = hub.preferences_lock.lock().await;
    preferences::write(&hub.path.with_file_name("preferences.json"), &preferences)?;
    for panel in app
        .webviews()
        .values()
        .filter(|view| view.label().starts_with("panel-"))
    {
        if let Ok(url) = panel.url() {
            panel
                .eval(preferences::panel_script(&preferences, &url))
                .map_err(|e| HubError::new("preferences", e))?;
        }
    }
    app.emit_to("main", "preferences-changed", &preferences)
        .map_err(|e| HubError::new("preferences", e))
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("servers.json");
            let (servers, load_error) = match store::read(&path) {
                Ok(s) => (s, None),
                Err(e) => (Vec::new(), Some(e.message)),
            };
            app.manage(Hub {
                path,
                preferences_lock: Mutex::new(()),
                inner: Arc::new(Mutex::new(Inner {
                    servers,
                    connections: HashMap::new(),
                    pending_keys: HashMap::new(),
                    load_error,
                    remote_operations: std::collections::HashSet::new(),
                })),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_repository,
            list_servers,
            save_server,
            delete_server,
            connect_server,
            disconnect_server,
            list_sessions,
            trust_host,
            reset_host,
            sync_panels,
            reload_panel,
            login_panel,
            reveal_panel_password,
            reset_panel_credentials,
            read_preferences,
            save_preferences,
            management::initialize_service,
            management::update_forwarding
        ])
        .build(tauri::generate_context!())
        .expect("failed to initialize S-UI Hub")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let hub = app.state::<Hub>();
                tauri::async_runtime::block_on(async {
                    for connection in hub.inner.lock().await.connections.values() {
                        connection.cancel.cancel();
                    }
                });
            }
        });
}
