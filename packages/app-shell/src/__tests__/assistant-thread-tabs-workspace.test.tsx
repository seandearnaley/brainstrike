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

vi.mock('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element', () => ({
  autoScrollForElements: () => () => undefined,
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
        metadata: { color: 'rose' },
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
    // The tab lane hides its scrollbar (chevrons + wheel scroll it) and
    // centers tabs in the full strip height — no scrollbar track may render
    // under the tab bottoms and no vertical padding may offset them.
    expect(tabScroll).toHaveClass('h-full', 'items-center', '[scrollbar-width:none]');
    expect(tabScroll).not.toHaveClass('scrollbar-thin', 'py-1', '[scrollbar-gutter:stable]');
    expect(tabList).toContainElement(firstTab);
    expect(within(tabList).queryByRole('button', { name: 'New assistant thread' })).toBeNull();
    expect(
      within(tabList).queryByRole('button', { name: 'Scroll assistant tabs left' })
    ).toBeNull();
    expect(
      within(tabList).queryByRole('button', { name: 'Scroll assistant tabs right' })
    ).toBeNull();
    expect(tabStrip).toHaveClass('@container/assistant-tabs');
    expect(screen.getByTestId('assistant-tabs-scroll-left')).toHaveClass(
      'hidden',
      '@[300px]/assistant-tabs:inline-flex'
    );
    expect(screen.getByTestId('assistant-tabs-scroll-right')).toHaveClass(
      'hidden',
      '@[300px]/assistant-tabs:inline-flex'
    );
    expect(screen.getByTestId('assistant-new-thread-label')).toHaveClass(
      'hidden',
      '@[380px]/assistant-tabs:inline'
    );
    // Symmetric padding: the close affordance sits in flow after the tab
    // button, so no oversized right padding is reserved for an overlay.
    expect(firstTab).toHaveClass('pl-2');
    expect(firstTab).not.toHaveClass('pr-8');
    expect(firstTab).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('links tabs and force-mounted panels while keeping one tab in the page tab sequence', async () => {
    renderWorkspace();

    const firstTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    const secondTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    const firstPanel = screen.getByTestId('assistant-thread-panel-thread-a');
    const secondPanel = screen.getByTestId('assistant-thread-panel-thread-b');

    expect(firstTab).toHaveAttribute('id', 'assistant-thread-tab-thread-a');
    expect(firstTab).toHaveAttribute('aria-controls', 'assistant-thread-panel-thread-a');
    expect(firstPanel).toHaveAttribute('aria-labelledby', 'assistant-thread-tab-thread-a');
    expect(secondTab).toHaveAttribute('tabindex', '0');
    expect(firstTab).toHaveAttribute('tabindex', '-1');
    expect(firstPanel).toBeInTheDocument();
    expect(secondPanel).toBeInTheDocument();
  });

  it('uses durable thread color on tabs and leaves unassigned tabs neutral', async () => {
    renderWorkspace();

    const coloredTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    expect(coloredTab.closest('[data-thread-color]')).toHaveAttribute('data-thread-color', 'rose');
    // Color lives on the leading icon chip; the old top accent stripe is gone.
    expect(screen.getByTestId('assistant-thread-tab-icon-rose')).toBeVisible();
    expect(screen.queryByTestId('assistant-thread-tab-accent-rose')).not.toBeInTheDocument();

    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    const neutralTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    expect(neutralTab.closest('[data-thread-color]')).toHaveAttribute(
      'data-thread-color',
      'unassigned'
    );
    expect(screen.getByTestId('assistant-thread-tab-icon-unassigned')).toBeVisible();
  });

  it('keeps the close affordance in flow and optically matched with the leading icon', async () => {
    renderWorkspace();

    const tab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    const closeButton = screen.getByRole('button', {
      name: 'Close thread Purchasing app search log',
    });

    // The close button is a flex sibling of the tab button (vertically centered
    // by the row), not an absolutely positioned overlay pinned to a corner.
    expect(closeButton).not.toHaveClass('absolute');
    expect(closeButton.parentElement).toBe(tab.parentElement);
    expect(closeButton).toHaveClass('h-5', 'w-5');
    // Visual box is 20px, but the pseudo-element extends the hit target to
    // 28px so the pointer target stays above the 24px minimum guidance.
    expect(closeButton.className).toMatch(/after:-inset-1/);

    // Leading and close glyphs share one optical size (12px in a 20px box).
    const leadingIcon = screen.getByTestId('assistant-thread-tab-icon-rose');
    expect(leadingIcon).toHaveClass('h-5', 'w-5');
    expect(leadingIcon.querySelector('svg')).toHaveClass('h-3', 'w-3');
    expect(closeButton.querySelector('svg')).toHaveClass('h-3', 'w-3');
  });

  it('supports automatic Arrow, Home, and End tab activation with roving focus', async () => {
    renderWorkspace();
    const firstTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    const secondTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });

    secondTab.focus();
    fireEvent.keyDown(secondTab, { key: 'ArrowLeft' });
    expect(firstTab).toHaveFocus();
    expect(firstTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(firstTab, { key: 'End' });
    expect(secondTab).toHaveFocus();
    expect(secondTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(secondTab, { key: 'Home' });
    expect(firstTab).toHaveFocus();
    expect(firstTab).toHaveAttribute('aria-selected', 'true');
  });

  it('closes the focused tab with Delete and moves focus to the following tab', async () => {
    threadRows.push({
      createdAt: new Date('2026-04-22T09:00:00Z'),
      id: 'thread-c',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Release checklist',
      updatedAt: new Date('2026-04-22T09:00:00Z'),
    });
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    act(() => {
      const store = useAssistantThreadStore.getState();
      store.openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
      store.openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-c');
      store.openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    const middleTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    const followingTab = screen.getByRole('tab', { name: /Release checklist/ });

    middleTab.focus();
    fireEvent.keyDown(middleTab, { key: 'Delete' });

    await waitFor(() => expect(followingTab).toHaveFocus());
    expect(screen.queryByRole('tab', { name: /Amazon Bedrock Converse/ })).not.toBeInTheDocument();
    expect(followingTab).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps focus and activation on the existing active tab when closing an inactive tab', async () => {
    threadRows.push({
      createdAt: new Date('2026-04-22T09:00:00Z'),
      id: 'thread-c',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Release checklist',
      updatedAt: new Date('2026-04-22T09:00:00Z'),
    });
    renderWorkspace();
    const activeTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    act(() => {
      const store = useAssistantThreadStore.getState();
      store.openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
      store.openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-c');
      store.openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-a');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close thread Amazon Bedrock Converse' }));

    await waitFor(() => expect(activeTab).toHaveFocus());
    expect(activeTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Release checklist/ })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('reorders tabs with Alt+Shift+Arrow without changing the active thread', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    const activeTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });

    activeTab.focus();
    fireEvent.keyDown(activeTab, { altKey: true, key: 'ArrowLeft', shiftKey: true });

    await waitFor(() => {
      expect(
        useAssistantThreadStore.getState().openThreadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
      ).toEqual(['thread-b', 'thread-a']);
    });
    expect(activeTab).toHaveFocus();
    expect(activeTab).toHaveAttribute('aria-selected', 'true');
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

    expect(screen.getByTestId('assistant-panel-loading-tab-strip')).toHaveClass('h-9');
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading PGlite-backed threads.');
    expect(screen.queryByText('Assistant threads failed to load')).not.toBeInTheDocument();
    expect(screen.queryByText('Memory database unavailable')).not.toBeInTheDocument();
  });

  it('shows loading instead of unavailable before lazy database initialization starts', () => {
    dbMocks.database = null;
    dbMocks.initializing = false;
    dbMocks.initializationStatus = 'idle';

    renderWorkspace();

    expect(screen.getByTestId('assistant-panel-loading-tab-strip')).toHaveClass('h-9');
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

      expect(screen.getByTestId('assistant-panel-loading-tab-strip')).toHaveClass('h-9');
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

  it('uses instant scroll behavior when reduced motion is requested', async () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockReturnValue({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    });
    try {
      renderWorkspace();
      await screen.findByRole('tab', { name: /Purchasing app search log/ });
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

      fireEvent.click(screen.getByRole('button', { name: 'Scroll assistant tabs right' }));

      expect(scrollBy).toHaveBeenCalledWith({ behavior: 'auto', left: 160 });
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it('scrolls the newly active tab into view without moving the vertical page', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      renderWorkspace();
      await screen.findByRole('tab', { name: /Purchasing app search log/ });

      act(() => {
        useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
      });

      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenLastCalledWith({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        })
      );
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
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
    await waitFor(() => expect(inactiveTab).toHaveFocus());
  });

  it('restores focus after closing a tab from its context menu', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    const closingTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    const remainingTab = screen.getByRole('tab', { name: /Purchasing app search log/ });

    fireEvent.contextMenu(closingTab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }));

    await waitFor(() => expect(remainingTab).toHaveFocus());
    expect(remainingTab).toHaveAttribute('aria-selected', 'true');
  });

  it('moves focus to New after closing all tabs from the context menu', async () => {
    renderWorkspace();
    const activeTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });

    fireEvent.contextMenu(activeTab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close All Tabs' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New assistant thread' })).toHaveFocus();
    });
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
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

  it('moves a tab left from its context action while preserving focus identity', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    const secondTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    secondTab.focus();

    fireEvent.contextMenu(secondTab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move Left' }));

    await waitFor(() => {
      expect(
        useAssistantThreadStore.getState().openThreadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
      ).toEqual(['thread-b', 'thread-a']);
    });
    expect(secondTab).toHaveFocus();
  });

  it('exposes Move Right and disables movement beyond the left edge', async () => {
    renderWorkspace();
    const firstTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    act(() => {
      useAssistantThreadStore.getState().openThreadTab(WORKSPACE_MEMORY_RESOURCE_ID, 'thread-b');
    });
    firstTab.focus();

    fireEvent.contextMenu(firstTab);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Move Left' })).toHaveAttribute(
      'data-disabled'
    );
    const moveRight = within(menu).getByRole('menuitem', { name: 'Move Right' });
    expect(moveRight).not.toHaveAttribute('data-disabled');
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
