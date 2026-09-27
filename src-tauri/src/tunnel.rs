use crate::model::{AuthType, HubError, Result, Server};
use russh::{
    client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    Disconnect,
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinSet};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub struct HostVerifier {
    pub expected: Option<String>,
    pub observed: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostVerifier {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        *self.observed.lock().expect("fingerprint lock") = Some(fingerprint.clone());
        Ok(self.expected.as_ref() == Some(&fingerprint))
    }
}

pub struct Established {
    pub handle: Arc<client::Handle<HostVerifier>>,
    pub listener: TcpListener,
    pub url: String,
}

pub async fn establish(server: &Server, secret: Option<Zeroizing<String>>) -> Result<Established> {
    let handle = authenticate(server, secret).await?;
    forward(server, handle).await
}

pub async fn authenticate(
    server: &Server,
    secret: Option<Zeroizing<String>>,
) -> Result<client::Handle<HostVerifier>> {
    let observed = Arc::new(Mutex::new(None));
    let verifier = HostVerifier {
        expected: server.host_fingerprint.clone(),
        observed: observed.clone(),
    };
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    };
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        client::connect(
            Arc::new(config),
            (server.host.as_str(), server.port),
            verifier,
        ),
    )
    .await;
    let mut handle = match result {
        Ok(Ok(handle)) => handle,
        other => {
            if let Some(fingerprint) = observed.lock().expect("fingerprint lock").clone() {
                if server.host_fingerprint.as_ref() != Some(&fingerprint) {
                    return Err(HubError {
                        code: if server.host_fingerprint.is_some() {
                            "host_key_changed"
                        } else {
                            "host_key_unknown"
                        }
                        .into(),
                        message: if server.host_fingerprint.is_some() {
                            "服务器主机指纹已变化，连接已阻止。请独立核验后重置指纹。"
                        } else {
                            "首次连接，请核对服务器 SSH 指纹。"
                        }
                        .into(),
                        fingerprint: Some(fingerprint),
                    });
                }
            }
            return Err(HubError::new(
                "ssh",
                match other {
                    Ok(Err(e)) => e.to_string(),
                    _ => "SSH 连接超时".into(),
                },
            ));
        }
    };
    let auth = tokio::time::timeout(Duration::from_secs(20), async {
        match server.auth_type {
            AuthType::Password => {
                let password = secret
                    .as_ref()
                    .ok_or_else(|| HubError::new("credentials", "请先编辑服务器并保存 SSH 密码"))?;
                handle
                    .authenticate_password(&server.username, password.as_str())
                    .await
                    .map_err(|e| HubError::new("auth", e))
            }
            AuthType::Key => {
                let path = if let Some(relative) = server
                    .private_key_path
                    .strip_prefix("~/")
                    .or_else(|| server.private_key_path.strip_prefix("~\\"))
                {
                    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                        .ok_or_else(|| HubError::new("key", "无法确定用户目录"))?;
                    std::path::PathBuf::from(home).join(relative)
                } else {
                    std::path::PathBuf::from(&server.private_key_path)
                };
                let key = tokio::task::spawn_blocking(move || {
                    russh::keys::load_secret_key(path, secret.as_ref().map(|s| s.as_str()))
                })
                .await
                .map_err(|e| HubError::new("key", e))?
                .map_err(|e| HubError::new("key", e))?;
                let hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| HubError::new("auth", e))?
                    .flatten();
                handle
                    .authenticate_publickey(
                        &server.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| HubError::new("auth", e))
            }
        }
    })
    .await
    .map_err(|_| HubError::new("auth", "SSH 身份验证超时"))??;
    if !auth.success() {
        return Err(HubError::new(
            "auth",
            "SSH 身份验证失败，请检查用户名和凭证",
        ));
    }
    Ok(handle)
}

async fn forward(server: &Server, handle: client::Handle<HostVerifier>) -> Result<Established> {
    let channel = tokio::time::timeout(
        Duration::from_secs(10),
        handle.channel_open_direct_tcpip(
            &server.panel_host,
            u32::from(server.panel_port),
            "127.0.0.1",
            0,
        ),
    )
    .await
    .map_err(|_| HubError::new("forward", "面板连接超时"))?
    .map_err(|e| {
        HubError::new(
            "forward",
            format!("无法访问面板，请检查地址及 SSH 转发权限：{e}"),
        )
    })?;
    let _ = channel.close().await;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| HubError::new("listen", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| HubError::new("listen", e))?
        .port();
    // Each server receives a separate browser profile; ports alone do not isolate cookies.
    let url = format!(
        "{}://127.0.0.1:{}{}",
        server.panel_scheme, port, server.panel_path
    );
    Ok(Established {
        handle: Arc::new(handle),
        listener,
        url,
    })
}

pub async fn run(
    established: Established,
    server: Server,
    cancel: CancellationToken,
) -> Result<()> {
    let mut tasks = JoinSet::new();
    let mut health = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = health.tick() => {
                if established.handle.is_closed() { return Err(HubError::new("ssh", "SSH 连接已断开")); }
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = established.listener.accept(), if tasks.len() < 128 => {
                let (mut socket, peer) = accepted.map_err(|e| HubError::new("listen", e))?;
                let handle = established.handle.clone();
                let host = server.panel_host.clone();
                let port = server.panel_port;
                tasks.spawn(async move {
                    let channel = tokio::time::timeout(Duration::from_secs(15), handle.channel_open_direct_tcpip(host, u32::from(port), peer.ip().to_string(), u32::from(peer.port()))).await;
                    if let Ok(Ok(channel)) = channel {
                        let mut remote = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut remote).await;
                    }
                });
            }
        }
    }
    tasks.abort_all();
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        established
            .handle
            .disconnect(Disconnect::ByApplication, "closed", "en"),
    )
    .await;
    Ok(())
}
