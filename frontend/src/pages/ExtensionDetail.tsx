import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { fetchText, type Extension } from '../api';
import { ExtensionIcon } from '../components/ExtensionIcon';
import { Link, itemUrl } from '../router';

type Tab = 'readme' | 'changelog';

function Markdown({ url }: { url: string | null }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setHtml(null);
    setError(null);
    if (!url) return;
    fetchText(url)
      .then((text) => setHtml(DOMPurify.sanitize(marked.parse(text, { async: false }))))
      .catch((err: Error) => setError(err.message));
  }, [url]);
  if (!url) return <p className="muted">Not provided.</p>;
  if (error) return <p className="muted">Could not load: {error}</p>;
  if (html === null) return <p className="muted">Loading…</p>;
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ExtensionDetail({ extensions, identity }: { extensions: Extension[] | null; identity: string }) {
  const [tab, setTab] = useState<Tab>('readme');
  if (extensions === null) return <p className="muted">Loading…</p>;
  const ext = extensions.find((candidate) => candidate.identity.toLowerCase() === identity.toLowerCase());
  if (!ext) {
    return (
      <p>
        Extension <code>{identity}</code> is not available on this marketplace. <Link href="/">Back to all</Link>
      </p>
    );
  }
  const publisherName = ext.identity.split('.')[0];

  return (
    <article>
      <div className="detail-header">
        <ExtensionIcon extension={ext} size={96} />
        <div>
          <h1>{ext.displayName}</h1>
          <div className="muted">
            <Link href={`/publishers/${encodeURIComponent(publisherName)}`}>{ext.publisher}</Link> · <code>{ext.identity}</code> ·
            v{ext.version}
            {ext.uploaded && <span className="badge">uploaded</span>}
          </div>
          <p>{ext.shortDescription}</p>
        </div>
      </div>

      <div className="detail-layout">
        <section>
          <div className="tabs" role="tablist">
            {(['readme', 'changelog'] as Tab[]).map((name) => (
              <button
                key={name}
                role="tab"
                aria-selected={tab === name}
                className={tab === name ? 'active' : undefined}
                onClick={() => setTab(name)}
              >
                {name === 'readme' ? 'Details' : 'Changelog'}
              </button>
            ))}
          </div>
          <Markdown url={tab === 'readme' ? ext.readme : ext.changelog} />
        </section>

        <aside>
          <h3>Install</h3>
          <p className="small">Search for it in the VS Code Extensions view, or run:</p>
          <pre>code --install-extension {ext.identity}</pre>
          <h3>Download VSIX</h3>
          <ul className="plain">
            {ext.downloads.map((download) => (
              <li key={download.url}>
                <a href={download.url} download={`${ext.identity}-${download.version}-${download.targetPlatform}.vsix`}>
                  {download.version} ({download.targetPlatform})
                </a>
              </li>
            ))}
          </ul>
          {ext.engine && (
            <>
              <h3>Requires VS Code</h3>
              <p className="small">
                <code>{ext.engine}</code>
              </p>
            </>
          )}
          {ext.dependencies.length > 0 && (
            <>
              <h3>Dependencies</h3>
              <ul className="plain">
                {ext.dependencies.map((dep) => (
                  <li key={dep}>
                    <Link href={itemUrl(dep)}>{dep}</Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          {ext.categories.length > 0 && (
            <>
              <h3>Categories</h3>
              <p className="small">{ext.categories.join(', ')}</p>
            </>
          )}
        </aside>
      </div>
    </article>
  );
}
