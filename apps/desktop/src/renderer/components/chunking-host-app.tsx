import { StrictMode } from 'react';
import { BackgroundHostErrorBoundary } from './background-host-error-boundary';
import { ChunkingHostRuntime } from './chunking-host-runtime';
import { DesktopChunkingWorkerProvider } from './desktop-chunking-worker-provider';

export function ChunkingHostApp() {
  return (
    <StrictMode>
      <BackgroundHostErrorBoundary host="chunking-host">
        <DesktopChunkingWorkerProvider autoStart={true} mode="local">
          <ChunkingHostRuntime />
        </DesktopChunkingWorkerProvider>
      </BackgroundHostErrorBoundary>
    </StrictMode>
  );
}
