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
            || !host_valid(&self.panel_host)
            || self.username.trim().is_empty()
        {
            return Err(HubError::new("validation", "主机或用户名无效"));
        }
        if self.port == 0 || self.panel_port == 0 {
            return Err(HubError::new("validation", "端口范围为 1–65535"));
        }
        if !["http", "https"].contains(&self.panel_scheme.as_str())
            || !self.panel_path.starts_with('/')
            || self.panel_path.starts_with("//")
            || self
                .panel_path
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "\\?#".contains(c))
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
        Ok(())
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
