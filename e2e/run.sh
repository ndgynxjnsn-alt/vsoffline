#!/usr/bin/env bash
# End-to-end test: real sync -> bundle import -> real VS Code GUI (headless, Xvfb) against the gallery.
# Needs Docker and internet access for the sync. Work data lives in e2e/.work (reused between runs,
# FRESH=1 re-syncs). Exit code is the number of failed checks.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
W=$ROOT/e2e/.work
URL=https://localhost:8443
UIDGID="$(id -u):$(id -g)"
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
OLD_YAML=1.18.0
failures=0

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
check() { # check "description" command...
  local description=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  PASS $description"; else echo "  FAIL $description"; failures=$((failures + 1)); fi
}
gallery_log() { docker logs e2e-gallery 2>&1; }
curl_gallery() { curl -sS --cacert "$W/certs/ca.crt" "$@"; }

# Runs a shell command in the harness as the current user, trusting the gallery CA like the extension's
# certificate import does (NSS store + system store)
client() {
  docker run --rm --network host -v "$W:$W" -v /var/run/docker.sock:/var/run/docker.sock \
    -e HOME="$W/home" -e "CMD=$1" -w "$W" vscode-e2e bash -c '
      cp '"$W"'/certs/ca.crt /usr/local/share/ca-certificates/e2e.crt && update-ca-certificates >/dev/null 2>&1
      # Tools like `id -u -n` (used by Dev Containers) need a passwd entry
      getent group '"${UIDGID#*:}"' >/dev/null || groupadd -o -g '"${UIDGID#*:}"' tester
      getent passwd '"${UIDGID%:*}"' >/dev/null || useradd -o -u '"${UIDGID%:*}"' -g '"${UIDGID#*:}"' -M -d '"$W"'/home tester
      exec setpriv --reuid='"${UIDGID%:*}"' --regid='"${UIDGID#*:}"' --groups='"$DOCKER_GID"' --inh-caps=-all bash -c "$CMD"'
}
CODE="$W/VSCode-linux-x64/code"
CODE_ARGS="--user-data-dir $W/client/data --extensions-dir $W/client/ext"
# Starts the VS Code GUI for $1 seconds with extra arguments $2
run_gui() {
  client "timeout $1 xvfb-run -a -s '-screen 0 1280x900x24' $CODE --no-sandbox --disable-gpu --disable-workspace-trust --log trace \
    $CODE_ARGS ${2:-$W/workspace} >$W/gui.log 2>&1; true"
}
extension_log() { find "$W/client/data/logs" -name '*Offline Marketplace.log' -newer "$W/.launch" -exec cat {} + 2>/dev/null; }

step "Build images"
docker build -q -t vscode-e2e e2e >/dev/null || exit 1
docker build -q -t vscsync-e2e -f vscodeoffline/vscoffline/vscsync/Dockerfile vscodeoffline >/dev/null || exit 1
docker build -q -t gallery-e2e -f docker/gallery.Dockerfile . >/dev/null || exit 1

step "Sync (internet)"
if [ "${FRESH:-}" = 1 ] || [ ! -f "$W/bundle.tar" ]; then
  rm -rf "$W/online" && mkdir -p "$W/online/artifacts"
  printf 'redhat.vscode-yaml\nms-vscode-remote.remote-containers\n' >"$W/online/list.txt"
  docker run --rm -u "$UIDGID" -v "$W/online/artifacts:/artifacts" -v "$W/online/list.txt:/list.txt:ro" vscsync-e2e \
    python3 sync.py --artifacts /artifacts --update-binaries --binaries linux-deb-x64,server-linux-x64 \
    --update-extensions --update-malicious-extensions --extension-list /list.txt --target-platforms linux-x64 \
    --vscode-version 1.105.0 2>&1 | grep -E 'Pinning|Version:|Complete|WARN' | sed 's/^/  /'
  tar -cf "$W/bundle.tar" -C "$W/online/artifacts" --exclude=./specified.json --exclude=./updated.json .
fi
DEB_COMMIT=$(python3 -c "import json;print(json.load(open('$W/online/artifacts/installers/linux-deb-x64/stable/latest.json'))['version'])")
SERVER_COMMIT=$(python3 -c "import json;print(json.load(open('$W/online/artifacts/installers/server-linux-x64/stable/latest.json'))['version'])")
DEB_VERSION=$(python3 -c "import json;print(json.load(open('$W/online/artifacts/installers/linux-deb-x64/stable/latest.json'))['name'])")
check "server is pinned to the .deb commit ($DEB_VERSION ${DEB_COMMIT:0:10})" test "$DEB_COMMIT" = "$SERVER_COMMIT"

