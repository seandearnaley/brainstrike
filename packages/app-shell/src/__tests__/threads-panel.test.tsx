import {
  type AssistantMemoryThread,
  useAssistantThreadGroupsStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { ThreadSearchRepository } from '@brainstrike/db';
import { ActionRegistryProvider, resetToastStore, Toaster } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantThreadActions } from '../assistant-thread-context-actions';
import {
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  THREAD_CONTROL_ACTION_CLASS_NAME,
  THREAD_CONTROL_MARK_CLASS_NAME,
  THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_ROW_PITCH_PX,
  THREAD_CONTROL_TITLE_CLASS_NAME,
} from '../assistant-thread-presentation';
import { lookupThreadBranch } from '../thread-branch-resolution';
import { getThreadPanelRowHeightPx } from '../thread-panel-visible-rows';
import { useThreadSearchStore } from '../thread-search-store';
import { ThreadsPanel } from '../threads-panel';

const virtualizerState = vi.hoisted(() => ({
  estimatedSizes: [] as number[],
  windowSize: Number.POSITIVE_INFINITY,
}));

// TreeTable's real virtualizer depends on layout measurements that JSDOM does
// not provide. Render its complete disclosed row model here; a dedicated
// virtualization test covers the bounded mounted-window contract.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(
    ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => {
      // Geometry derives from the callback rather than a hardcoded pitch, so the
      // mock can't contradict the density contract the tests below assert.
      const sizes = Array.from({ length: count }, (_, index) => estimateSize(index));
      virtualizerState.estimatedSizes.push(...sizes);
      const offset = (index: number): number =>
        sizes.slice(0, index).reduce((total, size) => total + size, 0);
      return {
        getTotalSize: () => offset(count),
        getVirtualItems: () =>
          Array.from({ length: Math.min(count, virtualizerState.windowSize) }, (_, index) => ({
            end: offset(index) + (sizes[index] ?? 0),
            index,
            key: `thread-row-${index}`,
            size: sizes[index] ?? 0,
            start: offset(index),
          })),
        measureElement: vi.fn(),
        scrollToIndex: vi.fn(),
      };
    }
  ),
}));

const {
  dbMocks,
  fileExplorerMocks,
  gitMocks,
  groupRows,
  mockDb,
  placementRows,
  rootRows,
  threadRows,
} = vi.hoisted(() => ({
  dbMocks: {
    activeRunError: null as Error | null,
    activeRunQueryEnabled: [] as boolean[],
    activeRunRows: [] as Record<string, unknown>[],
    activeRunSweepError: null as Error | null,
    awaitingApprovalError: null as Error | null,
    awaitingApprovalRows: [] as Record<string, unknown>[],
    database: undefined as unknown,
    deleteFailureThreadId: null as string | null,
    forgePrError: null as Error | null,
    forgePrRows: [] as Record<string, unknown>[],
    getNavigationTitles: vi.fn<ThreadSearchRepository['getNavigationTitles']>(),
    initializationStatus: 'ready' as 'idle' | 'initializing' | 'ready' | 'error',
    initializing: false,
    metadataFailureMessage: 'Metadata update failed in PGlite.',
    metadataFailureThreadId: null as string | null,
    providerError: null as Error | null,
    rootsQueryError: null as Error | null,
  },
  fileExplorerMocks: {
    rootDirectoryHandle: {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    } as { name: string; path: string } | null,
  },
  gitMocks: {
    available: true,
    deferredLoads: [] as boolean[],
    worktrees: [] as {
      branch: string | null;
      /** Workspace root ids containing this worktree; defaults to none. */
      containment?: readonly string[];
      detached: boolean;
      path: string;
    }[],
  },
  groupRows: [] as Record<string, unknown>[],
  mockDb: {
    exec: vi.fn(() => Promise.resolve()),
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(
      () => Promise.resolve({ rows: [] })
    ),
  },
  placementRows: [] as Record<string, unknown>[],
  rootRows: [] as Record<string, unknown>[],
  threadRows: [] as Record<string, unknown>[],
}));

function parseMetadataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

vi.mock('@brainstrike/db', () => ({
  // Search returns no matches; the real controller still resolves the title
  // batch and clears index rows when threads are deleted.
  createThreadSearchService: () => ({
    searchThreads: () =>
      Promise.resolve({
        metadata: {
          ftsResultCount: 0,
          semanticArmUsed: false,
          titleResultCount: 0,
          totalMs: 0,
          vectorResultCount: 0,
        },
        results: [],
      }),
  }),
  ThreadSearchRepository: class {
    readonly getNavigationTitles = dbMocks.getNavigationTitles;
    deleteThreads(): Promise<void> {
      return Promise.resolve();
    }
    fullTextSearch(): Promise<never[]> {
      return Promise.resolve([]);
    }
    getCoverage(): Promise<Record<string, number>> {
      return Promise.resolve({
        embeddableMessages: 0,
        embeddedMessages: 0,
        erroredMessages: 0,
        indexedMessages: 0,
        totalMessages: 0,
      });
    }
    getEmbeddingProfile(): Promise<Record<string, unknown>> {
      return Promise.resolve({
        dimensions: 384,
        distance: 'cosine',
        id: 'default',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      });
    }
    listNeedingEmbedding(): Promise<never[]> {
      return Promise.resolve([]);
    }
    markEmbeddingError(): Promise<boolean> {
      return Promise.resolve(true);
    }
    searchSimilar(): Promise<never[]> {
      return Promise.resolve([]);
    }
    searchThreadTitles(): Promise<never[]> {
      return Promise.resolve([]);
    }
    storeEmbedding(): Promise<boolean> {
      return Promise.resolve(true);
    }
    sync(): Promise<Record<string, number>> {
      return Promise.resolve({ deletedOrphans: 0, inserted: 0, refreshed: 0 });
    }
  },
  useDbInitializationStatus: () => dbMocks.initializationStatus,
  useDbInitializing: () => dbMocks.initializing,
  useDbProviderError: () => dbMocks.providerError,
  usePGliteDatabase: () => (dbMocks.database === undefined ? mockDb : dbMocks.database),
}));
vi.mock('@brainstrike/db/react', () => ({
  // Search returns no matches; the real controller still resolves the title
  // batch and clears index rows when threads are deleted.
  createThreadSearchService: () => ({
    searchThreads: () =>
      Promise.resolve({
        metadata: {
          ftsResultCount: 0,
          semanticArmUsed: false,
          titleResultCount: 0,
          totalMs: 0,
          vectorResultCount: 0,
        },
        results: [],
      }),
  }),
  makeLiveQueryKey: (...parts: readonly unknown[]) => JSON.stringify(parts),
  ThreadSearchRepository: class {
    readonly getNavigationTitles = dbMocks.getNavigationTitles;
    deleteThreads(): Promise<void> {
      return Promise.resolve();
    }
    fullTextSearch(): Promise<never[]> {
      return Promise.resolve([]);
    }
    getCoverage(): Promise<Record<string, number>> {
      return Promise.resolve({
        embeddableMessages: 0,
        embeddedMessages: 0,
        erroredMessages: 0,
        indexedMessages: 0,
        totalMessages: 0,
      });
    }
    getEmbeddingProfile(): Promise<Record<string, unknown>> {
      return Promise.resolve({
        dimensions: 384,
        distance: 'cosine',
        id: 'default',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      });
    }
    listNeedingEmbedding(): Promise<never[]> {
      return Promise.resolve([]);
    }
    markEmbeddingError(): Promise<boolean> {
      return Promise.resolve(true);
    }
    searchSimilar(): Promise<never[]> {
      return Promise.resolve([]);
    }
    searchThreadTitles(): Promise<never[]> {
      return Promise.resolve([]);
    }
    storeEmbedding(): Promise<boolean> {
      return Promise.resolve(true);
    }
    sync(): Promise<Record<string, number>> {
      return Promise.resolve({ deletedOrphans: 0, inserted: 0, refreshed: 0 });
    }
  },
  useDbInitializationStatus: () => dbMocks.initializationStatus,
  useDbInitializing: () => dbMocks.initializing,
  useDbProviderError: () => dbMocks.providerError,
  usePGliteDatabase: () => (dbMocks.database === undefined ? mockDb : dbMocks.database),
  // Routed BY cacheKey, never by call order: the panel runs distinct live
  // projections, including two with identical row shapes ({ threadId}), so an
  // order-based double would happily feed the running spinners approval rows.
  usePGliteLiveQuery: (options: { readonly cacheKey: string; readonly enabled: boolean }) => {
    if (options.cacheKey.startsWith('["threads-awaiting-approval"')) {
      return {
        error: dbMocks.awaitingApprovalError,
        loading: false,
        refresh: vi.fn(),
        rows: options.enabled ? dbMocks.awaitingApprovalRows : [],
      };
    }
    if (options.cacheKey.startsWith('["forge-pr-cache"')) {
      return {
        error: dbMocks.forgePrError,
        loading: false,
        refresh: vi.fn(),
        rows: options.enabled ? dbMocks.forgePrRows : [],
      };
    }
    if (!options.cacheKey.startsWith('["active-assistant-thread-ids"')) {
      throw new Error(`Unrouted thread panel live query: ${options.cacheKey}`);
    }
    dbMocks.activeRunQueryEnabled.push(options.enabled);
    return {
      error: dbMocks.activeRunError,
      loading: false,
      refresh: vi.fn(),
      rows: options.enabled ? dbMocks.activeRunRows : [],
    };
  },
}));

// The branch chips' inventory: `deferInitialLoad` keeps `inventory` null, the
// same observable pre-first-load state the real hook reports, so the folder-mode
// gate stays visible to these tests.
vi.mock('../changes/use-git-inventory', () => ({
  useGitInventory: (options?: {
    readonly active?: boolean;
    readonly deferInitialLoad?: boolean;
  }) => {
    const deferred = Boolean(options?.deferInitialLoad);
    gitMocks.deferredLoads.push(deferred);
    return {
      available: gitMocks.available,
      error: null,
      inventory:
        deferred || !gitMocks.available
          ? null
          : {
              errors: [],
              repositories: [
                {
                  identity: {
                    gitCommonDir: '/tmp/workspace-a/.git',
                    repositoryRoot: '/tmp/workspace-a',
                  },
                  worktrees: gitMocks.worktrees.map(({ containment, ...worktree }) => ({
                    ...worktree,
                    containment: containment ?? 'outside-roots',
                    provenance: 'primary',
                    trust: 'validated',
                  })),
                },
              ],
            },
      loading: false,
      refresh: vi.fn(),
    };
  },
}));

vi.mock('@brainstrike/app-state/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('@brainstrike/app-state/stores/model-registry-store', () => {
  const registryState = { models: [], providers: [] };
  return {
    useModelRegistryStore: (selector?: (state: typeof registryState) => unknown) =>
      selector ? selector(registryState) : registryState,
  };
});

vi.mock('@brainstrike/vector-management', () => ({
  useSharedSearchEmbedder: () => ({
    embedDocumentWithRecovery: vi.fn(() => Promise.resolve([])),
    embedQueryWithRecovery: vi.fn(() => Promise.resolve([])),
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof fileExplorerMocks) => T): T =>
    selector(fileExplorerMocks),
  useFileSystem: () => ({ rootDirectoryHandle: fileExplorerMocks.rootDirectoryHandle }),
}));

function renderThreadsPanel(): ReturnType<typeof createTestActionRegistry> {
  const actionRegistry = createTestActionRegistry({ actions: assistantThreadActions });
  render(
    <ActionRegistryProvider registry={actionRegistry.registry}>
      <ThreadsPanel />
      <Toaster />
    </ActionRegistryProvider>
  );
  return actionRegistry;
}

