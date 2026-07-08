import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '../assistant-memory-resource';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { ThreadsPanel } from '../threads-panel';

const { dbMocks, fileExplorerMocks, mockDb, threadRows } = vi.hoisted(() => ({
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
  mockDb: {
    exec: vi.fn(() => Promise.resolve()),
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(
      () => Promise.resolve({ rows: [] })
    ),
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

describe('ThreadsPanel', () => {
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

  it('loads workspace-global threads even when no folder is open', async () => {
    // Multi-root: assistant memory is workspace-global and usable with zero roots.
    // There is no "open a folder first" gate, and threads are keyed on a stable
    // resource id rather than the focused root path.
    fileExplorerMocks.rootDirectoryHandle = null;

    render(<ThreadsPanel />);

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

    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-loading-card')).toBeVisible();
    expect(screen.getByText('Loading threads...')).toBeVisible();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant memory database unavailable')).not.toBeInTheDocument();
  });

  it('shows loading instead of unavailable before lazy database initialization starts', () => {
    dbMocks.database = null;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'idle';

    render(<ThreadsPanel />);

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

      render(<ThreadsPanel />);

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

    render(<ThreadsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Assistant memory database unavailable')).toBeVisible();
    });
    expect(screen.queryByText('Loading threads...')).not.toBeInTheDocument();
  });

  it('shows the database provider error after initialization fails', () => {
    dbMocks.database = null;
    dbMocks.providerError = new Error('PGlite startup failed.');

    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-error-card')).toBeVisible();
    expect(screen.getByText('Assistant memory database failed')).toBeVisible();
    expect(screen.getByText('PGlite startup failed.')).toBeVisible();
    expect(screen.queryByText('Assistant memory database unavailable')).not.toBeInTheDocument();
  });

  it('lists workspace-scoped historical Mastra threads from PGlite', async () => {
    render(<ThreadsPanel />);

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
    render(<ThreadsPanel />);

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

  it('saves curated icon and color metadata through Mastra thread storage', async () => {
    const user = userEvent.setup();
    render(<ThreadsPanel />);

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
    render(<ThreadsPanel />);

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
    render(<ThreadsPanel />);

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
    render(<ThreadsPanel />);

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
      expect.any(Date),
    ]);
  });

  it('keeps rename validation local to the row', async () => {
    const user = userEvent.setup();
    render(<ThreadsPanel />);

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
    render(<ThreadsPanel />);

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
    render(<ThreadsPanel />);

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