step "VS Code client matching the synced .deb"
if [ "$(python3 -c "import json;print(json.load(open('$W/VSCode-linux-x64/resources/app/product.json'))['commit'])" 2>/dev/null)" != "$DEB_COMMIT" ]; then
  rm -rf "$W/VSCode-linux-x64"
  curl -sSL "https://update.code.visualstudio.com/commit:$DEB_COMMIT/linux-x64/stable" | tar -xz -C "$W"
fi
check "client commit equals .deb commit" grep -q "\"commit\": \"$DEB_COMMIT\"" "$W/VSCode-linux-x64/resources/app/product.json"

step "Start gallery"
docker rm -f e2e-gallery >/dev/null 2>&1
rm -rf "$W/artifacts" "$W/certs" && mkdir -p "$W/artifacts"
(cd "$W" && "$ROOT/scripts/make-cert.sh" localhost 127.0.0.1 >/dev/null 2>&1 && mv "$ROOT/certs" "$W/certs")
docker run -d --name e2e-gallery -u "$UIDGID" -p 8443:443 -e URLROOT=$URL \
  -v "$W/artifacts:/artifacts" -v "$W/certs:/certs:ro" gallery-e2e >/dev/null
for _ in $(seq 30); do curl_gallery -o /dev/null "$URL/api/health" 2>/dev/null && break; sleep 1; done
curl_gallery -X POST --data-binary @"$W/bundle.tar" "$URL/api/import" | sed 's/^/  /'; echo
curl_gallery -X POST --data-binary @"$ROOT/extension/offline-marketplace.vsix" "$URL/api/upload/vsix" | sed 's/^/  /'; echo
check "update check endpoint knows yaml" curl_gallery -f "$URL/_apis/public/gallery/vscode/redhat/vscode-yaml/latest"
check "server for client commit is served" curl_gallery -f -o /dev/null -L "$URL/commit:$DEB_COMMIT/server-linux-x64/stable"

step "Prepare client"
rm -rf "$W/client" "$W/home" "$W/workspace" && mkdir -p "$W/client/data/User" "$W/home/.pki/nssdb" "$W/workspace"
cat >"$W/client/data/User/settings.json" <<EOF
{
  "offlineMarketplace.url": "$URL",
  "extensions.autoUpdate": true,
  "extensions.autoUpdateDelay": 0,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "workbench.startupEditor": "none"
}
EOF
client "certutil -d sql:$W/home/.pki/nssdb -N --empty-password && certutil -d sql:$W/home/.pki/nssdb -A -t C,, -n e2e -i $W/certs/ca.crt"
# product.json patched with the extension's own code (the GUI path asks for confirmation in a dialog)
[ -f "$W/product.json.orig" ] || cp "$W/VSCode-linux-x64/resources/app/product.json" "$W/product.json.orig"
cp "$W/product.json.orig" "$W/VSCode-linux-x64/resources/app/product.json"
cat >"$W/patch.js" <<'EOF'
const Module = require('module');
const load = Module._load;
Module._load = (request, ...rest) => (request === 'vscode' ? { env: { appRoot: process.argv[2] } } : load(request, ...rest));
const p = require(process.argv[3]);
p.writeProduct(p.patchProduct(p.readProduct(), process.argv[4]), null, { appendLine: () => {} }).then((ok) => process.exit(ok ? 0 : 1));
EOF
check "product.json patched" env ELECTRON_RUN_AS_NODE=1 "$CODE" "$W/patch.js" "$W/VSCode-linux-x64/resources/app" "$ROOT/extension/out/product.js" "$URL"
curl -sSL --compressed -o "$W/yaml-old.vsix" \
  "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/redhat/vsextensions/vscode-yaml/$OLD_YAML/vspackage"
# The CLI does not read the system CA store
client "NODE_EXTRA_CA_CERTS=$W/certs/ca.crt $W/VSCode-linux-x64/bin/code $CODE_ARGS --install-extension $W/yaml-old.vsix \
  --install-extension ms-vscode-remote.remote-containers --install-extension offline.offline-marketplace" 2>&1 \
  | grep -E 'installed|rror' | sed 's/^/  /'
check "old yaml $OLD_YAML installed" test -d "$W/client/ext/redhat.vscode-yaml-$OLD_YAML"
# VS Code never auto-updates VSIX installs; make the old yaml look like an older gallery install
python3 - "$W/client/ext/extensions.json" <<'PY'
import json, sys
extensions = json.load(open(sys.argv[1]))
for extension in extensions:
    if extension['identifier']['id'] == 'redhat.vscode-yaml':
        extension['metadata'].update(source='gallery', pinned=False, targetPlatform='undefined', updated=False)
