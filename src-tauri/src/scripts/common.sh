set -eu
set +x
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fail() { printf '%s\n' "$1"; exit 1; }
[ "$(id -u)" = 0 ] || fail HUB_ROOT_REQUIRED
[ -f /etc/os-release ] || fail HUB_UNSUPPORTED_OS
. /etc/os-release
case "$ID" in
    alpine) command -v rc-service >/dev/null || fail HUB_UNSUPPORTED_OS; hub_init=openrc ;;
    ubuntu|debian) command -v systemctl >/dev/null && [ -d /run/systemd/system ] || fail HUB_UNSUPPORTED_OS; hub_init=systemd ;;
    *) fail HUB_UNSUPPORTED_OS ;;
esac
# A remote lock also serializes separate Hub clients. The trap releases it on failure.
mkdir /run/s-ui-hub-management.lock 2>/dev/null || fail HUB_BUSY
hub_tmp=''
cleanup() {
    [ -z "$hub_tmp" ] || rm -rf -- "$hub_tmp"
    rmdir /run/s-ui-hub-management.lock
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
hub_tmp=$(mktemp -d /tmp/s-ui-hub.XXXXXXXX)
packages() {
    if [ "$hub_init" = openrc ]; then
        apk add --no-cache ca-certificates curl tar iproute2 bash
    else
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq ca-certificates curl tar iproute2 bash
    fi
}
fetch() { curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 --retry 2 "$1" -o "$2"; }
service_stop() {
    if [ "$hub_init" = openrc ]; then
        if rc-service "$1" status >/dev/null 2>&1; then rc-service "$1" stop; fi
    else systemctl stop "$1"; fi
}
service_start() {
    if [ "$hub_init" = openrc ]; then rc-service "$1" start; else systemctl start "$1"; fi
}
service_enable() {
    if [ "$hub_init" = openrc ]; then
        rc-update add "$1" default
    else
        systemctl enable "$1"
    fi
}
service_running() {
    if [ "$hub_init" = openrc ]; then rc-service "$1" status; else systemctl is-active --quiet "$1"; fi
}
