export interface Download {
  version: string;
  targetPlatform: string;
  url: string;
}

export interface Extension {
  identity: string;
  displayName: string;
  publisher: string;
  shortDescription: string;
  version: string;
  lastUpdated: string | null;
  installs: number;
  categories: string[];
  uploaded: boolean;
  engine: string | null;
  dependencies: string[];
  icon: string | null;
  readme: string | null;
  changelog: string | null;
  downloads: Download[];
}

export interface Installer {
  identity: string;
  quality: string;
  name: string;
  productVersion: string | null;
  commit: string | null;
  timestamp: number | null;
  url: string | null;
}

export interface Installers {
  installers: Installer[];
  client: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export const fetchExtensions = () => getJson<Extension[]>('/api/extensions');
export const fetchInstallers = () => getJson<Installers>('/api/installers');

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.text();
}

/** POSTs a file as the raw request body, reporting progress (0..1). Resolves with the JSON response. */
export function uploadFile(url: string, file: File, onProgress: (fraction: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onload = () => {
      let body: { description?: string; title?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.description ?? body?.title ?? `${xhr.status} ${xhr.statusText}`));
    };
    xhr.send(file);
  });
}
