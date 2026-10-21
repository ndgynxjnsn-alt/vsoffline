import { useMemo, useState } from 'react';
import type { Extension } from '../api';
import { ExtensionIcon } from '../components/ExtensionIcon';
import { Link, itemUrl } from '../router';

type Sort = 'installs' | 'name' | 'updated';

const formatCount = (n: number) => Intl.NumberFormat(undefined, { notation: 'compact' }).format(n);

export function ExtensionList({ extensions, publisher }: { extensions: Extension[] | null; publisher: string | null }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('installs');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const result = (extensions ?? []).filter(
      (ext) =>
        (!publisher || ext.identity.toLowerCase().startsWith(publisher.toLowerCase() + '.')) &&
        (!q ||
          ext.identity.toLowerCase().includes(q) ||
          ext.displayName.toLowerCase().includes(q) ||
          ext.shortDescription.toLowerCase().includes(q)),
    );
    const compare: Record<Sort, (a: Extension, b: Extension) => number> = {
      installs: (a, b) => b.installs - a.installs,
      name: (a, b) => a.displayName.localeCompare(b.displayName),
      updated: (a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''),
    };
    return result.sort(compare[sort]);
  }, [extensions, publisher, query, sort]);

  return (
    <>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search extensions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="Sort by">
          <option value="installs">Most installed</option>
          <option value="name">Name</option>
          <option value="updated">Recently updated</option>
        </select>
      </div>
      {publisher && (
        <p className="muted">
          Published by <strong>{publisher}</strong> · <Link href="/">show all</Link>
        </p>
      )}
      {extensions === null ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="muted">No extensions found.</p>
      ) : (
        <>
          <p className="muted">{visible.length} extensions</p>
          <ul className="grid">
            {visible.map((ext) => (
              <li key={ext.identity}>
                <Link href={itemUrl(ext.identity)} className="card">
                  <ExtensionIcon extension={ext} />
                  <div className="card-body">
                    <div className="card-title">{ext.displayName}</div>
                    <div className="muted small">
                      {ext.publisher} · v{ext.version}
                      {ext.installs > 0 && <> · {formatCount(ext.installs)} installs</>}
                    </div>
                    <p className="description">{ext.shortDescription}</p>
                    {ext.uploaded && <span className="badge">uploaded</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
