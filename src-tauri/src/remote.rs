use crate::{
    model::{HubError, Result},
    tunnel::HostVerifier,
};
use russh::{client, ChannelMsg};
use std::time::Duration;
use zeroize::Zeroizing;

// Only fixed, bundled scripts enter the command. All form values travel via stdin.
pub fn command(script: &str) -> String {
    let quoted = format!("'{}'", script.replace('\'', "'\\''"));
    format!(
        "if [ \"$(id -u)\" = 0 ]; then exec sh -c {quoted}; else exec sudo -n sh -c {quoted}; fi"
    )
}

pub async fn run(
    handle: &client::Handle<HostVerifier>,
    script: &str,
    input: &str,
    seconds: u64,
) -> Result<()> {
    let operation = async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|_| HubError::new("remote", "无法打开 SSH 命令通道"))?;
        channel
            .exec(true, command(script))
            .await
            .map_err(|_| HubError::new("remote", "无法执行远端管理命令"))?;
        channel
            .data(input.as_bytes())
            .await
            .map_err(|_| HubError::new("remote", "远端传输失败，结果未知，请检查服务器状态"))?;
        channel
            .eof()
            .await
            .map_err(|_| HubError::new("remote", "远端传输失败，结果未知，请检查服务器状态"))?;
        let mut output = Zeroizing::new(Vec::new());
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if output.len() + data.len() > 1024 * 1024 {
                        let _ = channel.close().await;
                        return Err(HubError::new(
                            "remote",
                            "远端输出过多，结果未知，请检查服务器状态",
                        ));
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
        }
        let output = String::from_utf8_lossy(&output);
        if status == Some(0) && output.lines().any(|line| line == "HUB_OK") {
            return Ok(());
        }
        // Never expose upstream output: S-UI commands may print credentials.
        let message = if output.lines().any(|s| s == "HUB_UNSUPPORTED_OS") {
            "仅支持使用 OpenRC 的 Alpine 和使用 systemd 的 Ubuntu / Debian"
        } else if output.lines().any(|s| s == "HUB_UNSUPPORTED_ARCH") {
            "初始化仅支持 x86_64 和 aarch64 服务器"
        } else if output.lines().any(|s| s == "HUB_SUI_EXISTS") {
            "检测到已有 S-UI 安装，已保留原配置；请直接配置面板连接"
        } else if output.lines().any(|s| s == "HUB_BUSY") {
            "另一项远端管理操作正在运行，请稍后重试"
        } else if output.lines().any(|s| s == "HUB_ROLLED_BACK") {
            "规则应用失败，已恢复原配置；请检查端口占用、目标地址及服务日志"
        } else {
            "远端操作未确认成功。请检查 root 或免密 sudo 权限、GitHub 访问及服务日志；远端可能已变更，请检查后再重试。"
        };
        Err(HubError::new("remote", message))
    };
    tokio::time::timeout(Duration::from_secs(seconds), operation)
        .await
        .map_err(|_| HubError::new("remote", "远端操作超时，结果未知，请检查服务器状态后再重试"))?
}

pub const COMMON: &str = include_str!("scripts/common.sh");
