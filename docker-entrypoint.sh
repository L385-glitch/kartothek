#!/bin/sh
set -e
# TrueNAS custom apps bind-mount data dirs that are usually root-owned on
# the host. If we started as root, fix ownership, then drop to the app user.
if [ "$(id -u)" = "0" ] && [ -d /data ]; then
    chown -R studydeck:studydeck /data
fi
exec gosu studydeck "$@"
