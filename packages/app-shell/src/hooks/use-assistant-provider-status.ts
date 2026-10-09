import { createContext, useContext, useMemo } from 'react';
import type { AssistantProviderSource } from './assistant-provider-source';
import type { AssistantAvailabilityStatus } from './use-assistant-availability';

/**
 * The host's assistant availability, read once for the root panel and every
 * child conversation surface: the host owns which providers are configured,
 * so a child composer gates on the same providers as the root's.
 */
export const AssistantProviderStatusContext = createContext<
  AssistantAvailabilityStatus | undefined
>(undefined);

export function useAssistantProviderStatus(): AssistantAvailabilityStatus {
  const status = useContext(AssistantProviderStatusContext);
  if (!status) {
    throw new Error('AssistantProviderStatusProvider is required');
  }
  return status;
}

/** The provider source a composer discovers with under the host's status. */
export function useAssistantStatusProviderSource(): AssistantProviderSource {
  const status = useAssistantProviderStatus();
  return useMemo(() => resolveAssistantProviderSource(status), [status]);
}

function resolveAssistantProviderSource(
  status: AssistantAvailabilityStatus
): AssistantProviderSource {
  if (status.state === 'enabled' && status.provider && status.model) {
    return {
      kind: 'authoritative',
      providers: status.providers ?? [status.provider],
    };
  }
  if (status.state === 'enabled' && status.providers) {
    return { kind: 'discovery', seeds: status.providers };
  }
  return { kind: 'discovery' };
}
