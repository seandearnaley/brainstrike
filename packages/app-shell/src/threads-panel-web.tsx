import {
  createPgliteAssistantThreadGroupsRepository,
  createPgliteAssistantThreadRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { ThreadSearchRepository } from '@brainstrike/db';
import {
  useDbInitializationStatus,
  useDbInitializing,
  useDbProviderError,
  usePGliteDatabase,
} from '@brainstrike/db/react';
import { type ReactElement, useMemo } from 'react';
import { shouldRenderAssistantThreadDatabaseStartupLoading } from './assistant-thread-database-state';
import { useThreadsAwaitingApproval } from './hooks/use-threads-awaiting-approval';
import { ThreadsPanelCore, type ThreadsPanelProps } from './threads-panel';
import { useActiveAssistantThreadIds } from './use-active-assistant-thread-ids';
export function WebThreadsPanel(props: ThreadsPanelProps): ReactElement {
  const database = usePGliteDatabase();
  const databaseInitializing = useDbInitializing();
  const databaseStatus = useDbInitializationStatus();
  const databaseError = useDbProviderError();
  const repository = useMemo(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
  );
  const groupsRepository = useMemo(
    () => (database ? createPgliteAssistantThreadGroupsRepository(database) : null),
    [database]
  );
  const threadSearchRepository = useMemo(
    () => (database ? new ThreadSearchRepository(database) : null),
    [database]
  );
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const scope = {
    database,
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    schemaReady: Object.hasOwn(threadsByResourceId, WORKSPACE_MEMORY_RESOURCE_ID),
  };
  const activeThreads = useActiveAssistantThreadIds(scope);
  const threadsAwaitingApproval = useThreadsAwaitingApproval(scope);
  const databaseStartupLoading = shouldRenderAssistantThreadDatabaseStartupLoading({
    databaseError,
    databaseInitializing,
    databaseStatus,
    repositoryReady: Boolean(repository),
  });
  return (
    <ThreadsPanelCore
      {...props}
      activeThreads={activeThreads}
      database={database}
      databaseError={databaseError}
      databaseStartupLoading={databaseStartupLoading}
      groupsRepository={groupsRepository}
      repository={repository}
      threadSearchRepository={threadSearchRepository}
      threadsAwaitingApproval={threadsAwaitingApproval}
    />
  );
}
