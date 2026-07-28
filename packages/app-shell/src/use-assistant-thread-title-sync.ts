import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo } from 'react';
import type { AssistantThreadRepository } from './assistant-memory-repository';

const logger = createLogger('AssistantThreadTitleSync');

const ASSISTANT_THREAD_TITLES_QUERY = `
  SELECT id, title
  FROM mastra_threads
  WHERE "resourceId" = $1
  ORDER BY id ASC
`;

interface AssistantThreadTitleRow {
  readonly id: string;
  readonly title: string | null;
}

interface UseAssistantThreadTitleSyncInput {
  readonly enabled: boolean;
  readonly refreshResourceThreads: (
    repository: AssistantThreadRepository,
    resourceId: string
  ) => Promise<void>;
  readonly repository: AssistantThreadRepository | null;
  readonly resourceId: string;
}

/**
 * Keep the thread store aligned with out-of-band Mastra title writes.
 *
 * Mastra title generation settles after the main provider turn, so a
 * message-finish callback can race the title update. PGlite's live query is the
 * exact local mutation signal. Depending on a stable id/title signature avoids
 * re-listing threads when Mastra only bumps a thread's updatedAt.
 */
export function useAssistantThreadTitleSync({
  enabled,
  refreshResourceThreads,
  repository,
  resourceId,
}: UseAssistantThreadTitleSyncInput): () => void {
  const { error, loading, rows } = usePGliteLiveQuery<AssistantThreadTitleRow>({
    cacheKey: makeLiveQueryKey('assistant-thread-titles', resourceId),
    clearOnDisable: true,
    enabled,
    params: [resourceId],
    query: ASSISTANT_THREAD_TITLES_QUERY,
  });
  const titleSignature = useMemo(
    () => JSON.stringify(rows.map(({ id, title }) => [id, title])),
    [rows]
  );
  const refreshAfterRun = useCallback(() => {
    if (!repository) {
      return;
    }
    refreshResourceThreads(repository, resourceId).catch((refreshError: unknown) => {
      logger.warn('Failed to refresh assistant threads after run', {
        error: refreshError,
        resourceId,
      });
    });
  }, [refreshResourceThreads, repository, resourceId]);

  useEffect(() => {
    if (error) {
      logger.warn('Assistant thread title subscription failed', { error, resourceId });
    }
  }, [error, resourceId]);

  useEffect(() => {
    if (!(enabled && repository) || loading || error) {
      return;
    }
    refreshResourceThreads(repository, resourceId).catch((refreshError: unknown) => {
      logger.warn('Failed to apply an assistant thread title update', {
        error: refreshError,
        resourceId,
      });
    });
  }, [enabled, error, loading, refreshResourceThreads, repository, resourceId, titleSignature]);

  return refreshAfterRun;
}
