import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { get, RequestError, save } from './net';
import { Product } from './product';

const DEV_CONTAINERS = 'ms-vscode-remote.remote-containers';

/** Lets Dev Containers download the VS Code server from the offline marketplace. */
export async function configureServerDownload(url: string, log: vscode.OutputChannel): Promise<void> {
  if (!vscode.extensions.getExtension(DEV_CONTAINERS)) {
    return;
  }
  const remote = vscode.workspace.getConfiguration('remote');
  if (remote.get<string>('serverDownloadBaseUrl') !== url) {
    await remote.update('serverDownloadBaseUrl', url, vscode.ConfigurationTarget.Global);
    log.appendLine(`Set remote.serverDownloadBaseUrl to ${url}`);
  }
}

/**
 * Places the VS Code server matching this VS Code into the Dev Containers download cache
 * (globalStorage/ms-vscode-remote.remote-containers/serverCache/<commit>/), where it is picked up
 * instead of being downloaded when a container is opened.
 */
export async function fillServerCache(
  context: vscode.ExtensionContext,
  url: string,
  product: Product,
  platforms: string[],
  log: vscode.OutputChannel,
): Promise<void> {
  if (!vscode.extensions.getExtension(DEV_CONTAINERS) || !product.commit) {
    return;
  }
  const quality = product.quality ?? 'stable';
  const globalStorage = path.dirname(context.globalStorageUri.fsPath);
  const cacheDir = path.join(globalStorage, DEV_CONTAINERS, 'serverCache', product.commit);
  const missing = platforms.filter(
    (platform) => !fs.existsSync(path.join(cacheDir, serverArchiveName(platform, quality))),
  );
  if (!missing.length) {
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  for (const platform of missing) {
    const source = `${url}/commit:${product.commit}/server-${platform}/${quality}`;
    const destination = path.join(cacheDir, serverArchiveName(platform, quality));
    try {
      // Only show progress once the server actually has this build
      const response = await get(source);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Offline Marketplace: Downloading VS Code server (${platform}) for Dev Containers`,
        },
        () => save(response, destination),
      );
      log.appendLine(`Cached ${source} at ${destination}`);
    } catch (err) {
      log.appendLine(`Could not cache VS Code server ${source}: ${(err as Error).message}`);
      if ((err as RequestError).status === 404) {
        await notifyServerMissing(context, url, product, platform, log);
      }
    }
  }
}

/** The server only keeps the newest VS Code, so older clients cannot get a matching server. Tell once per version. */
async function notifyServerMissing(
  context: vscode.ExtensionContext,
  url: string,
  product: Product,
  platform: string,
  log: vscode.OutputChannel,
) {
  const key = `serverMissing:${product.commit}:${platform}`;
  if (context.globalState.get<boolean>(key)) {
    return;
  }
  await context.globalState.update(key, true);
  log.appendLine(`Warned: no VS Code server ${platform} for commit ${product.commit} on ${url}`);
  const choice = await vscode.window.showWarningMessage(
    `The offline marketplace has no VS Code server (${platform}) for this VS Code version (commit ${product.commit?.slice(0, 10)}). ` +
      'Dev Containers will not start until you update VS Code to the version offered by the marketplace.',
    'Open Downloads',
  );
  if (choice === 'Open Downloads') {
    await vscode.env.openExternal(vscode.Uri.parse(`${url}/downloads`));
  }
}

function serverArchiveName(platform: string, quality: string): string {
  return `vscode-server-${platform}${quality === 'stable' ? '' : `-${quality}`}.tar.gz`;
}
