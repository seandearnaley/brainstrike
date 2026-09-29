import { DbProvider } from '@brainstrike/db/react';
import { StrictMode } from 'react';
import { BackgroundHostErrorBoundary } from './background-host-error-boundary';
import { EmbeddingHostRuntime } from './embedding-host-runtime';

export function EmbeddingHostApp() {
  return (
    <StrictMode>
      <BackgroundHostErrorBoundary host="embedding-host">
        {/* useElectronIPC routes to the main-process filesystem PGlite (engine-versioned
            via the pg-data-version guard). No dbPath: the hidden host's preload exposes
            `electronAPI.db`, so the capability probe always selects the IPC transport and
            no renderer-side PGlite is ever opened here (BST-1653). */}
        <DbProvider useElectronIPC={true}>
          <EmbeddingHostRuntime />
        </DbProvider>
      </BackgroundHostErrorBoundary>
    </StrictMode>
  );
}
