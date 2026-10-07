use crate::{
    model::{HubError, Result, Server},
    tunnel::HostVerifier,
};
use russh::{client, ChannelMsg};
use std::time::Duration;
use zeroize::Zeroizing;

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialAction {
    Initialize,
    Reset,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialInput {
    pub secret: Option<String>,
    pub clear: bool,
    pub action: Option<CredentialAction>,
}

// UUID v4 uses the OS random source. Keep generated passwords in the same
// zeroizing/vault path as explicitly supplied passwords, never in the IPC response.
pub fn prepare_credentials(
    server: &mut Server,
    password: &mut Option<Zeroizing<String>>,
    action: CredentialAction,
) -> Result<()> {
    if server.panel_username.trim().is_empty() {
        server.panel_username = format!("hub_{}", uuid::Uuid::new_v4().simple());
    }
    if password.as_ref().is_none_or(|value| value.is_empty())
        && (matches!(action, CredentialAction::Reset) || !server.has_panel_secret)
    {
        *password = Some(Zeroizing::new(uuid::Uuid::new_v4().simple().to_string()));
    }
    if let Some(password) = password {
        validate_credentials(&server.panel_username, password)?;
    }
    Ok(())
}

// Never interpolate credentials into shell source. The fixed command reads them
// through SSH stdin and passes quoted variables to S-UI's supported admin CLI.
pub const RESET_COMMAND: &str = "set +x; IFS= read -r hub_user || exit 71; IFS= read -r hub_pass || exit 71; cd /usr/local/s-ui || exit 72; test -x ./sui || exit 72; ./sui admin -username \"$hub_user\" -password \"$hub_pass\"";

pub fn validate_credentials(username: &str, password: &str) -> Result<()> {
    if username.trim().is_empty()
        || password.is_empty()
        || username.len() > 128
        || password.len() > 4096
        || username
            .chars()
            .chain(password.chars())
            .any(|c| c.is_control())
    {
        return Err(HubError::new(
            "credentials",
            "请填写面板账号和密码，不可包含换行或控制字符",
        ));
    }
    Ok(())
}

pub async fn reset(
    handle: &client::Handle<HostVerifier>,
    username: &str,
    password: &str,
) -> Result<()> {
    validate_credentials(username, password)?;
    let operation = async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|_| HubError::new("reset", "无法打开 SSH 命令通道"))?;
        channel
            .exec(true, RESET_COMMAND)
            .await
            .map_err(|_| HubError::new("reset", "无法执行 S-UI 管理命令"))?;
        let input = Zeroizing::new(format!("{username}\n{password}\n"));
        channel
            .data(input.as_bytes())
            .await
            .map_err(|_| HubError::new("reset", "凭证传输失败，请检查远端状态后再重试"))?;
        channel
            .eof()
            .await
            .map_err(|_| HubError::new("reset", "传输中断，请检查远端状态后再重试"))?;
        let mut output = Zeroizing::new(Vec::new());
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if output.len() + data.len() > 65536 {
                        let _ = channel.close().await;
                        return Err(HubError::new("reset", "输出异常，请检查远端状态"));
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                _ => {}
            }
        }
        // Some S-UI releases return status 0 even on errors. Require the explicit
        // success marker, and never return raw command output containing secrets.
        if exit == Some(0)
            && String::from_utf8_lossy(&output)
                .lines()
                .any(|line| line.trim() == "reset admin credentials success")
        {
            Ok(())
        } else {
            Err(HubError::new("reset", "未确认重置成功。请检查 /usr/local/s-ui/sui、SSH 权限及 S-UI 版本；远端可能已变更，请先验证后再重试。"))
        }
    };
    tokio::time::timeout(Duration::from_secs(25), operation)
        .await
        .map_err(|_| HubError::new("reset", "重置超时，结果未知。请先验证远端账号再重试。"))?
}

pub fn login_script(server: &Server, local_url: &str, password: &str) -> Result<String> {
    validate_credentials(&server.panel_username, password)?;
    let url: url::Url = local_url
        .parse()
        .map_err(|_| HubError::new("url", "面板地址无效"))?;
    let args = serde_json::json!({
        "origin": url.origin().ascii_serialization(),
        "path": format!("{}/login", server.panel_path.trim_end_matches('/')),
        "username": server.panel_username,
        "password": password,
    });
    Ok(format!("({})({});", include_str!("panel_login.js"), args))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generates_missing_credentials_without_replacing_explicit_values() {
        let mut server = crate::model::tests::server();
        let mut password = None;
        prepare_credentials(&mut server, &mut password, CredentialAction::Initialize).unwrap();
        assert!(server.panel_username.starts_with("hub_"));
        let generated = password.unwrap();
        assert_eq!(generated.len(), 32);
        assert!(validate_credentials(&server.panel_username, &generated).is_ok());
        let original_username = server.panel_username.clone();
        let mut password = Some(Zeroizing::new("explicit'\"$password".to_string()));
        prepare_credentials(&mut server, &mut password, CredentialAction::Reset).unwrap();
        assert_eq!(server.panel_username, original_username);
        assert_eq!(password.unwrap().as_str(), "explicit'\"$password");

        server.panel_username.clear();
        let mut password = Some(Zeroizing::new("chosen-password".to_string()));
        prepare_credentials(&mut server, &mut password, CredentialAction::Initialize).unwrap();
        assert_ne!(server.panel_username, original_username);
        assert_eq!(password.unwrap().as_str(), "chosen-password");
    }

    #[test]
    fn blank_reset_password_rotates_even_when_a_password_is_already_saved() {
        let mut server = crate::model::tests::server();
        server.panel_username = "chosen-admin".into();
        server.has_panel_secret = true;
        let mut password = None;
        prepare_credentials(&mut server, &mut password, CredentialAction::Initialize).unwrap();
        assert!(password.is_none());
        prepare_credentials(&mut server, &mut password, CredentialAction::Reset).unwrap();
        let first = password.take().unwrap();
        prepare_credentials(&mut server, &mut password, CredentialAction::Reset).unwrap();
        assert_ne!(first.as_str(), password.unwrap().as_str());
        assert_eq!(server.panel_username, "chosen-admin");
    }

    #[test]
    fn reset_rejects_protocol_delimiters_and_keeps_shell_metacharacters_as_data() {
        assert!(validate_credentials("admin", "$(touch /tmp/bad)'$!\\\"").is_ok());
        for value in ["", "abc\nxyz", "abc\rxyz", "abc\0xyz"] {
            assert!(validate_credentials("admin", value).is_err());
        }
        assert!(!RESET_COMMAND.contains("eval"));
    }
    #[test]
    fn login_script_serializes_credentials_and_guards_origin() {
        let mut s = crate::model::tests::server();
        s.panel_username = "admin".into();
        s.panel_path = "/app/".into();
        let script = login_script(&s, "http://127.0.0.1:43210/app/", "quote\"\\<script>$").unwrap();
        assert!(script.contains("location.origin !== config.origin"));
        assert!(script.contains("quote\\\"\\\\<script>$"));
    }
}
