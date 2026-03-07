import { DbProvider } from '@brainstrike/db';
import { StrictMode } from 'react';
import { EmbeddingHostRuntime } from './embedding-host-runtime';

export function EmbeddingHostApp() {
  return (
    <StrictMode>
      <DbProvider dbPath="idb://brainstrike-desktop" useElectronIPC={true}>
        <EmbeddingHostRuntime />
      </DbProvider>
    </StrictMode>
  );
}
