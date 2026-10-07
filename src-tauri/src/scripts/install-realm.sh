# Verify an existing Hub installation before any package, binary or service writes.
hub_binary=/usr/local/lib/s-ui-hub/realm
if [ -e "$hub_binary" ] || [ -L "$hub_binary" ]; then
    [ -x "$hub_binary" ] && "$hub_binary" --version || fail HUB_REALM_EXISTS
    if { [ "$hub_init" = openrc ] && [ -f /etc/init.d/s-ui-hub-realm ]; } ||
       { [ "$hub_init" = systemd ] && [ -f /etc/systemd/system/s-ui-hub-realm.service ]; }; then
        printf 'HUB_OK\n'
        exit 0
    fi
else
    for hub_existing in /etc/s-ui-hub/realm.json /etc/init.d/s-ui-hub-realm /etc/systemd/system/s-ui-hub-realm.service; do
        if [ -e "$hub_existing" ] || [ -L "$hub_existing" ]; then fail HUB_REALM_EXISTS; fi
    done
fi
case "$(uname -m)" in
    x86_64|amd64) hub_arch=x86_64; hub_sha=b1cc335547bea8bb2a88178bef12ec7f2363e36200e7ea1d4e1e67627929bf65 ;;
    aarch64|arm64) hub_arch=aarch64; hub_sha=f4c0318dd86854da483dcb7645b4f39cae2cc3f91c688fef969d53220b949488 ;;
    *) fail HUB_UNSUPPORTED_ARCH ;;
esac
packages
mkdir -p /usr/local/lib/s-ui-hub /etc/s-ui-hub
# Static musl releases run on both Alpine (musl) and Ubuntu (glibc).
# Re-running initialization preserves the installed binary and all rules.
if [ ! -x /usr/local/lib/s-ui-hub/realm ]; then
    fetch "https://github.com/zhboner/realm/releases/download/v2.9.6/realm-${hub_arch}-unknown-linux-musl.tar.gz" "$hub_tmp/realm.tar.gz"
    printf '%s  %s\n' "$hub_sha" "$hub_tmp/realm.tar.gz" | sha256sum -c -
    tar -xzf "$hub_tmp/realm.tar.gz" -C "$hub_tmp" realm
    chmod 755 "$hub_tmp/realm"
    "$hub_tmp/realm" --version
    cp "$hub_tmp/realm" /usr/local/lib/s-ui-hub/realm.new
    mv /usr/local/lib/s-ui-hub/realm.new /usr/local/lib/s-ui-hub/realm
fi
/usr/local/lib/s-ui-hub/realm --version
if [ "$hub_init" = openrc ]; then
    cat > /etc/init.d/s-ui-hub-realm <<'SERVICE'
#!/sbin/openrc-run
description="S-UI Hub realm forwarding"
command="/usr/local/lib/s-ui-hub/realm"
command_args="-c /etc/s-ui-hub/realm.json"
command_background=true
pidfile="/run/s-ui-hub-realm.pid"
output_log="/var/log/s-ui-hub-realm.log"
error_log="/var/log/s-ui-hub-realm.log"
depend() { need net; after firewall; }
SERVICE
    chmod 755 /etc/init.d/s-ui-hub-realm
else
    cat > /etc/systemd/system/s-ui-hub-realm.service <<'SERVICE'
[Unit]
Description=S-UI Hub realm forwarding
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/lib/s-ui-hub/realm -c /etc/s-ui-hub/realm.json
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
SERVICE
    chmod 644 /etc/systemd/system/s-ui-hub-realm.service
    systemctl daemon-reload
fi
printf 'HUB_OK\n'
