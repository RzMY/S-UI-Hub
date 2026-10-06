use crate::{
    model::{validate_rules, ForwardRule, Result},
    remote,
};
use serde_json::json;

pub fn payload(rules: &[ForwardRule]) -> Result<String> {
    validate_rules(rules)?;
    let active: Vec<_> = rules.iter().filter(|r| r.enabled).collect();
    let endpoints: Vec<_> = active.iter().map(|rule| {
        let host = if rule.remote_host.contains(':') { format!("[{}]", rule.remote_host) } else { rule.remote_host.clone() };
        json!({"listen": format!("0.0.0.0:{}", rule.listen_port), "remote": format!("{host}:{}", rule.remote_port)})
    }).collect();
    let config = json!({"log": {"level": "warn"}, "network": {"no_tcp": false, "use_udp": true}, "endpoints": endpoints});
    let ports = active
        .iter()
        .map(|r| r.listen_port.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        "{}\n{ports}\n{config}\n",
        u8::from(!active.is_empty())
    ))
}

pub fn apply_script() -> String {
    format!(
        "{}\n{}",
        remote::COMMON,
        include_str!("scripts/apply-realm.sh")
    )
}
pub fn install_script() -> String {
    format!(
        "{}\n{}",
        remote::COMMON,
        include_str!("scripts/install-realm.sh")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn rule() -> ForwardRule {
        ForwardRule {
            id: uuid::Uuid::new_v4().to_string(),
            remark: "example".into(),
            listen_port: 12345,
            remote_host: "2001:db8::1".into(),
            remote_port: 443,
            enabled: true,
        }
    }
    #[test]
    fn serializes_ipv6_and_excludes_disabled_rules_and_remarks() {
        let mut first = rule();
        first.remark = "$(touch /tmp/nope)".into();
        let mut second = rule();
        second.listen_port += 1;
        second.enabled = false;
        let input = payload(&[first, second]).unwrap();
        let config: serde_json::Value =
            serde_json::from_str(input.splitn(3, '\n').nth(2).unwrap()).unwrap();
        assert_eq!(config["endpoints"].as_array().unwrap().len(), 1);
        assert_eq!(config["endpoints"][0]["remote"], "[2001:db8::1]:443");
        assert!(!input.contains("touch"));
        assert!(payload(&[]).unwrap().starts_with("0\n\n"));
    }
    #[test]
    fn rejects_invalid_hosts_and_duplicate_ports() {
        for host in [
            "",
            "a\nb",
            "host:443",
            "https://example.com",
            "$(id)",
            "[::1]",
            "a b",
            "-example.com",
        ] {
            let mut r = rule();
            r.remote_host = host.into();
            assert!(r.validate().is_err(), "{host}");
        }
        let r = rule();
        let mut duplicate = rule();
        duplicate.enabled = false;
        assert!(payload(&[r, duplicate]).is_err());
    }
}
