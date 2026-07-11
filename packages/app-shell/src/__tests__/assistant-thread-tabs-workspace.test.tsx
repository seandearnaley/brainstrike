import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '../assistant-memory-resource';
import { assistantThreadActions } from '../assistant-thread-context-actions';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { AssistantThreadTabsWorkspace } from '../assistant-thread-tabs-workspace';

const { dbMocks, fileExplorerMocks, mockDb, threadRows } = vi.hoisted(() => ({
  dbMocks: {
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
  mockDb: {
    exec: vi.fn(() => Promise.resolve()),
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(
      () => Promise.resolve({ rows: [] })
    ),
  },
  threadRows: [] as Record<string, unknown>[],
}));

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

vi.mock('../assistant-ui-panel-wrapper', () => ({
  AssistantUiPanelWrapper: ({
    memoryThreadId,
  }: {
    memoryResourceId?: string;
    memoryThreadId?: string;
  }) => <div data-testid="assistant-thread-wrapper">{memoryThreadId}</div>,
}));

function renderWorkspace(): ReturnType<typeof createTestActionRegistry> {
  const actionRegistry = createTestActionRegistry({ actions: assistantThreadActions });
  render(
    <ActionRegistryProvider registry={actionRegistry.registry}>
      <AssistantThreadTabsWorkspace initialProviders={['openai']} />
    </ActionRegistryProvider>
  );
  return actionRegistry;
}

describe('AssistantThreadTabsWorkspace', () => {
  beforeEach(() => {
    fileExplorerMocks.rootDirectoryHandle = {
      name: 'workspace-a',
      path: '/tmp/workspace-a',
    };
    dbMocks.database = undefined;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'ready';
    dbMocks.providerError = null;
    threadRows.splice(
      0,
      threadRows.length,
      {
        createdAt: new Date('2026-04-22T09:00:00Z'),
        id: 'thread-a',
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

  it('force-mounts one assistant wrapper per open thread tab', async () => {
    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });

    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });

    expect(screen.getAllByTestId('assistant-thread-wrapper')).toHaveLength(2);
    expect(screen.getByTestId('assistant-thread-panel-thread-a')).not.toBeVisible();
    expect(screen.getByTestId('assistant-thread-panel-thread-b')).toBeVisible();
    expect(screen.getByRole('tab', { name: /Amazon Bedrock Converse/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('creates durable threads as focused tabs', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-00000000000e');
    renderWorkspace();

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
        WORKSPACE_MEMORY_RESOURCE_ID,
        'New Thread',
      ])
    );
    uuidSpy.mockRestore();
  });

  it('keeps the new-thread action outside the scrollable tablist', async () => {
    renderWorkspace();

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

  it('mounts assistant threads even when no folder is open', async () => {
    // Multi-root: assistant memory is workspace-global; zero roots is fine and
    // the "open a workspace first" gate is gone.
    fileExplorerMocks.rootDirectoryHandle = null;
    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });
    expect(screen.queryByText('No workspace open')).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Open assistant threads' })).toBeInTheDocument();
  });

  it('shows the load-error state without mounting assistant tabs', () => {
    renderWorkspace();
    act(() => {
      useAssistantThreadStore.setState({
        loadStateByResourceId: {
          [WORKSPACE_MEMORY_RESOURCE_ID]: {
            error: 'PGlite failed to initialize.',
            status: 'error',
          },
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

    renderWorkspace();

    expect(screen.getByTestId('assistant-panel-loading-tab-strip')).toHaveClass('h-12');
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading PGlite-backed threads.');
    expect(screen.queryByText('Assistant threads failed to load')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
  });

  it('shows loading instead of unavailable before lazy database initialization starts', () => {
    dbMocks.database = null;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'idle';

    renderWorkspace();

    expect(screen.getByTestId('assistant-panel-loading-tab-strip')).toHaveClass('h-12');
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading PGlite-backed threads.');
    expect(screen.queryByText('Assistant threads failed to load')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
  });

  it('keeps loading while lazy database initialization has not completed', () => {
    vi.useFakeTimers();
    try {
      dbMocks.database = null;
      dbMocks.initializing = false;
      dbMocks.initializationStatus = 'idle';

      renderWorkspace();

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.getByTestId('assistant-panel-loading-tab-strip')).toHaveClass('h-12');
      expect(screen.getByRole('status')).toHaveAccessibleName('Loading PGlite-backed threads.');
      expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows unavailable when the database stays missing after startup settles', async () => {
    dbMocks.database = null;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'ready';

    renderWorkspace();

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

    renderWorkspace();

    expect(screen.getByText('Memory database failed')).toBeInTheDocument();
    expect(screen.getByText('PGlite startup failed.')).toBeInTheDocument();
    expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
  });

  it('updates scroll affordances and scrolls the tab list from arrow buttons', async () => {
    renderWorkspace();

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
    renderWorkspace();

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

  it('uses the right-clicked inactive tab for copy and atomic Close Others actions', async () => {
    const { writtenTexts } = renderWorkspace();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    const inactiveTab = screen.getByRole('tab', { name: /Purchasing app search log/ });

    fireEvent.contextMenu(inactiveTab);
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-b');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Thread Title' }));
    await waitFor(() => {
      expect(writtenTexts).toEqual(['Purchasing app search log']);
    });

    fireEvent.contextMenu(inactiveTab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Others' }));

    expect(
      useAssistantThreadStore.getState().openThreadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual(['thread-a']);
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');
    expect(
      useAssistantThreadStore.getState().selectedThreadByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-a');
    expect(
      useAssistantThreadStore.getState().threadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual(['thread-a', 'thread-b']);
    expect(mockDb.query).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM mastra_threads'),
      expect.anything()
    );
  });

  it('closes tabs to the right from the claimed tab and disables the no-op action', async () => {
    threadRows.push({
      createdAt: new Date('2026-04-22T09:00:00Z'),
      id: 'thread-c',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Release checklist',
      updatedAt: new Date('2026-04-22T09:00:00Z'),
    });
    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });
    act(() => {
      const store = useAssistantThreadStore.getState();
      store.openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
      store.openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-c');
    });
    const middleTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });

    fireEvent.contextMenu(middleTab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Tabs to the Right' }));

    expect(
      useAssistantThreadStore.getState().openThreadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual(['thread-a', 'thread-b']);
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('thread-b');

    fireEvent.contextMenu(middleTab);
    expect(
      await screen.findByRole('menuitem', { name: 'Close Tabs to the Right' })
    ).toHaveAttribute('data-disabled');
  });

  it('does not claim assistant message content as a thread-tab context target', async () => {
    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByTestId('assistant-thread-wrapper')).toBeVisible();
    });
    fireEvent.contextMenu(screen.getByTestId('assistant-thread-wrapper'));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes tabs without deleting durable thread history', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    await user.click(screen.getByRole('button', { name: 'Close thread Amazon Bedrock Converse' }));

    expect(mockDb.query).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM mastra_threads'),
      expect.anything()
    );
    expect(
      useAssistantThreadStore.getState().threadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual(['thread-a', 'thread-b']);
    expect(screen.queryByTestId('assistant-thread-panel-thread-b')).not.toBeInTheDocument();
  });
});
