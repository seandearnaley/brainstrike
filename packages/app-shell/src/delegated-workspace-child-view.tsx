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
  DebugBundleProvider,
  type DelegatedConversationRuntimeOptions,
  EditCheckpointProvider,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import type { AssistantProviderSettingsMap } from '@brainstrike/types';
import { type ReactNode, use, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DelegatedChildConversationPanel } from './delegated-child-conversation-panel';
import { DelegatedConversationBreadcrumbs } from './delegated-conversation-breadcrumbs';
import { DelegatedConversationToolbar } from './delegated-conversation-toolbar';
import { createDelegatedWorkspaceDiscovery } from './delegated-workspace-discovery';
import { DelegatedWorkspaceNavigation } from './delegated-workspace-navigation';
import type { ChildNode } from './delegated-workspace-node';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';
import { useDebugBundleBinding } from './hooks/use-debug-bundle';
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
interface RootSettings {
  readonly planMode: boolean;
  readonly providerSettings: AssistantProviderSettingsMap;
  readonly selectedModel: string | null;
}
const emptySubscribe = () => () => undefined;
function resolveChildLoadingBoundary({
  error,
  hasConversation,
  hasRoot,
  hasRoots,
}: {
  readonly error: Error | undefined;
  readonly hasConversation: boolean;
  readonly hasRoot: boolean;
  readonly hasRoots: boolean;
}): ReactNode {
  if (!hasRoots) {
    return <Failure error={new Error('The child workspace has no owning root registry.')} />;
  }
  if (!hasRoot) {
    return (
      <p className="p-4" role="status">
        Opening owning conversation…
      </p>
    );
  }
  if (error) {
    return <Failure error={error} />;
  }
  if (!hasConversation) {
    return (
      <p className="p-4" role="status">
        Loading conversation…
      </p>
    );
  }
  return;
}

interface ReadyChildViewProps {
  readonly checkpoints: ReturnType<typeof useEditCheckpoints>['checkpoints'];
  readonly db: DbHandle;
  readonly inheritedSettings: RootSettings;
  readonly insights: ReturnType<typeof useDelegatedConversationInsights>;
  readonly live: ReturnType<
    NonNullable<ReturnType<typeof useDelegatedConversationRoot>>['store']['getConversation']
  >;
  readonly loaded:
    | { readonly history: History; readonly hostRunId: string | undefined }
    | undefined;
  readonly loadedSearchRequest: number | undefined;
  readonly node: ChildNode;
  readonly repository: ReturnType<typeof createDelegatedConversationRepository>;
  readonly root: NonNullable<ReturnType<typeof useDelegatedConversationRoot>>;
  readonly searchTarget: ReturnType<typeof useThreadSearchStore.getState>['navigationTarget'];
  readonly setLoadedSearchRequest: (value: number | undefined) => void;
  readonly setRefresh: (update: (value: number) => number) => void;
  readonly setSaved: (value: undefined) => void;
}

function ReadyChildView({
  checkpoints,
  db,
  inheritedSettings,
  insights,
  live,
  loaded,
  loadedSearchRequest,
  node,
  repository,
  root,
  searchTarget,
  setLoadedSearchRequest,
  setRefresh,
  setSaved,
}: ReadyChildViewProps) {
  const durableUsage = hasDurableAssistantUsageCapability();
  const isRunning = live?.update.message.status.type === 'running';
  // The host answers this child's approvals on the ROOT leg only; the child's
  // cards read those answers from the owning root's registered thread.
  const ownerThread = useSyncExternalStore(
    root.subscribeOwner,
    root.getOwnerThread,
    root.getOwnerThread
  );
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
              allowIdleInput={durableUsage}
              extendHistoryForSearch={loaded?.hostRunId === live?.update.baseline?.hostRunId}
              inheritedModel={inheritedSettings.selectedModel}
              inheritedPlanMode={inheritedSettings.planMode}
              inheritedProviderSettings={inheritedSettings.providerSettings}
              insights={insights}
              isRunning={isRunning}
              label={node.displayName}
              panelProps={{
                decisionRoute: {
                  dispatch: (message) => {
                    if (typeof message === 'string') {
                      throw new Error('A delegated decision requires structured run metadata.');
                    }
                    if (message.role !== undefined && message.role !== 'user') {
                      throw new Error('A delegated decision must be a user message.');
                    }
                    if (!message.metadata) {
                      throw new Error('A delegated decision requires decision metadata.');
                    }
                    const decision = {
                      ...message,
                      attachments: message.attachments ?? [],
                      createdAt: message.createdAt ?? new Date(),
                      metadata: message.metadata,
                      parentId: message.parentId ?? null,
                      role: 'user' as const,
                      runConfig: message.runConfig,
                      sourceId: message.sourceId ?? null,
                    };
                    return root.sendDecision(node.threadId, decision, () =>
                      resolveDelegatedWorkspaceDecision(repository, node, decision)
                    );
                  },
                  queueThreadKey: node.rootThreadId,
                },
                ownerThread,
                workspaceBar: (
                  <DelegatedConversationToolbar insights={insights} isRunning={isRunning} />
                ),
              }}
              {...(durableUsage
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
              {...(durableUsage
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
              {...(durableUsage
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
              onNew={async (message) => {
                await root.sendDecision(node.threadId, message, () =>
                  resolveDelegatedWorkspaceDecision(repository, node, message)
                );
              }}
              {...(loaded ? { persistedHistory: loaded.history } : {})}
              store={root.store}
              threadId={node.threadId}
            />
          </div>
        </div>
      </EditCheckpointProvider>
    </DelegatedWorkspaceNavigation>
  );
}

export function ChildView({ db, node }: { readonly db: DbHandle; readonly node: ChildNode }) {
  const debugBundle = useDebugBundleBinding(node.threadId);
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
  const boundary = resolveChildLoadingBoundary({
    error: saved && 'error' in saved ? saved.error : undefined,
    hasConversation: Boolean(saved || live),
    hasRoot: Boolean(root),
    hasRoots: Boolean(roots),
  });
  if (boundary) {
    return boundary;
  }
  if (!root) {
    throw new Error('The child workspace lost its owning root.');
  }
  const loaded = saved && 'history' in saved ? saved : undefined;
  return (
    <DebugBundleProvider value={debugBundle}>
      <ReadyChildView
        checkpoints={checkpoints}
        db={db}
        inheritedSettings={inheritedSettings}
        insights={insights}
        live={live}
        loaded={loaded}
        loadedSearchRequest={loadedSearchRequest}
        node={node}
        repository={repository}
        root={root}
        searchTarget={searchTarget}
        setLoadedSearchRequest={setLoadedSearchRequest}
        setRefresh={setRefresh}
        setSaved={setSaved}
      />
    </DebugBundleProvider>
  );
}
