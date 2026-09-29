import {
  type AssistantThreadRepository,
  createAssistantThreadHistoryAdapter,
  createSuspendedRunDiscovery,
} from '@brainstrike/assistant-data';
import { useMemo } from 'react';
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';

export function useAssistantRootHistoryAdapter({
  repository,
  threadId,
  resourceId,
  desktopBackend,
}: {
  readonly repository: AssistantThreadRepository | null | undefined;
  readonly threadId: string | undefined;
  readonly resourceId: string;
  readonly desktopBackend: boolean;
}) {
  return useMemo(() => {
    if (!(repository && threadId)) {
      return;
    }
    // Restart-safe approval rediscovery is desktop-only (web never suspends —
    // no assistant server/storage). Capability gating, no isElectron() check.
    return createAssistantThreadHistoryAdapter({
      repository,
      resourceId,
      threadId,
      ...(desktopBackend
        ? { discoverSuspendedRuns: createSuspendedRunDiscovery(resolveAssistantBaseUrl) }
        : {}),
    });
  }, [repository, desktopBackend, resourceId, threadId]);
}
