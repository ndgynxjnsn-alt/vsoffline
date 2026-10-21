import { useState } from 'react';
import type { Extension } from '../api';

export function ExtensionIcon({ extension, size = 56 }: { extension: Extension; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (extension.icon && !failed) {
    return (
      <img className="icon" src={extension.icon} alt="" width={size} height={size} onError={() => setFailed(true)} />
    );
  }
  return (
    <div className="icon placeholder" style={{ width: size, height: size, fontSize: size / 2.2 }} aria-hidden>
      {extension.displayName.charAt(0).toUpperCase()}
    </div>
  );
}
