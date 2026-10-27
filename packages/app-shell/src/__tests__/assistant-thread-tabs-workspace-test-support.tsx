import {
  type AssistantMemoryThread,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { act } from '@brainstrike/test-utils/react-act';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, vi } from 'vitest';
import { assistantThreadActions } from '../assistant-thread-context-actions';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
  type AssistantThreadHostRun,
  createHostAssistantThreadRepository,
} from '../assistant-thread-host-context';
import {
  AssistantThreadTabsWorkspace,
  type AssistantThreadTabsWorkspaceProps,
} from '../assistant-thread-tabs-workspace';

/**
 * Shared harness for the thread-tab workspace suites: a fake agent host whose
 * conversations are `threadRows`, whose run state is fed from `dbMocks`, and
 * the REAL thread mark counted per thread id in `markRenders`. Import this
 * module FIRST (side-effect import) so its mocks register before the
 * workspace loads.
 */
const harness = vi.hoisted(() => ({
  assistantWrapperProps: [] as Array<{
    isVisible?: boolean;
    memoryThreadId?: string;
    onRunningChange?: (threadId: string, running: boolean) => void;
    providerReadErrors?: unknown;
  }>,
  dbMocks: {
    activeRunRows: [] as Record<string, unknown>[],
    awaitingApprovalRows: [] as Record<string, unknown>[],
  },
  fileExplorerMocks: {
    rootDirectoryHandle: {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    } as { name: string; path: string } | null,
  },
  /** ThreadIdentityMark renders per thread id: which tabs' marks re-rendered. */
  markRenders: new Map<string, number>(),
  threadRows: [] as Record<string, unknown>[],
  /** Thread ids whose fake host panel throws during render. */
  wrapperCrashThreadIds: new Set<string>(),
  /** `mount:<threadId>` / `unmount:<threadId>`, in order: a panel that keeps its run owns one mount. */
  wrapperLifecycle: [] as string[],
}));

export const {
  assistantWrapperProps,
  dbMocks,
  fileExplorerMocks,
  markRenders,
  threadRows,
  wrapperCrashThreadIds,
  wrapperLifecycle,
} = harness;

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

/**
 * What the host's panel renderer mounts for a thread. The real host renders the
 * conversation; here it records its props and lifecycle, and can be made to
 * crash, as the old wrapper stand-in did.
 */
function HostPanel(props: {
  isVisible: boolean;
  onRunningChange: ((threadId: string, running: boolean) => void) | undefined;
  providerReadErrors: unknown;
  threadId: string;
}) {
  harness.assistantWrapperProps.push({
    isVisible: props.isVisible,
    memoryThreadId: props.threadId,
    ...(props.onRunningChange ? { onRunningChange: props.onRunningChange } : {}),
    providerReadErrors: props.providerReadErrors,
  });
  if (harness.wrapperCrashThreadIds.has(props.threadId)) {
    throw new Error(`Assistant panel for ${props.threadId} exploded`);
  }
  // The real panel owns the run through its runtime, whose unmount cleanup
  // aborts it; the stand-in records the mount/unmount that would trigger that.
  const { threadId } = props;
  useEffect(() => {
    harness.wrapperLifecycle.push(`mount:${threadId}`);
    return () => {
      harness.wrapperLifecycle.push(`unmount:${threadId}`);
    };
  }, [threadId]);
  return (
    <div data-is-visible={props.isVisible} data-testid="assistant-thread-wrapper">
      {props.threadId}
    </div>
  );
}

function toThread(row: Record<string, unknown>): AssistantMemoryThread {
  const threadId = String(row['id']);
  const status = row['latestRunStatus'];
  return {
    createdAt: row['createdAt'] as Date,
    id: threadId,
    ...(row['metadata']
      ? { metadata: row['metadata'] as NonNullable<AssistantMemoryThread['metadata']> }
      : {}),
    ...(status
      ? {
          latestRun: {
            completedAt: (row['latestRunCompletedAt'] as Date | null) ?? null,
            createdAt: row['latestRunCreatedAt'] as Date,
            error: (row['latestRunError'] as string | null) ?? null,
            id: String(row['latestRunId']),
            model: String(row['latestRunModel']),
            provider: String(row['latestRunProvider']),
            resourceId: String(row['latestRunResourceId']),
            runtimeKind: row['latestRunRuntimeKind'] as 'hosted',
            startedAt: row['latestRunStartedAt'] as Date,
            status: status as 'completed',
            threadId,
            turnMessageId: null,
            updatedAt: row['latestRunUpdatedAt'] as Date,
          },
        }
      : {}),
    resourceId: String(row['resourceId']),
    title: String(row['title']),
    updatedAt: row['updatedAt'] as Date,
  };
}

