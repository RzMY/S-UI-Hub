use crate::{
    model::{HubError, Result, Server},
    tunnel::HostVerifier,
};
use russh::{client, ChannelMsg};
use std::time::Duration;
use zeroize::Zeroizing;

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
