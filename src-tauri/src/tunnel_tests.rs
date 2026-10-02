use crate::{
    model::{tests::server, AuthType},
    tunnel::{establish, run, HostVerifier},
};
use russh::{
    keys::{Algorithm, HashAlg, PrivateKey, PublicKey, PublicKeyOrCertificate},
    server::{self, Server as _},
    Channel,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Clone)]
struct TestSsh {
    password_attempts: Arc<AtomicUsize>,
    live_sessions: Arc<AtomicUsize>,
    is_session: bool,
    command: Vec<u8>,
    input: Vec<u8>,
}
impl server::Server for TestSsh {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.live_sessions.fetch_add(1, Ordering::SeqCst);
        let mut session = self.clone();
        session.is_session = true;
        session
    }
}
impl Drop for TestSsh {
    fn drop(&mut self) {
        if self.is_session {
            self.live_sessions.fetch_sub(1, Ordering::SeqCst);
        }
    }
}
impl server::Handler for TestSsh {
    type Error = russh::Error;
    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.command.clear();
        self.input.clear();
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.command = data.to_vec();
        session.channel_success(channel)?;
        Ok(())
    }
    async fn data(
        &mut self,
        _: russh::ChannelId,
        data: &[u8],
        _: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.input.extend_from_slice(data);
        Ok(())
    }
    async fn channel_eof(
        &mut self,
        channel: russh::ChannelId,
        session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        assert_eq!(
            self.command,
            crate::panel::RESET_COMMAND.as_bytes(),
            "credentials must not enter command source"
        );
        if self.input == b"admin\nquotes'\"$()!\\safe\n" {
            session.data(channel, b"reset admin credentials success\n".to_vec())?;
        } else {
            session.data(channel, b"reset failed: do not expose secret\n".to_vec())?;
        }
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> std::result::Result<server::Auth, Self::Error> {
        self.password_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "root" && password == "local-test-password" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        _: &str,
        _: &PublicKey,
    ) -> std::result::Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        if let Ok(mut stream) = TcpStream::connect((host, port as u16)).await {
            reply.accept().await;
            tokio::spawn(async move {
                let _ =
                    tokio::io::copy_bidirectional(&mut channel.into_stream(), &mut stream).await;
            });
        }
        Ok(())
    }
}

