// @vitest-environment jsdom
import {
  type AssistantMemoryThread,
  useAssistantThreadGroupsStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { act } from '@brainstrike/test-utils/react-act';
import { ActionRegistryProvider, resetToastStore, Toaster } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, type ReactNode, useState } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { assistantThreadActions } from '../assistant-thread-context-actions';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import {
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  THREAD_CONTROL_ACTION_CLASS_NAME,
  THREAD_CONTROL_MARK_CLASS_NAME,
  THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_ROW_PITCH_PX,
  THREAD_CONTROL_TITLE_CLASS_NAME,
} from '../assistant-thread-presentation';
import { SidebarHeaderContext } from '../sidebar-header';
import { useOnScreenThreadStore } from '../stores/on-screen-thread-store';
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
  fileExplorerMocks,
  fixture,
  gitMocks,
  groupRows,
  hostMocks,
  placementRows,
  rootRows,
  runMocks,
  threadRows,
} = vi.hoisted(() => ({
  fileExplorerMocks: {
    rootDirectoryHandle: {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    } as { name: string; path: string } | null,
  },
  // Failure injection for the fake host.
  fixture: {
    deleteFailureThreadId: null as string | null,
    metadataFailureMessage: 'Metadata update failed.',
    metadataFailureThreadId: null as string | null,
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
  // The default fake host's operations; their implementations are installed per test.
  hostMocks: {
    createThread: vi.fn<AssistantThreadHostCapability['createThread']>(),
    deleteThread: vi.fn<AssistantThreadHostCapability['deleteThread']>(),
    listThreads: vi.fn<AssistantThreadHostCapability['listThreads']>(),
    ownsThread: vi.fn<AssistantThreadHostCapability['ownsThread']>(),
    renameThread: vi.fn<AssistantThreadHostCapability['renameThread']>(),
    updateThreadBinding: vi.fn<AssistantThreadHostCapability['updateThreadBinding']>(),
  },
  placementRows: [] as Record<string, unknown>[],
  rootRows: [] as Record<string, unknown>[],
  // The host's committed runs, as its run-state snapshot reports them.
  runMocks: {
    listeners: new Set<() => void>(),
    runs: new Map<
      string,
      {
        completedAt: Date | null;
        needsInput: boolean;
        status: 'running';
      }
    >(),
  },
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

/** The runs the fixture threads last ran, as the host lists them on each thread. */
const LATEST_RUN_ROWS = [
  {
    completedAt: new Date('2026-04-22T11:00:10Z'),
    createdAt: new Date('2026-04-22T11:00:00Z'),
    error: null,
    id: 'run-1',
    model: 'gpt-5.2-chat-latest',
    modelSettings: { maxOutputTokens: 512 },
    provider: 'openai',
    providerOptions: { openai: { reasoningEffort: 'high' } },
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
    provider: 'openrouter',
    providerOptions: { openrouter: { reasoning: { effort: 'low', summary: 'auto' } } },
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    runtimeKind: 'hosted',
    startedAt: new Date('2026-04-22T09:00:00Z'),
    status: 'completed',
    threadId: 'thread-a',
    turnMessageId: null,
    updatedAt: new Date('2026-04-22T09:00:10Z'),
  },
] as const;

/** A fixture row as the host lists it: parsed metadata and the thread's latest run. */
function toThread(row: Record<string, unknown>): AssistantMemoryThread {
  const metadata = parseMetadataObject(row['metadata']);
  const latestRun = LATEST_RUN_ROWS.find((run) => run.threadId === row['id']);
  return {
    createdAt: row['createdAt'] as Date,
    id: String(row['id']),
    ...(latestRun
      ? { latestRun: latestRun as unknown as NonNullable<AssistantMemoryThread['latestRun']> }
      : {}),
    ...(Object.keys(metadata).length > 0
      ? { metadata: metadata as NonNullable<AssistantMemoryThread['metadata']> }
      : {}),
    resourceId: String(row['resourceId']),
    title: String(row['title']),
    updatedAt: row['updatedAt'] as Date,
  };
}

/** Replaces the host's run-state snapshot and notifies its subscribers. */
function setHostRuns(running: readonly string[], needsInput: readonly string[] = []): void {
  runMocks.runs = new Map(
    running.map((threadId) => [
      threadId,
      { completedAt: null, needsInput: needsInput.includes(threadId), status: 'running' as const },
    ])
  );
  for (const listener of runMocks.listeners) {
    listener();
  }
}

/** The groups capability Main exposes, over the fixture's group and placement rows. */
async function handleThreadGroupsRequest(input: {
  readonly operation: string;
  readonly [key: string]: unknown;
}): Promise<{ groups: Record<string, unknown>[]; placements: Record<string, unknown>[] }> {
  const groupById = (groupId: unknown) => groupRows.find((row) => row['id'] === groupId);
  switch (input.operation) {
    case 'create':
      groupRows.push({ ...(input['group'] as Record<string, unknown>) });
      break;
    case 'delete': {
      const index = groupRows.findIndex((row) => row['id'] === input['groupId']);
      if (index >= 0) {
        groupRows.splice(index, 1);
      }
      for (const placement of placementRows) {
        if (placement['groupId'] === input['groupId']) {
          placement['groupId'] = null;
        }
      }
      break;
    }
    case 'rename': {
      const group = groupById(input['groupId']);
      if (group) {
        group['name'] = input['name'];
      }
      break;
    }
    case 'color': {
      const group = groupById(input['groupId']);
      if (group) {
        group['color'] = input['color'] ?? null;
      }
      break;
    }
    case 'icon': {
      const group = groupById(input['groupId']);
      if (group) {
        group['icon'] = input['icon'] ?? null;
      }
      break;
    }
    case 'ranks':
      for (const entry of input['entries'] as readonly { groupId: string; rank: string }[]) {
        const group = groupById(entry.groupId);
        if (group) {
          group['rank'] = entry.rank;
        }
      }
      break;
    case 'placements':
      for (const placement of input['placements'] as readonly Record<string, unknown>[]) {
        const index = placementRows.findIndex((row) => row['threadId'] === placement['threadId']);
        if (index >= 0) {
          placementRows[index] = { ...placement };
        } else {
          placementRows.push({ ...placement });
        }
      }
      break;
    case 'clear': {
      const threadIds = input['threadIds'] as readonly string[];
      for (let index = placementRows.length - 1; index >= 0; index -= 1) {
        if (threadIds.includes(String(placementRows[index]?.['threadId']))) {
          placementRows.splice(index, 1);
        }
      }
      break;
    }
    default:
      break;
  }
  return {
    groups: groupRows.map((row) => ({ ...row })),
    placements: placementRows.map((row) => ({ ...row })),
  };
}

vi.mock('../thread-search-service', () => ({
  // Search returns no matches; the real controller still drives the host search.
  createThreadSearchService: () => ({
    searchThreads: () =>
      Promise.resolve({
        metadata: {
          ftsResultCount: 0,
          titleResultCount: 0,
          totalMs: 0,
        },
        results: [],
      }),
  }),
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

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof fileExplorerMocks) => T): T =>
    selector(fileExplorerMocks),
  useFileSystem: () => ({ rootDirectoryHandle: fileExplorerMocks.rootDirectoryHandle }),
}));

/** The attached agent host: every operation runs over the fixture's in-memory rows. */
function createDefaultHost(): AssistantThreadHostCapability {
  return {
    createThread: hostMocks.createThread,
    deleteThread: hostMocks.deleteThread,
    listThreads: hostMocks.listThreads,
    ownsThread: hostMocks.ownsThread,
    renameThread: hostMocks.renameThread,
    renderThread: () => null,
    runs: {
      getSnapshot: () => runMocks.runs,
      subscribe: (listener) => {
        runMocks.listeners.add(listener);
        return () => {
          runMocks.listeners.delete(listener);
        };
      },
    },
    searchThreads: async () => ({ messages: [], titles: [] }),
    updateThreadBinding: hostMocks.updateThreadBinding,
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
}

/** Stands in for AgentWorkspaceLayout's left header row, where the toolbar renders. */
function SidebarHeader({ children }: { readonly children: ReactNode }): ReactElement {
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div data-testid="sidebar-header" ref={setHeader} />
      <SidebarHeaderContext.Provider value={header}>{children}</SidebarHeaderContext.Provider>
    </>
  );
}

function renderThreadsPanel(
  host: AssistantThreadHostCapability = createDefaultHost()
): ReturnType<typeof createTestActionRegistry> & { rerender(): void } {
  const actionRegistry = createTestActionRegistry({ actions: assistantThreadActions });
  const view = () => (
    <ActionRegistryProvider registry={actionRegistry.registry}>
      <AssistantThreadHostContext.Provider value={host}>
        <SidebarHeader>
          <ThreadsPanel />
        </SidebarHeader>
      </AssistantThreadHostContext.Provider>
      <Toaster />
    </ActionRegistryProvider>
  );
  const rendered = render(view());
  return { ...actionRegistry, rerender: () => rendered.rerender(view()) };
}

// Finish each real Radix popover's deferred autofocus before RTL removes its DOM.
afterEach(async () => {
  const triggers = screen
    .queryAllByRole('button', { expanded: true })
    .filter((trigger) => trigger.getAttribute('aria-haspopup') === 'dialog');
  for (const trigger of triggers) {
    // Toasts can own Escape; click this popover's trigger without moving focus
    // so the observed return focus belongs to Radix's deferred close callback.
    fireEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveFocus());
  }
});

beforeEach(() => {
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: {
      readRoots: async () => ({
        ok: true,
        value: rootRows.map((row) => ({ ...row, status: 'live' })),
      }),
      request: async (input: Parameters<typeof handleThreadGroupsRequest>[0]) => ({
        ok: true,
        value: await handleThreadGroupsRequest(input),
      }),
    },
  });
  virtualizerState.windowSize = Number.POSITIVE_INFINITY;
  // Shared across every render in this file; without a reset it becomes
  // order-dependent state the next test to read it silently inherits.
  virtualizerState.estimatedSizes.length = 0;
  fileExplorerMocks.rootDirectoryHandle = {
    name: 'workspace-a',
    path: '/tmp/workspace-a',
  };
  fixture.deleteFailureThreadId = null;
  fixture.metadataFailureMessage = 'Metadata update failed.';
  fixture.metadataFailureThreadId = null;
  gitMocks.available = true;
  gitMocks.deferredLoads = [];
  gitMocks.worktrees = [];
  rootRows.splice(0, rootRows.length);
  runMocks.listeners.clear();
  runMocks.runs = new Map();
  resetToastStore();
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
  hostMocks.listThreads.mockReset().mockImplementation(async () => threadRows.map(toThread));
  hostMocks.createThread.mockReset().mockImplementation(async (resourceId) => {
    const row = {
      createdAt: new Date(),
      id: `thread-${crypto.randomUUID()}`,
      metadata: null,
      resourceId,
      title: 'New Thread',
      updatedAt: new Date(),
    };
    threadRows.unshift(row);
    return toThread(row);
  });
  hostMocks.deleteThread.mockReset().mockImplementation(async (threadId) => {
    if (fixture.deleteFailureThreadId === threadId) {
      throw new Error('Delete failed.');
    }
    const index = threadRows.findIndex((row) => row['id'] === threadId);
    if (index < 0) {
      return;
    }
    threadRows.splice(index, 1);
    return [threadId];
  });
  hostMocks.ownsThread
    .mockReset()
    .mockImplementation(async (threadId) => threadRows.some((row) => row['id'] === threadId));
  hostMocks.renameThread.mockReset().mockImplementation(async (threadId, title) => {
    // The host never commits a blank title.
    if (!title.trim()) {
      throw new Error('Thread title is required.');
    }
    const row = threadRows.find((item) => item['id'] === threadId);
    if (row) {
      row['title'] = title;
    }
  });
  hostMocks.updateThreadBinding.mockReset().mockImplementation(async (threadId, metadata) => {
    if (fixture.metadataFailureThreadId === threadId || fixture.metadataFailureThreadId === '*') {
      throw new Error(fixture.metadataFailureMessage);
    }
    const row = threadRows.find((item) => item['id'] === threadId);
    if (row) {
      row['metadata'] = JSON.stringify({ ...parseMetadataObject(row['metadata']), ...metadata });
    }
  });
});

