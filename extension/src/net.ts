import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

const CERTIFICATE_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }

  get isCertificateError(): boolean {
    return this.code !== undefined && CERTIFICATE_ERRORS.has(this.code);
  }
}

/**
 * GET with redirects. Uses Node's http(s) modules, which VS Code patches in the extension host
 * to honour its proxy and certificate settings, so the result matches what VS Code itself sees.
 */
export function get(url: string, redirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 15000 }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume();
        get(new URL(response.headers.location, url).toString(), redirects - 1).then(resolve, reject);
      } else if (status !== 200) {
        response.resume();
        reject(new RequestError(`${url} returned HTTP ${status}`, undefined, status));
      } else {
        resolve(response);
      }
    });
    request.on('timeout', () => request.destroy(new RequestError(`${url} timed out`, 'ETIMEDOUT')));
    request.on('error', (err: NodeJS.ErrnoException) =>
      reject(err instanceof RequestError ? err : new RequestError(err.message, err.code)),
    );
  });
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await get(url);
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

/** Saves a response to a temporary file next to destination and renames it once complete. */
export async function save(response: http.IncomingMessage, destination: string): Promise<void> {
  const partial = `${destination}.partial`;
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(partial);
    response.on('error', reject);
    file.on('error', reject);
    file.on('finish', resolve);
    response.pipe(file);
  }).catch((err) => {
    fs.rmSync(partial, { force: true });
    throw err;
  });
  fs.renameSync(partial, destination);
}
