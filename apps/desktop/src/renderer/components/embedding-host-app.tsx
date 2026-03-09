import { DbProvider } from '@brainstrike/db';
import { StrictMode } from 'react';
import { BackgroundHostErrorBoundary } from './background-host-error-boundary';
import { EmbeddingHostRuntime } from './embedding-host-runtime';

export function EmbeddingHostApp() {
  return (
    <StrictMode>
      <BackgroundHostErrorBoundary host="embedding-host">
        <DbProvider dbPath="idb://brainstrike-desktop" useElectronIPC={true}>
          <EmbeddingHostRuntime />
        </DbProvider>
      </BackgroundHostErrorBoundary>
    </StrictMode>
  );
}
