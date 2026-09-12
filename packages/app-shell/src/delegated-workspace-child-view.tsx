import type { AssistantChildInput } from '@brainstrike/assistant-contract';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
  createSuspendedRunDiscovery,
  hasDurableAssistantUsageCapability,
  resolveAssistantAuthHeaders,
} from '@brainstrike/assistant-data';
import {
  type DelegatedConversationRuntimeOptions,
  EditCheckpointProvider,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import type { AssistantProviderSettingsMap } from '@brainstrike/types';
import { use, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DelegatedChildConversationPanel } from './delegated-child-conversation-panel';
import { DelegatedConversationBreadcrumbs } from './delegated-conversation-breadcrumbs';
import { DelegatedConversationToolbar } from './delegated-conversation-toolbar';
import { createDelegatedWorkspaceDiscovery } from './delegated-workspace-discovery';
import { DelegatedWorkspaceNavigation } from './delegated-workspace-navigation';
import type { ChildNode } from './delegated-workspace-node';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';
import { useEditCheckpoints } from './hooks/use-edit-checkpoints';
import { resolveDelegatedWorkspaceDecision } from './resolve-delegated-workspace-identity';
import { sendDelegatedWorkspaceInput } from './send-delegated-workspace-input';
import { useThreadSearchStore } from './thread-search-store';
import { useDelegatedConversationInsights } from './use-delegated-conversation-insights';
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
const EMPTY_ROOT_SETTINGS = {
  planMode: false,
  providerSettings: {} as AssistantProviderSettingsMap,
  selectedModel: null,
};
const emptySubscribe = () => () => undefined;
export function ChildView({ db, node }: { readonly db: DbHandle; readonly node: ChildNode }) {
  const roots = use(RootsContext);
  const repository = useMemo(() => createDelegatedConversationRepository(db), [db]);
  const root = useDelegatedConversationRoot(node.ownerResourceId, node.rootThreadId);
  const historyRepository = useMemo(() => createPgliteAssistantThreadRepository(db), [db]);
  const { checkpoints, refetch } = useEditCheckpoints(
    typeof window !== 'undefined' && window.assistantCheckpoints ? historyRepository : null,
    node.threadId
  );
  const live = useSyncExternalStore(
    root?.store.subscribe ?? emptySubscribe,
    () => root?.store.getConversation(node.threadId),
    () => root?.store.getConversation(node.threadId)
  );
  const inheritedSettings = useSyncExternalStore(
    root?.modelSelection.subscribe ?? emptySubscribe,
    () => root?.modelSelection.getState() ?? EMPTY_ROOT_SETTINGS,
    () => root?.modelSelection.getState() ?? EMPTY_ROOT_SETTINGS
  );
  const insights = useDelegatedConversationInsights({ db, node, update: live?.update });
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
  const hasLive = Boolean(live);
  const navigationTarget = useThreadSearchStore((state) => state.navigationTarget);
  const searchTarget =
    navigationTarget?.ownerResourceId === node.ownerResourceId &&
    navigationTarget.threadId === node.threadId
      ? navigationTarget
      : null;
  const [loadedSearchRequest, setLoadedSearchRequest] = useState<number>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let terminalLeg: string | undefined;
    return root?.store.subscribe(() => {
      const update = root.store.getConversation(node.threadId)?.update;
      const leg = update?.baseline?.hostRunId;
      if (leg && update.message.status.type !== 'running' && leg !== terminalLeg) {
        terminalLeg = leg;
        void refetch();
      }
    });
  }, [node.threadId, root, refetch]);
  const [saved, setSaved] = useState<
    | { readonly history: History; readonly hostRunId: string | undefined }
    | { readonly error: Error }
  >();
  useEffect(() => {
    if (!root || (!searchTarget && root.store.getConversation(node.threadId))) {
      return;
    }
    if (
      loadedSearchRequest !== undefined &&
      (!searchTarget || searchTarget.requestId === loadedSearchRequest)
    ) {
      return;
    }
    let active = true;
    const controller = new AbortController();
    // A search extension belongs to the host leg observed when its read began.
    // A later admitted baseline may intentionally exclude deleted/rewound rows.
    const hostRunId = searchTarget
      ? root.store.getConversation(node.threadId)?.update.baseline?.hostRunId
      : undefined;
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
      signal: controller.signal,
      threadId: node.threadId,
      ...(searchTarget ? { targetMessageId: searchTarget.messageId } : {}),
    });
    adapter.load().then(
      (history) => {
        if (active) {
          setSaved({ history, hostRunId });
          setLoadedSearchRequest(searchTarget?.requestId);
        }
      },
      (error: unknown) => {
        if (active) {
          if (searchTarget) {
            useThreadSearchStore
              .getState()
              .finishNavigation(searchTarget.requestId, asError(error).message);
            setLoadedSearchRequest(undefined);
          } else {
            setSaved({ error: asError(error) });
          }
        }
      }
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [db, node, repository, root, refresh, hasLive, searchTarget, loadedSearchRequest]);
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
      isSearchHistoryLoading={Boolean(
        searchTarget && loadedSearchRequest !== searchTarget.requestId
      )}
      ownerResourceId={node.ownerResourceId}
      rootThreadId={node.rootThreadId}
    >
      <EditCheckpointProvider value={checkpoints}>
        <div className="flex h-full min-h-0 flex-col">
          <DelegatedConversationBreadcrumbs db={db} node={node} />
          <div className="min-h-0 flex-1">
            <DelegatedChildConversationPanel
              allowIdleInput={hasDurableAssistantUsageCapability()}
              extendHistoryForSearch={saved?.hostRunId === live?.update.baseline?.hostRunId}
              inheritedModel={inheritedSettings.selectedModel}
              inheritedPlanMode={inheritedSettings.planMode}
              inheritedProviderSettings={inheritedSettings.providerSettings}
              insights={insights}
              isRunning={live?.update.message.status.type === 'running'}
              label={node.displayName}
              panelProps={{
                workspaceBar: (
                  <DelegatedConversationToolbar
                    insights={insights}
                    isRunning={live?.update.message.status.type === 'running'}
                  />
                ),
              }}
              {...(hasDurableAssistantUsageCapability()
                ? {
                    onSendActiveInput: (input: AssistantChildInput, signal: AbortSignal) => {
                      const current = root.store.getConversation(node.threadId);
                      if (current?.update.message.status.type !== 'running') {
                        return root.sendFollowup(node.threadId, input, signal);
                      }
                      const hostRunId = current.update.baseline?.hostRunId;
                      if (!hostRunId) {
                        throw new Error('Child input has no active host owner.');
                      }
                      return sendDelegatedWorkspaceInput(node, hostRunId, input, signal);
                    },
                  }
                : {})}
              {...(hasDurableAssistantUsageCapability()
                ? {
                    onCancel: async () => {
                      const [baseUrl, headers] = await Promise.all([
                        resolveAssistantBaseUrl(),
                        resolveAssistantAuthHeaders(),
                      ]);
                      const response = await fetch(new URL('/assistant/cancel-child', baseUrl), {
                        body: JSON.stringify({
                          ownerResourceId: node.ownerResourceId,
                          rootThreadId: node.rootThreadId,
                          scope: 'subtree',
                          threadId: node.threadId,
                        }),
                        headers: { ...headers, 'Content-Type': 'application/json' },
                        method: 'POST',
                      });
                      if (!response.ok) {
                        const failure: unknown = await response.json();
                        if (
                          failure &&
                          typeof failure === 'object' &&
                          'message' in failure &&
                          typeof failure.message === 'string'
                        ) {
                          throw new Error(failure.message);
                        }
                        throw new Error(
                          `Child Stop returned an invalid error response (status ${response.status}).`
                        );
                      }
                      root.store.invalidate(node.threadId);
                      setSaved(undefined);
                      setLoadedSearchRequest(undefined);
                      setRefresh((value) => value + 1);
                    },
                  }
                : {})}
              {...(hasDurableAssistantUsageCapability()
                ? {
                    onBranch: async (input: Omit<AssistantChildFollowupAction, 'threadId'>) => {
                      const current = root.store.getConversation(node.threadId);
                      if (current?.update.message.status.type === 'running') {
                        throw new Error('Stop the child before changing its conversation branch.');
                      }
                      await root.sendFollowup(node.threadId, input, new AbortController().signal);
                    },
                  }
                : {})}
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
      </EditCheckpointProvider>
    </DelegatedWorkspaceNavigation>
  );
}
