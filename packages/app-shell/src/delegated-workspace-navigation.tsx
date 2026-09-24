import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  SubagentConversationNavigationContext,
  SubagentConversationPresentationContext,
  SubagentInvocationResolverContext,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { type ReactNode, useCallback } from 'react';
import { ASSISTANT_THREAD_COLOR_PRESENTATION } from './assistant-thread-presentation';
import type { DelegatedConversationRoot } from './delegated-conversation-owner';
import { loadDelegatedWorkspaceNode } from './delegated-workspace-node';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
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
  const root = useDelegatedConversationRoot(ownerResourceId, rootThreadId);
  const db = usePGliteDatabase();
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
        markClassName: ASSISTANT_THREAD_COLOR_PRESENTATION[node.color].markClassName,
      };
    },
    [db, ownerResourceId, rootThreadId, currentThreadId]
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
      <SubagentConversationPresentationContext value={db && root ? presentation : null}>
        <SubagentInvocationResolverContext value={db && root ? resolveInvocation : null}>
          <ThreadSearchMessageNavigation
            isLoading={isSearchHistoryLoading ?? false}
            ownerResourceId={ownerResourceId}
            threadId={currentThreadId ?? rootThreadId}
          >
            {children}
          </ThreadSearchMessageNavigation>
        </SubagentInvocationResolverContext>
      </SubagentConversationPresentationContext>
    </SubagentConversationNavigationContext>
  );
}
