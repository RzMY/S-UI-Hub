IFS= read -r hub_port
IFS= read -r hub_path
IFS= read -r hub_user
IFS= read -r hub_pass
[ ! -e /usr/local/s-ui ] || fail HUB_SUI_EXISTS
case "$(uname -m)" in
    x86_64|amd64) hub_arch=amd64; hub_sha=f33bf45ec222bd67207cbe294b968c99a95ae92c8db989c59b49262558b003dd ;;
    aarch64|arm64) hub_arch=arm64; hub_sha=399c6d551b43878b95b53187d75951109ad95e68d28292a343668cdfe7f8a784 ;;
    *) fail HUB_UNSUPPORTED_ARCH ;;
esac
packages
# The release archive contains the Go binary and management script, not an installer.
hub_base=https://github.com/alireza0/s-ui/releases/download/v1.6.3
fetch "$hub_base/s-ui-linux-${hub_arch}.tar.gz" "$hub_tmp/s-ui.tar.gz"
printf '%s  %s\n' "$hub_sha" "$hub_tmp/s-ui.tar.gz" | sha256sum -c -
tar -xzf "$hub_tmp/s-ui.tar.gz" -C "$hub_tmp"
chmod 755 "$hub_tmp/s-ui/sui"
"$hub_tmp/s-ui/sui" -v
cp -R "$hub_tmp/s-ui" /usr/local/s-ui
chmod 755 /usr/local/s-ui/s-ui.sh
cp /usr/local/s-ui/s-ui.sh /usr/bin/s-ui
cd /usr/local/s-ui
./sui migrate
./sui setting -port "$hub_port" -path "$hub_path" > "$hub_tmp/settings-output"
grep -Fx 'set port success' "$hub_tmp/settings-output"
grep -Fx 'set path success' "$hub_tmp/settings-output"
./sui admin -username "$hub_user" -password "$hub_pass" | grep -Fx 'reset admin credentials success'
unset hub_pass
if [ "$hub_init" = openrc ]; then
    cat > /etc/init.d/s-ui <<'SERVICE'
#!/sbin/openrc-run
description="S-UI panel"
command="/usr/local/s-ui/sui"
directory="/usr/local/s-ui"
command_background=true
pidfile="/run/s-ui.pid"
output_log="/var/log/s-ui.log"
error_log="/var/log/s-ui.log"
depend() { need net; after firewall; }
SERVICE
    chmod 755 /etc/init.d/s-ui
else
    cp /usr/local/s-ui/s-ui.service /etc/systemd/system/s-ui.service
    chmod 644 /etc/systemd/system/s-ui.service
    systemctl daemon-reload
fi
service_start s-ui
sleep 2
service_running s-ui
service_enable s-ui
printf 'HUB_OK\n'
