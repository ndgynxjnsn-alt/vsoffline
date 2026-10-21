# OfflineMarketplace

Makes VS Code use a self-hosted offline marketplace (see the repository readme) instead of the
official Microsoft services, which are unreachable on air-gapped machines.

On startup the extension:

1. Asks for the marketplace URL (`offlineMarketplace.url`) if it is not configured.
2. Checks that VS Code's `product.json` points the extension gallery, update and download URLs at the
   marketplace. If not, it patches the file, asking for your sudo password when it is not writable.
   A backup is kept next to it as `product.json.offline-backup`.
3. Requests the marketplace over HTTPS. When the certificate is not trusted, it offers to import a CA
   certificate into VS Code's (Chromium's) NSS trust store `~/.pki/nssdb` and the system trust store.
4. Sets `remote.serverDownloadBaseUrl` and places the VS Code server into the Dev Containers download
   cache, so dev containers start without access to update.code.visualstudio.com.

Changes to `product.json` and certificates take effect after restarting VS Code; the extension offers to quit.
VS Code updates replace `product.json`, so the check runs on every start.

Commands: **Offline Marketplace: Set Marketplace URL**, **Check Configuration**, **Import CA Certificate**.
