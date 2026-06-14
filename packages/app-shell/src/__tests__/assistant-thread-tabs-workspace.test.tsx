import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { AssistantThreadTabsWorkspace } from '../assistant-thread-tabs-workspace';

const { dbMocks, fileExplorerMocks, mockDb, threadRows } = vi.hoisted(() => ({
  dbMocks: {
    database: undefined as unknown,
    initializing: false,
    initializationStatus: 'ready' as 'idle' | 'initializing' | 'ready' | 'error',
    providerError: null as Error | null,
  },
  fileExplorerMocks: {
    activeRootIds: [] as string[],
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
  useDbInitializationStatus: () => dbMocks.initializationStatus,
  useDbProviderError: () => dbMocks.providerError,
  usePGliteDatabase: () => (dbMocks.database === undefined ? mockDb : dbMocks.database),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof fileExplorerMocks) => T): T =>
    selector(fileExplorerMocks),
}));

vi.mock('../assistant-ui-panel-wrapper', () => ({
  AssistantUiPanelWrapper: ({
    memoryResourceId,
    memoryThreadId,
  }: {
    memoryResourceId?: string;
    memoryThreadId?: string;
  }) => (
    <div data-resource-id={memoryResourceId} data-testid="assistant-thread-wrapper">
      {memoryThreadId}
    </div>
  ),
}));

