import {
  SubagentConversationNavigationContext,
  SubagentInvocationResolverContext,
  SubagentLiveInvocationContext,
} from '@brainstrike/assistant-ui';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { createLogger } from '@brainstrike/logging';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AssistantThreadHostChild,
  useAssistantThreadHost,
} from './assistant-thread-host-context';
import { hostChildWorkspaceTabId } from './host-child-workspace-tab';

const logger = createLogger('HostChildConversations');

interface Invocation {
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
}

const invocationKey = (identity: Invocation): string =>
  JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId]);

const UNAVAILABLE = 'The delegated conversation is unavailable or belongs to another parent.';

/** The child's workspace tab opens, then takes focus as the ordinary thread-tab shell does. */
function openChildTab(child: AssistantThreadHostChild): void {
  const appId = hostChildWorkspaceTabId({ persona: child.persona, threadId: child.threadId });
  useWorkspaceTabSelectionStore.getState().openApp(appId);
  window.requestAnimationFrame(() => {
    document.getElementById(`workspace-app-tab-${appId}`)?.focus();
  });
}

/**
 * BST-1932: a host thread's delegation cards reach their child threads through
 * the host. The live index, the resolver and navigation all read the host's
 * committed children of `threadId`; `revision` changes when this thread's
 * committed log may have started or settled a child.
 */
export function HostChildConversations({
  children,
  revision,
  threadId,
}: {
  readonly children: ReactNode;
  readonly revision: number;
  readonly threadId: string;
}) {
  const host = useAssistantThreadHost();
  const list = useMemo(
    () => (host?.childThreads ? host.childThreads.bind(host) : undefined),
    [host]
  );
  const [listed, setListed] = useState<{
    readonly children: readonly AssistantThreadHostChild[];
    readonly threadId: string;
  }>();
  useEffect(() => {
    if (!list) {
      return;
    }
    let active = true;
    list(threadId).then(
      (found) => {
        if (active) {
          setListed({ children: found, threadId });
        }
      },
      (error: unknown) => {
        // Cards still open through the resolver, which reports its own failure.
        logger.error('Host child threads could not be listed', { error, threadId });
      }
    );
    return () => {
      active = false;
    };
  }, [list, revision, threadId]);
  const current = listed?.threadId === threadId ? listed.children : undefined;
  const liveInvocations = useMemo(() => {
    const threads = new Map(
      (current ?? []).map((child) => [
        invocationKey({
          parentRuntimeRunId: child.parentRunId,
          parentToolCallId: child.toolCallId,
        }),
        child.threadId,
      ])
    );
    return {
      getThreadId: (identity: Invocation) => threads.get(invocationKey(identity)),
      // A newly listed child replaces this value, which re-reads every card.
      subscribe: () => () => undefined,
    };
  }, [current]);
  const resolveInvocation = useCallback(
    async (identity: Invocation): Promise<string> => {
      if (!list) {
        throw new Error(UNAVAILABLE);
      }
      const child = (await list(threadId)).find(
        (candidate) =>
          candidate.parentRunId === identity.parentRuntimeRunId &&
          candidate.toolCallId === identity.parentToolCallId
      );
      if (!child) {
        throw new Error(UNAVAILABLE);
      }
      return child.threadId;
    },
    [list, threadId]
  );
  const open = useCallback(
    (childThreadId: string) => {
      const known = current?.find((child) => child.threadId === childThreadId);
      if (known) {
        openChildTab(known);
        return;
      }
      // The card can read a result before this view's listing catches up.
      list?.(threadId)
        .then((found) => {
          const child = found.find((candidate) => candidate.threadId === childThreadId);
          if (!child) {
            throw new Error(UNAVAILABLE);
          }
          openChildTab(child);
        })
        .catch((error: unknown) => {
          logger.error('Host child conversation could not be opened', {
            childThreadId,
            error,
            threadId,
          });
        });
    },
    [current, list, threadId]
  );
  return (
    <SubagentConversationNavigationContext value={list ? open : null}>
      <SubagentInvocationResolverContext value={list ? resolveInvocation : null}>
        <SubagentLiveInvocationContext value={list ? liveInvocations : null}>
          {children}
        </SubagentLiveInvocationContext>
      </SubagentInvocationResolverContext>
    </SubagentConversationNavigationContext>
  );
}
