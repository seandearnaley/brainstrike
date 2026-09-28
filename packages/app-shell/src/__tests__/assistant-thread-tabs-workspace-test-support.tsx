import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, vi } from 'vitest';
import { assistantThreadActions } from '../assistant-thread-context-actions';
import {
  AssistantThreadTabsWorkspace,
  type AssistantThreadTabsWorkspaceProps,
} from '../assistant-thread-tabs-workspace';

/**
 * Shared harness for the thread-tab workspace suites: a mocked PGlite whose
 * `mastra_threads` rows are `threadRows`, live run-state projections fed from
 * `dbMocks`, and the REAL thread mark counted per thread id in `markRenders`.
 * Import this module FIRST (side-effect import) so its mocks register before
 * the workspace loads.
 */
const harness = vi.hoisted(() => ({
  assistantWrapperProps: [] as Array<{
    memoryResourceId?: string;
    memoryThreadId?: string;
    onRunningChange?: (threadId: string, running: boolean) => void;
    providerKeySources?: unknown;
  }>,
  dbMocks: {
    activeRunError: null as Error | null,
    activeRunRows: [] as Record<string, unknown>[],
    awaitingApprovalError: null as Error | null,
    awaitingApprovalRows: [] as Record<string, unknown>[],
    database: undefined as unknown,
    initializationStatus: 'ready' as 'idle' | 'initializing' | 'ready' | 'error',
    initializing: false,
    providerError: null as Error | null,
  },
  fileExplorerMocks: {
    rootDirectoryHandle: {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    } as { name: string; path: string } | null,
  },
  /** ThreadIdentityMark renders per thread id: which tabs' marks re-rendered. */
  markRenders: new Map<string, number>(),
  mockDb: {
    exec: vi.fn(() => Promise.resolve()),
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(
      () => Promise.resolve({ rows: [] })
    ),
  },
  threadRows: [] as Record<string, unknown>[],
  /** Thread ids whose mocked assistant wrapper throws during render. */
  wrapperCrashThreadIds: new Set<string>(),
  /** `mount:<threadId>` / `unmount:<threadId>`, in order: a panel that keeps its run owns one mount. */
  wrapperLifecycle: [] as string[],
}));

export const {
  assistantWrapperProps,
  dbMocks,
  fileExplorerMocks,
  markRenders,
  mockDb,
  threadRows,
  wrapperCrashThreadIds,
  wrapperLifecycle,
} = harness;

vi.mock('@brainstrike/db', () => ({
  useDbInitializationStatus: () => harness.dbMocks.initializationStatus,
  useDbInitializing: () => harness.dbMocks.initializing,
  useDbProviderError: () => harness.dbMocks.providerError,
  usePGliteDatabase: () =>
    harness.dbMocks.database === undefined ? harness.mockDb : harness.dbMocks.database,
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: (...parts: readonly unknown[]) => JSON.stringify(parts),
  useDbInitializationStatus: () => harness.dbMocks.initializationStatus,
  useDbInitializing: () => harness.dbMocks.initializing,
  useDbProviderError: () => harness.dbMocks.providerError,
  usePGliteDatabase: () =>
    harness.dbMocks.database === undefined ? harness.mockDb : harness.dbMocks.database,
  // Routed BY cacheKey: both run-state projections return `{ threadId }` rows.
  usePGliteLiveQuery: (options: { readonly cacheKey: string; readonly enabled: boolean }) => {
    if (options.cacheKey.startsWith('["threads-awaiting-approval"')) {
      return {
        error: harness.dbMocks.awaitingApprovalError,
        loading: false,
        refresh: vi.fn(),
        rows: options.enabled ? harness.dbMocks.awaitingApprovalRows : [],
      };
    }
    if (options.cacheKey.startsWith('["active-assistant-thread-ids"')) {
      return {
        error: harness.dbMocks.activeRunError,
        loading: false,
        refresh: vi.fn(),
        rows: options.enabled ? harness.dbMocks.activeRunRows : [],
      };
    }
    throw new Error(`Unrouted thread tab live query: ${options.cacheKey}`);
  },
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof harness.fileExplorerMocks) => T): T =>
    selector(harness.fileExplorerMocks),
  useFileSystem: () => ({ rootDirectoryHandle: harness.fileExplorerMocks.rootDirectoryHandle }),
}));

// happy-dom loads no Tailwind: give the strip's scroller the `overflow-x-auto`
// it computes in the app, so drag auto-scroll registers against a scrollable
// element instead of warning on every mount.
const scrollerOverflow = document.createElement('style');
scrollerOverflow.textContent =
  '[data-slot="tab-strip"] [data-group="scroll"] { overflow-x: auto; }';
document.head.append(scrollerOverflow);

vi.mock('../assistant-ui-panel-wrapper', () => ({
  AssistantUiPanelWrapper: (props: {
    memoryResourceId?: string;
    memoryThreadId?: string;
    onRunningChange?: (threadId: string, running: boolean) => void;
    providerKeySources?: unknown;
  }) => {
    harness.assistantWrapperProps.push(props);
    if (props.memoryThreadId && harness.wrapperCrashThreadIds.has(props.memoryThreadId)) {
      throw new Error(`Assistant panel for ${props.memoryThreadId} exploded`);
    }
    // The real wrapper owns the run through `useLocalRuntime`, whose unmount
    // cleanup aborts it; the mock records the mount/unmount that would trigger that.
    const threadId = props.memoryThreadId;
    useEffect(() => {
      harness.wrapperLifecycle.push(`mount:${threadId}`);
      return () => {
        harness.wrapperLifecycle.push(`unmount:${threadId}`);
      };
    }, [threadId]);
    return <div data-testid="assistant-thread-wrapper">{props.memoryThreadId}</div>;
  },
}));

