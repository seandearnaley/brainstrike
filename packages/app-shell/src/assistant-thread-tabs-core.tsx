import { hasFactoryResetPreparationStarted } from '@brainstrike/app-state/factory-reset';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  type AssistantMemoryThread,
  type AssistantThreadCatalogRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import {
  type ActionOutcome,
  type AnyContextAction,
  createReopenClosedTabAction,
  createTabStripActions,
  defineContextAction,
} from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/logging';
import {
  Button,
  TAB_STRIP_ICON_BUTTON_CLASS_NAME,
  TabPanelBoundary,
  TabStrip,
  type TabStripContextMenu,
  type TabStripItem,
} from '@brainstrike/ui';
import { Plus, TriangleAlert } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AssistantPanelLoadingState } from './assistant-panel-loading-state';
import { assistantThreadToTarget } from './assistant-thread-context-actions';
import { useAssistantThreadHost } from './assistant-thread-host-context';
import {
  getAssistantThreadColorSurface,
  resolveThreadRowStatusState,
  type ThreadRowStatusState,
} from './assistant-thread-presentation';
import type { FixedProviderModels } from './assistant-ui-panel-wrapper-runtime';
import { usePublishOnScreenThreadId } from './hooks/use-on-screen-thread';
import { useMarkOnScreenThreadViewed, useUnseenThreadIds } from './hooks/use-unseen-thread-ids';
import { ThreadIdentityMark } from './thread-identity-mark';
import { useAssistantThreadTabChords } from './use-assistant-thread-tab-chords';
import { useRetainedThreadPanels } from './use-retained-thread-panels';

const logger = createLogger('AssistantThreadTabsWorkspace');

const EMPTY_THREADS: readonly AssistantMemoryThread[] = [];
const EMPTY_THREAD_IDS: readonly string[] = [];
const STRIP_TARGET = { kind: 'tab-strip', stripId: 'assistant-threads' } as const;

/** Accessible-name text per run state; the mark draws the matching badge. */
const THREAD_TAB_STATUS_LABELS: Readonly<Record<ThreadRowStatusState, string>> = {
  'done-unseen': 'finished',
  'failed-unseen': 'failed',
  'needs-you': 'needs your input',
  running: 'running',
};

function getTabId(threadId: string): string {
  return `assistant-thread-tab-${threadId}`;
}

function getTabPanelId(threadId: string): string {
  return `assistant-thread-panel-${threadId}`;
}

/**
 * One mark element per (thread object, status). `TabStrip` compares `mark` by
 * reference, so a fresh element per render would re-render every tab; keying
 * on the loaded thread object means a metadata or title write still repaints.
 */
// Relies on the thread store REPLACING a thread object on any title or metadata change.
const threadTabMarks = new WeakMap<
  AssistantMemoryThread,
  Map<ThreadRowStatusState | 'none', ReactElement>
>();

function getThreadTabMark(
  thread: AssistantMemoryThread,
  status: ThreadRowStatusState | null
): ReactElement {
  let marksByStatus = threadTabMarks.get(thread);
  if (!marksByStatus) {
    marksByStatus = new Map();
    threadTabMarks.set(thread, marksByStatus);
  }
  const key = status ?? 'none';
  const cached = marksByStatus.get(key);
  if (cached) {
    return cached;
  }
  const mark = <ThreadIdentityMark status={status} thread={thread} />;
  marksByStatus.set(key, mark);
  return mark;
}

function getNewThreadAction(retryCatalog: boolean): { label: string; text: string } {
  return retryCatalog
    ? { label: 'Retry loading conversations', text: 'Retry' }
    : { label: 'New assistant thread', text: 'New' };
}

export interface AssistantThreadTabsWorkspaceProps {
  readonly fixedProviderModels?: FixedProviderModels;
  readonly providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
  readonly providerReadErrors?: Partial<Record<SupportedProvider, string>>;
}