beforeEach(() => {
  virtualizerState.windowSize = Number.POSITIVE_INFINITY;
  // Shared across every render in this file; without a reset it becomes
  // order-dependent state the next test to read it silently inherits.
  virtualizerState.estimatedSizes.length = 0;
  fileExplorerMocks.rootDirectoryHandle = {
    name: 'workspace-a',
    path: '/tmp/workspace-a',
  };
  dbMocks.database = { exec: mockDb.exec, query: mockDb.query };
  dbMocks.getNavigationTitles.mockReset().mockResolvedValue([]);
  dbMocks.activeRunQueryEnabled = [];
  dbMocks.activeRunError = null;
  dbMocks.activeRunRows = [];
  dbMocks.activeRunSweepError = null;
  dbMocks.awaitingApprovalError = null;
  dbMocks.awaitingApprovalRows = [];
  dbMocks.forgePrError = null;
  dbMocks.forgePrRows = [];
  dbMocks.rootsQueryError = null;
  gitMocks.available = true;
  gitMocks.deferredLoads = [];
  gitMocks.worktrees = [];
  rootRows.splice(0, rootRows.length);
  resetToastStore();
  dbMocks.deleteFailureThreadId = null;
  dbMocks.initializing = false;
  dbMocks.initializationStatus = 'ready';
  dbMocks.metadataFailureMessage = 'Metadata update failed in PGlite.';
  dbMocks.metadataFailureThreadId = null;
  dbMocks.providerError = null;
  groupRows.splice(0, groupRows.length);
  placementRows.splice(0, placementRows.length);
  useAssistantThreadGroupsStore.getState().reset();
  // Session-scoped and previously never reset here: a test that types into the
  // search box left every later test rendering search results.
  useThreadSearchStore.getState().clearSearch();
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: {},
    draftRuntimeByThreadId: {},
    // Persisted and module-scope: without this reset, a test that opens a
    // thread leaves every later test's "unseen" watermark already stamped.
    lastViewedAtByThreadId: {},
    loadStateByResourceId: {},
    openThreadIdsByResourceId: {},
    selectedThreadByResourceId: {},
    threadIdsByResourceId: {},
    threadsByResourceId: {},
    // The real store stamps this at creation, which is AFTER these fixtures'
    // 2026-04 completion times — so the suite pins it to 0 and the tests that
    // care about the floor set it themselves.
    unseenBaselineAt: 0,
  });
  threadRows.splice(
    0,
    threadRows.length,
    {
      createdAt: new Date('2026-04-22T10:00:00Z'),
      id: 'thread-b',
      metadata: JSON.stringify({ color: 'blue', icon: 'message' }),
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Second thread',
      updatedAt: new Date('2026-04-22T11:00:00Z'),
    },
    {
      createdAt: new Date('2026-04-22T09:00:00Z'),
      id: 'thread-a',
      metadata: JSON.stringify({ color: 'emerald', icon: 'code' }),
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'First thread',
      updatedAt: new Date('2026-04-22T09:00:00Z'),
    }
  );
  mockDb.exec.mockClear();
  mockDb.query.mockClear();
  const latestRunRows = [
    {
      completedAt: new Date('2026-04-22T11:00:10Z'),
      createdAt: new Date('2026-04-22T11:00:00Z'),
      error: null,
      id: 'run-1',
      model: 'gpt-5.2-chat-latest',
      modelSettings: JSON.stringify({ maxOutputTokens: 512 }),
      provider: 'openai',
      providerOptions: JSON.stringify({ openai: { reasoningEffort: 'high' } }),
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      runtimeKind: 'hosted',
      startedAt: new Date('2026-04-22T11:00:00Z'),
      status: 'completed',
      threadId: 'thread-b',
      turnMessageId: null,
      updatedAt: new Date('2026-04-22T11:00:10Z'),
    },
    {
      completedAt: new Date('2026-04-22T09:00:10Z'),
      createdAt: new Date('2026-04-22T09:00:00Z'),
      error: null,
      id: 'run-openrouter-1',
      model: 'openai/gpt-5.6-terra',
      modelSettings: null,
      provider: 'openrouter',
      providerOptions: JSON.stringify({
        openrouter: { reasoning: { effort: 'low', summary: 'auto' } },
      }),
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      runtimeKind: 'hosted',
      startedAt: new Date('2026-04-22T09:00:00Z'),
      status: 'completed',
      threadId: 'thread-a',
      turnMessageId: null,
      updatedAt: new Date('2026-04-22T09:00:10Z'),
    },
  ];
  const latestRunByThreadId = new Map(latestRunRows.map((run) => [run.threadId, run] as const));
  mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT to_regclass')) {
      return { rows: [{ oid: 'brainstrike_assistant_thread_runs' }] };
    }
    if (sql.includes('UPDATE brainstrike_assistant_thread_runs')) {
      if (dbMocks.activeRunSweepError) {
        throw dbMocks.activeRunSweepError;
      }
      return { rows: [] };
    }
    if (sql.includes('deleted_threads AS')) {
      const threadIds = (params ?? []).map(String);
      if (threadIds.some((threadId) => dbMocks.deleteFailureThreadId === threadId)) {
        throw new Error('Bulk delete failed in PGlite.');
      }
      for (let index = threadRows.length - 1; index >= 0; index -= 1) {
        if (threadIds.includes(String(threadRows[index]?.['id']))) {
          threadRows.splice(index, 1);
        }
      }
      for (let index = placementRows.length - 1; index >= 0; index -= 1) {
        if (threadIds.includes(String(placementRows[index]?.['threadId']))) {
          placementRows.splice(index, 1);
        }
      }
      return { rows: [{ allAuthorized: true, allFound: true }] };
    }
    if (sql.includes('updated_threads AS')) {
      const threadIds = (params ?? []).slice(0, -1).map(String);
      const metadata = parseMetadataObject(params?.at(-1));
      for (const row of threadRows) {
        if (threadIds.includes(String(row['id']))) {
          row['metadata'] = JSON.stringify({
            ...parseMetadataObject(row['metadata']),
            ...metadata,
          });
        }
      }
      return { rows: [{ allFound: true }] };
    }
    if (sql.includes('INSERT INTO mastra_threads')) {
      threadRows.unshift({
        createdAt: params?.[4],
        id: String(params?.[0]),
        resourceId: String(params?.[1]),
        title: String(params?.[2]),
        updatedAt: params?.[5],
      });
    }
    if (sql.includes('DELETE FROM mastra_threads')) {
      const threadId = String(params?.[0]);
      if (dbMocks.deleteFailureThreadId === threadId) {
        throw new Error('Delete failed in PGlite.');
      }
      const index = threadRows.findIndex((row) => row['id'] === threadId);
      if (index >= 0) {
        threadRows.splice(index, 1);
      }
      return { rows: [{ allAuthorized: true }] };
    }
    if (sql.includes('SET metadata')) {
      const threadId = String(params?.[0]);
      if (dbMocks.metadataFailureThreadId === threadId || dbMocks.metadataFailureThreadId === '*') {
        throw new Error(dbMocks.metadataFailureMessage);
      }
      const row = threadRows.find((item) => item['id'] === threadId);
      if (row) {
        row['metadata'] = JSON.stringify({
          ...parseMetadataObject(row['metadata']),
          ...parseMetadataObject(params?.[1]),
        });
      }
    }
    if (sql.includes('INSERT INTO brainstrike_assistant_thread_groups')) {
      groupRows.push({
        color: null,
        icon: null,
        id: String(params?.[0]),
        name: String(params?.[2]),
        rank: String(params?.[3]),
        resourceId: String(params?.[1]),
      });
      return { rows: [] };
    }
    if (sql.includes('UPDATE brainstrike_assistant_thread_groups')) {
      const row = groupRows.find((item) => item['id'] === String(params?.[0]));
      if (row) {
        if (sql.includes('SET name')) {
          row['name'] = String(params?.[1]);
        }
        if (sql.includes('SET rank')) {
          row['rank'] = String(params?.[1]);
        }
        if (sql.includes('SET color')) {
          row['color'] = params?.[1] ?? null;
        }
        if (sql.includes('SET icon')) {
          row['icon'] = params?.[1] ?? null;
        }
      }
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM brainstrike_assistant_thread_groups')) {
      if (sql.includes('DELETE FROM brainstrike_assistant_thread_placements')) {
        for (let index = placementRows.length - 1; index >= 0; index -= 1) {
          if (placementRows[index]?.['groupId'] === String(params?.[0])) {
            placementRows.splice(index, 1);
          }
        }
      }
      const index = groupRows.findIndex((row) => row['id'] === String(params?.[0]));
      if (index >= 0) {
        groupRows.splice(index, 1);
      }
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO brainstrike_assistant_thread_placements')) {
      const placementThreadId = String(params?.[0]);
      const nextPlacement = {
        flatRank: params?.[4] ?? null,
        groupId: params?.[2] ?? null,
        rank: String(params?.[3]),
        resourceId: String(params?.[1]),
        threadId: placementThreadId,
      };
      const index = placementRows.findIndex((row) => row['threadId'] === placementThreadId);
      if (index >= 0) {
        placementRows[index] = nextPlacement;
      } else {
        placementRows.push(nextPlacement);
      }
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM brainstrike_assistant_thread_placements WHERE group_id')) {
      const removedGroupId = String(params?.[0]);
      for (let index = placementRows.length - 1; index >= 0; index -= 1) {
        if (placementRows[index]?.['groupId'] === removedGroupId) {
          placementRows.splice(index, 1);
        }
      }
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM brainstrike_assistant_thread_placements WHERE thread_id')) {
      const threadIds = (params ?? []).map(String);
      for (let index = placementRows.length - 1; index >= 0; index -= 1) {
        if (threadIds.includes(String(placementRows[index]?.['threadId']))) {
          placementRows.splice(index, 1);
        }
      }
      return { rows: [] };
    }
    if (sql.includes('FROM brainstrike_assistant_thread_groups')) {
      return { rows: [...groupRows] };
    }
    if (sql.includes('FROM brainstrike_assistant_thread_placements')) {
      return { rows: [...placementRows] };
    }
    // The joined list query also names the run table; match its outer source
    // explicitly so this branch cannot become order-dependent with the run read.
    if (sql.includes('FROM mastra_threads AS threads')) {
      return {
        rows: threadRows.map((thread) => {
          const latestRun = latestRunByThreadId.get(String(thread['id']));
          if (!latestRun) {
            return { ...thread };
          }
          return {
            ...thread,
            latestRunCompletedAt: latestRun.completedAt,
            latestRunCreatedAt: latestRun.createdAt,
            latestRunError: latestRun.error,
            latestRunId: latestRun.id,
            latestRunModel: latestRun.model,
            latestRunModelSettings: latestRun.modelSettings,
            latestRunProvider: latestRun.provider,
            latestRunProviderOptions: latestRun.providerOptions,
            latestRunResourceId: latestRun.resourceId,
            latestRunRuntimeKind: latestRun.runtimeKind,
            latestRunStartedAt: latestRun.startedAt,
            latestRunStatus: latestRun.status,
            latestRunThreadId: latestRun.threadId,
            latestRunTurnMessageId: latestRun.turnMessageId,
            latestRunUpdatedAt: latestRun.updatedAt,
          };
        }),
      };
    }
    if (sql.includes('FROM roots WHERE id = ANY')) {
      if (dbMocks.rootsQueryError) {
        throw dbMocks.rootsQueryError;
      }
      const requestedIds = (params?.[0] ?? []) as readonly string[];
      return { rows: rootRows.filter((row) => requestedIds.includes(String(row['id']))) };
    }
    if (sql.includes('FROM brainstrike_assistant_thread_runs')) {
      return { rows: [...latestRunRows] };
    }
    return { rows: [] };
  });
});

