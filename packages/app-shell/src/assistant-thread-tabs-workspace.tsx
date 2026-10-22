import type { ReactElement } from 'react';
import { useMemo } from 'react';
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

export function AssistantThreadTabsWorkspace(
  props: AssistantThreadTabsWorkspaceProps
): ReactElement {
  const host = useAssistantThreadHost();
  if (!host) {
    return <div role="alert">Assistant thread host unavailable</div>;
  }
  return <HostThreadTabs {...props} host={host} />;
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
