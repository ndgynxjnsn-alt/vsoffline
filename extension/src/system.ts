import { spawn } from 'child_process';
import * as vscode from 'vscode';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(command: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });
}

export async function commandExists(command: string): Promise<boolean> {
  return (await run('sh', ['-c', 'command -v "$1"', 'sh', command])).code === 0;
}

/** Runs commands as root, asking for the sudo password once per instance. */
export class Sudo {
  private password: string | undefined;

  /** Returns undefined when the user cancelled the password prompt. */
  async run(reason: string, args: string[]): Promise<RunResult | undefined> {
    if (this.password === undefined) {
      this.password = await vscode.window.showInputBox({
        title: 'Offline Marketplace',
        prompt: `sudo password to ${reason}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (this.password === undefined) {
        return undefined;
      }
    }
    const result = await run('sudo', ['-S', '-k', '-p', '', '--', ...args], `${this.password}\n`);
    if (result.code !== 0 && /incorrect password|try again/i.test(result.stderr)) {
      this.password = undefined;
    }
    return result;
  }
}
