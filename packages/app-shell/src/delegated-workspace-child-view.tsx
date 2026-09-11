import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
  createSuspendedRunDiscovery,
  hasDurableAssistantUsageCapability,
} from '@brainstrike/assistant-data';
import type { DelegatedConversationRuntimeOptions } from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { DelegatedConversationPanel } from './delegated-conversation-panel';
import { createDelegatedWorkspaceDiscovery } from './delegated-workspace-discovery';
import { DelegatedWorkspaceNavigation } from './delegated-workspace-navigation';
import type { ChildNode } from './delegated-workspace-node';
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';
import { resolveDelegatedWorkspaceDecision } from './resolve-delegated-workspace-identity';
import { useDelegatedConversationRoot } from './use-delegated-conversation-root';
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
export function ChildView({ db, node }: { readonly db: DbHandle; readonly node: ChildNode }) {
  const root = useDelegatedConversationRoot(node.ownerResourceId, node.rootThreadId);
  if (!root) {
    throw new Error('The child workspace has no owning root registry.');
  }
  const live = useSyncExternalStore(
    root.store.subscribe,
    () => root.store.getConversation(node.threadId),
    () => root.store.getConversation(node.threadId)
  );
  const [saved, setSaved] = useState<{ readonly history: History } | { readonly error: Error }>();
  useEffect(() => {
    if (root?.store.getConversation(node.threadId)) {
      return;
    }
    let active = true;
    const adapter = createAssistantThreadHistoryAdapter({
      ...(hasDurableAssistantUsageCapability()
        ? {
            discoverSuspendedRuns: createDelegatedWorkspaceDiscovery(
              createDelegatedConversationRepository(db),
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
  }, [db, node, root]);
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
      ownerResourceId={node.ownerResourceId}
      rootThreadId={node.rootThreadId}
    >
      <DelegatedConversationPanel
        label={node.displayName}
        onNew={(message) =>
          root.sendDecision(node.threadId, message, () =>
            resolveDelegatedWorkspaceDecision(
              createDelegatedConversationRepository(db),
              node,
              message
            )
          )
        }
        {...(saved ? { persistedHistory: saved.history } : {})}
        store={root.store}
        threadId={node.threadId}
      />
    </DelegatedWorkspaceNavigation>
  );
}
