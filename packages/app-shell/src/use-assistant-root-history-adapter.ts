import {
  type AssistantThreadRepository,
  createAssistantThreadHistoryAdapter,
} from '@brainstrike/assistant-data';
import { useMemo } from 'react';

export function useAssistantRootHistoryAdapter({
  repository,
  threadId,
  resourceId,
}: {
  readonly repository: AssistantThreadRepository | null | undefined;
  readonly threadId: string | undefined;
  readonly resourceId: string;
}) {
  return useMemo(() => {
    if (!(repository && threadId)) {
      return;
    }
    return createAssistantThreadHistoryAdapter({ repository, resourceId, threadId });
  }, [repository, resourceId, threadId]);
}
