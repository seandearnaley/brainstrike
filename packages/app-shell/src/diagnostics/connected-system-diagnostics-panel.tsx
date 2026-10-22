import { useOptionalTokenCacheContext } from '@brainstrike/file-explorer-ui/indexing';
import type { ReactElement } from 'react';
import { SystemDiagnosticsPanel } from './system-diagnostics-panel';

/** Reads token-cache state from context before rendering diagnostics. */
export function ConnectedSystemDiagnosticsPanel(): ReactElement {
  const tokenCache = useOptionalTokenCacheContext();

  return (
    <SystemDiagnosticsPanel
      persistenceMode={tokenCache?.persistenceMode}
      tokenCacheOperational={tokenCache?.isOperational}
      tokenCachePersisted={tokenCache?.isPersisted}
    />
  );
}
