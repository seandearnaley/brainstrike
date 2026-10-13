import {
  createPgliteAssistantThreadRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import {
  useDbInitializationStatus,
  useDbInitializing,
  useDbProviderError,
  usePGliteDatabase,
} from '@brainstrike/db/react';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { shouldRenderAssistantThreadDatabaseStartupLoading } from './assistant-thread-database-state';
import {
  AssistantThreadTabsCore,
  type AssistantThreadTabsWorkspaceProps,
} from './assistant-thread-tabs-core';
import { AssistantUiPanelWrapper } from './assistant-ui-panel-wrapper';
import { useThreadsAwaitingApproval } from './hooks/use-threads-awaiting-approval';
import { useActiveAssistantThreadIds } from './use-active-assistant-thread-ids';
import { useAssistantThreadRunCompletionSync } from './use-assistant-thread-run-completion-sync';

export function WebThreadTabs(props: AssistantThreadTabsWorkspaceProps): ReactElement {
  const database = usePGliteDatabase();
  const databaseInitializing = useDbInitializing();
  const databaseStatus = useDbInitializationStatus();
  const databaseError = useDbProviderError();
  const repository = useMemo(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
  );
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
  const schemaReady = useAssistantThreadStore((state) =>
    Object.hasOwn(state.threadsByResourceId, resourceId)
  );
  const refreshResourceThreads = useAssistantThreadStore((state) => state.refreshResourceThreads);
  const activeThreads = useActiveAssistantThreadIds({ database, resourceId, schemaReady });
  const threadsAwaitingApproval = useThreadsAwaitingApproval({ database, resourceId, schemaReady });
  useAssistantThreadRunCompletionSync({
    enabled: repository !== null && schemaReady,
    refreshResourceThreads,
    repository,
    resourceId,
  });
  const databaseStartupLoading = shouldRenderAssistantThreadDatabaseStartupLoading({
    databaseError,
    databaseInitializing,
    databaseStatus,
    repositoryReady: Boolean(repository),
  });
  return (
    <AssistantThreadTabsCore
      {...props}
      activeThreads={activeThreads}
      databaseError={databaseError}
      databaseStartupLoading={databaseStartupLoading}
      loadingLabel="Loading PGlite-backed threads."
      renderThread={(panel) => <AssistantUiPanelWrapper {...panel} />}
      repository={repository}
      threadsAwaitingApproval={threadsAwaitingApproval}
    />
  );
}