// The REAL mark, counted per thread id: a render here means its tab rendered a
// new mark element.
vi.mock('../thread-identity-mark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../thread-identity-mark')>();
  return {
    ThreadIdentityMark: (props: Parameters<typeof actual.ThreadIdentityMark>[0]) => {
      harness.markRenders.set(props.thread.id, (harness.markRenders.get(props.thread.id) ?? 0) + 1);
      return <actual.ThreadIdentityMark {...props} />;
    },
  };
});

export function renderWorkspace(
  props: AssistantThreadTabsWorkspaceProps = {}
): ReturnType<typeof createTestActionRegistry> {
  const actionRegistry = createTestActionRegistry({ actions: assistantThreadActions });
  render(
    <ActionRegistryProvider registry={actionRegistry.registry}>
      <AssistantThreadTabsWorkspace {...props} />
    </ActionRegistryProvider>
  );
  return actionRegistry;
}

export function openThreadTabs(...threadIds: readonly string[]): void {
  act(() => {
    for (const threadId of threadIds) {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, threadId);
    }
  });
}

/**
 * Drive a panel's own run state the way its mounted runtime reports it
 * (`thread.isRunning` through the wrapper's `onRunningChange` seam). The
 * durable run rows in `dbMocks` are a separate signal.
 */
export function setPanelRunning(threadId: string, running: boolean): void {
  const props = assistantWrapperProps.findLast((entry) => entry.memoryThreadId === threadId);
  act(() => {
    props?.onRunningChange?.(threadId, running);
  });
}

export function openThreadIds(): readonly string[] | undefined {
  return useAssistantThreadStore.getState().openThreadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID];
}

export function activeThreadId(): string | undefined {
  return useAssistantThreadStore.getState().activeThreadIdByResourceId[
    WORKSPACE_MEMORY_RESOURCE_ID
  ];
}

/** The joined list query's latest-run columns for a run that finished at `completedAt`. */
export function latestRunColumns(
  threadId: string,
  status: 'completed' | 'failed',
  completedAt: Date
): Record<string, unknown> {
  return {
    latestRunCompletedAt: completedAt,
    latestRunCreatedAt: new Date('2026-04-22T11:00:00Z'),
    latestRunError: status === 'failed' ? 'Provider timed out' : null,
    latestRunId: `run-${threadId}`,
    latestRunModel: 'gpt-5.2-chat-latest',
    latestRunProvider: 'openai',
    latestRunResourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    latestRunRuntimeKind: 'hosted',
    latestRunStartedAt: new Date('2026-04-22T11:00:00Z'),
    latestRunStatus: status,
    latestRunThreadId: threadId,
    latestRunTurnMessageId: null,
    latestRunUpdatedAt: completedAt,
  };
}

export function addThreadRow(id: string, title: string, extra: Record<string, unknown> = {}): void {
  threadRows.push({
    createdAt: new Date('2026-04-22T09:00:00Z'),
    id,
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title,
    updatedAt: new Date('2026-04-22T09:00:00Z'),
    ...extra,
  });
}

beforeEach(() => {
  fileExplorerMocks.rootDirectoryHandle = {
    name: 'workspace-a',
    path: '/tmp/workspace-a',
  };
  dbMocks.database = undefined;
  dbMocks.initializing = false;
  dbMocks.initializationStatus = 'ready';
  dbMocks.providerError = null;
  dbMocks.activeRunError = null;
  dbMocks.activeRunRows = [];
  dbMocks.awaitingApprovalError = null;
  dbMocks.awaitingApprovalRows = [];
  markRenders.clear();
  wrapperCrashThreadIds.clear();
  wrapperLifecycle.splice(0, wrapperLifecycle.length);
  assistantWrapperProps.splice(0, assistantWrapperProps.length);
  threadRows.splice(
    0,
    threadRows.length,
    {
      createdAt: new Date('2026-04-22T09:00:00Z'),
      id: 'thread-a',
      metadata: { color: 'rose', icon: 'research' },
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Purchasing app search log',
      updatedAt: new Date('2026-04-22T11:00:00Z'),
    },
    {
      createdAt: new Date('2026-04-22T09:00:00Z'),
      id: 'thread-b',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Amazon Bedrock Converse',
      updatedAt: new Date('2026-04-22T10:00:00Z'),
    }
  );
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: {},
    draftRuntimeByThreadId: {},
    lastViewedAtByThreadId: {},
    loadStateByResourceId: {},
    openThreadIdsByResourceId: {},
    selectedThreadByResourceId: {},
    threadIdsByResourceId: {},
    threadsByResourceId: {},
    unseenBaselineAt: 0,
  });
  mockDb.exec.mockClear();
  mockDb.query.mockClear();
  mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO mastra_threads')) {
      threadRows.unshift({
        createdAt: params?.[4],
        id: String(params?.[0]),
        resourceId: String(params?.[1]),
        title: String(params?.[2]),
        updatedAt: params?.[5],
      });
    }
    if (sql.includes('FROM mastra_threads')) {
      return { rows: [...threadRows] };
    }
    return { rows: [] };
  });
});
