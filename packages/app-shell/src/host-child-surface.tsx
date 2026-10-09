import { AssistantLinkCapabilitiesProvider } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
import type { ReactNode } from 'react';
import { AssistantProviderSourceProvider } from './hooks/assistant-provider-source';
import { useAssistantStatusProviderSource } from './hooks/use-assistant-provider-status';
import { useAssistantLinkCapabilitiesValue } from './use-assistant-link-capabilities';

/**
 * The assistant panel's own providers, as a host child conversation receives
 * them: its composer discovers providers seeded by the host's status, exactly
 * as the root panel's does, so a credential the host reads (an environment
 * key included) configures the child the same as its parent.
 */
export function HostChildSurface({ children }: { readonly children: ReactNode }) {
  const linkCapabilities = useAssistantLinkCapabilitiesValue();
  const providerSource = useAssistantStatusProviderSource();
  return (
    <AssistantProviderSourceProvider source={providerSource}>
      <AssistantLinkCapabilitiesProvider capabilities={linkCapabilities}>
        {children}
      </AssistantLinkCapabilitiesProvider>
    </AssistantProviderSourceProvider>
  );
}
