import {
  type BulkAssistantThreadRepository,
  createPgliteAssistantThreadRepository,
} from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { useMemo } from 'react';
import { useAssistantThreadHost, withAssistantThreadHost } from '../assistant-thread-host-context';

export interface AssistantThreadRepositories {
  readonly assistantThreadRepository: BulkAssistantThreadRepository | null;
  /** The forge writer's repository: host threads commit through their host binding. */
  readonly forgeThreadRepository: BulkAssistantThreadRepository | null;
}

/**
 * The wrapper's history repository, plus the one writer that routes through the
 * thread host. Forge observations walk every thread in the resource, host threads
 * included, so a host thread's forgePrUrl is part of its committed binding, never
 * a history row.
 */
export function useAssistantThreadRepositories(db: DbHandle | null): AssistantThreadRepositories {
  const threadHost = useAssistantThreadHost();
  const assistantThreadRepository = useMemo(
    () => (db ? createPgliteAssistantThreadRepository(db) : null),
    [db]
  );
  const forgeThreadRepository = useMemo(
    () =>
      assistantThreadRepository
        ? withAssistantThreadHost(assistantThreadRepository, threadHost)
        : null,
    [assistantThreadRepository, threadHost]
  );
  return { assistantThreadRepository, forgeThreadRepository };
}
