#!/bin/bash
set -eu
key=/run/lethics-key/keyfile
if [ ! -s "$key" ]; then
  umask 077
  openssl rand -base64 756 > "$key"
fi
chown mongodb:mongodb "$key"
chmod 400 "$key"
exec /usr/local/bin/docker-entrypoint.sh mongod --replSet lethics-rs --keyFile "$key" --bind_ip_all --port 27018
