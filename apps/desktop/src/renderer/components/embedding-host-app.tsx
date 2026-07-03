import { DbProvider } from '@brainstrike/db';
import { StrictMode } from 'react';
import { BackgroundHostErrorBoundary } from './background-host-error-boundary';
import { EmbeddingHostRuntime } from './embedding-host-runtime';

export function EmbeddingHostApp() {
  return (
    <StrictMode>
      <BackgroundHostErrorBoundary host="embedding-host">
        {/* useElectronIPC routes to the main-process database runtime selected by profile
            bootstrap; this idb path opens no renderer-side database, so it is intentionally
            not engine-versioned. */}
        <DbProvider dbPath="idb://brainstrike-desktop" useElectronIPC={true}>
          <EmbeddingHostRuntime />
        </DbProvider>
      </BackgroundHostErrorBoundary>
    </StrictMode>
  );
}