/** What one mounted thread's panel renderer is given. */
interface AssistantThreadPanelProps {
  fixedProviderModels?: FixedProviderModels;
  isVisible?: boolean;
  memoryResourceId?: string;
  memoryThreadId?: string;
  onRunningChange?: (threadId: string, running: boolean) => void;
  providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
  providerReadErrors?: Partial<Record<SupportedProvider, string>>;
}

interface ThreadTabStatusProjection {
  readonly error: Error | null;
  readonly threadIds: ReadonlySet<string>;
}

export interface AssistantThreadTabsCoreProps extends AssistantThreadTabsWorkspaceProps {
  readonly activeThreads: ThreadTabStatusProjection;
  readonly loadingLabel: string;
  /** The new-thread composer, shown while no thread is active. */
  readonly renderNewThread: (
    resourceId: string,
    providerReadErrors: AssistantThreadPanelProps['providerReadErrors']
  ) => ReactNode;
  readonly renderThread: (props: AssistantThreadPanelProps) => ReactNode;
  readonly repository: AssistantThreadCatalogRepository;
  readonly threadsAwaitingApproval: ThreadTabStatusProjection;
}

export function AssistantThreadTabsCore({
  fixedProviderModels,
  providerKeySources,
  providerReadErrors,
  repository,
  loadingLabel,
  activeThreads,
  threadsAwaitingApproval,
  renderNewThread,
  renderThread,
}: AssistantThreadTabsCoreProps): ReactElement {
  const host = useAssistantThreadHost();
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;

  const activeThreadIdByResourceId = useAssistantThreadStore(
    (state) => state.activeThreadIdByResourceId
  );
  const openThreadIdsByResourceId = useAssistantThreadStore(
    (state) => state.openThreadIdsByResourceId
  );
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const loadStateByResourceId = useAssistantThreadStore((state) => state.loadStateByResourceId);
  const lastViewedAtByThreadId = useAssistantThreadStore((state) => state.lastViewedAtByThreadId);
  const unseenBaselineAt = useAssistantThreadStore((state) => state.unseenBaselineAt);
  const ensureResourceThreads = useAssistantThreadStore((state) => state.ensureResourceThreads);
  const refreshResourceThreads = useAssistantThreadStore((state) => state.refreshResourceThreads);
  const startNewThread = useAssistantThreadStore((state) => state.startNewThread);
  const openThreadTab = useAssistantThreadStore((state) => state.openThreadTab);
  const reorderThreadTabs = useAssistantThreadStore((state) => state.reorderThreadTabs);

  const loadState = loadStateByResourceId[resourceId] ?? { status: 'idle' };
  const threads = threadsByResourceId[resourceId] ?? EMPTY_THREADS;
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads]
  );
  const openThreadIds = openThreadIdsByResourceId[resourceId] ?? EMPTY_THREAD_IDS;
  const activeThreadId = activeThreadIdByResourceId[resourceId] ?? null;
  const unavailableSavedThread = useAssistantThreadStore(
    (state) => state.unavailableSavedThreadByResourceId[resourceId]
  );
  const catalogLoaded = Object.hasOwn(threadsByResourceId, resourceId);
  const retryCatalog = loadState.status === 'error' && !catalogLoaded;
  const newThreadAction = getNewThreadAction(retryCatalog);
  const newThreadDisabled = loadState.status === 'loading';
  // No active thread is the new-thread screen: its composer creates the thread
  // on the first send. Open tabs stay mounted, hidden, behind it.
  const showWelcome = catalogLoaded && activeThreadId === null;
  // The thread whose transcript this component renders: the active tab, unless
  // a load-error card below replaces the panels. (The loading card replaces them
  // only before the catalog first loads with NO open tab; a list still loading
  // with tabs open renders its transcripts. The store keeps the active thread
  // among the open tabs, so its panel is the one not `hidden`.)
  const transcriptThreadId = loadState.status === 'error' ? null : activeThreadId;

  // Host and web adapters supply their owner's status projections. This surface
  // alone publishes the visible transcript and advances its viewed watermark.
  const onScreenThreadId = usePublishOnScreenThreadId(transcriptThreadId);
  const unseenThreadIds = useUnseenThreadIds({
    lastViewedAtByThreadId,
    onScreenThreadId,
    threads,
    unseenBaselineAt,
  });
  useMarkOnScreenThreadViewed({ onScreenThreadId, threads });
  // Host threads commit titles (a rename or an auto-title) and workspace moves
  // (a worktree the agent entered) in the host log, which no history query sees.
  useEffect(() => {
    if (!host?.subscribeEntryChanges) {
      return;
    }
    return host.subscribeEntryChanges(() => {
      refreshResourceThreads(repository, resourceId).catch((error: unknown) => {
        logger.warn('Failed to refresh assistant threads after a host thread entry change', {
          error,
          resourceId,
        });
      });
    });
  }, [host, refreshResourceThreads, repository, resourceId]);

  // A failed projection reports an empty set. The strip says so, as the Threads
  // panel does, rather than let every tab read as idle.
  const statusErrorText = [
    activeThreads.error ? `Active thread status unavailable: ${activeThreads.error.message}` : null,
    threadsAwaitingApproval.error
      ? `Approval status unavailable: ${threadsAwaitingApproval.error.message}`
      : null,
  ]
    .filter((message) => message !== null)
    .join('. ');

  const items = useMemo<readonly TabStripItem[]>(
    () =>
      openThreadIds.map((threadId) => {
        const thread = threadById.get(threadId);
        const colorId = thread?.metadata?.color ?? null;
        const surface = getAssistantThreadColorSurface(colorId);
        const status = resolveThreadRowStatusState({
          failedUnseen: unseenThreadIds.failedUnseen.has(threadId),
          needsYou: threadsAwaitingApproval.threadIds.has(threadId),
          running: activeThreads.threadIds.has(threadId),
          unseen: unseenThreadIds.unseen.has(threadId),
        });
        return {
          appearance: {
            idleClassName: surface.idleClassName,
            selectedClassName: surface.selectedClassName,
          },
          closable: true,
          dataAttributes: { 'data-thread-color': colorId ?? 'unassigned' },
          id: threadId,
          label: thread?.title ?? threadId,
          mark: thread ? getThreadTabMark(thread, status) : undefined,
          panelDomId: getTabPanelId(threadId),
          statusLabel: status ? THREAD_TAB_STATUS_LABELS[status] : undefined,
          tabDomId: getTabId(threadId),
        };
      }),
    [
      activeThreads.threadIds,
      openThreadIds,
      threadById,
      threadsAwaitingApproval.threadIds,
      unseenThreadIds,
    ]
  );

  // New opens the new-thread screen; nothing is created until its first send.
  const createNewThread = useCallback(async (): Promise<void> => {
    if (retryCatalog) {
      await ensureResourceThreads(repository, resourceId);
      return;
    }
    startNewThread(resourceId);
  }, [ensureResourceThreads, repository, resourceId, retryCatalog, startNewThread]);

  const handleNewThreadClick = useCallback((): void => {
    createNewThread().catch(() => {
      // The store records the explicit error state; no fallback thread source is used.
    });
  }, [createNewThread]);

  const handleActivateThreadTab = useCallback(
    (threadId: string): void => openThreadTab(resourceId, threadId),
    [openThreadTab, resourceId]
  );
  const handleReorderThreadTabs = useCallback(
    (orderedThreadIds: readonly string[]): void => reorderThreadTabs(resourceId, orderedThreadIds),
    [reorderThreadTabs, resourceId]
  );

  const { mountedThreadIds, onRunningChange, onTabsRemoved } = useRetainedThreadPanels(
    resourceId,
    openThreadIds,
    threadById
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const closes = useAssistantThreadTabChords(resourceId, panelRef, onTabsRemoved);

  const contextMenu = useMemo<TabStripContextMenu>(() => {
    const readOpenThreadIds = (): readonly string[] =>
      useAssistantThreadStore.getState().openThreadIdsByResourceId[resourceId] ?? EMPTY_THREAD_IDS;
    const localActions: readonly AnyContextAction[] = [
      ...createTabStripActions({
        close: closes.close,
        closeAll: closes.closeAll,
        closeOthers: closes.closeOthers,
        closeToRight: closes.closeToRight,
        getId: (target) => target.id,
        getLabel: (target) => target.title,
        getOrderedIds: readOpenThreadIds,
        idPrefix: 'assistant-thread-tab',
        kind: 'assistant-thread-tab',
        noun: 'thread tab',
        reorder: handleReorderThreadTabs,
      }),
      defineContextAction({
        appliesTo: ['tab-strip'] as const,
        group: 'primary',
        icon: Plus,
        id: 'assistant-thread-strip.new-thread',
        isEnabled: () => !newThreadDisabled,
        label: 'New Thread',
        run: (): Promise<ActionOutcome> =>
          createNewThread().then(
            () => ({ ok: true }),
            (error: unknown) => ({
              error: error instanceof Error ? error.message : String(error),
              ok: false,
            })
          ),
      }),
      defineContextAction({
        appliesTo: ['tab-strip'] as const,
        group: 'primary',
        id: 'assistant-thread-strip.close-all',
        isEnabled: () => readOpenThreadIds().length > 0,
        label: 'Close All',
        run: (): Promise<ActionOutcome> => {
          closes.closeAll();
          return Promise.resolve({ ok: true });
        },
      }),
      createReopenClosedTabAction({
        hasClosedTabs: closes.hasClosedTabs,
        idPrefix: 'assistant-thread-strip',
        reopen: closes.reopenClosed,
        stripId: STRIP_TARGET.stripId,
      }),
    ];
    return {
      getStripTarget: () => STRIP_TARGET,
      getTabTarget: (threadId) => {
        const thread = threadById.get(threadId);
        if (!thread) {
          logger.error('Could not resolve assistant thread tab context target', {
            resourceId,
            threadId,
          });
          return null;
        }
        return assistantThreadToTarget(thread, 'assistant-thread-tab');
      },
      localActions,
    };
  }, [closes, createNewThread, handleReorderThreadTabs, newThreadDisabled, resourceId, threadById]);

  useEffect(() => {
    if (hasFactoryResetPreparationStarted()) {
      return;
    }
    ensureResourceThreads(repository, resourceId).catch(() => {
      // The store records the explicit error state; the assistant remains unavailable.
    });
  }, [ensureResourceThreads, repository, resourceId]);

  if (loadState.status === 'loading' && !catalogLoaded && openThreadIds.length === 0) {
    return <AssistantPanelLoadingState label={loadingLabel} />;
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="assistant-thread-tabs-workspace"
      ref={panelRef}
    >
      <TabStrip
        activeId={activeThreadId}
        aria-label="Open assistant threads"
        chrome="standalone"
        contextMenu={contextMenu}
        items={items}
        onActivate={handleActivateThreadTab}
        onClose={closes.close}
        onCloseAll={closes.closeAll}
        onReorder={handleReorderThreadTabs}
        scrollTestId="assistant-thread-tab-scroll"
        testId="assistant-thread-tab-strip"
        trailing={
          <>
            {statusErrorText ? (
              <span
                aria-label={`Thread status unavailable. ${statusErrorText}`}
                className="text-destructive flex size-7 shrink-0 items-center justify-center"
                data-testid="assistant-thread-tab-status-error"
                role="img"
                title={statusErrorText}
              >
                <TriangleAlert className="size-3.5" />
              </span>
            ) : null}
            <Button
              aria-label={newThreadAction.label}
              className={TAB_STRIP_ICON_BUTTON_CLASS_NAME}
              data-testid="assistant-new-thread-button"
              disabled={newThreadDisabled}
              onClick={handleNewThreadClick}
              size="xs"
              type="button"
              variant="ghost"
            >
              <Plus className="size-3.5" />
              <span
                className="hidden @min-[380px]/tab-strip:inline"
                data-testid="assistant-new-thread-label"
              >
                {newThreadAction.text}
              </span>
            </Button>
          </>
        }
      />

      {unavailableSavedThread ? (
        <div className="text-muted-foreground p-3 text-sm" role="status">
          Your saved conversation is unavailable. Start a new chat using New.
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {loadState.status === 'error' && !showWelcome ? (
          <ThreadWorkspaceState
            description={loadState.error}
            title="Assistant threads failed to load"
            variant="error"
          />
        ) : (
          <>
            {showWelcome ? renderNewThread(resourceId, providerReadErrors) : null}
            <ThreadPanels
              activeThreadId={activeThreadId}
              fixedProviderModels={fixedProviderModels}
              mountedThreadIds={mountedThreadIds}
              onRunningChange={onRunningChange}
              openThreadIds={openThreadIds}
              providerKeySources={providerKeySources}
              providerReadErrors={providerReadErrors}
              renderThread={renderThread}
              resourceId={resourceId}
              threadById={threadById}
            />
          </>
        )}
      </div>
    </div>
  );
}

type OptionalWrapperProp<K extends keyof AssistantThreadTabsWorkspaceProps> =
  | AssistantThreadTabsWorkspaceProps[K]
  | undefined;

/**
 * One kept-alive panel per mounted thread, each crash-contained to itself. Open
 * tabs and retained (closed-while-running) threads share ONE list in thread-id
 * order, so no reopen or tab reorder ever moves a panel's DOM node.
 */
function ThreadPanels({
  activeThreadId,
  fixedProviderModels,
  mountedThreadIds,
  onRunningChange,
  openThreadIds,
  providerKeySources,
  providerReadErrors,
  resourceId,
  renderThread,
  threadById,
}: {
  readonly activeThreadId: string | null;
  readonly fixedProviderModels: OptionalWrapperProp<'fixedProviderModels'>;
  readonly mountedThreadIds: readonly string[];
  readonly onRunningChange: (threadId: string, running: boolean) => void;
  readonly openThreadIds: readonly string[];
  readonly providerKeySources: OptionalWrapperProp<'providerKeySources'>;
  readonly providerReadErrors: OptionalWrapperProp<'providerReadErrors'>;
  readonly resourceId: string;
  readonly renderThread: AssistantThreadTabsCoreProps['renderThread'];
  readonly threadById: ReadonlyMap<string, AssistantMemoryThread>;
}): ReactElement {
  const openIds = new Set(openThreadIds);
  return (
    <>
      {mountedThreadIds.map((threadId) => {
        const isOpen = openIds.has(threadId);
        return (
          // Keep runtime ownership mounted: this wrapper owns tool updates.
          // Only the panel's presentation subtree may pause in an Activity.
          // A retained panel has no tab, so it claims no tabpanel role.
          <div
            {...(isOpen ? { 'aria-labelledby': getTabId(threadId), role: 'tabpanel' } : {})}
            className="h-full min-h-0"
            data-testid={`assistant-thread-panel-${threadId}`}
            hidden={!isOpen || threadId !== activeThreadId}
            id={getTabPanelId(threadId)}
            key={threadId}
          >
            {/* No resetKey: inside key={threadId} it could never change; "Reload tab" resets. */}
            <TabPanelBoundary label={threadById.get(threadId)?.title ?? threadId}>
              {renderThread({
                isVisible: isOpen && threadId === activeThreadId,
                ...(fixedProviderModels ? { fixedProviderModels } : {}),
                ...(providerKeySources ? { providerKeySources } : {}),
                ...(providerReadErrors ? { providerReadErrors } : {}),
                memoryResourceId: resourceId,
                memoryThreadId: threadId,
                onRunningChange,
              })}
            </TabPanelBoundary>
          </div>
        );
      })}
    </>
  );
}

function ThreadWorkspaceState({
  description,
  title,
  variant = 'muted',
}: {
  readonly description: string;
  readonly title: string;
  readonly variant?: 'error' | 'muted';
}): ReactElement {
  const tone = variant === 'error' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div
      className={`p-4 text-xs ${tone}`}
      data-testid="assistant-thread-workspace-state"
      data-variant={variant}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1">{description}</div>
    </div>
  );
}
