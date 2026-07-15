import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '../assistant-memory-resource';
import { assistantThreadActions } from '../assistant-thread-context-actions';
import { useAssistantThreadGroupsStore } from '../assistant-thread-groups-store';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { ThreadsPanel } from '../threads-panel';

const virtualizerState = vi.hoisted(() => ({ windowSize: Number.POSITIVE_INFINITY }));

// TreeTable's real virtualizer depends on layout measurements that JSDOM does
// not provide. Render its complete disclosed row model here; a dedicated
// virtualization test covers the bounded mounted-window contract.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, virtualizerState.windowSize) }, (_, index) => ({
        end: (index + 1) * 40,
        index,
        key: `thread-row-${index}`,
        size: 40,
        start: index * 40,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  })),
}));

const { dbMocks, fileExplorerMocks, groupRows, mockDb, placementRows, threadRows } = vi.hoisted(
  () => ({
    dbMocks: {
      database: undefined as unknown,
      deleteFailureThreadId: null as string | null,
      initializationStatus: 'ready' as 'idle' | 'initializing' | 'ready' | 'error',
      initializing: false,
      metadataFailureThreadId: null as string | null,
      providerError: null as Error | null,
    },
    fileExplorerMocks: {
      rootDirectoryHandle: {
        name: 'workspace-a',
        path: '/tmp/workspace-a',
      } as { name: string; path: string } | null,
    },
    groupRows: [] as Record<string, unknown>[],
    mockDb: {
      exec: vi.fn(() => Promise.resolve()),
      query: vi.fn<
        (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
      >(() => Promise.resolve({ rows: [] })),
    },
    placementRows: [] as Record<string, unknown>[],
    threadRows: [] as Record<string, unknown>[],
  })
);

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
  useDbInitializationStatus: () => dbMocks.initializationStatus,
  useDbInitializing: () => dbMocks.initializing,
  useDbProviderError: () => dbMocks.providerError,
  usePGliteDatabase: () => (dbMocks.database === undefined ? mockDb : dbMocks.database),
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
    </ActionRegistryProvider>
  );
  return actionRegistry;
}

beforeEach(() => {
  virtualizerState.windowSize = Number.POSITIVE_INFINITY;
  fileExplorerMocks.rootDirectoryHandle = {
    name: 'workspace-a',
    path: '/tmp/workspace-a',
  };
  dbMocks.database = undefined;
  dbMocks.deleteFailureThreadId = null;
  dbMocks.initializing = false;
  dbMocks.initializationStatus = 'ready';
  dbMocks.metadataFailureThreadId = null;
  dbMocks.providerError = null;
  groupRows.splice(0, groupRows.length);
  placementRows.splice(0, placementRows.length);
  useAssistantThreadGroupsStore.getState().reset();
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: {},
    draftRuntimeByThreadId: {},
    loadStateByResourceId: {},
    openThreadIdsByResourceId: {},
    selectedThreadByResourceId: {},
    threadIdsByResourceId: {},
    threadsByResourceId: {},
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
  mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
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
      return { rows: [{ allFound: true }] };
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
    }
    if (sql.includes('SET metadata')) {
      const threadId = String(params?.[0]);
      if (dbMocks.metadataFailureThreadId === threadId) {
        throw new Error('Metadata update failed in PGlite.');
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
    if (sql.includes('FROM mastra_threads')) {
      return { rows: [...threadRows] };
    }
    if (sql.includes('FROM brainstrike_assistant_thread_runs')) {
      return {
        rows: [
          {
            completedAt: new Date('2026-04-22T11:00:10Z'),
            createdAt: new Date('2026-04-22T11:00:00Z'),
            error: null,
            id: 'run-1',
            model: 'gpt-5.2',
            modelSettings: JSON.stringify({ maxOutputTokens: 512 }),
            provider: 'openai',
            providerOptions: JSON.stringify({ openai: { reasoningEffort: 'high' } }),
            resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
            runtimeKind: 'hosted',
            startedAt: new Date('2026-04-22T11:00:00Z'),
            status: 'completed',
            threadId: 'thread-b',
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
            updatedAt: new Date('2026-04-22T09:00:10Z'),
          },
        ],
      };
    }
    return { rows: [] };
  });
});

describe('ThreadsPanel', () => {
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
    expect(screen.getAllByTestId('thread-row')[0]).toHaveClass('ring-1', 'ring-inset');
    expect(screen.getAllByTestId('thread-row')[0]).not.toHaveClass(
      'group-data-[focused=true]/thread-tree-row:outline-2'
    );
    expect(viewport?.parentElement?.parentElement).not.toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('threads-panel')).toHaveClass('@container/threads', 'h-full');

    const idleThread = screen.getByText('First thread').closest('[data-testid="thread-row"]');
    expect(idleThread).toHaveClass(
      'bg-emerald-50/20',
      'ring-emerald-200/30',
      'hover:bg-emerald-50/35'
    );
    expect(idleThread).not.toHaveClass('bg-transparent', 'hover:bg-accent/35');
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
    expect(bulkColorGrid).toHaveClass('grid-cols-4');
    for (const button of within(bulkColorGrid).getAllByRole('button')) {
      expect(button).toHaveClass('size-8', 'justify-self-center');
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
    expect(screen.getByTestId('threads-preview-badge')).toHaveTextContent('Memory');
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
    expect(screen.getByText('gpt-5.2')).toBeVisible();
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
    expect(within(secondThread).getByText('gpt-5.2')).toBeVisible();
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

  it('uses quiet idle pills, a strong active treatment, and breathing room around each thread', async () => {
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    const [activeThread, idleThread] = screen.getAllByTestId('thread-row');

    expect(activeThread).toHaveClass('my-0.5', 'mr-1', 'ring-2', 'shadow-sm');
    expect(idleThread).toHaveClass('my-0.5', 'mr-1', 'bg-emerald-50/20');
    expect(idleThread).not.toHaveClass('ring-2', 'shadow-sm');
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
    expect(within(details).getByText('gpt-5.2')).toBeVisible();
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
      ['thread-b', 'thread:thread-b']
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

  it('renders group sections with the ungrouped section below', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    const section = await screen.findByTestId('thread-group-section');
    expect(within(section).getByText('Research')).toBeVisible();
    expect(within(section).getByText('Research')).toHaveClass('text-[13px]', 'leading-4');
    const nestedThreadRow = screen.getByText('Second thread').closest('tr');
    expect(nestedThreadRow).toHaveAttribute('data-depth', '1');
    expect(nestedThreadRow?.querySelector<HTMLElement>('td > div > span')).toHaveStyle({
      width: '28px',
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

  it('assigns group icon and color through the durable store without painting a section frame', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-a', 'group-research', 'a0');

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
    expect(folderColorGrid).toHaveClass('grid-cols-4');
    for (const button of within(folderColorGrid).getAllByRole('button')) {
      expect(button).toHaveClass('size-8', 'justify-self-center');
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Use Rose color for Research' }));

    await waitFor(() => {
      expect(screen.getByTestId('thread-group-color-rose')).toBeVisible();
    });
    const groupHeaderRow = screen.getByText('Research').closest('tr');
    const groupedThreadRow = screen.getByText('First thread').closest('tr');
    expect(screen.getByTestId('thread-group-color-rose')).toHaveClass(
      'border-rose-300',
      'bg-rose-50'
    );
    expect(groupHeaderRow).not.toHaveClass('border-l-4', 'bg-rose-50/25');
    expect(groupedThreadRow).not.toHaveClass('border-l-4', 'bg-rose-50/25');
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SET color'), [
      'group-research',
      'rose',
    ]);

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
