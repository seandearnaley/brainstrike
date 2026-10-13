import type { ReactElement } from 'react';
import { lazy, Suspense, useMemo } from 'react';
import { AssistantPanelLoadingState } from './assistant-panel-loading-state';
import {
  type AssistantThreadHostCapability,
  createHostAssistantThreadRepository,
  useAssistantThreadHost,
  useAssistantThreadHostRuns,
} from './assistant-thread-host-context';
import {
  AssistantThreadTabsCore,
  type AssistantThreadTabsWorkspaceProps,
} from './assistant-thread-tabs-core';

export type { AssistantThreadTabsWorkspaceProps } from './assistant-thread-tabs-core';

const WebThreadTabs = lazy(() =>
  import('./assistant-thread-tabs-web').then((module) => ({ default: module.WebThreadTabs }))
);

export function AssistantThreadTabsWorkspace(
  props: AssistantThreadTabsWorkspaceProps
): ReactElement {
  const host = useAssistantThreadHost();
  if (host) {
    return <HostThreadTabs {...props} host={host} />;
  }
  return (
    <Suspense fallback={<AssistantPanelLoadingState label="Loading PGlite-backed threads." />}>
      <WebThreadTabs {...props} />
    </Suspense>
  );
}

function HostThreadTabs({
  host,
  ...props
}: AssistantThreadTabsWorkspaceProps & {
  readonly host: AssistantThreadHostCapability;
}): ReactElement {
  const repository = useMemo(() => createHostAssistantThreadRepository(host), [host]);
  const runs = useAssistantThreadHostRuns();
  const activeThreads = useMemo(
    () => ({
      error: null,
      threadIds: new Set([...runs].filter(([, run]) => run.status === 'running').map(([id]) => id)),
    }),
    [runs]
  );
  const threadsAwaitingApproval = useMemo(
    () => ({
      error: null,
      threadIds: new Set([...runs].filter(([, run]) => run.needsInput).map(([id]) => id)),
    }),
    [runs]
  );
  return (
    <AssistantThreadTabsCore
      {...props}
      activeThreads={activeThreads}
      databaseError={null}
      databaseStartupLoading={false}
      loadingLabel="Loading conversations."
      renderThread={(panel) => {
        const threadId = panel.memoryThreadId;
        if (!threadId) {
          throw new Error('A host conversation requires its thread identity.');
        }
        const rendered = host.renderThread(
          threadId,
          panel.isVisible ?? true,
          panel.onRunningChange,
          panel.providerReadErrors
        );
        return rendered === undefined ? <div role="alert">Conversation unavailable</div> : rendered;
      }}
      repository={repository}
      threadsAwaitingApproval={threadsAwaitingApproval}
    />
  );
}