#[tokio::test]
async fn verifies_host_before_credentials_forwards_concurrently_and_cleans_up() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    let attempts = Arc::new(AtomicUsize::new(0));
    let live_sessions = Arc::new(AtomicUsize::new(0));
    let ssh_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ssh_port = ssh_listener.local_addr().unwrap().port();
    let mut ssh = TestSsh {
        password_attempts: attempts.clone(),
        live_sessions: live_sessions.clone(),
        is_session: false,
        command: Vec::new(),
        input: Vec::new(),
    };
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(1),
        ..Default::default()
    });
    let ssh_task =
        tokio::spawn(async move { ssh.run_on_socket(config, &ssh_listener).await.unwrap() });
    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_listener.local_addr().unwrap().port();
    let echo_task = tokio::spawn(async move {
        loop {
            let (socket, _) = echo_listener.accept().await.unwrap();
            tokio::spawn(async move {
                let (mut r, mut w) = socket.into_split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    let mut config = server();
    config.host = "127.0.0.1".into();
    config.port = ssh_port;
    config.panel_port = echo_port;
    let credential = || Some(Zeroizing::new("local-test-password".into()));
    let error = establish(&config, credential()).await.err().unwrap();
    assert_eq!(error.code, "host_key_unknown");
    assert_eq!(error.fingerprint.as_ref(), Some(&fingerprint));
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        0,
        "must not send password before host verification"
    );
    config.host_fingerprint = Some("SHA256:changed".into());
    assert_eq!(
        establish(&config, credential()).await.err().unwrap().code,
        "host_key_changed"
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 0);
    config.host_fingerprint = Some(fingerprint);
    assert_eq!(
        establish(&config, Some(Zeroizing::new("wrong".into())))
            .await
            .err()
            .unwrap()
            .code,
        "auth"
    );
    let tunnel = establish(&config, credential()).await.unwrap();
    let local = tunnel.listener.local_addr().unwrap();
    assert!(local.ip().is_loopback());
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let task = tokio::spawn(run(tunnel, config.clone(), token));
    let mut jobs = tokio::task::JoinSet::new();
    for i in 0..8 {
        jobs.spawn(async move {
            let mut socket = TcpStream::connect(local).await.unwrap();
            let data = format!("panel-request-{i}");
            socket.write_all(data.as_bytes()).await.unwrap();
            let mut response = vec![0; data.len()];
            tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut response))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(response, data.as_bytes());
            socket
        });
    }
    let mut sockets = Vec::new();
    while let Some(result) = jobs.join_next().await {
        sockets.push(result.unwrap());
    }
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(TcpStream::connect(local).await.is_err());
    for mut socket in sockets {
        let result = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut [0]))
            .await
            .unwrap();
        assert!(
            matches!(result, Ok(0) | Err(_)),
            "disconnect must close active forwarded sockets"
        );
    }
    wait_for_no_sessions(&live_sessions).await;

    // Repeatedly closing, abandoning and aborting connections must not leave
    // russh's independently spawned I/O tasks behind.
    for mode in 0..9 {
        let tunnel = establish(&config, credential()).await.unwrap();
        let local = tunnel.listener.local_addr().unwrap();
        if mode % 3 == 0 {
            drop(tunnel);
        } else {
            let cancel = CancellationToken::new();
            let task = tokio::spawn(run(tunnel, config.clone(), cancel.clone()));
            tokio::task::yield_now().await;
            if mode % 3 == 1 {
                cancel.cancel();
                tokio::time::timeout(Duration::from_secs(1), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
            } else {
                task.abort();
                assert!(task.await.is_err());
            }
        }
        wait_for_no_sessions(&live_sessions).await;
        assert!(TcpStream::connect(local).await.is_err());
    }
    let key_dir = tempfile::tempdir().unwrap();
    let key_path = key_dir.path().join("id_ed25519");
    let private = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    private
        .write_openssh_file(&key_path, Default::default())
        .unwrap();
    config.auth_type = AuthType::Key;
    config.private_key_path = key_path.to_string_lossy().into();
    assert!(establish(&config, None).await.is_ok());
    let handle = crate::tunnel::authenticate(&config, None).await.unwrap();
    crate::panel::reset(&handle, "admin", "quotes'\"$()!\\safe")
        .await
        .unwrap();
    let error = crate::panel::reset(&handle, "admin", "incorrect-test-value")
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "reset");
    assert!(!error.message.contains("do not expose secret"));
    handle.close().await;
    wait_for_no_sessions(&live_sessions).await;
    ssh_task.abort();
    echo_task.abort();
}

async fn wait_for_no_sessions(live_sessions: &AtomicUsize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while live_sessions.load(Ordering::SeqCst) != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("all SSH sessions must be released");
}

#[tokio::test]
async fn verifier_pins_the_exact_key() {
    use russh::client::Handler;
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    let observed = Arc::new(Mutex::new(None));
    let mut verifier = HostVerifier {
        expected: Some(fingerprint.clone()),
        observed: observed.clone(),
        closed: CancellationToken::new(),
    };
    assert!(verifier
        .check_server_key(&PublicKeyOrCertificate::from(key.public_key().clone()))
        .await
        .unwrap());
    assert_eq!(observed.lock().unwrap().as_ref(), Some(&fingerprint));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_stalled_handshake_closes_the_ssh_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = server();
    config.host = "127.0.0.1".into();
    config.port = listener.local_addr().unwrap().port();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        socket.write_all(b"SSH-2.0-stalled-test\r\n").await.unwrap();
        // Wait for the client's KEXINIT packet, then leave key exchange pending.
        let mut byte = [0];
        loop {
            socket.read_exact(&mut byte).await.unwrap();
            if byte[0] == b'\n' {
                break;
            }
        }
        socket.read_exact(&mut byte).await.unwrap();
        started_tx.send(()).unwrap();
        let mut remaining = Vec::new();
        socket.read_to_end(&mut remaining).await
    });
    let connection =
        tokio::spawn(
            async move { establish(&config, Some(Zeroizing::new("test-only".into()))).await },
        );
    tokio::time::timeout(Duration::from_secs(5), started_rx)
        .await
        .unwrap()
        .unwrap();
    connection.abort();
    assert!(connection.await.is_err());
    let closed = tokio::time::timeout(Duration::from_secs(1), peer).await;
    assert!(
        closed.is_ok(),
        "cancelling a connection must close the socket even during SSH key exchange"
    );
}
