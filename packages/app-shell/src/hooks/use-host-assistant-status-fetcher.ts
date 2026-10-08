import { useMemo } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import {
  type AssistantStatusFetcher,
  createAssistantStatusFetcher,
} from './use-assistant-availability';

/** The host's availability read; undefined where no host answers it (web). */
export function useHostAssistantStatusFetcher(): AssistantStatusFetcher | undefined {
  const providers = useAssistantThreadHost()?.providers;
  return useMemo(
    () => (providers ? createAssistantStatusFetcher(() => providers.readStatus()) : undefined),
    [providers]
  );
}
