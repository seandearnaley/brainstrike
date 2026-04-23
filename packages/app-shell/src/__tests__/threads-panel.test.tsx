import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { ThreadsPanel } from '../threads-panel';

const { fileExplorerMocks, memoryStoreMocks, mockDb } = vi.hoisted(() => ({
  fileExplorerMocks: {
    rootDirectoryHandle: {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    } as { name: string; path: string } | null,
  },
  memoryStoreMocks: {
    init: vi.fn(() => Promise.resolve()),
    saveThread: vi.fn(({ thread }: { thread: unknown }) => Promise.resolve(thread)),
    deleteThread: vi.fn(() => Promise.resolve()),
    listMessages: vi.fn(() => Promise.resolve({ messages: [] })),
    listThreads: vi.fn(() =>
      Promise.resolve({
        threads: [
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
          },
        ],
        total: 2,
        page: 0,
        perPage: false,
        hasMore: false,
      })
    ),
  },
  mockDb: {
    exec: vi.fn(() => Promise.resolve()),
    query: vi.fn(() => Promise.resolve({ rows: [] })),
  },
}));

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: () => mockDb,
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof fileExplorerMocks) => T): T =>
    selector(fileExplorerMocks),
}));

vi.mock('@brainstrike/agent/pglite-mastra-memory/store', () => ({
  PgliteMemoryStore: class {
    init = memoryStoreMocks.init;
    saveThread = memoryStoreMocks.saveThread;
    deleteThread = memoryStoreMocks.deleteThread;
    listMessages = memoryStoreMocks.listMessages;
    listThreads = memoryStoreMocks.listThreads;
  },
}));

describe('ThreadsPanel', () => {
  beforeEach(() => {
    fileExplorerMocks.rootDirectoryHandle = {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    };
    useAssistantThreadStore.setState({
      loadStateByResourceId: {},
      selectedThreadByResourceId: {},
      threadIdsByResourceId: {},
      threadsByResourceId: {},
    });
    memoryStoreMocks.init.mockClear();
    memoryStoreMocks.saveThread.mockClear();
    memoryStoreMocks.deleteThread.mockClear();
    memoryStoreMocks.listMessages.mockClear();
    memoryStoreMocks.listThreads.mockClear();
    memoryStoreMocks.listThreads.mockResolvedValue({
      threads: [
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
        },
      ],
      total: 2,
      page: 0,
      perPage: false,
      hasMore: false,
    });
    memoryStoreMocks.saveThread.mockImplementation(({ thread }: { thread: unknown }) =>
      Promise.resolve(thread)
    );
  });

  it('shows an explicit empty workspace state before a workspace is open', () => {
    fileExplorerMocks.rootDirectoryHandle = null;

    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-preview-badge')).toHaveTextContent('Memory');
    expect(screen.getByRole('button', { name: 'New thread' })).toBeDisabled();
    expect(screen.getByTestId('threads-placeholder-card')).toBeVisible();
    expect(screen.getByText('No workspace open')).toBeVisible();
  });

  it('lists workspace-scoped historical Mastra threads from PGlite', async () => {
    render(<ThreadsPanel />);

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(memoryStoreMocks.listThreads).toHaveBeenCalledWith({
      filter: { resourceId: '/tmp/workspace-a' },
      perPage: false,
      orderBy: { field: 'updatedAt', direction: 'DESC' },
    });
    expect(screen.getByText('First thread')).toBeVisible();
    expect(screen.getByText('Second thread')).toBeVisible();
    expect(useAssistantThreadStore.getState().selectedThreadByResourceId['/tmp/workspace-a']).toBe(
      'thread-b'
    );
  });

  it('persists newly created threads through Mastra storage instead of replacing the list', async () => {
    const user = userEvent.setup();
    memoryStoreMocks.saveThread.mockImplementation(({ thread }: { thread: unknown }) =>
      Promise.resolve({
        ...(typeof thread === 'object' && thread ? thread : {}),
        id: 'thread-c',
        title: 'New Thread',
        resourceId: '/tmp/workspace-a',
        createdAt: new Date('2026-04-22T12:00:00Z'),
        updatedAt: new Date('2026-04-22T12:00:00Z'),
      })
    );
    render(<ThreadsPanel />);

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'New thread' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(3);
    });
    expect(memoryStoreMocks.saveThread).toHaveBeenCalledTimes(1);
    expect(screen.getByText('thread-c')).toBeVisible();
    expect(useAssistantThreadStore.getState().threadIdsByResourceId['/tmp/workspace-a']).toEqual([
      'thread-c',
      'thread-b',
      'thread-a',
    ]);
  });
});
