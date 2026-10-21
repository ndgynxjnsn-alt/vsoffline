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