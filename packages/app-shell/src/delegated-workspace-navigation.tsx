import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  SubagentConversationNavigationContext,
  SubagentConversationPresentationContext,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { type ReactNode, useCallback } from 'react';
import { ASSISTANT_THREAD_COLOR_PRESENTATION } from './assistant-thread-presentation';
import type { DelegatedConversationRoot } from './delegated-conversation-owner';
import { loadDelegatedWorkspaceNode } from './delegated-workspace-node';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import { useDelegatedConversationRoot } from './use-delegated-conversation-root';

const origins = new WeakMap<
  DelegatedConversationRoot,
  Map<string, { readonly element: HTMLElement; readonly parentThreadId: string }>
>();

/** Both main and child cards use the existing workspace's singleton tab action. */
export function DelegatedWorkspaceNavigation({
  children,
  ownerResourceId,
  rootThreadId,
  currentThreadId,
}: {
  readonly children: ReactNode;
  readonly currentThreadId?: string;
  readonly ownerResourceId: string;
  readonly rootThreadId: string | undefined;
}) {
  const root = useDelegatedConversationRoot(ownerResourceId, rootThreadId);
  const db = usePGliteDatabase();
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
          element: origin,
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
        if (returningTo?.parentThreadId === threadId && returningTo.element.isConnected) {
          returningTo.element.focus();
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
        {children}
      </SubagentConversationPresentationContext>
    </SubagentConversationNavigationContext>
  );
}
