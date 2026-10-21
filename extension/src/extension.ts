import * as vscode from 'vscode';
import { pickAndImportCertificate } from './certificates';
import { getJson, RequestError } from './net';
import { findMismatches, patchProduct, productPath, readProduct, writeProduct } from './product';
import { configureServerDownload, fillServerCache } from './serverCache';
import { Sudo } from './system';

const SECTION = 'offlineMarketplace';
let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Offline Marketplace');
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand(`${SECTION}.configure`, async () => {
      const url = await promptForUrl();
      if (url) {
        await runChecks(context, url, true);
      }
    }),
    vscode.commands.registerCommand(`${SECTION}.check`, () => runChecks(context, configuredUrl(), true)),
    vscode.commands.registerCommand(`${SECTION}.importCertificate`, async () => {
      if (await pickAndImportCertificate(new Sudo(), log)) {
        await promptRestart(['The certificate was imported.']);
      }
    }),
  );

  if (vscode.workspace.getConfiguration(SECTION).get<boolean>('checkOnStartup', true)) {
    runChecks(context, configuredUrl(), false).catch((err) => log.appendLine(`Check failed: ${err}`));
  }
}

export function deactivate() {}

function configuredUrl(): string | undefined {
  return normaliseUrl(vscode.workspace.getConfiguration(SECTION).get<string>('url') ?? '');
}

function normaliseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

async function promptForUrl(): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'Offline Marketplace',
    prompt: 'URL of the offline marketplace used for extensions and VS Code updates',
    placeHolder: 'https://vscode-marketplace.internal',
    value: vscode.workspace.getConfiguration(SECTION).get<string>('url') || 'https://',
    ignoreFocusOut: true,
    validateInput: (input) => (normaliseUrl(input) ? undefined : 'Enter an http(s) URL'),
  });
  const url = value === undefined ? undefined : normaliseUrl(value);
  if (url) {
    await vscode.workspace.getConfiguration(SECTION).update('url', url, vscode.ConfigurationTarget.Global);
  }
  return url;
}

async function runChecks(context: vscode.ExtensionContext, url: string | undefined, interactive: boolean) {
  if (process.platform !== 'linux') {
    if (interactive) {
      vscode.window.showWarningMessage('Offline Marketplace only supports VS Code on Linux.');
    }
    return;
  }
  url = url ?? (await promptForUrl());
  if (!url) {
    return;
  }

  const sudo = new Sudo();
  const restartReasons: string[] = [];
  const product = readProduct();

  const mismatches = findMismatches(product, url);
  if (mismatches.length) {
    log.appendLine(`${productPath()} does not point at ${url}: ${mismatches.join(', ')}`);
    const choice = await vscode.window.showWarningMessage(
      `VS Code's product.json does not use ${url} for extensions and updates. Update it now? This may ask for your sudo password.`,
      'Update product.json',
      'Not now',
    );
    if (choice === 'Update product.json' && (await writeProduct(patchProduct(product, url), sudo, log))) {
      restartReasons.push('product.json now points at the offline marketplace.');
    }
  }

  try {
    await configureServerDownload(url, log);
  } catch (err) {
    log.appendLine(`Could not set remote.serverDownloadBaseUrl: ${(err as Error).message}`);
  }

  const reachability = await checkReachable(url, sudo);
  if (reachability === 'reachable') {
    const platforms = vscode.workspace.getConfiguration(SECTION).get<string[]>('serverCachePlatforms', ['linux-x64']);
    await fillServerCache(context, url, product, platforms, log);
  } else if (reachability === 'certificateImported') {
    restartReasons.push('The certificate was imported.');
  }

  if (restartReasons.length) {
    await promptRestart(restartReasons);
  } else if (interactive && !mismatches.length) {
    vscode.window.showInformationMessage(`VS Code is configured to use ${url}.`);
  }
}

/**
 * Requests the marketplace from within VS Code. On certificate errors the user may import a CA certificate,
 * which only takes effect after a restart.
 */
async function checkReachable(url: string, sudo: Sudo): Promise<'reachable' | 'certificateImported' | 'unreachable'> {
  try {
    await getJson(`${url}/api/health`);
    log.appendLine(`${url} is reachable`);
    return 'reachable';
  } catch (err) {
    const error = err as RequestError;
    log.appendLine(`${url} is not reachable: ${error.message} (${error.code ?? 'no code'})`);
    if (error.isCertificateError) {
      const choice = await vscode.window.showWarningMessage(
        `The certificate of ${url} is not trusted (${error.code}). Select the CA certificate to import into VS Code's trust store?`,
        'Select Certificate…',
        'Not now',
      );
      if (choice === 'Select Certificate…' && (await pickAndImportCertificate(sudo, log))) {
        return 'certificateImported';
      }
    } else {
      vscode.window.showErrorMessage(`Cannot reach the offline marketplace at ${url}: ${error.message}`);
    }
    return 'unreachable';
  }
}

async function promptRestart(reasons: string[]) {
  const choice = await vscode.window.showInformationMessage(
    `${reasons.join(' ')} Restart VS Code for the changes to take effect.`,
    { modal: true },
    'Quit VS Code',
  );
  if (choice === 'Quit VS Code') {
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}
