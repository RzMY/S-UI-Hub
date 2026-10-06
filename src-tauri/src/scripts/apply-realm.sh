test -x /usr/local/lib/s-ui-hub/realm
IFS= read -r hub_enabled
IFS= read -r hub_ports
# Keep a same-filesystem staging file and a backup until the service is verified.
cat > "$hub_tmp/realm.json"
test -s "$hub_tmp/realm.json"
hub_had_config=0
if [ -f /etc/s-ui-hub/realm.json ]; then
    cp /etc/s-ui-hub/realm.json "$hub_tmp/previous.json"
    hub_had_config=1
fi
hub_was_running=0
if service_running s-ui-hub-realm >/dev/null 2>&1; then hub_was_running=1; fi
cp "$hub_tmp/realm.json" /etc/s-ui-hub/realm.json.new
service_stop s-ui-hub-realm
mv /etc/s-ui-hub/realm.json.new /etc/s-ui-hub/realm.json
apply_ok=1
if [ "$hub_enabled" = 1 ]; then
    service_start s-ui-hub-realm || apply_ok=0
    sleep 2
    service_running s-ui-hub-realm >/dev/null 2>&1 || apply_ok=0
    if [ "$hub_init" = openrc ]; then
        hub_pid=$(cat /run/s-ui-hub-realm.pid 2>/dev/null) || hub_pid=0
    else
        hub_pid=$(systemctl show s-ui-hub-realm --property MainPID --value) || hub_pid=0
    fi
    # realm may keep running when only some endpoints fail to bind.
    for hub_port in $hub_ports; do
        ss -H -lntp "sport = :$hub_port" | grep -F "pid=$hub_pid," >/dev/null || apply_ok=0
        ss -H -lnup "sport = :$hub_port" | grep -F "pid=$hub_pid," >/dev/null || apply_ok=0
    done
fi
if [ "$apply_ok" = 0 ]; then
    service_stop s-ui-hub-realm || fail HUB_ROLLBACK_FAILED
    if [ "$hub_had_config" = 1 ]; then
        cp "$hub_tmp/previous.json" /etc/s-ui-hub/realm.json.new
        mv /etc/s-ui-hub/realm.json.new /etc/s-ui-hub/realm.json
    else
        rm -f /etc/s-ui-hub/realm.json
    fi
    if [ "$hub_was_running" = 1 ]; then
        service_start s-ui-hub-realm || fail HUB_ROLLBACK_FAILED
        sleep 2
        service_running s-ui-hub-realm >/dev/null 2>&1 || fail HUB_ROLLBACK_FAILED
    fi
    fail HUB_ROLLED_BACK
fi
if [ "$hub_enabled" = 0 ]; then
    if [ "$hub_init" = openrc ]; then rc-update del s-ui-hub-realm default 2>/dev/null || :; else systemctl disable s-ui-hub-realm; fi
else
    service_enable s-ui-hub-realm
fi
printf 'HUB_OK\n'
