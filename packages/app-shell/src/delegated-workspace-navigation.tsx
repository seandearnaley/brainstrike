import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  DelegatedApprovalOwnerContext,
  SubagentConversationNavigationContext,
  SubagentConversationPresentationContext,
  SubagentInvocationResolverContext,
  SubagentLiveInvocationContext,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react';
import { getDelegatedColorPresentation } from './agent-color-presentation';
import {
  getDelegatedColorRevision,
  subscribeDelegatedColorRefresh,
} from './delegated-color-refresh';
import type { DelegatedConversationRoot } from './delegated-conversation-owner';
import { loadDelegatedWorkspaceNode } from './delegated-workspace-node';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import { type ApprovalOwner, resolveApprovalOwner } from './resolve-approval-owner';
import { ThreadSearchMessageNavigation } from './thread-search-message-navigation';
import { useDelegatedConversationRoot } from './use-delegated-conversation-root';

const origins = new WeakMap<
  DelegatedConversationRoot,
  Map<string, { readonly element: WeakRef<HTMLElement>; readonly parentThreadId: string }>
>();

/** Both main and child cards use the existing workspace's singleton tab action. */
export function DelegatedWorkspaceNavigation({
  children,
  ownerResourceId,
  rootThreadId,
  currentThreadId,
  isSearchHistoryLoading,
}: {
  readonly children: ReactNode;
  readonly isSearchHistoryLoading?: boolean;
  readonly currentThreadId?: string;
  readonly ownerResourceId: string;
  readonly rootThreadId: string | undefined;
}) {
  const colorRevision = useSyncExternalStore(
    subscribeDelegatedColorRefresh,
    getDelegatedColorRevision
  );
  const root = useDelegatedConversationRoot(ownerResourceId, rootThreadId);
  const db = usePGliteDatabase();
  const liveInvocations = useMemo(() => {
    if (!root) {
      return null;
    }
    let snapshot: ReturnType<typeof root.store.getSnapshot> | undefined;
    let threads = new Map<string, string>();
    const refresh = () => {
      const current = root.store.getSnapshot();
      if (current === snapshot) {
        return;
      }
      snapshot = current;
      threads = new Map();
      for (const [threadId, child] of current) {
        const identity = child.update.identity;
        if (identity) {
          threads.set(
            JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId]),
            threadId
          );
        }
      }
    };
    return {
      getThreadId: (identity: {
        parentRuntimeRunId: string;
        parentToolCallId: string;
      }): string | undefined => {
        refresh();
        return threads.get(
          JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId])
        );
      },
      subscribe: root.store.subscribe,
    };
  }, [root]);
  const resolveInvocation = useCallback(
    async (identity: { parentRuntimeRunId: string; parentToolCallId: string }): Promise<string> => {
      if (!(db && rootThreadId)) {
        throw new Error('The owning workspace is unavailable.');
      }
      const invocation = await createDelegatedConversationRepository(db).getInvocation(
        { ownerResourceId, rootThreadId },
        identity
      );
      if (!invocation || invocation.parentThreadId !== (currentThreadId ?? rootThreadId)) {
        throw new Error('The delegated conversation is unavailable or belongs to another parent.');
      }
      return invocation.threadId;
    },
    [db, ownerResourceId, rootThreadId, currentThreadId]
  );
  const presentation = useCallback(
    async (threadId: string) => {
      if (!(db && rootThreadId)) {
        throw new Error('The owning workspace is unavailable.');
      }
      const node = await loadDelegatedWorkspaceNode(createDelegatedConversationRepository(db), {
        ownerResourceId,
        rootThreadId,
        threadId,
      });
      if (node.parentThreadId !== (currentThreadId ?? rootThreadId)) {
        throw new Error('The child conversation belongs to another parent.');
      }
      return {
        colorId: node.color,
        displayName: node.displayName,
        markClassName: getDelegatedColorPresentation(node.color).markClassName,
      };
    },
    [db, ownerResourceId, rootThreadId, currentThreadId, colorRevision]
  );
  const approvalOwner = useCallback(
    async (approval: AssistantToolApprovalRequest): Promise<ApprovalOwner | undefined> => {
      if (!(db && rootThreadId)) {
        return undefined;
      }
      return resolveApprovalOwner(
        createDelegatedConversationRepository(db),
        { ownerResourceId, rootThreadId },
        currentThreadId ?? rootThreadId,
        approval
      );
    },
    [db, ownerResourceId, rootThreadId, currentThreadId, colorRevision]
  );
  const open = useCallback(
    (threadId: string, origin?: HTMLElement) => {
      if (!(rootThreadId && root)) {
        throw new Error('The owning conversation is unavailable.');
      }
      let remembered = origins.get(root);
      if (!remembered) {
        remembered = new Map();
        origins.set(root, remembered);
      }
      if (origin) {
        remembered.set(threadId, {
          element: new WeakRef(origin),
          parentThreadId: currentThreadId ?? rootThreadId,
        });
      }
      const returningTo = !origin && currentThreadId ? remembered.get(currentThreadId) : undefined;
      const rootTarget = threadId === rootThreadId;
      const appId = rootTarget
        ? undefined
        : delegatedWorkspaceTabId({ ownerResourceId, rootThreadId, threadId });
      if (appId) {
        useWorkspaceTabSelectionStore.getState().openApp(appId);
      } else {
        useAssistantThreadStore.getState().openThreadTab(ownerResourceId, rootThreadId);
      }
      // Selection commits before focus, matching the ordinary thread-tab shell.
      window.requestAnimationFrame(() => {
        const element = returningTo?.element.deref();
        if (returningTo?.parentThreadId === threadId && element?.isConnected) {
          remembered.delete(currentThreadId ?? threadId);
          element.focus();
          return;
        }
        document
          .getElementById(
            rootTarget ? `assistant-thread-tab-${rootThreadId}` : `workspace-app-tab-${appId}`
          )
          ?.focus();
      });
    },
    [currentThreadId, ownerResourceId, root, rootThreadId]
  );
  return (
    <SubagentConversationNavigationContext value={root ? open : null}>
      <DelegatedApprovalOwnerContext value={db && root ? approvalOwner : null}>
        <SubagentConversationPresentationContext value={db && root ? presentation : null}>
          <SubagentInvocationResolverContext value={db && root ? resolveInvocation : null}>
            <SubagentLiveInvocationContext value={liveInvocations}>
              <ThreadSearchMessageNavigation
                isLoading={isSearchHistoryLoading ?? false}
                ownerResourceId={ownerResourceId}
                threadId={currentThreadId ?? rootThreadId}
              >
                {children}
              </ThreadSearchMessageNavigation>
            </SubagentLiveInvocationContext>
          </SubagentInvocationResolverContext>
        </SubagentConversationPresentationContext>
      </DelegatedApprovalOwnerContext>
    </SubagentConversationNavigationContext>
  );
}