describe('ThreadsPanel', () => {
  it('shows independent reduced-motion-safe activity spinners without replacing thread icons', async () => {
    setHostRuns(['thread-a', 'thread-b']);
    const view = renderThreadsPanel();

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

    act(() => setHostRuns([]));
    view.rerender();
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
    setHostRuns(['thread-a']);
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
  });

  it('puts its toolbar in the sidebar header, leaving only the search row above the list', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    const toolbar = screen.getByTestId('threads-panel-toolbar');
    const search = screen.getByTestId('threads-panel-search');
    // The toolbar owns the heading, the live count, and the select-visible
    // control, and it renders in the layout's header row, so the search row is
    // the panel's only chrome above the list.
    expect(toolbar.parentElement).toBe(screen.getByTestId('sidebar-header'));
    expect(within(toolbar).getByRole('heading', { name: 'Threads' })).toBeVisible();
    expect(within(toolbar).getByTestId('threads-visible-count')).toHaveTextContent('2');
    expect(within(toolbar).getByRole('button', { name: 'Select 2 visible threads' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'New thread' })).toBeVisible();
    expect(within(search).getByTestId('thread-search-input')).toBeVisible();
    expect(screen.getByTestId('threads-panel').firstElementChild).toBe(search);
    expect(screen.queryByTestId('threads-panel-select-band')).not.toBeInTheDocument();

    // One row of controls only reads as a row when the controls are the same
    // size; the view-options trigger used to be 32px next to 28px neighbours.
    // Same 28px square for every control, New Thread included — it only grows
    // into a labelled pill at @[360px]/threads-toolbar, where the label appears.
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
      expect(hostMocks.listThreads).toHaveBeenCalledWith(WORKSPACE_MEMORY_RESOURCE_ID);
    });
    expect(useThreadSearchStore.getState().status).toBe('results');
    expect(screen.getByRole('button', { name: 'New thread' })).toBeVisible();
  });

  it('withdraws the count and select-visible toggle while a state card replaces the list', () => {
    // The first catalog read is pending, so the loading card stands in for the list.
    const firstRead = Promise.withResolvers<AssistantMemoryThread[]>();
    hostMocks.listThreads.mockReturnValue(firstRead.promise);
    // The store memoizes the in-flight load across tests; settle it.
    onTestFinished(() => firstRead.resolve([]));

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
    // The host catalog has no atomic bulk metadata update, so applying a color
    // is not exercised here; the color grid itself is.
    fireEvent.keyDown(bulkColorGrid, { key: 'Escape' });
    fixture.deleteFailureThreadId = 'thread-b';
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete 2 selected threads?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByText('Delete failed.')).toBeVisible();
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

  it('lists workspace-scoped threads from the host', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(hostMocks.listThreads).toHaveBeenCalledWith(WORKSPACE_MEMORY_RESOURCE_ID);
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
    expect(hostMocks.renameThread).not.toHaveBeenCalled();

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
    expect(hostMocks.updateThreadBinding).not.toHaveBeenCalled();

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
    expect(hostMocks.deleteThread).not.toHaveBeenCalled();
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
    expect(hostMocks.updateThreadBinding).toHaveBeenCalledWith(
      'thread-b',
      expect.objectContaining({ icon: 'bug' })
    );
    expect(hostMocks.updateThreadBinding).toHaveBeenCalledWith(
      'thread-b',
      expect.objectContaining({ color: 'rose' })
    );
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

  it('opens the new-thread screen without creating a thread', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'New thread' }));

    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBeUndefined();
    expect(hostMocks.createThread).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
  });

  it('renames a thread through the host', async () => {
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
    expect(hostMocks.renameThread).toHaveBeenCalledWith('thread-b', 'Deployment plan');
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
    expect(hostMocks.deleteThread).toHaveBeenCalledWith('thread-b');
    expect(screen.queryByText('Second thread')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
    expect(
      useAssistantThreadStore.getState().threadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual(['thread-a']);
  });

  it('keeps delete errors local to the row without collapsing the thread list', async () => {
    const user = userEvent.setup();
    fixture.deleteFailureThreadId = 'thread-b';
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Thread actions Second thread' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete thread Second thread' }));

    expect(await screen.findByText('Delete failed.')).toBeVisible();
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
      width: '16px',
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
    expect(groupRows[0]).toMatchObject({ icon: 'research', id: 'group-research' });
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
      'bs-agent-solid-mark',
      'bg-rose-500',
      'text-black'
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
    expect(groupRows[0]).toMatchObject({ color: 'rose', id: 'group-research' });

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
    expect(groupRows).toEqual([expect.objectContaining({ name: 'Planning' })]);
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
    expect(groupRows).toEqual([
      expect.objectContaining({ id: 'group-research', name: 'Deep Work' }),
    ]);
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
    expect(groupRows).toEqual([]);
    // The group's members keep their placement rows, ungrouped.
    expect(placementRows).toEqual([
      expect.objectContaining({ groupId: null, threadId: 'thread-b' }),
    ]);
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
    expect(placementRows).toEqual([
      expect.objectContaining({
        groupId: 'group-research',
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        threadId: 'thread-a',
      }),
    ]);
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
    setHostRuns(['thread-b']);
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    // The three boxes are ONE labelled group, not loose checkboxes that happen
    // to sit under a heading: a screen reader announces "Show only" when focus
    // enters, which is the only thing that says these narrow the list.
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
    setHostRuns(['thread-b'], ['thread-b']);
    renderThreadsPanel();

    const needsYou = await screen.findByTestId('thread-needs-you-glyph');
    expect(needsYou).toHaveAccessibleName('Second thread needs your approval');
    expect(within(rowFor('Second thread')).queryByTestId('thread-active-spinner')).toBeNull();
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

  // BST-1845: "seen" is a fact about the SCREEN, and only the surface that
  // renders transcripts can report it (`onScreenThreadId`). A Threads panel
  // mounted without that surface has nothing on screen — so even the row it has
  // selected carries its dot.
  it('marks every finished thread unseen, the selected one included, while nothing is on screen', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-unseen-glyph')).toHaveLength(2);
    });
    expect(within(rowFor('Second thread')).getByTestId('thread-unseen-glyph')).toBeInTheDocument();
    expect(within(rowFor('First thread')).getByTestId('thread-unseen-glyph')).toHaveAccessibleName(
      'First thread has unseen activity'
    );
  });

  it('exempts only the thread the transcript surface reports on screen', async () => {
    act(() => {
      useOnScreenThreadStore.getState().setOnScreenThreadId('thread-b');
    });
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-unseen-glyph')).toHaveLength(1);
    });
    expect(within(rowFor('Second thread')).queryByTestId('thread-unseen-glyph')).toBeNull();
    expect(within(rowFor('First thread')).getByTestId('thread-unseen-glyph')).toBeInTheDocument();

    act(() => {
      useOnScreenThreadStore.getState().setOnScreenThreadId('thread-a');
    });

    await waitFor(() => {
      expect(within(rowFor('First thread')).queryByTestId('thread-unseen-glyph')).toBeNull();
    });
    expect(within(rowFor('Second thread')).getByTestId('thread-unseen-glyph')).toBeInTheDocument();
  });

  // The Threads panel renders no transcript, so selecting a row there shows the
  // user nothing to have "seen". The transcript surface is the only stamper.
  it('never stamps the viewed watermark itself when a row is selected', async () => {
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-unseen-glyph')).toHaveLength(2);
    });

    fireEvent.click(within(rowFor('First thread')).getByText('First thread'));

    await waitFor(() => {
      expect(useAssistantThreadStore.getState().activeThreadIdByResourceId).toMatchObject({
        [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-a',
      });
    });
    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId).toEqual({});
    expect(within(rowFor('First thread')).getByTestId('thread-unseen-glyph')).toBeInTheDocument();
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
    setHostRuns(['thread-b']);
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

  it('starts a new thread bound to the folder it was started from, creating nothing yet', async () => {
    bindThreadToRoot('thread-a');
    renderThreadsPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await enterFolderGrouping();

    fireEvent.click(screen.getByTestId('thread-folder-new-thread'));

    expect(
      useAssistantThreadStore.getState().newThreadFolderByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual({ displayName: 'workspace-a', path: '/tmp/workspace-a', rootId: 'root-1' });
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBeUndefined();
    // The first send creates the thread and commits the binding (new-thread-welcome).
    expect(hostMocks.createThread).not.toHaveBeenCalled();
    expect(hostMocks.updateThreadBinding).not.toHaveBeenCalled();
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
});

describe('thread panel popover fixture lifetime', () => {
  let restoredFocus = false;

  afterAll(() => {
    expect(restoredFocus).toBe(true);
  });

  it('finishes focus restoration when a test leaves View options open', async () => {
    renderThreadsPanel();
    const trigger = screen.getByRole('button', { name: 'View options' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(trigger).not.toHaveFocus();
    trigger.addEventListener(
      'focus',
      () => {
        restoredFocus = true;
      },
      { once: true }
    );
    // The registered fixture teardown must close the real popover.
  });
});

it('loads host conversations, retained folders and custom groups', async () => {
  const thread: AssistantMemoryThread = {
    createdAt: new Date(),
    id: 'host-current',
    metadata: {
      operatingRootDisplayName: 'Retained',
      operatingRootId: 'retained-root',
      operatingRootPath: '/tmp/retained',
    },
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: 'Host current',
    updatedAt: new Date(),
  };
  const childThreads = vi.fn(async () => []);
  const host: AssistantThreadHostCapability = {
    childThreads,
    createThread: vi.fn(async () => thread),
    deleteThread: vi.fn(async () => [thread.id]),
    isHostThread: () => true,
    listThreads: vi.fn(async () => [thread]),
    ownsThread: vi.fn(async () => true),
    renameThread: vi.fn(),
    renderThread: () => null,
    subscribeChildren: () => () => undefined,
    updateThreadBinding: vi.fn(),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
  const request = vi.fn(async () => ({
    groups: [
      {
        color: null,
        icon: null,
        id: 'thread-group-current',
        name: 'My work',
        rank: 'a0',
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      },
    ],
    placements: [
      {
        flatRank: null,
        groupId: 'thread-group-current',
        rank: 'a0',
        resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
        threadId: thread.id,
      },
    ],
  }));
  const readRoots = vi.fn(async () => [
    { displayName: 'Retained', id: 'retained-root', path: '/tmp/retained', status: 'disconnected' },
  ]);
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: {
      readRoots: async () => ({ ok: true, value: await readRoots() }),
      request: async (...args: Parameters<typeof request>) => ({
        ok: true,
        value: await request(...args),
      }),
    },
  });
  renderThreadsPanel(host);
  const leaf = await screen.findByText('Host current');
  expect(leaf).toBeVisible();
  await waitFor(() => expect(childThreads).toHaveBeenCalledWith(thread.id));
  expect(
    within(leaf.closest('tr') as HTMLElement).queryByRole('button', { name: 'Expand' })
  ).toBeNull();
  expect(screen.queryByText('No child conversations')).toBeNull();
  expect(await screen.findByText('My work')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'View options' }));
  await userEvent.setup().click(screen.getByRole('radio', { name: 'Folder' }));
  expect(await screen.findByText('Retained')).toBeVisible();
  expect(readRoots).toHaveBeenCalledTimes(1);
});
