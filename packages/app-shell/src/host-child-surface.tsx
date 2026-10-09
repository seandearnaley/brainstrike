import { AssistantLinkCapabilitiesProvider } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
import type { ReactNode } from 'react';
import { CHILD_PROVIDER_SOURCE } from './child-provider-source';
import { AssistantProviderSourceProvider } from './hooks/assistant-provider-source';
import { useAssistantLinkCapabilitiesValue } from './use-assistant-link-capabilities';

/** The assistant panel's own providers, as a legacy child conversation receives them. */
export function HostChildSurface({ children }: { readonly children: ReactNode }) {
  const linkCapabilities = useAssistantLinkCapabilitiesValue();
  return (
    <AssistantProviderSourceProvider source={CHILD_PROVIDER_SOURCE}>
      <AssistantLinkCapabilitiesProvider capabilities={linkCapabilities}>
        {children}
      </AssistantLinkCapabilitiesProvider>
    </AssistantProviderSourceProvider>
  );
}
