use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

impl HubError {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
            fingerprint: None,
        }
    }
}
pub type Result<T> = std::result::Result<T, HubError>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Password,
    Key,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub auth_type: AuthType,
    pub private_key_path: String,
    pub panel_host: String,
    pub panel_port: u16,
    pub panel_path: String,
    pub panel_scheme: String,
    pub color: String,
    pub host_fingerprint: Option<String>,
    pub has_secret: bool,
    #[serde(default)]
    pub panel_username: String,
    #[serde(default)]
    pub has_panel_secret: bool,
    #[serde(default)]
    pub auto_login: bool,
    #[serde(default = "enabled_by_default")]
    pub panel_enabled: bool,
    #[serde(default)]
    pub realm_installed: bool,
    #[serde(default)]
    pub forwarding_rules: Vec<ForwardRule>,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForwardRule {
    pub id: String,
    pub remark: String,
    pub listen_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub enabled: bool,
}

impl ForwardRule {
    pub fn validate(&self) -> Result<()> {
        let host = &self.remote_host;
        let valid_host = host.parse::<std::net::IpAddr>().is_ok()
            || (host.len() <= 253
                && host.trim_end_matches('.').split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                }));
        if uuid::Uuid::parse_str(&self.id).is_err()
            || self.remark.len() > 240
            || self.remark.chars().any(|c| c.is_control())
            || !valid_host
            || self.listen_port == 0
            || self.remote_port == 0
        {
            return Err(HubError::new(
                "validation",
                "转发规则无效，请检查备注、目标地址和端口",
            ));
        }
        Ok(())
    }
}

pub fn validate_rules(rules: &[ForwardRule]) -> Result<()> {
    if rules.len() > 256 {
        return Err(HubError::new("validation", "每台服务器最多 256 条转发规则"));
    }
    let mut ids = std::collections::HashSet::new();
    let mut ports = std::collections::HashSet::new();
    for rule in rules {
        rule.validate()?;
        if !ids.insert(&rule.id) || !ports.insert(rule.listen_port) {
            return Err(HubError::new("validation", "同一服务器的入站端口不能重复"));
        }
    }
    Ok(())
}

impl Server {
    pub fn validate(&self) -> Result<()> {
        let host_valid = |s: &str| {
            !s.is_empty()
                && s.len() <= 253
                && !s
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || "/\\@".contains(c))
        };
        if uuid::Uuid::parse_str(&self.id).is_err() {
            return Err(HubError::new("validation", "无效的服务器 ID"));
        }
        if self.name.trim().is_empty() || self.name.len() > 120 || self.group.len() > 120 {
            return Err(HubError::new(
                "validation",
                "服务器名称不能为空，名称和分组最多 120 字节",
            ));
        }
        if !host_valid(&self.host)
            || (self.panel_enabled && !host_valid(&self.panel_host))
            || self.username.trim().is_empty()
        {
            return Err(HubError::new("validation", "主机或用户名无效"));
        }
        if self.port == 0 || (self.panel_enabled && self.panel_port == 0) {
            return Err(HubError::new("validation", "端口范围为 1–65535"));
        }
        if self.panel_enabled
            && (!["http", "https"].contains(&self.panel_scheme.as_str())
                || !self.panel_path.starts_with('/')
                || self.panel_path.starts_with("//")
                || self
                    .panel_path
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || "\\?#".contains(c)))
        {
            return Err(HubError::new("validation", "面板协议或路径无效"));
        }
        if self.auth_type == AuthType::Key && self.private_key_path.trim().is_empty() {
            return Err(HubError::new("validation", "请填写私钥路径"));
        }
        if self.panel_username.len() > 128 || self.panel_username.chars().any(|c| c.is_control()) {
            return Err(HubError::new("validation", "面板账号无效"));
        }
        if self.color.len() != 7
            || !self.color.starts_with('#')
            || !self.color[1..].bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(HubError::new("validation", "无效的颜色"));
        }
        validate_rules(&self.forwarding_rules)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub status: String,
    pub local_url: String,
    pub message: Option<String>,
}

#[derive(Deserialize)]
pub struct PanelBounds {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub fn server() -> Server {
        Server {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Tokyo".into(),
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
            group: "".into(),
            auth_type: AuthType::Password,
            private_key_path: "".into(),
            panel_host: "127.0.0.1".into(),
            panel_port: 2095,
            panel_path: "/".into(),
            panel_scheme: "http".into(),
            color: "#7cb798".into(),
            host_fingerprint: None,
            has_secret: false,
            panel_username: String::new(),
            has_panel_secret: false,
            auto_login: false,
            panel_enabled: true,
            realm_installed: false,
            forwarding_rules: Vec::new(),
        }
    }
    #[test]
    fn validates_network_boundaries() {
        let mut s = server();
        assert!(s.validate().is_ok());
        for path in ["//evil.com", "/\\evil.com", "/?redirect=evil", "/\n"] {
            s.panel_path = path.into();
            assert!(s.validate().is_err());
        }
        s.panel_path = "/secret/".into();
        s.port = 0;
        assert!(s.validate().is_err());
        s.port = 22;
        s.id = "../escape".into();
        assert!(s.validate().is_err());
    }
}
