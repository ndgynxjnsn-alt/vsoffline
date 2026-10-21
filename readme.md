# VSCode offline.

VSCode environment that works offline. Consists of 
- VSCode extension
- API backend
- small frontend to upload new VSIX extensions
- artifact downloader.

## Overview

Makes VSCode usable in an air-gapped environment. Downloads artifacts such as
- latest VSCode amd 64 bit linux .deb
- corresponding code server
- extensions of list

on a machine with internet. Then hosts them in a way that makes VSCode able to self-update, open .devcontainer.json and install and update extensions.

## VSCode extension "OfflineMarketplace"

On VSCode start (and installation of the extension), check if extension setting custom url is configured. The URL should point to the custom marketplace the user wants to use. If not configured, the extension should prompt the user to enter the custom URL.

On each startup, the extension should read VSCode's installed product.json (only needs to work on Linux) and check if the whole bunch of gallery urls needed for VSIX installation are pointed to the custom URL instead of the official microsoft marketplace (this won't be reachable for airgapped devices.)
Also check the

If not, prompt the user for sudo and overwrite the product.json where the URLs point to the custom URL.
The extension should do an in-VSCode request to the https URLs in order to check if the URL can be reached safely. If not, prompt the user to select a certificate file to import into VSCodes trust store (it doesn't use the OS trust store) and prompt to quit VSCode (changes will only take effect on restart i think.)

## Backend

Based on https://github.com/LOLINTERNETZ/vscodeoffline. Should host the files necessary to install extensions, update vscode
Download the files necessary from the official marketplace, like LOLINTERNETZ/vscodeoffline itself.

You should not implement a lot. Just do surgical changes to LOLINTERNETZ/vscodeoffline and use that.

## Frontend

Part of the "backend server." Should be pretty minimal. Should be able to browse the extensions available and upload my own .VSIX extensions. If you need inspiration, look at openvsx/webui.
The frontend should be React-based.

## Implementation hint

Write a small artifacts.txt with the 10 most popular extensions.

### Continuous running.
I want to be able to run my backend without great interruption. The downloader on the internet machine could download all files necessary, I tar them on the machine without compression. The offline backend, when given the tar via an browser upload, should soak up the new extensions. Old versions of extensions should be deleted to save space.
Users should be able to upload VSIX files themselves to make them available for others.

### VSCode server in devcontainer
VSCode attempts to download the VSCode server component for the remote machine from GitHub, I think. That won't be reachable. If you cant change this download base url, what's been shown to work is simply putting the code server archive into the special ~/.config/code or whatever special folder where VSCode would download it. VSCode thinks it downloaded it itself and pushes it onto the server.

## Usage

Layout: `vscodeoffline/` is LOLINTERNETZ/vscodeoffline with small changes (configurable `URLROOT`, extension list,
binary/target-platform filters, dependency download, version pruning) plus `vscoffline/offline.py` (uploads, bundle
import, frontend API). `frontend/` is the React UI, `extension/` the OfflineMarketplace VS Code extension.

### Internet machine

1. Edit `artifacts.txt` (dependencies and extension packs are fetched automatically).
2. `scripts/download.sh` mirrors VS Code (.deb, .tar.gz, server for linux-x64/alpine, alpine CLI) and the
   extensions into `artifacts/`, and writes an uncompressed `bundles/vscode-offline-<date>.tar`.
   Binaries and target platforms are set in `docker-compose.yml` (`--binaries`, `--target-platforms`).
3. First time only: `docker compose build gallery && docker save <image> -o gallery.tar` to carry the image over.

### Offline machine

1. `scripts/make-cert.sh vscode-marketplace.internal` creates `certs/ca.crt` and a server certificate
   (or put your own `certs/server.crt` and `certs/server.key` there).
2. `cp .env.example .env`, set `PUBLIC_URL`, then `docker compose up -d gallery`.
3. Open the URL, go to *Upload*, and import the bundle tar. Re-importing newer bundles adds new versions and deletes old
   extension versions. Users can upload their own VSIX files there too; those are marked private, so VS Code installs
   them without a marketplace signature, and they can never replace a mirrored marketplace extension.

### Clients

Install VS Code from *Downloads*, then the OfflineMarketplace extension (`code --install-extension offline-marketplace.vsix`,
also linked there). It asks for the URL, patches `product.json` (using sudo if necessary), offers to import
`certs/ca.crt` when the certificate is not trusted, sets `remote.serverDownloadBaseUrl` and pre-fills the Dev Containers
server cache. Restart VS Code afterwards.