json.dump(extensions, open(sys.argv[1], 'w'))
PY
# A newer upload of an extension installed from the gallery, the realistic update case
python3 - "$ROOT/extension/offline-marketplace.vsix" "$W/offline-marketplace-1.0.1.vsix" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], 'w') as target:
    for item in source.infolist():
        data = source.read(item)
        if item.filename in ('extension.vsixmanifest', 'extension/package.json'):
            data = data.replace(b'Version="1.0.0"', b'Version="1.0.1"').replace(b'"version": "1.0.0"', b'"version": "1.0.1"')
        target.writestr(item, data)
PY
check "upload of 1.0.1 accepted" curl_gallery -f -X POST --data-binary @"$W/offline-marketplace-1.0.1.vsix" "$URL/api/upload/vsix"
check "Dev Containers installed from gallery" compgen -G "$W/client/ext/ms-vscode-remote.remote-containers-*"

step "First start: extension update and server cache"
CACHE="$W/client/data/User/globalStorage/ms-vscode-remote.remote-containers/serverCache/$DEB_COMMIT/vscode-server-linux-x64.tar.gz"
touch "$W/.launch"; sleep 1
run_gui 120
extension_log | sed 's/^/  log: /'
check "VS Code asked the gallery for yaml's latest version" sh -c "docker logs e2e-gallery 2>&1 | grep -q 'GET /_apis/public/gallery/vscode/redhat/vscode-yaml/latest HTTP/1.1\" 200'"
check "yaml auto-updated to the gallery version" compgen -G "$W/client/ext/redhat.vscode-yaml-2.*"
check "uploaded extension auto-updated to 1.0.1" test -d "$W/client/ext/offline.offline-marketplace-1.0.1"
check "remote.serverDownloadBaseUrl set" grep -q "\"remote.serverDownloadBaseUrl\": \"$URL\"" "$W/client/data/User/settings.json"
check "server archive cached for Dev Containers" test -s "$CACHE"
check "cached server matches gallery file" cmp -s "$CACHE" "$W/artifacts/installers/server-linux-x64/stable/vscode-$DEB_VERSION.tar.gz"
check "no 404s from the gallery" sh -c "! docker logs e2e-gallery 2>&1 | grep -E '\" 404 '"

step "Second start: nothing to download"
before=$(gallery_log | grep -c 'commit:')
touch "$W/.launch"; sleep 1
run_gui 45
check "no server download on second start" test "$(gallery_log | grep -c 'commit:')" = "$before"

step "Server missing for this VS Code: warn once, no download attempts with progress"
rm -rf "$W/artifacts/installers/server-linux-x64" "$(dirname "$CACHE")"
for run in 1 2; do
  touch "$W/.launch"; sleep 1
  run_gui 45
  extension_log >"$W/missing-$run.log"
done
check "first start warns about the missing server" grep -q 'Warned: no VS Code server' "$W/missing-1.log"
check "second start does not warn again" sh -c "! grep -q 'Warned: no VS Code server' '$W/missing-2.log'"
check "no partial archive left behind" sh -c "! compgen -G '$(dirname "$CACHE")/*'"

step "Dev container uses the gallery's server"
curl_gallery -X POST --data-binary @"$W/bundle.tar" "$URL/api/import" >/dev/null
rm -rf "$W/devws" && mkdir -p "$W/devws/.devcontainer"
echo '{ "image": "debian:bookworm-slim" }' >"$W/devws/.devcontainer/devcontainer.json"
docker pull -q debian:bookworm-slim >/dev/null
for c in $(docker ps -aq --filter "label=devcontainer.local_folder=$W/devws"); do docker rm -f "$c" >/dev/null; done
HEX=$(printf %s "$W/devws" | od -An -tx1 | tr -d ' \n')
touch "$W/.launch"; sleep 1
run_gui 150 "--folder-uri vscode-remote://dev-container+$HEX/workspaces/devws"
DEVC=$(docker ps -aq --filter "label=devcontainer.local_folder=$W/devws" | head -1)
check "dev container was created" test -n "$DEVC"
check "VS Code server $DEB_VERSION runs in the dev container" \
  docker exec "$DEVC" sh -c "ls -d /root/.vscode-server/bin/$DEB_COMMIT || ls -d /root/.vscode-server/cli/servers/Stable-$DEB_COMMIT"
[ -n "$DEVC" ] && docker rm -f "$DEVC" >/dev/null

step "Result"
gallery_log >"$W/gallery.log"
docker rm -f e2e-gallery >/dev/null
if [ "$failures" = 0 ]; then echo "  all checks passed"; else echo "  $failures check(s) failed"; fi
exit "$failures"
