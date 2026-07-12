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
        row['updatedAt'] = params?.[2];
      }
    }
    if (sql.includes('INSERT INTO brainstrike_assistant_thread_groups')) {
      groupRows.push({
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
      }
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM brainstrike_assistant_thread_groups')) {
      const index = groupRows.findIndex((row) => row['id'] === String(params?.[0]));
      if (index >= 0) {
        groupRows.splice(index, 1);
      }
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO brainstrike_assistant_thread_placements')) {
      const placementThreadId = String(params?.[0]);
      const nextPlacement = {
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
      const index = placementRows.findIndex((row) => row['threadId'] === String(params?.[0]));
      if (index >= 0) {
        placementRows.splice(index, 1);
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
        ],
      };
    }
    return { rows: [] };
  });
});

describe('ThreadsPanel', () => {
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

  it('saves curated icon and color metadata through Mastra thread storage', async () => {
    const user = userEvent.setup();
    renderThreadsPanel();

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Customize thread Second thread' }));
    await user.click(screen.getByRole('button', { name: 'Use Bug icon' }));
    await user.click(screen.getByRole('button', { name: 'Use Rose color' }));

    await waitFor(() => {
      expect(screen.getByTestId('thread-icon-bug')).toBeVisible();
    });
    expect(screen.getByTestId('thread-color-rose')).toBeVisible();
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SET metadata'), [
      'thread-b',
      expect.stringContaining('"icon":"bug"'),
      expect.any(Date),
    ]);
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SET metadata'), [
      'thread-b',
      expect.stringContaining('"color":"rose"'),
      expect.any(Date),
    ]);
    const persistedRow = threadRows.find((row) => row['id'] === 'thread-b');
    expect(JSON.parse(String(persistedRow?.['metadata']))).toMatchObject({
      color: 'rose',
      icon: 'bug',
    });
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
    await user.click(screen.getByRole('button', { name: 'Rename thread Second thread' }));
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
    await user.click(screen.getByRole('button', { name: 'Rename thread Second thread' }));
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
    await user.click(screen.getByRole('button', { name: 'Delete thread Second thread' }));
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
    await user.click(screen.getByRole('button', { name: 'Delete thread Second thread' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete thread Second thread' }));

    expect(await screen.findByText('Delete failed in PGlite.')).toBeVisible();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
  });
});

describe('ThreadsPanel groups', () => {
  function seedGroup(id: string, name: string, rank: string): void {
    groupRows.push({ id, name, rank, resourceId: WORKSPACE_MEMORY_RESOURCE_ID });
  }

  function seedPlacement(threadId: string, groupId: string | null, rank: string): void {
    placementRows.push({
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
    expect(within(section).getByText('Second thread')).toBeVisible();
    const ungrouped = screen.getByTestId('threads-ungrouped-section');
    expect(within(ungrouped).getByText('Ungrouped')).toBeVisible();
    expect(within(ungrouped).getByText('First thread')).toBeVisible();
    const sectionOrder = Array.from(
      document.querySelectorAll(
        '[data-testid="thread-group-section"], [data-testid="threads-ungrouped-section"]'
      )
    ).map((element) => element.getAttribute('data-testid'));
    expect(sectionOrder).toEqual(['thread-group-section', 'threads-ungrouped-section']);
  });

  it('collapses and expands a group', async () => {
    seedGroup('group-research', 'Research', 'a0');
    seedPlacement('thread-b', 'group-research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    expect(screen.getByText('Second thread')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse group Research' }));
    expect(screen.queryByText('Second thread')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand group Research' }));
    expect(screen.getByText('Second thread')).toBeVisible();
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
    fireEvent.click(screen.getByRole('button', { name: 'Rename group Research' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete group Research' }));

    await waitFor(() => {
      expect(screen.queryByTestId('thread-group-section')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM brainstrike_assistant_thread_placements WHERE group_id'),
      ['group-research']
    );
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM brainstrike_assistant_thread_groups'),
      ['group-research']
    );
  });

  it('moves a thread into a group from the context menu', async () => {
    seedGroup('group-research', 'Research', 'a0');

    renderThreadsPanel();

    await screen.findByTestId('thread-group-section');
    fireEvent.contextMenu(screen.getByText('First thread'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Research' }));

    await waitFor(() => {
      const section = screen.getByTestId('thread-group-section');
      expect(within(section).getByText('First thread')).toBeVisible();
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
      const ungrouped = screen.getByTestId('threads-ungrouped-section');
      expect(within(ungrouped).getByText('Second thread')).toBeVisible();
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
    expect(useAssistantThreadGroupsStore.getState().sortBy).toBe('name');
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
