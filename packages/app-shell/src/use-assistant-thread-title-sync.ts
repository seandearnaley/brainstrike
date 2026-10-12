import { MASTRA_MEMORY_TABLES } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useEffect, useMemo } from 'react';
import { useAssistantThreadHost, withAssistantThreadHost } from './assistant-thread-host-context';

const logger = createLogger('AssistantThreadTitleSync');

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
  repository: historyRepository,
  resourceId,
}: UseAssistantThreadTitleSyncInput): () => void {
  // A refresh REPLACES the resource's thread list, so it lists through the
  // host as well: a history-only listing would drop every host thread from
  // the store until the next host-routed refresh.
  const host = useAssistantThreadHost();
  const repository = useMemo(
    () => (historyRepository ? withAssistantThreadHost(historyRepository, host) : null),
    [historyRepository, host]
  );
  // Schema constants are initialized by the assistant-contract chunk. Reading
  // them inside the hook avoids a module-evaluation ordering dependency.
  const titleQuery = useMemo(
    () => `
      SELECT id, title
      FROM ${MASTRA_MEMORY_TABLES.threads}
      WHERE "resourceId" = $1
      ORDER BY id ASC
    `,
    []
  );
  const { error, loading, rows } = usePGliteLiveQuery<AssistantThreadTitleRow>({
    cacheKey: makeLiveQueryKey('assistant-thread-titles', resourceId),
    clearOnDisable: true,
    enabled,
    params: [resourceId],
    query: titleQuery,
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