describe('AssistantThreadTabsWorkspace', () => {
  beforeEach(() => {
    fileExplorerMocks.rootDirectoryHandle = {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    };
    fileExplorerMocks.activeRootIds = [];
    dbMocks.database = undefined;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'ready';
    dbMocks.providerError = null;
    threadRows.splice(
      0,
      threadRows.length,
      {
        id: 'thread-a',
        resourceId: '/tmp/workspace-a',
        title: 'Purchasing app search log',
        createdAt: new Date('2026-04-22T09:00:00Z'),
        updatedAt: new Date('2026-04-22T11:00:00Z'),
      },
      {
        id: 'thread-b',
        resourceId: '/tmp/workspace-a',
        title: 'Amazon Bedrock Converse',
        createdAt: new Date('2026-04-22T09:00:00Z'),
        updatedAt: new Date('2026-04-22T10:00:00Z'),
      }
    );
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: {},
      draftRuntimeByThreadId: {},
      loadStateByResourceId: {},
      openThreadIdsByResourceId: {},
      selectedThreadByResourceId: {},
      threadIdsByResourceId: {},
      threadsByResourceId: {},
    });
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
      if (sql.includes('FROM mastra_threads')) {
        return { rows: [...threadRows] };
      }
      return { rows: [] };
    });
  });

  it('force-mounts one assistant wrapper per open thread tab', async () => {
    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });

    act(() => {
      useAssistantThreadStore.getState().openThreadTab('/tmp/workspace-a', 'thread-b');
    });

    expect(screen.getAllByTestId('assistant-thread-wrapper')).toHaveLength(2);
    expect(screen.getByTestId('assistant-thread-panel-thread-a')).not.toBeVisible();
    expect(screen.getByTestId('assistant-thread-panel-thread-b')).toBeVisible();
    expect(screen.getByRole('tab', { name: /Amazon Bedrock Converse/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('uses a stable multi-root forest resource id for assistant thread tabs', async () => {
    const forestResourceId = 'assistant-workspace:roots:root-a|root-b';
    fileExplorerMocks.activeRootIds = ['root-b', 'root-a'];
    threadRows.splice(0, threadRows.length, {
      id: 'thread-forest',
      resourceId: forestResourceId,
      title: 'Forest-scoped thread',
      createdAt: new Date('2026-04-22T09:00:00Z'),
      updatedAt: new Date('2026-04-22T11:00:00Z'),
    });

    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Forest-scoped thread/ })).toBeVisible();
    });
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('FROM mastra_threads'), [
      forestResourceId,
    ]);
    expect(screen.getByTestId('assistant-thread-wrapper')).toHaveAttribute(
      'data-resource-id',
      forestResourceId
    );
  });

  it('creates durable threads as focused tabs', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-00000000000e');
    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: 'New assistant thread' }));

    await waitFor(() => {
      expect(
        screen.getByTestId('assistant-thread-panel-thread-00000000-0000-4000-8000-00000000000e')
      ).toBeVisible();
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mastra_threads'),
      expect.arrayContaining([
        'thread-00000000-0000-4000-8000-00000000000e',
        '/tmp/workspace-a',
        'New Thread',
      ])
    );
    uuidSpy.mockRestore();
  });

  it('keeps the new-thread action outside the scrollable tablist', async () => {
    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });

    const tabStrip = screen.getByTestId('assistant-thread-tab-strip');
    const tabScroll = screen.getByTestId('assistant-thread-tab-scroll');
    const tabList = screen.getByRole('tablist', { name: 'Open assistant threads' });
    const newThreadButton = screen.getByRole('button', { name: 'New assistant thread' });
    const firstTab = screen.getByRole('tab', { name: /Purchasing app search log/ });

    expect(tabStrip).toContainElement(tabScroll);
    expect(tabStrip).toContainElement(newThreadButton);
    expect(tabList).toContainElement(firstTab);
    expect(within(tabList).queryByRole('button', { name: 'New assistant thread' })).toBeNull();
    expect(
      within(tabList).queryByRole('button', { name: 'Scroll assistant tabs left' })
    ).toBeNull();
    expect(
      within(tabList).queryByRole('button', { name: 'Scroll assistant tabs right' })
    ).toBeNull();
  });

  it('shows explicit workspace and load-error states without mounting assistant tabs', async () => {
    fileExplorerMocks.rootDirectoryHandle = null;
    const noWorkspaceView = render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    expect(screen.getByText('No workspace open')).toBeInTheDocument();
    expect(
      screen.getByText('Open a workspace before starting assistant threads.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('assistant-thread-workspace-state')).toHaveAttribute(
      'data-variant',
      'muted'
    );
    expect(
      screen.queryByRole('tablist', { name: 'Open assistant threads' })
    ).not.toBeInTheDocument();

    noWorkspaceView.unmount();
    fileExplorerMocks.rootDirectoryHandle = {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    };
    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);
    act(() => {
      useAssistantThreadStore.setState({
        loadStateByResourceId: {
          '/tmp/workspace-a': { status: 'error', error: 'PGlite failed to initialize.' },
        },
      });
    });

    expect(screen.getByText('Assistant threads failed to load')).toBeInTheDocument();
    expect(screen.getByText('PGlite failed to initialize.')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-thread-workspace-state')).toHaveAttribute(
      'data-variant',
      'error'
    );
  });

  it('shows loading instead of unavailable while the database is initializing', () => {
    dbMocks.database = null;
    dbMocks.initializing = true;
    dbMocks.initializationStatus = 'initializing';

    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.getByText('Loading PGlite-backed threads.')).toBeInTheDocument();
    expect(screen.queryByText('Assistant threads failed to load')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
  });

  it('shows loading instead of unavailable before lazy database initialization starts', () => {
    dbMocks.database = null;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'idle';

    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.getByText('Loading PGlite-backed threads.')).toBeInTheDocument();
    expect(screen.queryByText('Assistant threads failed to load')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
  });

  it('keeps loading while lazy database initialization has not completed', () => {
    vi.useFakeTimers();
    try {
      dbMocks.database = null;
      dbMocks.initializing = false;
      dbMocks.initializationStatus = 'idle';

      render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.getByText('Loading')).toBeInTheDocument();
      expect(screen.getByText('Loading PGlite-backed threads.')).toBeInTheDocument();
      expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows unavailable when the database stays missing after startup settles', async () => {
    dbMocks.database = null;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'ready';

    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    await waitFor(() => {
      expect(screen.getByText('Memory database unavailable')).toBeInTheDocument();
    });
    expect(screen.getByTestId('assistant-thread-workspace-state')).toHaveAttribute(
      'data-variant',
      'error'
    );
    expect(screen.queryByText('Loading PGlite-backed threads.')).not.toBeInTheDocument();
  });

  it('shows the database provider error after initialization fails', () => {
    dbMocks.database = null;
    dbMocks.providerError = new Error('PGlite startup failed.');

    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    expect(screen.getByText('Memory database failed')).toBeInTheDocument();
    expect(screen.getByText('PGlite startup failed.')).toBeInTheDocument();
    expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
  });

  it('updates scroll affordances and scrolls the tab list from arrow buttons', async () => {
    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });

    const tabScroll = screen.getByTestId('assistant-thread-tab-scroll') as HTMLDivElement & {
      scrollBy: ReturnType<typeof vi.fn>;
    };
    const scrollBy = vi.fn();
    tabScroll.scrollBy = scrollBy;
    Object.defineProperties(tabScroll, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 700 },
    });

    fireEvent.scroll(tabScroll);
    expect(screen.getByRole('button', { name: 'Scroll assistant tabs left' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Scroll assistant tabs right' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Scroll assistant tabs right' }));
    expect(scrollBy).toHaveBeenCalledWith({ behavior: 'smooth', left: 160 });

    tabScroll.scrollLeft = 500;
    fireEvent.scroll(tabScroll);
    expect(screen.getByRole('button', { name: 'Scroll assistant tabs left' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Scroll assistant tabs right' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Scroll assistant tabs left' }));
    expect(scrollBy).toHaveBeenCalledWith({ behavior: 'smooth', left: -160 });
  });

  it('scrolls the tab lane when vertical wheel input lands over the tabs', async () => {
    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });

    const tabScroll = screen.getByTestId('assistant-thread-tab-scroll');
    Object.defineProperties(tabScroll, {
      clientWidth: { configurable: true, value: 240 },
      scrollWidth: { configurable: true, value: 720 },
    });

    fireEvent.wheel(tabScroll, { deltaX: 0, deltaY: 96 });

    expect(tabScroll.scrollLeft).toBe(96);
  });

  it('closes tabs without deleting durable thread history', async () => {
    const user = userEvent.setup();
    render(<AssistantThreadTabsWorkspace initialProviders={['openai']} />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab('/tmp/workspace-a', 'thread-b');
    });
    await user.click(screen.getByRole('button', { name: 'Close thread Amazon Bedrock Converse' }));

    expect(mockDb.query).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM mastra_threads'),
      expect.anything()
    );
    expect(useAssistantThreadStore.getState().threadIdsByResourceId['/tmp/workspace-a']).toEqual([
      'thread-a',
      'thread-b',
    ]);
    expect(screen.queryByTestId('assistant-thread-panel-thread-b')).not.toBeInTheDocument();
  });
});
