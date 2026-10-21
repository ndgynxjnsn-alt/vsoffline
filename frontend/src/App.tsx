import { useCallback, useEffect, useState } from 'react';
import { fetchExtensions, type Extension } from './api';
import { Link, useLocation } from './router';
import { ExtensionList } from './pages/ExtensionList';
import { ExtensionDetail } from './pages/ExtensionDetail';
import { Upload } from './pages/Upload';
import { Downloads } from './pages/Downloads';

export function App() {
  const location = useLocation();
  const [extensions, setExtensions] = useState<Extension[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchExtensions()
      .then((result) => {
        setExtensions(result);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(reload, [reload]);

  const path = location.pathname;
  let page;
  if (path === '/items') {
    page = <ExtensionDetail extensions={extensions} identity={location.searchParams.get('itemName') ?? ''} />;
  } else if (path === '/upload') {
    page = <Upload onUploaded={reload} />;
  } else if (path === '/downloads') {
    page = <Downloads />;
  } else {
    const publisher = path.startsWith('/publishers/') ? decodeURIComponent(path.slice('/publishers/'.length)) : null;
    page = <ExtensionList extensions={extensions} publisher={publisher} />;
  }

  const tab = (href: string, label: string, active: boolean) => (
    <Link href={href} className={active ? 'active' : undefined}>
      {label}
    </Link>
  );

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          Offline Marketplace
        </Link>
        <nav>
          {tab('/', 'Extensions', path === '/' || path === '/items' || path.startsWith('/publishers'))}
          {tab('/upload', 'Upload', path === '/upload')}
          {tab('/downloads', 'Downloads', path === '/downloads')}
        </nav>
      </header>
      <main>
        {error && <div className="notice error">Could not load extensions: {error}</div>}
        {page}
      </main>
    </>
  );
}
