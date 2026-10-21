import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { commandExists, run, Sudo } from './system';

const SYSTEM_STORES = [
  { dir: '/usr/local/share/ca-certificates', update: 'update-ca-certificates' }, // Debian, Ubuntu
  { dir: '/etc/pki/ca-trust/source/anchors', update: 'update-ca-trust' }, // Fedora, RHEL
];

function toPem(content: Buffer): string {
  const text = content.toString('utf8');
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    return text;
  }
  // DER encoded
  const base64 = content.toString('base64').replace(/.{64}/g, '$&\n');
  return `-----BEGIN CERTIFICATE-----\n${base64.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

/** Asks for a CA certificate file and imports it. Returns true when anything was imported. */
export async function pickAndImportCertificate(sudo: Sudo, log: vscode.OutputChannel): Promise<boolean> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Select the CA certificate of the offline marketplace',
    canSelectMany: false,
    filters: { Certificates: ['crt', 'pem', 'cer', 'der'], 'All files': ['*'] },
  });
  if (!picked?.length) {
    return false;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-marketplace-'));
  const pem = path.join(temp, 'offline-marketplace-ca.crt');
  fs.writeFileSync(pem, toPem(fs.readFileSync(picked[0].fsPath)));
  const imported: string[] = [];
  const problems: string[] = [];

  try {
    // Chromium's trust store on Linux, used by VS Code's own network requests
    if (await commandExists('certutil')) {
      const db = `sql:${path.join(os.homedir(), '.pki', 'nssdb')}`;
      fs.mkdirSync(path.join(os.homedir(), '.pki', 'nssdb'), { recursive: true });
      if (!fs.existsSync(path.join(os.homedir(), '.pki', 'nssdb', 'cert9.db'))) {
        await run('certutil', ['-d', db, '-N', '--empty-password']);
      }
      const nickname = `Offline Marketplace CA (${path.basename(picked[0].fsPath)})`;
      const result = await run('certutil', ['-d', db, '-A', '-t', 'C,,', '-n', nickname, '-i', pem]);
      if (result.code === 0) {
        imported.push('VS Code (NSS) trust store');
      } else {
        problems.push(`certutil failed: ${result.stderr.trim()}`);
      }
    } else {
      problems.push('certutil is not installed (package libnss3-tools or nss-tools), so the NSS store was not updated');
    }

    // System store, read by VS Code's Node based requests (http.systemCertificates)
    const store = SYSTEM_STORES.find((candidate) => fs.existsSync(candidate.dir));
    if (store) {
      const script = 'cp "$1" "$2" && chmod 644 "$2" && "$3"';
      const destination = path.join(store.dir, 'offline-marketplace-ca.crt');
      const result = await sudo.run('add the certificate to the system trust store', [
        'sh',
        '-c',
        script,
        'sh',
        pem,
        destination,
        store.update,
      ]);
      if (result?.code === 0) {
        imported.push('system trust store');
      } else if (result) {
        problems.push(`system trust store update failed: ${result.stderr.trim()}`);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  for (const line of [...imported.map((store) => `Imported certificate into ${store}`), ...problems]) {
    log.appendLine(line);
  }
  if (problems.length) {
    vscode.window.showWarningMessage(problems.join('. '));
  }
  return imported.length > 0;
}
