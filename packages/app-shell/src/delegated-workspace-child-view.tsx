import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
  createSuspendedRunDiscovery,
  hasDurableAssistantUsageCapability,
} from '@brainstrike/assistant-data';
import {
  type DelegatedConversationRuntimeOptions,
  SubagentInvocationResolverContext,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { use, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DelegatedConversationBreadcrumbs } from './delegated-conversation-breadcrumbs';
import { DelegatedConversationPanel } from './delegated-conversation-panel';
import { createDelegatedWorkspaceDiscovery } from './delegated-workspace-discovery';
import { DelegatedWorkspaceNavigation } from './delegated-workspace-navigation';
import type { ChildNode } from './delegated-workspace-node';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';
import { resolveDelegatedWorkspaceDecision } from './resolve-delegated-workspace-identity';
import { RootsContext, useDelegatedConversationRoot } from './use-delegated-conversation-root';
export function Failure({ error }: { readonly error: Error }) {
  return (
    <div className="p-4 text-destructive" role="alert">
      {error.message}
    </div>
  );
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type History = DelegatedConversationRuntimeOptions['history'];
const emptySubscribe = () => () => undefined;
export function ChildView({ db, node }: { readonly db: DbHandle; readonly node: ChildNode }) {
  const roots = use(RootsContext);
  const repository = useMemo(() => createDelegatedConversationRepository(db), [db]);
  const root = useDelegatedConversationRoot(node.ownerResourceId, node.rootThreadId);
  const live = useSyncExternalStore(
    root?.store.subscribe ?? emptySubscribe,
    () => root?.store.getConversation(node.threadId),
    () => root?.store.getConversation(node.threadId)
  );
  useEffect(() => {
    const markVisibleRead = () => {
      const { selection } = useWorkspaceTabSelectionStore.getState();
      if (selection.kind === 'app' && selection.appId === delegatedWorkspaceTabId(node)) {
        root?.store.markRead(node.threadId);
      }
    };
    markVisibleRead();
    const unsubscribeSelection = useWorkspaceTabSelectionStore.subscribe(markVisibleRead);
    const unsubscribeActivity = root?.store.subscribe(markVisibleRead);
    return () => {
      unsubscribeSelection();
      unsubscribeActivity?.();
    };
  }, [root, node]);
  const resolveInvocation = useCallback(
    async (identity: { parentRuntimeRunId: string; parentToolCallId: string }): Promise<string> => {
      const invocation = await repository.getInvocation(node, identity);
      if (!invocation || invocation.parentThreadId !== node.threadId) {
        throw new Error('The delegated conversation is unavailable or belongs to another parent.');
      }
      return invocation.threadId;
    },
    [repository, node]
  );
  const [saved, setSaved] = useState<{ readonly history: History } | { readonly error: Error }>();
  useEffect(() => {
    if (!root || root.store.getConversation(node.threadId)) {
      return;
    }
    let active = true;
    const adapter = createAssistantThreadHistoryAdapter({
      ...(hasDurableAssistantUsageCapability()
        ? {
            discoverSuspendedRuns: createDelegatedWorkspaceDiscovery(
              repository,
              node,
              createSuspendedRunDiscovery(resolveAssistantBaseUrl)
            ),
          }
        : {}),
      repository: createPgliteAssistantThreadRepository(db),
      resourceId: node.resourceId,
      threadId: node.threadId,
    });
    adapter.load().then(
      (history) => {
        if (active) {
          setSaved({ history });
        }
      },
      (error: unknown) => {
        if (active) {
          setSaved({ error: asError(error) });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [db, node, repository, root]);
  if (!roots) {
    return <Failure error={new Error('The child workspace has no owning root registry.')} />;
  }
  if (!root) {
    return (
      <p className="p-4" role="status">
        Opening owning conversation…
      </p>
    );
  }
  if (saved && 'error' in saved) {
    return <Failure error={saved.error} />;
  }
  if (!(saved || live)) {
    return (
      <p className="p-4" role="status">
        Loading conversation…
      </p>
    );
  }
  return (
    <DelegatedWorkspaceNavigation
      currentThreadId={node.threadId}
      ownerResourceId={node.ownerResourceId}
      rootThreadId={node.rootThreadId}
    >
      <SubagentInvocationResolverContext value={resolveInvocation}>
        <div className="flex h-full min-h-0 flex-col">
          <DelegatedConversationBreadcrumbs db={db} node={node} />
          <div className="min-h-0 flex-1">
            <DelegatedConversationPanel
              label={node.displayName}
              onNew={(message) =>
                root.sendDecision(node.threadId, message, () =>
                  resolveDelegatedWorkspaceDecision(repository, node, message)
                )
              }
              {...(saved ? { persistedHistory: saved.history } : {})}
              store={root.store}
              threadId={node.threadId}
            />
          </div>
        </div>
      </SubagentInvocationResolverContext>
    </DelegatedWorkspaceNavigation>
  );
}