describe('ThreadsPanel', () => {
  it('shows independent reduced-motion-safe activity spinners without replacing thread icons', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-a' }, { threadId: 'thread-b' }];
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-active-spinner')).toHaveLength(2);
    });

    const firstThreadRow = screen
      .getByText('First thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    const secondThreadRow = screen
      .getByText('Second thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    expect(firstThreadRow).not.toBeNull();
    expect(secondThreadRow).not.toBeNull();
    if (!(firstThreadRow && secondThreadRow)) {
      throw new Error('Expected both thread rows to render.');
    }

    expect(within(firstThreadRow).getByTestId('thread-icon-code')).toBeVisible();
    expect(within(secondThreadRow).getByTestId('thread-icon-message')).toBeVisible();
    expect(within(firstThreadRow).getByRole('img', { name: 'First thread is active' })).toHaveClass(
      'motion-reduce:animate-none'
    );
    expect(
      within(secondThreadRow).getByRole('img', { name: 'Second thread is active' })
    ).toBeVisible();

    dbMocks.activeRunRows = [];
    act(() => {
      useAssistantThreadStore.setState((state) => ({
        selectedThreadByResourceId: { ...state.selectedThreadByResourceId },
      }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('thread-active-spinner')).not.toBeInTheDocument();
    });
    expect(within(firstThreadRow).getByTestId('thread-icon-code')).toBeVisible();
    expect(within(secondThreadRow).getByTestId('thread-icon-message')).toBeVisible();
  });

  it('keeps the durable activity subscription live while thread creation reloads the list', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-a' }];
    renderThreadsPanel();

    expect(await screen.findByTestId('thread-active-spinner')).toBeVisible();
    act(() => {
      useAssistantThreadStore.setState((state) => ({
        loadStateByResourceId: {
          ...state.loadStateByResourceId,
          [WORKSPACE_MEMORY_RESOURCE_ID]: { status: 'loading' },
        },
      }));
    });

    expect(screen.getByTestId('thread-active-spinner')).toBeVisible();
    expect(dbMocks.activeRunQueryEnabled.at(-1)).toBe(true);
  });

  it('surfaces a web startup orphan-sweep failure before subscribing', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-a' }];
    dbMocks.activeRunSweepError = new Error('startup sweep failed');
    renderThreadsPanel();

    expect(await screen.findByTestId('thread-activity-error')).toHaveTextContent(
      'Active thread status unavailable: startup sweep failed'
    );
    expect(dbMocks.activeRunQueryEnabled.at(-1)).toBe(false);
    expect(screen.queryByTestId('thread-active-spinner')).not.toBeInTheDocument();
  });

  it('surfaces an active-run subscription failure instead of silently showing every thread idle', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-a' }];
    dbMocks.activeRunError = new Error('active run live query failed');
    renderThreadsPanel();

    expect(await screen.findByTestId('thread-activity-error')).toHaveTextContent(
      'Active thread status unavailable: active run live query failed'
    );
    expect(screen.queryByTestId('thread-active-spinner')).not.toBeInTheDocument();
  });

  it('rejects malformed active-run rows instead of guessing a thread identity', async () => {
    dbMocks.activeRunRows = [{ threadId: 42 }];
    renderThreadsPanel();

    expect(await screen.findByTestId('thread-activity-error')).toHaveTextContent(
      'Active thread status unavailable: Active assistant thread query returned an invalid thread id.'
    );
    expect(screen.queryByTestId('thread-active-spinner')).not.toBeInTheDocument();
  });

  it('spends exactly two chrome rows above the list: a toolbar and the search row', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    const toolbar = screen.getByTestId('threads-panel-toolbar');
    const search = screen.getByTestId('threads-panel-search');
    // The toolbar owns the heading, the live count, and the select-visible
    // control; the count/select band that used to sit below the search row is
    // gone, so the panel chrome is two rows instead of three.
    expect(within(toolbar).getByRole('heading', { name: 'Threads' })).toBeVisible();
    expect(within(toolbar).getByTestId('threads-visible-count')).toHaveTextContent('2');
    expect(within(toolbar).getByRole('button', { name: 'Select 2 visible threads' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'New thread' })).toBeVisible();
    expect(within(search).getByTestId('thread-search-input')).toBeVisible();
    expect(toolbar.nextElementSibling).toBe(search);
    expect(screen.queryByTestId('threads-panel-select-band')).not.toBeInTheDocument();

    // One row of controls only reads as a row when the controls are the same
    // size; the view-options trigger used to be 32px next to 28px neighbours.
    // Same 28px square for every control, New Thread included — it only grows
    // into a labelled pill at @[360px]/threads, where the label appears.
    for (const label of ['Select 2 visible threads', 'View options', 'New group', 'New thread']) {
      expect(within(toolbar).getByRole('button', { name: label })).toHaveClass('size-7');
    }
    // Every control hovers toward the same accent. New Thread keeps a resting
    // fill because it is the primary action, but `secondary/80` alone hovered
    // LIGHTER while its ghost neighbours hovered darker — opposite directions
    // in one row.
    for (const label of ['Select 2 visible threads', 'View options', 'New group', 'New thread']) {
      expect(within(toolbar).getByRole('button', { name: label })).toHaveClass(
        'hover:bg-accent',
        'hover:text-accent-foreground'
      );
    }
    // Declared icon metrics must be the rendered ones: `h-3.5 w-3.5` loses to
    // the button base rule's `size-4`, so the icons render 16px, not 14px.
    for (const icon of toolbar.querySelectorAll('svg')) {
      expect(icon).toHaveClass('size-3.5');
    }
  });

  it('reads the visible count as singular when one thread is disclosed', async () => {
    threadRows.splice(1);

    renderThreadsPanel();

    expect(await screen.findByRole('button', { name: 'Select 1 visible thread' })).toBeVisible();
    expect(screen.getByTestId('threads-visible-count')).toHaveTextContent('1 thread visible');
  });

  it('withdraws the count and select-visible toggle while search replaces the list', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(screen.getByTestId('threads-visible-count')).toBeVisible();

    // Search results replace the treegrid, and the bulk-selection overlay lives
    // inside that now-hidden subtree. A live toggle here would select threads
    // the user cannot see, with no action bar and no way to clear.
    fireEvent.change(screen.getByTestId('thread-search-input'), { target: { value: 'alpha' } });

    await waitFor(() => {
      expect(screen.queryByTestId('threads-visible-count')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /visible threads?$/ })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(dbMocks.getNavigationTitles).toHaveBeenCalledWith(WORKSPACE_MEMORY_RESOURCE_ID, []);
    });
    expect(useThreadSearchStore.getState().status).toBe('results');
    expect(screen.getByRole('button', { name: 'New thread' })).toBeVisible();
  });

  it('withdraws the count and select-visible toggle while a state card replaces the list', () => {
    dbMocks.database = null;
    dbMocks.initializing = true;
    dbMocks.initializationStatus = 'initializing';

    renderThreadsPanel();

    expect(screen.getByTestId('threads-loading-card')).toBeVisible();
    expect(screen.queryByTestId('threads-visible-count')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /visible threads?$/ })).not.toBeInTheDocument();
  });

  it('drops the redundant Memory pill and its restated subtitle from the toolbar', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    expect(screen.queryByTestId('threads-preview-badge')).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace-scoped Mastra history')).not.toBeInTheDocument();
  });

  it('renders the disclosed collection through the shared virtual treegrid scroll owner', async () => {
    renderThreadsPanel();

    const treegrid = await screen.findByRole('treegrid', { name: 'Workspace threads' });
    expect(treegrid).toHaveAttribute('aria-multiselectable', 'true');
    expect(treegrid).toHaveClass('outline-none');
    expect(treegrid.querySelector('thead')).toBeNull();

    const viewport = treegrid.parentElement;
    expect(viewport).toHaveClass('overflow-auto');
    expect(viewport).toHaveStyle({ maxHeight: 'none' });
    expect(screen.getAllByTestId('thread-row')[0]?.closest('tr')).toHaveClass(
      'group/thread-tree-row'
    );
    expect(screen.getAllByTestId('thread-row')[0]).not.toHaveClass('border');
    expect(screen.getAllByTestId('thread-row')[0]).not.toHaveClass(
      'group-data-[focused=true]/thread-tree-row:outline-2'
    );
    expect(viewport?.parentElement?.parentElement).not.toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('threads-panel')).toHaveClass('@container/threads', 'h-full');

    const idleThread = screen.getByText('First thread').closest('[data-testid="thread-row"]');
    expect(idleThread).toHaveClass('bg-emerald-100/45', 'hover:bg-emerald-100/75');
    expect(idleThread).not.toHaveClass('hover:bg-accent/35');
  });

  it('keeps row action chips inside the row instead of filling its full height', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    const expand = screen.getByRole('button', { name: /Show thread details First thread/ });
    const actions = screen.getByRole('button', { name: /Thread actions First thread/ });

    for (const control of [expand, actions]) {
      // icon-xs paints a 28px chip, which is now the entire row height, so the
      // hover fill runs edge to edge. 20px leaves 4px above and below and
      // matches the tab's close affordance.
      expect(control).toHaveClass(...THREAD_CONTROL_ACTION_CLASS_NAME.split(' '));
      expect(control).not.toHaveClass('size-7');
      // Hover rides the tinted row rather than punching a neutral chip into it.
      expect(control).not.toHaveClass('hover:bg-accent');
      // Visual box shrinks but the pointer target stays >= 24px.
      expect(control.className).toMatch(/after:-inset-1/);
      expect(control.querySelector('svg')).toHaveClass('size-3');
    }
  });

  it('pads the expanded details block evenly against the row edges', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: /Show thread details First thread/ }));

    // The row supplies px-2 horizontally and no vertical padding (vertical
    // padding would push the collapsed control past the tab's 28px). So the
    // block itself has to carry a matching 8px below, or it sits flush against
    // the row's bottom edge while both sides are inset.
    const details = await screen.findByTestId('thread-expanded-details');
    expect(details).toHaveClass('mb-2');
    expect(details.closest('[data-testid="thread-row"]')).toHaveClass('px-2');
  });

  it('sizes rows from the shared thread control density contract', async () => {
    virtualizerState.estimatedSizes.length = 0;
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    const title = screen.getByText('First thread');
    const row = title.closest<HTMLElement>('[data-testid="thread-row"]');
    if (!row) {
      throw new Error('expected the thread title to be inside a thread row');
    }

    // A row and a tab render the same object, so they share one height.
    expect(row).toHaveClass(THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME);
    expect(row).not.toHaveClass('min-h-9');
    // The 28px control plus its 2px margins is the virtual row pitch — vertical
    // padding would push the painted control past the tab's height.
    expect(row).toHaveClass('my-0.5');
    expect(row).not.toHaveClass('py-0.5');
    // A flat view is all thread rows, so every estimate is the shared pitch.
    expect(new Set(virtualizerState.estimatedSizes)).toEqual(
      new Set([getThreadPanelRowHeightPx('thread')])
    );
    expect(virtualizerState.estimatedSizes).toContain(THREAD_CONTROL_ROW_PITCH_PX);

    expect(title).toHaveClass(...THREAD_CONTROL_TITLE_CLASS_NAME.split(' '));
    expect(title).not.toHaveClass('text-[13px]');

    const mark = within(row).getByTestId('thread-color-emerald');
    expect(mark).toHaveClass(...THREAD_CONTROL_MARK_CLASS_NAME.split(' '));
    expect(mark).not.toHaveClass('size-6');
    // The row is tinted with the same token family; the mark keeps its own
    // lighter fill and border so it stays visible on idle and selected rows.
    expect(mark).toHaveClass(
      ...ASSISTANT_THREAD_COLOR_PRESENTATION.emerald.markClassName.split(' ')
    );
    expect(mark).not.toHaveClass('bg-emerald-100');
  });

  it('mounts only the virtual window for a large disclosed collection', async () => {
    virtualizerState.windowSize = 12;
    useAssistantThreadGroupsStore.setState({ groupBy: 'none' });
    for (let index = 0; index < 100; index += 1) {
      threadRows.push({
        createdAt: new Date('2026-04-20T09:00:00Z'),
        id: `thread-window-${index}`,
        metadata: null,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        title: `Window thread ${index}`,
        updatedAt: new Date('2026-04-20T09:00:00Z'),
      });
    }

    renderThreadsPanel();

    const treegrid = await screen.findByRole('treegrid', { name: 'Workspace threads' });
    expect(treegrid).toHaveAttribute('aria-rowcount', '51');
    expect(screen.getAllByTestId('thread-row')).toHaveLength(12);
  });

  it('discloses 50 more threads with the exact remaining count', async () => {
    useAssistantThreadGroupsStore.setState({ groupBy: 'none' });
    for (let index = 0; index < 50; index += 1) {
      threadRows.push({
        createdAt: new Date('2026-04-20T09:00:00Z'),
        id: `thread-extra-${index}`,
        metadata: null,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        title: `Extra thread ${index}`,
        updatedAt: new Date('2026-04-20T09:00:00Z'),
      });
    }

    renderThreadsPanel();

    expect(await screen.findByRole('button', { name: 'Show 2 more threads' })).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more threads' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(52);
    });
    expect(screen.queryByRole('button', { name: /Show .* more threads/ })).not.toBeInTheDocument();
  });

  it('selects only disclosed threads and scopes Escape clearing to the thread panel', async () => {
    useAssistantThreadGroupsStore.setState({ groupBy: 'none' });
    for (let index = 0; index < 50; index += 1) {
      threadRows.push({
        createdAt: new Date('2026-04-20T09:00:00Z'),
        id: `thread-extra-${index}`,
        metadata: null,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        title: `Extra thread ${index}`,
        updatedAt: new Date('2026-04-20T09:00:00Z'),
      });
    }

    renderThreadsPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Select 50 visible threads' }));
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '50 selected'
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '50 selected'
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Clear 50 visible threads' }), {
      key: 'Escape',
    });
    expect(
      screen.queryByRole('toolbar', { name: 'Thread selection actions' })
    ).not.toBeInTheDocument();
  });

  it('offers staged bulk color and delete actions while retaining selection on failure', async () => {
    placementRows.push({
      flatRank: 'flat-b',
      groupId: 'group-research',
      rank: 'a0',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      threadId: 'thread-b',
    });
    renderThreadsPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Select 2 visible threads' }));
    const toolbar = screen.getByRole('toolbar', { name: 'Thread selection actions' });
    const overlay = screen.getByTestId('selection-action-overlay');
    expect(overlay).toHaveClass('bottom-3');
    expect(overlay).not.toHaveClass('top-12');
    expect(toolbar.parentElement).toBe(overlay);
    expect(toolbar).toHaveClass('w-full');
    expect(screen.getByRole('treegrid', { name: 'Workspace threads' }).parentElement).toHaveClass(
      'pb-20'
    );
    expect(within(toolbar).getByRole('button', { name: 'Move' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'Color' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'Delete' })).toBeVisible();

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Color' }));
    const bulkColorGrid = await screen.findByTestId('thread-bulk-color-grid');
    expect(within(bulkColorGrid).getByText('Voltage')).toBeVisible();
    expect(within(bulkColorGrid).getByText('Afterglow')).toBeVisible();
    for (const button of within(bulkColorGrid).getAllByRole('button')) {
      expect(button).toHaveClass('size-8');
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Use Rose color for 2 threads' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-color-rose')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select 2 visible threads' }));
    dbMocks.deleteFailureThreadId = 'thread-b';
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete 2 selected threads?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByText('Bulk delete failed in PGlite.')).toBeVisible();
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '2 selected'
    );
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(placementRows).toEqual([
      expect.objectContaining({ flatRank: 'flat-b', threadId: 'thread-b' }),
    ]);
  });
  it('loads workspace-global threads even when no folder is open', async () => {
    // Multi-root: assistant memory is workspace-global and usable with zero roots.
    // There is no "open a folder first" gate, and threads are keyed on a stable
    // resource id rather than the focused root path.
    fileExplorerMocks.rootDirectoryHandle = null;

    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(screen.queryByText('No workspace open')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New thread' })).toBeEnabled();
  });

  it('shows loading instead of unavailable while the database is initializing', () => {
    dbMocks.database = null;
    dbMocks.initializing = true;
    dbMocks.initializationStatus = 'initializing';

    renderThreadsPanel();

    expect(screen.getByTestId('threads-loading-card')).toBeVisible();
    expect(screen.getByText('Loading threads...')).toBeVisible();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant memory database unavailable')).not.toBeInTheDocument();
  });

  it('shows loading instead of unavailable before lazy database initialization starts', () => {
    dbMocks.database = null;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'idle';

    renderThreadsPanel();

    expect(screen.getByTestId('threads-loading-card')).toBeVisible();
    expect(screen.getByText('Loading threads...')).toBeVisible();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant memory database unavailable')).not.toBeInTheDocument();
  });

  it('keeps loading while lazy database initialization has not completed', () => {
    vi.useFakeTimers();
    try {
      dbMocks.database = null;
      dbMocks.initializing = false;
      dbMocks.initializationStatus = 'idle';

      renderThreadsPanel();

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.getByTestId('threads-loading-card')).toBeVisible();
      expect(screen.getByText('Loading threads...')).toBeVisible();
      expect(screen.queryByText('Assistant memory database unavailable')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows unavailable when the database stays missing after startup settles', async () => {
    dbMocks.database = null;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'ready';

    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getByText('Assistant memory database unavailable')).toBeVisible();
    });
    expect(screen.queryByText('Loading threads...')).not.toBeInTheDocument();
  });

  it('shows the database provider error after initialization fails', () => {
    dbMocks.database = null;
    dbMocks.providerError = new Error('PGlite startup failed.');

    renderThreadsPanel();

    expect(screen.getByTestId('threads-error-card')).toBeVisible();
    expect(screen.getByText('Assistant memory database failed')).toBeVisible();
    expect(screen.getByText('PGlite startup failed.')).toBeVisible();
    expect(screen.queryByText('Assistant memory database unavailable')).not.toBeInTheDocument();
  });

  it('lists workspace-scoped historical Mastra threads from PGlite', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('FROM mastra_threads'), [
      WORKSPACE_MEMORY_RESOURCE_ID,
    ]);
    expect(screen.getByText('First thread')).toBeVisible();
    expect(screen.getByText('Second thread')).toBeVisible();
    expect(screen.getByText('OpenAI')).toBeVisible();
    expect(screen.getByText('Unavailable · gpt-5.2-chat-latest')).toBeVisible();
    expect(screen.getByText('openai/gpt-5.6-terra')).toBeVisible();
    expect(screen.getByText('Reasoning: high')).toBeVisible();
    expect(screen.getByText('Reasoning: low')).toBeVisible();
    expect(screen.getByText('Max output: 512')).toBeVisible();
    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-b');
  });

  it('renders curated thread identity without using the uuid as the primary row label', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const secondThread = screen.getAllByTestId('thread-row')[0];
    if (!secondThread) {
      throw new Error('Expected second thread row to render.');
    }

    expect(within(secondThread).getByTestId('thread-icon-message')).toBeVisible();
    expect(within(secondThread).getByTestId('thread-color-blue')).toBeVisible();
    expect(within(secondThread).getByText('Second thread')).toBeVisible();
    expect(within(secondThread).getByText('OpenAI')).toBeVisible();
    expect(within(secondThread).getByText('Unavailable · gpt-5.2-chat-latest')).toBeVisible();
    expect(within(secondThread).queryByText('thread-b')).not.toBeInTheDocument();
  });

  it('uses the right-clicked row for copy and Open without selecting on menu open', async () => {
    const { writtenTexts } = renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const firstThreadTitle = screen.getByText('First thread');

    fireEvent.contextMenu(firstThreadTitle);
    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-b');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Thread Title' }));
    await waitFor(() => {
      expect(writtenTexts).toEqual(['First thread']);
    });

    fireEvent.contextMenu(firstThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Thread ID' }));
    await waitFor(() => {
      expect(writtenTexts).toEqual(['First thread', 'thread-a']);
    });

    fireEvent.contextMenu(firstThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open' }));
    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');
  });

  it('enters the existing rename flow and preserves the input native context menu', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select 2 visible threads' }));
    fireEvent.contextMenu(screen.getByText('Second thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));

    const titleInput = screen.getByRole('textbox', { name: 'Thread title' });
    expect(titleInput).toHaveValue('Second thread');
    expect(mockDb.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );

    fireEvent.contextMenu(titleInput);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    const selectionSummaryBeforeEscape = screen.getByRole('toolbar', {
      name: 'Thread selection actions',
    }).textContent;
    fireEvent.change(titleInput, { target: { value: 'Discard this draft' } });
    fireEvent.keyDown(titleInput, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Thread title' })).not.toBeInTheDocument();
    expect(screen.getByText('Second thread')).toBeVisible();
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' }).textContent).toBe(
      selectionSummaryBeforeEscape
    );
  });

  it('reuses customization, details, and delete-confirmation row flows', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const secondThreadTitle = screen.getByText('Second thread');

    fireEvent.contextMenu(secondThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Customize…' }));
    expect(screen.getByRole('button', { name: 'Use Bug icon' })).toBeVisible();
    expect(mockDb.query).not.toHaveBeenCalledWith(
      expect.stringContaining('SET metadata'),
      expect.anything()
    );

    fireEvent.contextMenu(secondThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show Details' }));
    expect(screen.getByTestId('thread-expanded-details')).toBeVisible();

    fireEvent.contextMenu(secondThreadTitle);
    expect(await screen.findByRole('menuitem', { name: 'Hide Details' })).toBeVisible();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.contextMenu(secondThreadTitle);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    expect(
      screen.getByRole('button', { name: 'Confirm delete thread Second thread' })
    ).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(mockDb.query).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM mastra_threads'),
      expect.anything()
    );
  });

  it('customizes thread identity in the stable row-actions popover', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(
      screen.queryByRole('button', { name: 'Customize thread Second thread' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('button', { name: 'Customize' }));
    const customizer = screen.getByRole('dialog');
    await user.click(within(customizer).getByRole('button', { name: 'Use Bug icon' }));
    await user.click(within(customizer).getByRole('button', { name: 'Use Rose color' }));

    await waitFor(() => {
      expect(screen.getByTestId('thread-icon-bug')).toBeVisible();
    });
    expect(screen.getByTestId('thread-color-rose')).toBeVisible();
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SET metadata'), [
      'thread-b',
      expect.stringContaining('"icon":"bug"'),
    ]);
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SET metadata'), [
      'thread-b',
      expect.stringContaining('"color":"rose"'),
    ]);
    const persistedRow = threadRows.find((row) => row['id'] === 'thread-b');
    expect(JSON.parse(String(persistedRow?.['metadata']))).toMatchObject({
      color: 'rose',
      icon: 'bug',
    });
    expect(persistedRow?.['updatedAt']).toEqual(new Date('2026-04-22T11:00:00Z'));
  });

  it('keeps thread detail and action controls out of row selection', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    const checkbox = await screen.findByRole('checkbox', {
      name: 'Select thread Second thread',
    });
    expect(checkbox.parentElement).toHaveAttribute('data-tree-controls-position', 'top');

    await user.click(screen.getByRole('button', { name: 'Show thread details Second thread' }));
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Customize' }));
    await user.click(screen.getByRole('button', { name: 'Use Bug icon' }));
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('opens a thread without implicitly adding it to bulk selection', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    const firstThreadCheckbox = await screen.findByRole('checkbox', {
      name: 'Select thread First thread',
    });
    const firstThreadRow = screen
      .getByText('First thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    if (!firstThreadRow) {
      throw new Error('Expected the first thread row to render.');
    }

    await user.click(within(firstThreadRow).getByRole('button', { name: /^First thread/ }));
    fireEvent.click(firstThreadRow);

    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');
    expect(firstThreadCheckbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('keeps keyboard activation of a thread title out of explicit checkbox selection', async () => {
    renderThreadsPanel();

    const firstThreadCheckbox = await screen.findByRole('checkbox', {
      name: 'Select thread First thread',
    });
    const firstThreadRow = screen
      .getByText('First thread')
      .closest<HTMLElement>('[data-testid="thread-row"]');
    if (!firstThreadRow) {
      throw new Error('Expected the first thread row to render.');
    }

    fireEvent.click(firstThreadRow);
    fireEvent.keyDown(within(firstThreadRow).getByRole('button', { name: /^First thread/ }), {
      key: ' ',
    });

    expect(firstThreadCheckbox).not.toBeChecked();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('uses tinted idle pills, an inset-ring active treatment, and breathing room around each thread', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const [activeThread, idleThread] = screen.getAllByTestId('thread-row');

    // Selected rows read through a stronger fill plus an inset ring — no border,
    // no accent stripe. Idle rows keep a visible tint of their thread color.
    expect(activeThread).toHaveClass(
      'my-0.5',
      THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
      'bg-sky-100',
      'ring-1',
      'ring-inset',
      'ring-sky-500/80',
      'shadow-xs'
    );
    expect(activeThread).not.toHaveClass('border', 'border-sky-500');
    expect(idleThread).toHaveClass(
      'my-0.5',
      THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
      'bg-emerald-100/45'
    );
    expect(idleThread).not.toHaveClass('shadow-xs', 'border');

    // The content stack is shorter than the row's min-height; the row must
    // center it vertically so the icon/title never pin to the top edge.
    for (const thread of [activeThread, idleThread]) {
      expect(thread).toHaveClass('flex', 'flex-col', 'justify-center');
    }
  });

  it('shows automatic expanded metadata and keeps diagnostics out of the primary row', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const secondThread = screen.getAllByTestId('thread-row')[0];
    if (!secondThread) {
      throw new Error('Expected second thread row to render.');
    }
    expect(within(secondThread).queryByText('thread-b')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show thread details Second thread' }));

    const details = within(secondThread).getByTestId('thread-expanded-details');
    expect(within(details).getByText('Provider')).toBeVisible();
    expect(within(details).getByText('OpenAI')).toBeVisible();
    expect(within(details).getByText('Model')).toBeVisible();
    expect(within(details).getByText('Unavailable · gpt-5.2-chat-latest')).toBeVisible();
    expect(within(details).getByText('Runtime')).toBeVisible();
    expect(within(details).getByText('hosted')).toBeVisible();
    expect(within(details).getByText('Status')).toBeVisible();
    expect(within(details).getByText('completed')).toBeVisible();
    expect(within(details).getByText('Reasoning')).toBeVisible();
    expect(within(details).getByText('high')).toBeVisible();
    expect(within(details).getByText('Max output')).toBeVisible();
    expect(within(details).getByText('512')).toBeVisible();
    expect(within(details).getByText('Diagnostics')).toBeVisible();
    expect(within(details).getByText('thread-b')).toBeVisible();
    expect(within(details).queryByText('Notes')).not.toBeInTheDocument();
    expect(within(details).queryByText('Description')).not.toBeInTheDocument();
  });

  it('persists newly created threads through Mastra storage instead of replacing the list', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-00000000000c');
    const threadId = 'thread-00000000-0000-4000-8000-00000000000c';
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'New thread' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(3);
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mastra_threads'),
      expect.arrayContaining([threadId, WORKSPACE_MEMORY_RESOURCE_ID, 'New Thread'])
    );
    expect(screen.queryByText(threadId)).not.toBeInTheDocument();
    expect(
      useAssistantThreadStore.getState().threadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual([threadId, 'thread-b', 'thread-a']);
    uuidSpy.mockRestore();
  });

  it('renames a thread through Mastra thread storage', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Thread title' });
    await user.clear(input);
    await user.type(input, 'Deployment plan');
    await user.click(screen.getByRole('button', { name: 'Save thread title' }));

    await waitFor(() => {
      expect(screen.getByText('Deployment plan')).toBeVisible();
    });
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE mastra_threads'), [
      'thread-b',
      'Deployment plan',
      'titleSource',
      expect.any(Date),
    ]);
  });

  it('keeps rename validation local to the row', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Thread title' });
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Save thread title' }));

    expect(await screen.findByText('Thread title is required.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Thread title' })).toBeVisible();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
  });

  it('deletes a thread only after explicit confirmation', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(
      screen.getByRole('button', { name: 'Confirm delete thread Second thread' })
    ).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Confirm delete thread Second thread' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM mastra_threads'),
      ['thread-b']
    );
    expect(screen.queryByText('Second thread')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
    expect(
      useAssistantThreadStore.getState().threadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual(['thread-a']);
  });

  it('keeps delete errors local to the row without collapsing the thread list', async () => {
    const user = userEvent.setup();
    dbMocks.deleteFailureThreadId = 'thread-b';
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete thread Second thread' }));

    expect(await screen.findByText('Delete failed in PGlite.')).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
  });
});

