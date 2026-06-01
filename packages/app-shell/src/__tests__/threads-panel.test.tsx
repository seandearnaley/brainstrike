import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { ThreadsPanel } from '../threads-panel';

const { dbMocks, fileExplorerMocks, mockDb, threadRows } = vi.hoisted(() => ({
  dbMocks: {
    database: undefined as unknown,
    initializing: false,
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

vi.mock('@brainstrike/db', () => ({
  useDbInitializing: () => dbMocks.initializing,
  useDbProviderError: () => dbMocks.providerError,
  usePGliteDatabase: () => (dbMocks.database === undefined ? mockDb : dbMocks.database),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof fileExplorerMocks) => T): T =>
    selector(fileExplorerMocks),
}));

describe('ThreadsPanel', () => {
  beforeEach(() => {
    fileExplorerMocks.rootDirectoryHandle = {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    };
    dbMocks.database = undefined;
    dbMocks.initializing = false;
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
        id: 'thread-b',
        resourceId: '/tmp/workspace-a',
        title: 'Second thread',
        createdAt: new Date('2026-04-22T10:00:00Z'),
        updatedAt: new Date('2026-04-22T11:00:00Z'),
      },
      {
        id: 'thread-a',
        resourceId: '/tmp/workspace-a',
        title: 'First thread',
        createdAt: new Date('2026-04-22T09:00:00Z'),
        updatedAt: new Date('2026-04-22T09:00:00Z'),
      }
    );
    mockDb.exec.mockClear();
    mockDb.query.mockClear();
    mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO mastra_threads')) {
        threadRows.unshift({
          id: String(params?.[0]),
          resourceId: String(params?.[1]),
          title: String(params?.[2]),
          createdAt: params?.[4],
          updatedAt: params?.[5],
        });
      }
      if (sql.includes('DELETE FROM mastra_threads')) {
        const threadId = String(params?.[0]);
        const index = threadRows.findIndex((row) => row['id'] === threadId);
        if (index >= 0) {
          threadRows.splice(index, 1);
        }
      }
      if (sql.includes('FROM mastra_threads')) {
        return { rows: [...threadRows] };
      }
      if (sql.includes('FROM brainstrike_assistant_thread_runs')) {
        return {
          rows: [
            {
              id: 'run-1',
              resourceId: '/tmp/workspace-a',
              threadId: 'thread-b',
              provider: 'openai',
              model: 'gpt-5.2',
              modelSettings: JSON.stringify({ maxOutputTokens: 512 }),
              providerOptions: JSON.stringify({ openai: { reasoningEffort: 'high' } }),
              runtimeKind: 'hosted',
              status: 'completed',
              error: null,
              startedAt: new Date('2026-04-22T11:00:00Z'),
              completedAt: new Date('2026-04-22T11:00:10Z'),
              createdAt: new Date('2026-04-22T11:00:00Z'),
              updatedAt: new Date('2026-04-22T11:00:10Z'),
            },
          ],
        };
      }
      return { rows: [] };
    });
  });

  it('shows an explicit empty workspace state before a workspace is open', () => {
    fileExplorerMocks.rootDirectoryHandle = null;

    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-preview-badge')).toHaveTextContent('Memory');
    expect(screen.getByRole('button', { name: 'New thread' })).toBeDisabled();
    expect(screen.getByTestId('threads-placeholder-card')).toBeVisible();
    expect(screen.getByText('No workspace open')).toBeVisible();
  });

  it('shows loading instead of unavailable while the database is initializing', () => {
    dbMocks.database = null;
    dbMocks.initializing = true;

    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-loading-card')).toBeVisible();
    expect(screen.getByText('Loading threads...')).toBeVisible();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant memory database unavailable')).not.toBeInTheDocument();
  });

  it('shows loading instead of unavailable before lazy database initialization starts', () => {
    dbMocks.database = null;
    dbMocks.initializing = false;

    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-loading-card')).toBeVisible();
    expect(screen.getByText('Loading threads...')).toBeVisible();
    expect(screen.queryByText('Failed to load threads')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant memory database unavailable')).not.toBeInTheDocument();
  });

  it('shows unavailable when the database stays missing after startup settles', async () => {
    dbMocks.database = null;
    dbMocks.initializing = false;

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
      '/tmp/workspace-a',
    ]);
    expect(screen.getByText('First thread')).toBeVisible();
    expect(screen.getByText('Second thread')).toBeVisible();
    expect(screen.getByText('OpenAI')).toBeVisible();
    expect(screen.getByText('gpt-5.2')).toBeVisible();
    expect(screen.getByText('Reasoning: high')).toBeVisible();
    expect(screen.getByText('Max output: 512')).toBeVisible();
    expect(useAssistantThreadStore.getState().selectedThreadByResourceId['/tmp/workspace-a']).toBe(
      'thread-b'
    );
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
      expect.arrayContaining([threadId, '/tmp/workspace-a', 'New Thread'])
    );
    expect(screen.getByText(threadId)).toBeVisible();
    expect(useAssistantThreadStore.getState().threadIdsByResourceId['/tmp/workspace-a']).toEqual([
      threadId,
      'thread-b',
      'thread-a',
    ]);
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
    expect(useAssistantThreadStore.getState().threadIdsByResourceId['/tmp/workspace-a']).toEqual([
      'thread-a',
    ]);
  });
});
