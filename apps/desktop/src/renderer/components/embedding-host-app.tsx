import { StrictMode } from 'react';
import { BackgroundHostErrorBoundary } from './background-host-error-boundary';
import { EmbeddingHostRuntime } from './embedding-host-runtime';

export function EmbeddingHostApp() {
  return (
    <StrictMode>
      <BackgroundHostErrorBoundary host="embedding-host">
        <EmbeddingHostRuntime />
      </BackgroundHostErrorBoundary>
    </StrictMode>
  );
}