describe('ThreadsPanel groups', () => {
  function seedGroup(id: string, name: string, rank: string): void {
    groupRows.push({
      color: null,
      icon: null,
      id,
      name,
      rank,
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    });
  }

  function seedPlacement(threadId: string, groupId: string | null, rank: string): void {
    placementRows.push({
      flatRank: null,
      groupId,
      rank,
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      threadId,
    });
  }

  it('estimates group headers at their own height, not the thread pitch', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();
    await screen.findByTestId('thread-group-section');

    // Group headers paint 40px while thread rows paint 32px. Estimating every
    // node at the thread pitch under-sizes each header by 8px, so first-paint
    // scrollbar length and scrollToIndex drift by an amount that grows with
    // group count — and grouped is the default view.
    expect(virtualizerState.estimatedSizes).toContain(getThreadPanelRowHeightPx('group'));
    expect(virtualizerState.estimatedSizes).toContain(getThreadPanelRowHeightPx('thread'));
    expect(getThreadPanelRowHeightPx('group')).not.toBe(getThreadPanelRowHeightPx('thread'));
  });

  it('renders group sections with the ungrouped section below', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    const section = await screen.findByTestId('thread-group-section');
    expect(within(section).getByText('Research')).toBeVisible();
    expect(within(section).getByText('Research')).toHaveClass('text-[13px]', 'leading-4');
    // Group headers share the thread rows' 8px chip-to-text rhythm so group
    // names start at exactly the same x as thread titles.
    expect(within(section).getByText('Research').parentElement).toHaveClass('gap-2');
    expect(within(section).getByText('Research').parentElement).not.toHaveClass('gap-1');
    const nestedThreadRow = screen.getByText('Second thread').closest('tr');
    expect(nestedThreadRow).toHaveAttribute('data-depth', '1');
    expect(nestedThreadRow?.querySelector<HTMLElement>('td > div > span')).toHaveStyle({
      width: '24px',
    });
    const ungrouped = screen.getByTestId('threads-ungrouped-section');
    expect(ungrouped.closest('tr')).not.toHaveClass('[&_[role=gridcell]>div]:pl-7');
    expect(within(ungrouped).getByTestId('threads-ungrouped-icon')).toHaveClass('size-6');
    expect(within(ungrouped).getByText('Ungrouped')).toBeVisible();
    expect(screen.getByText('First thread').closest('tr')).toHaveAttribute('data-depth', '1');
    const sectionOrder = Array.from(
      document.querySelectorAll(
        '[data-testid="thread-group-section"], [data-testid="threads-ungrouped-section"]'
      )
    ).map((element) => element.getAttribute('data-testid'));
    expect(sectionOrder).toEqual(['thread-group-section', 'threads-ungrouped-section']);
  });

  it('exposes Ungrouped as an expandable parent with symmetric tree navigation', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    const ungroupedRow = (await screen.findByTestId('threads-ungrouped-section')).closest('tr');
    const ungroupedThreadRow = screen.getByText('First thread').closest('tr');
    const treegrid = screen.getByRole('treegrid', { name: 'Workspace threads' });
    expect(ungroupedRow).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(ungroupedRow as HTMLElement);
    fireEvent.keyDown(treegrid, { key: 'ArrowRight' });
    expect(ungroupedThreadRow).toHaveAttribute('data-focused', 'true');

    fireEvent.keyDown(treegrid, { key: 'ArrowLeft' });
    expect(ungroupedRow).toHaveAttribute('data-focused', 'true');
    fireEvent.keyDown(treegrid, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(ungroupedRow).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('First thread')).not.toBeInTheDocument();
    });
    fireEvent.keyDown(treegrid, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(ungroupedRow).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('First thread')).toBeVisible();
    });
  });

  it('uses a tri-state group checkbox to select undisclosed members', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');
    for (let index = 0; index < 51; index += 1) {
      const threadId = `thread-grouped-${index}`;
      threadRows.push({
        createdAt: new Date('2026-04-20T09:00:00Z'),
        id: threadId,
        metadata: null,
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        title: `Grouped thread ${index}`,
        updatedAt: new Date('2026-04-20T09:00:00Z'),
      });
      seedPlacement(threadId, 'group-research', `b${String(index).padStart(2, '0')}`);
    }

    renderThreadsPanel();

    const groupCheckbox = await screen.findByRole('checkbox', {
      name: 'Select all 52 threads in Research',
    });
    expect(groupCheckbox.parentElement).toHaveAttribute('data-tree-controls-position', 'top');
    expect(groupCheckbox).toHaveAttribute('data-state', 'unchecked');
    fireEvent.click(groupCheckbox);

    expect(groupCheckbox).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('toolbar', { name: 'Thread selection actions' })).toHaveTextContent(
      '52 selected'
    );
  });

  it('assigns group icon and color through the durable store and wraps the entire grouped surface', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-a', 'group-research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a1');

    renderThreadsPanel();

    expect(
      screen.queryByRole('button', { name: 'Customize group Research' })
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Group actions Research' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Customize' }));
    const groupCustomizer = screen.getByRole('dialog');
    const groupIconGrid = within(groupCustomizer).getByTestId('thread-group-icon-grid');
    expect(groupIconGrid).toHaveClass('grid-cols-6');
    fireEvent.click(
      within(groupCustomizer).getByRole('button', { name: 'Use Research icon for Research' })
    );
    await waitFor(() => {
      expect(screen.getByTestId('thread-group-icon-research')).toBeVisible();
    });
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SET icon'), [
      'group-research',
      'research',
    ]);
    const folderColorGrid = within(groupCustomizer).getByTestId('thread-group-color-grid');
    expect(within(folderColorGrid).getByText('Voltage')).toBeVisible();
    expect(within(folderColorGrid).getByText('Afterglow')).toBeVisible();
    expect(within(folderColorGrid).getAllByRole('button')).toHaveLength(19);
    fireEvent.click(await screen.findByRole('button', { name: 'Use Rose color for Research' }));

    await waitFor(() => {
      expect(screen.getByTestId('thread-group-color-rose')).toBeVisible();
    });
    const groupHeaderRow = screen.getByText('Research').closest('tr');
    const firstGroupedThreadRow = screen.getByText('First thread').closest('tr');
    const groupSurfaceRows = Array.from(document.querySelectorAll('tr.thread-group-surface'));
    const lastGroupSurfaceRow = groupSurfaceRows.at(-1);
    expect(groupSurfaceRows).toHaveLength(3);
    expect(screen.getByRole('treegrid', { name: 'Workspace threads' })).toHaveClass(
      'border-separate',
      'border-spacing-0'
    );
    expect(screen.getByTestId('thread-group-color-rose')).toHaveClass(
      'border-rose-300',
      'bg-rose-50'
    );
    // Group surfaces are soft tinted fills only — the hairline outline borders
    // are gone so grouped threads read as one calm slab.
    expect(groupHeaderRow).toHaveClass(
      'thread-group-surface',
      '[&>td]:bg-rose-50/60',
      '[&>td]:rounded-t-lg'
    );
    expect(groupHeaderRow).not.toHaveClass('[&>td]:border-rose-200/60', '[&>td]:border-t');
    expect(firstGroupedThreadRow).toHaveClass('thread-group-surface', '[&>td]:bg-rose-50/60');
    expect(firstGroupedThreadRow).not.toHaveClass(
      '[&>td]:rounded-t-lg',
      '[&>td]:rounded-b-lg',
      '[&>td]:border-x',
      '[&>td]:border-rose-200/60'
    );
    expect(lastGroupSurfaceRow).toHaveClass(
      'thread-group-surface',
      '[&>td]:bg-rose-50/60',
      '[&>td]:rounded-b-lg'
    );
    expect(lastGroupSurfaceRow).not.toHaveClass('[&>td]:border-rose-200/60', '[&>td]:border-b');
    const groupContentLane = within(groupHeaderRow as HTMLElement).getByTestId(
      'thread-panel-content-lane'
    );
    const threadContentLane = within(firstGroupedThreadRow as HTMLElement).getByTestId(
      'thread-panel-content-lane'
    );
    expect(groupContentLane).toHaveClass('mx-1');
    expect(threadContentLane).toHaveClass('mx-1');
    expect(groupContentLane).not.toHaveClass('before:-left-1', 'before:bg-rose-500');
    expect(threadContentLane).not.toHaveClass('before:-left-1', 'before:bg-rose-500');
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SET color'), [
      'group-research',
      'rose',
    ]);

    fireEvent.click(
      within(groupHeaderRow as HTMLElement).getByRole('button', { name: 'Collapse' })
    );
    await waitFor(() => {
      expect(screen.queryByText('First thread')).not.toBeInTheDocument();
      expect(screen.queryByText('Second thread')).not.toBeInTheDocument();
      expect(screen.getByText('Research').closest('tr')).toHaveClass(
        'thread-group-surface',
        '[&>td]:rounded-lg'
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Clear color for Research' }));
    await waitFor(() => {
      expect(screen.getByTestId('thread-group-color-unassigned')).toBeVisible();
    });
  });

  it('moves selected grouped threads to Ungrouped without discarding flat rank', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-a', 'group-research', 'a0');
    placementRows[0] = { ...placementRows[0], flatRank: 'flat-a' };

    renderThreadsPanel();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select thread First thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ungrouped' }));

    await waitFor(() => {
      expect(useAssistantThreadGroupsStore.getState().placementsByThreadId['thread-a']).toEqual(
        expect.objectContaining({ flatRank: 'flat-a', groupId: null })
      );
    });
  });

  it('makes the expanded group body a drop target so the empty hint works', async () => {
    seedGroup('group-research', 'Research', 'a0');

    renderThreadsPanel();

    const section = await screen.findByTestId('thread-group-section');
    const hint = screen.getByText('Drop threads here');
    const bodyDropTarget = hint.closest('[data-drop-target-for-element="true"]');
    expect(bodyDropTarget).not.toBeNull();
    // The body target must be distinct from the header target so a drop on the
    // hint area files the thread even without touching the header.
    const header = within(section).getByTestId('thread-group-header');
    expect(bodyDropTarget?.contains(header)).toBe(false);
    const headerLane = header.closest<HTMLElement>('[data-testid="thread-panel-content-lane"]');
    const hintLane = hint.closest<HTMLElement>('[data-testid="thread-panel-content-lane"]');
    expect(headerLane).toHaveClass('mx-1');
    expect(hintLane).toHaveClass('mx-1');
    expect(hint.closest('[data-testid="thread-panel-drop-zone"]')).not.toBeNull();
  });

  it('collapses and expands a group', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    const section = await screen.findByTestId('thread-group-section');
    const groupRow = section.closest('tr');
    const treegrid = screen.getByRole('treegrid', { name: 'Workspace threads' });
    expect(groupRow).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Second thread')).toBeVisible();

    fireEvent.click(groupRow as HTMLElement);
    fireEvent.keyDown(treegrid, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(groupRow).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Second thread')).not.toBeInTheDocument();
    });

    fireEvent.keyDown(treegrid, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(groupRow).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Second thread')).toBeVisible();
    });
  });

  it('creates a group from the header button and names it inline', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));

    const nameInput = await screen.findByRole('textbox', { name: 'Group name' });
    expect(nameInput).toHaveValue('New group');
    const newGroupHeader = nameInput.closest<HTMLElement>('[data-testid="thread-group-header"]');
    const newGroupLane = nameInput.closest<HTMLElement>(
      '[data-testid="thread-panel-content-lane"]'
    );
    expect(newGroupHeader).toHaveClass('min-w-0');
    expect(newGroupLane).toHaveClass('mx-1');
    expect(nameInput).toHaveClass('text-[13px]', 'leading-4');
    fireEvent.change(nameInput, { target: { value: 'Planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save group name' }));

    await waitFor(() => {
      expect(screen.getByText('Planning')).toBeVisible();
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_thread_groups'),
      expect.anything()
    );
  });

  it('renames a group inline', async () => {
    seedGroup('group-research', 'Research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.click(screen.getByRole('button', { name: 'Group actions Research' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const nameInput = screen.getByRole('textbox', { name: 'Group name' });
    fireEvent.change(nameInput, { target: { value: 'Deep Work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save group name' }));

    await waitFor(() => {
      expect(screen.getByText('Deep Work')).toBeVisible();
    });
    expect(screen.queryByText('Research')).not.toBeInTheDocument();
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE brainstrike_assistant_thread_groups'),
      ['group-research', 'Deep Work']
    );
  });

  it('deletes a group and returns its threads to the flat list', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.click(screen.getByRole('button', { name: 'Group actions Research' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));

    expect(screen.getByText('Delete folder Research?')).toBeVisible();
    expect(screen.getByTestId('thread-group-section')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete group Research' }));

    await waitFor(() => {
      expect(screen.queryByTestId('thread-group-section')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    const deleteCalls = mockDb.query.mock.calls.filter(([sql]) =>
      String(sql).includes('WITH ungrouped_placements AS')
    );
    expect(deleteCalls).toHaveLength(1);
    expect(String(deleteCalls[0]?.[0])).toContain('SET group_id = NULL');
    expect(String(deleteCalls[0]?.[0])).not.toContain(
      'DELETE FROM brainstrike_assistant_thread_placements'
    );
    expect(String(deleteCalls[0]?.[0])).toContain(
      'DELETE FROM brainstrike_assistant_thread_groups'
    );
    expect(deleteCalls[0]?.[1]).toEqual(['group-research']);
  });

  it('moves a thread into a group from the context menu', async () => {
    seedGroup('group-research', 'Research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.contextMenu(screen.getByText('First thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Research' }));

    await waitFor(() => {
      expect(screen.getByText('First thread').closest('tr')).toHaveAttribute('data-depth', '1');
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO brainstrike_assistant_thread_placements'),
      expect.arrayContaining(['thread-a', WORKSPACE_MEMORY_RESOURCE_ID, 'group-research'])
    );
  });

  it('removes a thread from its group from the context menu', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.contextMenu(screen.getByText('Second thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from Group' }));

    await waitFor(() => {
      expect(screen.getByText('Second thread').closest('tr')).toHaveAttribute('data-depth', '1');
    });
  });

  it('changes sorting from the view options popover', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const initialTitles = screen
      .getAllByTestId('thread-row')
      .map((row) => within(row).getByText(/thread/i).textContent);
    expect(initialTitles).toEqual(['Second thread', 'First thread']);

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Name' }));

    await waitFor(() => {
      const titles = screen
        .getAllByTestId('thread-row')
        .map((row) => within(row).getByText(/thread/i).textContent);
      expect(titles).toEqual(['First thread', 'Second thread']);
    });
    expect(useAssistantThreadGroupsStore.getState().groupedSortBy).toBe('name');
  });

  it('hides group sections when grouping is set to none', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'No grouping' }));

    await waitFor(() => {
      expect(screen.queryByTestId('thread-group-section')).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(useAssistantThreadGroupsStore.getState().groupBy).toBe('none');
  });
});