/** The host's run state: running and needs-you threads from `dbMocks`, read at each snapshot. */
function createFakeHostRuns(): NonNullable<AssistantThreadHostCapability['runs']> {
  let last = new Map<string, AssistantThreadHostRun>();
  const signature = (runs: ReadonlyMap<string, AssistantThreadHostRun>): string =>
    JSON.stringify([...runs]);
  return {
    getSnapshot: () => {
      const next = new Map<string, AssistantThreadHostRun>();
      for (const row of harness.dbMocks.activeRunRows) {
        next.set(String(row['threadId']), {
          completedAt: null,
          needsInput: false,
          status: 'running',
        });
      }
      for (const row of harness.dbMocks.awaitingApprovalRows) {
        next.set(String(row['threadId']), {
          completedAt: null,
          needsInput: true,
          status: 'running',
        });
      }
      if (signature(next) !== signature(last)) {
        last = next;
      }
      return last;
    },
    subscribe: () => () => undefined,
  };
}

/** The conversation owner for these suites: `threadRows` are its committed conversations. */
function createFakeHost(): AssistantThreadHostCapability {
  return {
    createThread: vi.fn(async (resourceId: string) => {
      const row = {
        createdAt: new Date('2026-04-22T12:00:00Z'),
        id: `thread-new-${harness.threadRows.length}`,
        resourceId,
        title: 'New Thread',
        updatedAt: new Date('2026-04-22T12:00:00Z'),
      };
      harness.threadRows.unshift(row);
      return toThread(row);
    }),
    deleteThread: vi.fn(async (threadId: string) => {
      const index = harness.threadRows.findIndex((row) => row['id'] === threadId);
      if (index >= 0) {
        harness.threadRows.splice(index, 1);
      }
      return [threadId];
    }),
    listThreads: vi.fn(async () => harness.threadRows.map(toThread)),
    ownsThread: vi.fn(async () => true),
    renameThread: vi.fn(async (threadId: string, title: string) => {
      const row = harness.threadRows.find((candidate) => candidate['id'] === threadId);
      if (row) {
        row['title'] = title;
      }
    }),
    renderNewThread: (resourceId) => <div data-testid="new-thread-composer">{resourceId}</div>,
    renderThread: (threadId, isVisible, onRunningChange, providerReadErrors) => (
      <HostPanel
        isVisible={isVisible}
        onRunningChange={onRunningChange}
        providerReadErrors={providerReadErrors}
        threadId={threadId}
      />
    ),
    runs: createFakeHostRuns(),
    updateThreadBinding: vi.fn(async (threadId: string, metadata: Record<string, unknown>) => {
      const row = harness.threadRows.find((candidate) => candidate['id'] === threadId);
      if (row) {
        row['metadata'] = { ...(row['metadata'] as object | undefined), ...metadata };
      }
    }),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
}

let renderedHost: AssistantThreadHostCapability | undefined;

export function renderWorkspace(
  props: AssistantThreadTabsWorkspaceProps = {},
  host: AssistantThreadHostCapability = createFakeHost()
): ReturnType<typeof createTestActionRegistry> & { readonly rerender: () => void } {
  renderedHost = host;
  const actionRegistry = createTestActionRegistry({ actions: assistantThreadActions });
  const element = () => (
    <ActionRegistryProvider registry={actionRegistry.registry}>
      <AssistantThreadHostContext.Provider value={host}>
        <AssistantThreadTabsWorkspace {...props} />
      </AssistantThreadHostContext.Provider>
    </ActionRegistryProvider>
  );
  const view = render(element());
  return { ...actionRegistry, rerender: () => view.rerender(element()) };
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
 * (`thread.isRunning` through the panel's `onRunningChange` seam). The host's
 * run rows in `dbMocks` are a separate signal.
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

/**
 * Points the host's conversation list at a run that finished at `completedAt`,
 * without telling the store yet: the row a thread-list refresh will read next.
 */
export function stageFinishedRun(
  threadId: string,
  completedAt: Date,
  status: 'completed' | 'failed' = 'completed'
): void {
  const row = threadRows.find((candidate) => candidate['id'] === threadId);
  if (!row) {
    throw new Error(`No thread row ${threadId} to finish a run on.`);
  }
  Object.assign(row, latestRunColumns(threadId, status, completedAt));
}

/**
 * The store re-reads the thread list exactly as it does when a run's final turn
 * lands, through the host the workspace is mounted on. Call it inside `act`.
 */
export async function refreshThreadList(): Promise<void> {
  if (!renderedHost) {
    throw new Error('Render the workspace before refreshing its thread list.');
  }
  await useAssistantThreadStore
    .getState()
    .refreshResourceThreads(
      createHostAssistantThreadRepository(renderedHost),
      WORKSPACE_MEMORY_RESOURCE_ID
    );
}

/** A run finished: the list returns it and the store re-reads the list. */
export async function finishRun(
  threadId: string,
  completedAt: Date,
  status: 'completed' | 'failed' = 'completed'
): Promise<void> {
  stageFinishedRun(threadId, completedAt, status);
  await act(refreshThreadList);
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
  renderedHost = undefined;
  fileExplorerMocks.rootDirectoryHandle = {
    name: 'workspace-a',
    path: '/tmp/workspace-a',
  };
  dbMocks.activeRunRows = [];
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
    unavailableSavedThreadByResourceId: {},
    unseenBaselineAt: 0,
  });
});
