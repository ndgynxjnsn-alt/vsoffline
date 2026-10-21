#!/usr/bin/env bash
# Creates a private CA and a server certificate for the offline marketplace host in ./certs.
# Clients import certs/ca.crt (the OfflineMarketplace extension prompts for it).
#   usage: scripts/make-cert.sh vscode-marketplace.internal [more names or IPs...]
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { echo "usage: $0 HOSTNAME [ALTNAME...]" >&2; exit 1; }

mkdir -p certs
cd certs

san=""
for name in "$@"; do
  if [[ "$name" =~ ^[0-9.]+$ ]]; then san+="IP:$name,"; else san+="DNS:$name,"; fi
done
san="${san%,}"

if [ ! -f ca.key ]; then
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout ca.key -out ca.crt -subj "/CN=VS Code Offline Marketplace CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
fi

openssl req -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr -subj "/CN=$1"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -out server.crt \
  -extfile <(printf "subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" "$san")
rm server.csr
echo "Created certs/server.crt for $san, signed by certs/ca.crt"
