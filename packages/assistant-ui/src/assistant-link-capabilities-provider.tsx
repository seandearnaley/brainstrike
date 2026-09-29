import type { ReactElement, ReactNode } from 'react';
import {
  type AssistantLinkCapabilities,
  AssistantLinkCapabilitiesContext,
} from './assistant-link-capabilities';

// Type-only re-exports: erased at build time, so this file still exports
// exactly one runtime binding and Fast Refresh stays intact. Hosts get the
// provider and its contract from a single narrow entry point.
export type {
  AssistantLinkCapabilities,
  AssistantLinkOpenResult,
} from './assistant-link-capabilities';

export function AssistantLinkCapabilitiesProvider({
  capabilities,
  children,
}: {
  readonly capabilities: AssistantLinkCapabilities;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <AssistantLinkCapabilitiesContext value={capabilities}>
      {children}
    </AssistantLinkCapabilitiesContext>
  );
}
