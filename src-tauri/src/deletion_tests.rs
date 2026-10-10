use super::*;
use model::ForwardRule;

fn inner_with_rules() -> Inner {
    let mut server = model::tests::server();
    server.forwarding_rules.push(ForwardRule {
        id: uuid::Uuid::new_v4().to_string(),
        remark: "Offline relay".into(),
        listen_port: 8443,
        remote_host: "example.org".into(),
        remote_port: 443,
        enabled: true,
    });
    Inner {
        servers: vec![server, model::tests::server()],
        connections: HashMap::new(),
        pending_keys: HashMap::new(),
        load_error: None,
        remote_operations: Default::default(),
    }
}

#[test]
fn force_removes_only_the_target_and_its_rules() {
    let mut inner = inner_with_rules();
    let id = inner.servers[0].id.clone();
    for enabled in [true, false] {
        inner.servers[0].forwarding_rules[0].enabled = enabled;
        assert_eq!(
            servers_after_deletion(&inner, &id, false).unwrap_err().code,
            "realm"
        );
        let remaining = servers_after_deletion(&inner, &id, true).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, inner.servers[1].id);
        assert_eq!(inner.servers.len(), 2);
    }
    inner.servers[0].forwarding_rules.clear();
    assert_eq!(servers_after_deletion(&inner, &id, false).unwrap().len(), 1);
}

#[test]
fn force_preserves_storage_missing_and_busy_guards() {
    let mut inner = inner_with_rules();
    let id = inner.servers[0].id.clone();
    assert_eq!(
        servers_after_deletion(&inner, "missing", true)
            .unwrap_err()
            .code,
        "missing"
    );
    inner.load_error = Some("Unreadable configuration".into());
    assert_eq!(
        servers_after_deletion(&inner, &id, true).unwrap_err().code,
        "storage"
    );
    inner.load_error = None;
    inner.remote_operations.insert(id.clone());
    assert_eq!(
        servers_after_deletion(&inner, &id, true).unwrap_err().code,
        "busy"
    );
    inner.remote_operations.clear();
    inner.connections.insert(
        id.clone(),
        Connection {
            info: SessionInfo {
                id: id.clone(),
                status: "connected".into(),
                local_url: String::new(),
                message: None,
            },
            cancel: CancellationToken::new(),
            stopped: CancellationToken::new(),
        },
    );
    assert_eq!(
        servers_after_deletion(&inner, &id, true).unwrap_err().code,
        "busy"
    );
}
