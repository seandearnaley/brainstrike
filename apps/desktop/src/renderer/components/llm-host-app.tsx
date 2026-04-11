import { StrictMode } from 'react';
import { BackgroundHostErrorBoundary } from './background-host-error-boundary';
import { LlmHostRuntime } from './llm-host-runtime';

export function LlmHostApp() {
  return (
    <StrictMode>
      <BackgroundHostErrorBoundary host="llm-host">
        <LlmHostRuntime />
      </BackgroundHostErrorBoundary>
    </StrictMode>
  );
}
