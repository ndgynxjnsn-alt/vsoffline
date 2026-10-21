import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Sudo } from './system';

export interface Product {
  [key: string]: unknown;
  commit?: string;
  quality?: string;
  extensionsGallery?: Record<string, unknown>;
  linkProtectionTrustedDomains?: string[];
}

export const productPath = () => path.join(vscode.env.appRoot, 'product.json');

export function readProduct(): Product {
  return JSON.parse(fs.readFileSync(productPath(), 'utf8')) as Product;
}

/** product.json values that must point at the offline marketplace instead of Microsoft's services. */
function expectedValues(url: string, product: Product) {
  const gallery: Record<string, string> = {
    serviceUrl: `${url}/_apis/public/gallery`,
    itemUrl: `${url}/items`,
    publisherUrl: `${url}/publishers`,
    resourceUrlTemplate: `${url}/resources/{publisher}/{name}/{version}/{path}`,
    extensionUrlTemplate: `${url}/_gallery/{publisher}/{name}/latest`,
    controlUrl: `${url}/extensions/marketplace.json`,
    nlsBaseUrl: `${url}/_lp/`,
  };
  if (product.extensionsGallery?.mcpUrl !== undefined) {
    gallery.mcpUrl = `${url}/mcp/servers.json`;
  }
  const top: Record<string, string> = {
    updateUrl: url,
    downloadUrl: `${url}/downloads`,
  };
  return { gallery, top };
}

/** Names of the product.json entries which do not point at url. */
export function findMismatches(product: Product, url: string): string[] {
  const { gallery, top } = expectedValues(url, product);
  const mismatches = Object.entries(top)
    .filter(([key, value]) => product[key] !== value)
    .map(([key]) => key);
  mismatches.push(
    ...Object.entries(gallery)
      .filter(([key, value]) => product.extensionsGallery?.[key] !== value)
      .map(([key]) => `extensionsGallery.${key}`),
  );
  if (!product.linkProtectionTrustedDomains?.includes(url)) {
    mismatches.push('linkProtectionTrustedDomains');
  }
  return mismatches;
}

export function patchProduct(product: Product, url: string): Product {
  const { gallery, top } = expectedValues(url, product);
  const trusted = product.linkProtectionTrustedDomains ?? [];
  return {
    ...product,
    ...top,
    extensionsGallery: { ...product.extensionsGallery, ...gallery },
    linkProtectionTrustedDomains: trusted.includes(url) ? trusted : [...trusted, url],
  };
}

/**
 * Overwrites product.json, keeping the original as product.json.offline-backup.
 * Falls back to sudo when the file is not writable (e.g. /usr/share/code from the .deb).
 * Returns false when the user cancelled or writing failed.
 */
export async function writeProduct(product: Product, sudo: Sudo, log: vscode.OutputChannel): Promise<boolean> {
  const target = productPath();
  const backup = `${target}.offline-backup`;
  const content = JSON.stringify(product, null, '\t');

  try {
    fs.accessSync(target, fs.constants.W_OK);
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(target, backup);
    }
    fs.writeFileSync(target, content);
    log.appendLine(`Updated ${target}`);
    return true;
  } catch {
    // Not writable by the current user
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-marketplace-'));
  const source = path.join(temp, 'product.json');
  fs.writeFileSync(source, content);
  try {
    const script = '[ -e "$3" ] || cp -p "$1" "$3"; cp "$2" "$1"';
    const result = await sudo.run('update VS Code product.json', ['sh', '-c', script, 'sh', target, source, backup]);
    if (!result) {
      return false;
    }
    if (result.code !== 0) {
      log.appendLine(`Updating ${target} failed: ${result.stderr}`);
      vscode.window.showErrorMessage(`Updating product.json failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
      return false;
    }
    log.appendLine(`Updated ${target} using sudo`);
    return true;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
