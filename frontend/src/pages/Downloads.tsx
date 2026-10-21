import { useEffect, useState } from 'react';
import { fetchInstallers, type Installers } from '../api';

const LABELS: Record<string, string> = {
  'linux-deb-x64': 'Linux .deb (x64)',
  'linux-x64': 'Linux .tar.gz (x64)',
  'server-linux-x64': 'VS Code Server (Linux x64)',
  'server-linux-alpine': 'VS Code Server (Alpine)',
  'cli-alpine-x64': 'VS Code CLI (Alpine x64)',
};

export function Downloads() {
  const [data, setData] = useState<Installers | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchInstallers().then(setData, (err: Error) => setError(err.message));
  }, []);

  return (
    <div className="stack">
      <section className="panel">
        <h2>Set up VS Code</h2>
        <ol>
          <li>Install VS Code from the .deb below.</li>
          <li>
            Install the OfflineMarketplace extension:{' '}
            {data?.client ? <a href={data.client}>download VSIX</a> : <span className="muted">not bundled</span>}, then
            run <code>code --install-extension offline-marketplace.vsix</code>.
          </li>
          <li>
            Enter <code>{window.location.origin}</code> when the extension asks for the marketplace url. It patches
            VS Code's product.json (asks for your sudo password) and, if needed, imports the CA certificate.
          </li>
          <li>Restart VS Code. Extensions, updates and Dev Containers now use this server.</li>
        </ol>
      </section>

      <section className="panel">
        <h2>VS Code downloads</h2>
        {error && <div className="notice error">{error}</div>}
        {data === null && !error ? (
          <p className="muted">Loading…</p>
        ) : data?.installers.length === 0 ? (
          <p className="muted">No installers have been imported yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Build</th>
                  <th>Version</th>
                  <th>Quality</th>
                  <th>Commit</th>
                </tr>
              </thead>
              <tbody>
                {data?.installers.map((installer) => (
                  <tr key={`${installer.identity}-${installer.quality}`}>
                    <td>
                      {installer.url ? (
                        <a href={installer.url}>{LABELS[installer.identity] ?? installer.identity}</a>
                      ) : (
                        (LABELS[installer.identity] ?? installer.identity)
                      )}
                    </td>
                    <td>{installer.productVersion ?? installer.name}</td>
                    <td>{installer.quality}</td>
                    <td>
                      <code title={installer.commit ?? ''}>{installer.commit?.slice(0, 10)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
