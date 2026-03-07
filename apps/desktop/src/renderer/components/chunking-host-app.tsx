import { StrictMode } from 'react';
import { ChunkingHostRuntime } from './chunking-host-runtime';
import { DesktopChunkingWorkerProvider } from './desktop-chunking-worker-provider';

export function ChunkingHostApp() {
  return (
    <StrictMode>
      <DesktopChunkingWorkerProvider autoStart={true} mode="local">
        <ChunkingHostRuntime />
      </DesktopChunkingWorkerProvider>
    </StrictMode>
  );
}