describe('ThreadsPanel folders', () => {
  const WORKSPACE_ROOT = {
    displayName: 'workspace-a',
    id: 'root-1',
    path: '/tmp/workspace-a',
  };

  function bindThreadToRoot(threadId: string, root = WORKSPACE_ROOT): void {
    const row = threadRows.find((candidate) => candidate['id'] === threadId);
    if (!row) {
      throw new Error(`Cannot bind unknown thread ${threadId}.`);
    }
    row['metadata'] = JSON.stringify({
      ...parseMetadataObject(row['metadata']),
      operatingRootDisplayName: root.displayName,
      operatingRootId: root.id,
      operatingRootPath: root.path,
    });
    if (!rootRows.some((candidate) => candidate['id'] === root.id)) {
      rootRows.push({ displayName: root.displayName, id: root.id, path: root.path });
    }
  }

  function rowFor(title: string): HTMLElement {
    const row = screen.getByText(title).closest<HTMLElement>('[data-testid="thread-row"]');
    if (!row) {
      throw new Error(`Expected a rendered row for ${title}.`);
    }
    return row;
  }

  async function enterFolderGrouping(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Folder' }));
    await screen.findAllByTestId('thread-folder-count');
  }

  it('groups threads by their bound workspace folder with a trailing No folder section', async () => {
    bindThreadToRoot('thread-a');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    const sections = screen.getAllByTestId('thread-group-section');
    expect(sections).toHaveLength(2);
    const folderSection = sections[0] as HTMLElement;
    const unassignedSection = sections[1] as HTMLElement;
    expect(within(folderSection).getByText('workspace-a')).toBeVisible();
    expect(within(folderSection).getByTestId('thread-folder-count')).toHaveTextContent('1');
    expect(within(unassignedSection).getByText('No folder')).toBeVisible();
    expect(screen.getByText('First thread').closest('tr')).toHaveAttribute('data-depth', '1');
    expect(useAssistantThreadGroupsStore.getState().groupBy).toBe('folder');
    // A folder is not a custom group, and "No folder" is not a folder: there is
    // nothing for a new thread there to be bound to.
    expect(
      within(unassignedSection).queryByTestId('thread-folder-new-thread')
    ).not.toBeInTheDocument();
    expect(within(folderSection).getByTestId('thread-folder-new-thread')).toBeVisible();
  });

  // `collapsedGroupIds` is persisted, and folder sections mint their own keys.
  // Group keys are pruned when their group is deleted; nothing pruned a folder
  // key when the root behind it went away.
  it('prunes collapse keys for roots that no longer have a folder section', async () => {
    bindThreadToRoot('thread-a');
    act(() => {
      useAssistantThreadGroupsStore.setState({
        collapsedGroupIds: {
          'folder-unassigned': true,
          'folder:root-1': true,
          'folder:root-deleted': true,
          'group-research': true,
        },
      });
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    await waitFor(() => {
      expect(
        useAssistantThreadGroupsStore.getState().collapsedGroupIds['folder:root-deleted']
      ).toBeUndefined();
    });
    const collapsed = useAssistantThreadGroupsStore.getState().collapsedGroupIds;
    expect(collapsed['folder:root-1']).toBe(true);
    expect(collapsed['folder-unassigned']).toBe(true);
    expect(collapsed['group-research']).toBe(true);
  });

  it('renders a groupBy already rehydrated as folder instead of throwing on first paint', async () => {
    bindThreadToRoot('thread-a');
    // Persistence has accepted 'folder' since BST-1403, so the render path must
    // honor it on MOUNT, not only when the popover switches into it.
    act(() => {
      useAssistantThreadGroupsStore.setState({ groupBy: 'folder' });
    });

    expect(() => renderThreadsPanel()).not.toThrow();

    expect((await screen.findAllByTestId('thread-folder-count')).length).toBeGreaterThan(0);
  });

  it('offers folder sort without Custom and drives folderSortBy', async () => {
    bindThreadToRoot('thread-a');
    bindThreadToRoot('thread-b');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect(await screen.findByRole('radio', { name: 'Custom' })).toBeVisible();
    fireEvent.click(screen.getByRole('radio', { name: 'Folder' }));

    // Folder sections have no manual order, so Custom is not on offer there.
    expect(screen.queryByRole('radio', { name: 'Custom' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Name' }));
    expect(useAssistantThreadGroupsStore.getState().folderSortBy).toBe('name');
    // The manual-order presentations keep their own preference untouched.
    expect(useAssistantThreadGroupsStore.getState().groupedSortBy).toBe('recency');
    await waitFor(() => {
      const titles = screen
        .getAllByTestId('thread-row')
        .map((row) => within(row).getByText(/thread/i).textContent);
      expect(titles).toEqual(['First thread', 'Second thread']);
    });
  });

  it('narrows the list to running threads through the Show only filters', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-b' }];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    // The three boxes are ONE labelled group, not loose checkboxes that happen
    // to sit under a heading: a screen reader announces "Show only" when focus
    // enters, which is the only thing that says these narrow the list. "Has PR"
    // is not among them outside folder grouping — see the dedicated test below.
    const showOnly = await screen.findByRole('group', { name: 'Show only' });
    expect(within(showOnly).getAllByRole('checkbox')).toHaveLength(3);
    fireEvent.click(within(showOnly).getByRole('checkbox', { name: 'Running' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    });
    expect(screen.getByText('Second thread')).toBeVisible();
    expect(screen.queryByText('First thread')).not.toBeInTheDocument();
    expect(useAssistantThreadGroupsStore.getState().threadFilters.running).toBe(true);
    // The trigger's dot reports a narrowed list, not only a non-default sort.
    expect(screen.getByTestId('threads-view-options-dot')).toBeInTheDocument();

    // Two filters read as OR, not AND: ticking Unseen widens the list again.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unseen' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
  });

  it('names the filters when they hide every thread instead of showing an empty tree', async () => {
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Needs you' }));

    expect(await screen.findByTestId('threads-filtered-empty-card')).toBeVisible();
    expect(screen.queryByTestId('thread-row')).not.toBeInTheDocument();
  });

  it('shows a needs-you glyph that outranks the running spinner', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-b' }];
    dbMocks.awaitingApprovalRows = [{ threadId: 'thread-b' }];
    renderThreadsPanel();

    const needsYou = await screen.findByTestId('thread-needs-you-glyph');
    expect(needsYou).toHaveAccessibleName('Second thread needs your approval');
    expect(within(rowFor('Second thread')).queryByTestId('thread-active-spinner')).toBeNull();
  });

  it('surfaces an approval projection failure instead of showing every thread unblocked', async () => {
    // Rows AND an error: without the rows the glyph could never have rendered
    // and the absence assertion below would pass for the wrong reason. With
    // them, it says what it means — a FAILED projection reports no thread ids,
    // so the panel names the failure instead of glyphing one row.
    dbMocks.awaitingApprovalRows = [{ threadId: 'thread-b' }];
    dbMocks.awaitingApprovalError = new Error('approval live query failed');
    renderThreadsPanel();

    expect(await screen.findByTestId('thread-approvals-error')).toHaveTextContent(
      'Approval status unavailable: approval live query failed'
    );
    expect(screen.queryByTestId('thread-needs-you-glyph')).not.toBeInTheDocument();
  });

  // The fresh-install / post-upgrade storm: with no watermark for any thread,
  // an unfloored derivation dots EVERY thread that ever finished a run.
  it('paints no unseen dot for runs that completed before the store existed', async () => {
    useAssistantThreadStore.setState({
      unseenBaselineAt: new Date('2026-04-22T12:00:00Z').getTime(),
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    expect(screen.queryAllByTestId('thread-unseen-glyph')).toHaveLength(0);
    expect(screen.queryAllByTestId('thread-failed-glyph')).toHaveLength(0);
  });

  it('marks a completed thread unseen until it is opened', async () => {
    renderThreadsPanel();

    // The panel opens on the newest thread, and a thread you are looking at is
    // never unseen — so exactly the other one carries the glyph.
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-unseen-glyph')).toHaveLength(1);
    });
    expect(within(rowFor('Second thread')).queryByTestId('thread-unseen-glyph')).toBeNull();
    const firstRow = rowFor('First thread');
    expect(within(firstRow).getByTestId('thread-unseen-glyph')).toHaveAccessibleName(
      'First thread has unseen activity'
    );

    fireEvent.click(within(firstRow).getByText('First thread'));

    await waitFor(() => {
      expect(within(rowFor('First thread')).queryByTestId('thread-unseen-glyph')).toBeNull();
    });
    expect(
      useAssistantThreadStore.getState().lastViewedAtByThreadId['thread-a']
    ).toBeGreaterThanOrEqual(new Date('2026-04-22T09:00:10Z').getTime());
  });

  it('chips the folder branch on the bound row only, and only in folder grouping', async () => {
    bindThreadToRoot('thread-a');
    gitMocks.worktrees = [
      {
        branch: 'main',
        containment: ['root-1'],
        detached: false,
        path: '/tmp/workspace-a/',
      },
    ];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    // Grouped mode never pays for the repo/worktree scan, so it shows no chip.
    expect(screen.queryByText('main')).not.toBeInTheDocument();
    expect(gitMocks.deferredLoads.at(-1)).toBe(true);

    await enterFolderGrouping();

    expect(gitMocks.deferredLoads.at(-1)).toBe(false);
    const badges = within(rowFor('First thread')).getByTestId('thread-metadata-badges');
    expect(within(badges).getByText('main')).toBeVisible();
    // First badge: the one the container query keeps at narrow panel widths.
    expect(badges.firstElementChild).toHaveTextContent('main');
    expect(within(rowFor('Second thread')).queryByText('main')).not.toBeInTheDocument();
  });

  it('falls back to the normalized display path only when a thread has no durable root id', () => {
    const legacyThread: AssistantMemoryThread = {
      createdAt: new Date('2026-04-22T09:00:00Z'),
      id: 'legacy-thread',
      metadata: { operatingRootPath: '/tmp/workspace-a/' },
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Legacy thread',
      updatedAt: new Date('2026-04-22T09:00:00Z'),
    };

    expect(
      lookupThreadBranch(legacyThread, {
        byRootId: new Map(),
        byRootIdAndPath: new Map(),
        byRootPath: new Map([
          [
            '/tmp/workspace-a',
            {
              branch: 'legacy-branch',
              detached: false,
              gitCommonDir: '/tmp/workspace-a/.git',
            },
          ],
        ]),
      })
    ).toEqual({
      branch: 'legacy-branch',
      detached: false,
      gitCommonDir: '/tmp/workspace-a/.git',
    });
  });

  it('does not borrow a same-path replacement root branch when the durable root id differs', async () => {
    bindThreadToRoot('thread-a');
    gitMocks.worktrees = [
      {
        branch: 'replacement-branch',
        containment: ['replacement-root'],
        detached: false,
        path: '/tmp/workspace-a',
      },
    ];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    expect(within(rowFor('First thread')).queryByText('replacement-branch')).toBeNull();
  });

  it('keeps the root checkout branch when a nested worktree shares its durable root id', async () => {
    bindThreadToRoot('thread-a');
    gitMocks.worktrees = [
      {
        branch: 'main',
        containment: ['root-1'],
        detached: false,
        path: '/tmp/workspace-a',
      },
      {
        branch: 'feature/nested',
        containment: ['root-1'],
        detached: false,
        path: '/tmp/workspace-a/.worktrees/feature',
      },
    ];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    const badges = within(rowFor('First thread')).getByTestId('thread-metadata-badges');
    expect(within(badges).getByText('main')).toBeVisible();
    expect(within(badges).queryByText('feature/nested')).toBeNull();
  });

  // The symlink skew live e2e found: `roots.path` keeps the MOUNTED path,
  // git reports the REALPATH, so the exact-path join misses and the chip
  // silently vanished — while the composer's chip, asking git by rootId,
  // still said `main` for the same root.
  it('chips a folder whose mounted path is a symlink of the path git reports', async () => {
    bindThreadToRoot('thread-a');
    gitMocks.worktrees = [
      {
        branch: 'main',
        containment: ['root-1'],
        detached: false,
        path: '/private/tmp/workspace-a',
      },
    ];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    const badges = within(rowFor('First thread')).getByTestId('thread-metadata-badges');
    expect(within(badges).getByText('main')).toBeVisible();
  });

  // Two worktrees inside the folder: the folder has no branch of its own, and
  // picking one of them would be a fabricated chip.
  it('chips nothing when the folder contains more than one worktree', async () => {
    bindThreadToRoot('thread-a');
    gitMocks.worktrees = [
      { branch: 'main', containment: ['root-1'], detached: false, path: '/private/tmp/repo-one' },
      { branch: 'dev', containment: ['root-1'], detached: false, path: '/private/tmp/repo-two' },
    ];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    expect(screen.queryByText('main')).not.toBeInTheDocument();
    expect(screen.queryByText('dev')).not.toBeInTheDocument();
    // The badges slot still holds the provider/model pills, so the claim is
    // that the BRANCH is not among them — the first span is the branch when
    // there is one (that ordering is asserted by the exact-path test above).
    const badges = within(rowFor('First thread')).getByTestId('thread-metadata-badges');
    expect(badges.firstElementChild).toHaveTextContent('OpenRouter');
  });

  // `git worktree list --porcelain` emits `bare` with NEITHER a `branch` line
  // nor a `detached` line, so a bare worktree arrives as {branch: null,
  // detached: false} — the one shape that is neither a name nor a detached
  // HEAD. Rendered, it was a GitBranch icon with no label holding the first
  // badge slot the narrow-panel container query protects.
  it('chips nothing for a bare worktree, which has neither a branch nor a detached HEAD', async () => {
    bindThreadToRoot('thread-a');
    gitMocks.worktrees = [
      { branch: null, containment: ['root-1'], detached: false, path: '/private/tmp/workspace-a' },
    ];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    expect(screen.queryByText('detached')).not.toBeInTheDocument();
    const badges = within(rowFor('First thread')).getByTestId('thread-metadata-badges');
    // No empty first pill: the provider is back in the slot the branch would
    // have taken, so the branch chip was not rendered label-less.
    expect(badges.firstElementChild).toHaveTextContent('OpenRouter');
  });

  // Drag-reorder rewrites the whole listed section's ranks. Under a filter the
  // rendered section is PARTIAL, so the rewrite would renumber the visible
  // threads and interleave them with the hidden ones' untouched ranks. The
  // affordance withdraws rather than lying, exactly as it does in folder mode.
  it('withdraws the row drag affordance while a Show only filter narrows the list', async () => {
    dbMocks.activeRunRows = [{ threadId: 'thread-b' }];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(rowFor('Second thread').closest('[draggable="true"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Running' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    });
    expect(rowFor('Second thread').closest('[draggable="true"]')).toBeNull();
  });

  // The filtered-empty card told the user to "clear the filters in view
  // options" while the popover offered only the three individual boxes.
  it('offers the clear-filters control its filtered-empty card points at', async () => {
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    const showOnly = await screen.findByRole('group', { name: 'Show only' });
    // Nothing to clear yet: a control that cannot do anything is not offered.
    expect(within(showOnly).queryByRole('button', { name: 'Clear filters' })).toBeNull();
    fireEvent.click(within(showOnly).getByRole('checkbox', { name: 'Needs you' }));

    expect(await screen.findByTestId('threads-filtered-empty-card')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(useAssistantThreadGroupsStore.getState().threadFilters.needsYou).toBe(false);
    expect(screen.queryByTestId('threads-view-options-dot')).not.toBeInTheDocument();
  });

  // Every radio input carried NO `name`, so the browser treated all of them as
  // ONE implicit group per document: ArrowDown off the last "Group by" option
  // landed on the first "Sort by" option AND selected it, silently discarding
  // the user's sort. A distinct `name` per radiogroup makes the native
  // grouping match the ARIA grouping. JSDOM cannot dispatch real arrow-key
  // radio navigation (that is the browser's own behaviour, not the DOM's), so
  // this pins the CAUSE — the names — and the live re-check confirms the keys.
  it('gives each radiogroup its own native name so arrows cannot cross into another group', async () => {
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const namesIn = (group: HTMLElement): Set<string> =>
      new Set(
        Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map(
          (input) => input.name
        )
      );

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));

    const groupBy = await screen.findByRole('radiogroup', { name: 'Group by' });
    const sortBy = screen.getByRole('radiogroup', { name: 'Sort by' });
    expect(namesIn(groupBy)).toEqual(new Set(['threads-group-by']));
    expect(namesIn(sortBy)).toEqual(new Set(['threads-sort-by']));

    // Folder mode swaps Sort by's options for the folder-only pair; they are a
    // different setting and must not share the recency/name group either.
    fireEvent.click(screen.getByRole('radio', { name: 'Folder' }));

    await waitFor(() => {
      expect(namesIn(screen.getByRole('radiogroup', { name: 'Sort by' }))).toEqual(
        new Set(['threads-folder-sort'])
      );
    });
    expect(namesIn(screen.getByRole('radiogroup', { name: 'Group by' }))).toEqual(
      new Set(['threads-group-by'])
    );
  });

  it('paints a visible focus ring for every view-options radio and checkbox', async () => {
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));

    const groupBy = await screen.findByRole('radiogroup', { name: 'Group by' });
    const sortBy = screen.getByRole('radiogroup', { name: 'Sort by' });
    const showOnly = screen.getByRole('group', { name: 'Show only' });
    const controls = [
      ...within(groupBy).getAllByRole('radio'),
      ...within(sortBy).getAllByRole('radio'),
      ...within(showOnly).getAllByRole('checkbox'),
    ];
    expect(controls.length).toBeGreaterThan(0);

    // JSDOM does not apply Tailwind, so these class names are the unit-level
    // contract; the live browser check verifies the rendered focus state.
    for (const control of controls) {
      const label = control.closest('label');
      if (!label) {
        throw new Error('View-option controls must be wrapped by labels.');
      }
      expect(label).toHaveClass(
        'has-[:focus-visible]:ring-2',
        'has-[:focus-visible]:ring-ring',
        'has-[:focus-visible]:ring-inset'
      );
    }
  });

  it('creates a thread already bound to the folder it was started from', async () => {
    bindThreadToRoot('thread-a');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await enterFolderGrouping();
    mockDb.query.mockClear();

    fireEvent.click(screen.getByTestId('thread-folder-new-thread'));

    await waitFor(() => {
      const metadataCall = mockDb.query.mock.calls.find(([sql]) => sql.includes('SET metadata'));
      expect(parseMetadataObject(metadataCall?.[1]?.[1])).toMatchObject({
        operatingRootDisplayName: 'workspace-a',
        operatingRootId: 'root-1',
        operatingRootPath: '/tmp/workspace-a',
      });
    });
    expect(
      mockDb.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO mastra_threads'))
    ).toBe(true);
    // ONE metadata write for the whole binding, not one key at a time.
    expect(mockDb.query.mock.calls.filter(([sql]) => sql.includes('SET metadata'))).toHaveLength(1);
  });

  it('toasts when a thread started from a folder cannot be created', async () => {
    bindThreadToRoot('thread-a');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await enterFolderGrouping();
    mockDb.query.mockImplementationOnce(() => Promise.reject(new Error('thread insert failed')));

    fireEvent.click(screen.getByTestId('thread-folder-new-thread'));

    expect(await screen.findByText('New thread in workspace-a failed')).toBeVisible();
  });

  it('preserves a created thread in No folder when its folder binding fails', async () => {
    bindThreadToRoot('thread-a');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await enterFolderGrouping();
    mockDb.query.mockClear();
    dbMocks.metadataFailureThreadId = '*';
    dbMocks.metadataFailureMessage = 'Metadata update failed in PGlite';

    fireEvent.click(screen.getByTestId('thread-folder-new-thread'));

    expect(await screen.findByText('Thread created in No folder')).toBeVisible();
    expect(
      screen.getByText(
        'Could not bind it to workspace-a. Open the thread and select workspace-a to retry. Error: Metadata update failed in PGlite'
      )
    ).toBeVisible();
    await waitFor(() => {
      const unassignedSection = screen
        .getAllByTestId('thread-group-section')
        .find((section) => within(section).queryByText('No folder'));
      expect(unassignedSection).toBeDefined();
      expect(
        within(unassignedSection as HTMLElement).getByTestId('thread-folder-count')
      ).toHaveTextContent('2');
      expect(screen.getAllByTestId('thread-row')).toHaveLength(3);
    });
    expect(
      mockDb.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM mastra_threads'))
    ).toBe(false);
  });

  it('offers neither drag handles nor group membership actions in folder grouping', async () => {
    bindThreadToRoot('thread-a');
    groupRows.push({
      color: null,
      icon: null,
      id: 'group-research',
      name: 'Research',
      rank: 'a0',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    });
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(rowFor('First thread').closest('[draggable="true"]')).not.toBeNull();

    await enterFolderGrouping();

    const folderRow = rowFor('First thread');
    // A folder is not a custom group: re-binding is the composer's folder chip,
    // so the row offers no drag source and no membership actions.
    expect(folderRow.closest('[draggable="true"]')).toBeNull();
    fireEvent.contextMenu(screen.getByText('First thread'));
    expect(await screen.findByRole('menuitem', { name: 'Rename…' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Move to Research' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Remove from Group' })).not.toBeInTheDocument();
  });

  // "Has PR" can only ever match while folder grouping is active AND the
  // branch-lookup bridge is present — offering it elsewhere would be a filter
  // that can only ever answer "nothing".
  it('offers "Has PR" only once folder grouping is active', async () => {
    bindThreadToRoot('thread-a');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    let showOnly = await screen.findByRole('group', { name: 'Show only' });
    expect(within(showOnly).queryByRole('checkbox', { name: 'Has PR' })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('radio', { name: 'Folder' }));
    await screen.findAllByTestId('thread-folder-count');

    showOnly = screen.getByRole('group', { name: 'Show only' });
    expect(within(showOnly).getByRole('checkbox', { name: 'Has PR' })).toBeInTheDocument();
  });

  // Web omits the branch-lookup bridge entirely (the omit-don't-stub
  // constraint) rather than fabricating one, so the option stays hidden even
  // inside folder grouping when that bridge is absent.
  it('omits "Has PR" in folder grouping when the branch-lookup bridge is unavailable', async () => {
    bindThreadToRoot('thread-a');
    gitMocks.available = false;
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();

    const showOnly = screen.getByRole('group', { name: 'Show only' });
    expect(within(showOnly).queryByRole('checkbox', { name: 'Has PR' })).not.toBeInTheDocument();
  });

  // A "Has PR" ticked while folder grouping (and the branch lookup) was
  // available must not strand the list at zero rows once the user leaves that
  // mode — the checkbox that would undo it has just disappeared too.
  it('does not strand the list when leaving folder grouping with "Has PR" still ticked', async () => {
    bindThreadToRoot('thread-a');
    gitMocks.worktrees = [
      { branch: 'main', containment: ['root-1'], detached: false, path: '/tmp/workspace-a/' },
    ];
    dbMocks.forgePrRows = [
      {
        branch: 'main',
        checksJson: [],
        isDraft: false,
        number: 2574,
        repoCommonDir: '/tmp/workspace-a/.git',
        state: 'open',
        url: 'https://github.test/acme/widgets/pull/2574',
      },
    ];
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    await enterFolderGrouping();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show only' })).getByRole('checkbox', {
        name: 'Has PR',
      })
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Custom groups' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
  });

  describe('thread row PR pill — live query route', () => {
    function seedMatchingPrRow(): void {
      gitMocks.worktrees = [
        { branch: 'main', containment: ['root-1'], detached: false, path: '/tmp/workspace-a/' },
      ];
      dbMocks.forgePrRows = [
        {
          branch: 'main',
          checksJson: [{ conclusion: 'success', name: 'unit', url: null }],
          isDraft: false,
          number: 2574,
          repoCommonDir: '/tmp/workspace-a/.git',
          state: 'open',
          url: 'https://github.test/acme/widgets/pull/2574',
        },
      ];
    }

    // Proves the whole chain end-to-end: a row seeded through the live-query
    // route (not the metadata-badge component directly) joins on the
    // `gitCommonDir` the git inventory mock reports for the bound root, and
    // renders a real `thread-pr-pill` inside the actual thread row.
    it('renders a thread-pr-pill inside a real thread row', async () => {
      bindThreadToRoot('thread-a');
      seedMatchingPrRow();
      renderThreadsPanel();
      await waitFor(() => {
        expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
      });

      await enterFolderGrouping();

      const pill = within(rowFor('First thread')).getByTestId('thread-pr-pill');
      expect(pill).toHaveTextContent('#2574');
      expect(within(rowFor('Second thread')).queryByTestId('thread-pr-pill')).toBeNull();
    });

    it('narrows the list to threads with a cached PR through the "Has PR" filter', async () => {
      bindThreadToRoot('thread-a');
      seedMatchingPrRow();
      renderThreadsPanel();
      await waitFor(() => {
        expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
      });

      await enterFolderGrouping();
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Show only' })).getByRole('checkbox', {
          name: 'Has PR',
        })
      );

      await waitFor(() => {
        expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
      });
      expect(screen.getByText('First thread')).toBeVisible();
    });

    // The F1 fix: a malformed cache row fails the whole projection, and the
    // failure must be visible, not indistinguishable from "no PRs cached".
    it('renders the projection-failure banner when the forge PR cache query errors', async () => {
      bindThreadToRoot('thread-a');
      dbMocks.forgePrError = new Error('checks_json is unreadable');
      renderThreadsPanel();
      await waitFor(() => {
        expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
      });

      await enterFolderGrouping();

      expect(await screen.findByTestId('thread-pr-status-error')).toHaveTextContent(
        'Pull request status unavailable: checks_json is unreadable'
      );
    });
  });
});
