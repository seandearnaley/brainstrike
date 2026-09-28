import './assistant-thread-tabs-workspace-test-support';
import {
  type AssistantThreadRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { TAB_STRIP_ICON_BUTTON_CLASS_NAME } from '@brainstrike/ui';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  THREAD_CONTROL_ACTION_CLASS_NAME,
  THREAD_CONTROL_MARK_CLASS_NAME,
  UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION,
} from '../assistant-thread-presentation';
import {
  activeThreadId,
  addThreadRow,
  assistantWrapperProps,
  dbMocks,
  fileExplorerMocks,
  mockDb,
  openThreadIds,
  openThreadTabs,
  renderWorkspace,
} from './assistant-thread-tabs-workspace-test-support';

describe('AssistantThreadTabsWorkspace', () => {
  it('force-mounts one assistant wrapper per open thread tab', async () => {
    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });

    openThreadTabs('thread-b');

    expect(screen.getAllByTestId('assistant-thread-wrapper')).toHaveLength(2);
    // Keep-alive is the `hidden` attribute, never <Activity>: inactive panels stay mounted.
    expect(screen.getByTestId('assistant-thread-panel-thread-a')).toHaveAttribute('hidden');
    expect(screen.getByTestId('assistant-thread-panel-thread-a')).not.toBeVisible();
    expect(screen.getByTestId('assistant-thread-panel-thread-b')).toBeVisible();
    expect(screen.getByRole('tab', { name: /Amazon Bedrock Converse/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('forwards validated provider key sources to every thread wrapper', async () => {
    const providerKeySources = [
      { envVar: 'OPENAI_API_KEY', provider: 'openai' as const, source: 'env' as const },
    ];
    renderWorkspace({ providerKeySources });

    await screen.findByRole('tab', { name: /Purchasing app search log/ });

    expect(assistantWrapperProps).toContainEqual(
      expect.objectContaining({
        providerKeySources,
      })
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

  it('renders the shared strip with New as trailing chrome outside the tablist', async () => {
    renderWorkspace();

    const firstTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    const tabStrip = screen.getByTestId('assistant-thread-tab-strip');
    const tabScroll = screen.getByTestId('assistant-thread-tab-scroll');
    const tabList = screen.getByRole('tablist', { name: 'Open assistant threads' });
    const newThreadButton = screen.getByRole('button', { name: 'New assistant thread' });

    expect(tabStrip).toHaveAttribute('data-slot', 'tab-strip');
    expect(tabStrip).toHaveClass('@container/tab-strip');
    expect(tabList).toContainElement(tabScroll);
    expect(tabScroll).toContainElement(firstTab);
    expect(tabStrip).toContainElement(newThreadButton);
    expect(within(tabList).queryByRole('button', { name: 'New assistant thread' })).toBeNull();
    // The tab lane hides its scrollbar and centers tabs in the full strip height:
    // no scrollbar track may render under the tab bottoms, no vertical padding.
    expect(tabScroll).toHaveClass('h-full', 'items-center', '[scrollbar-width:none]');
    expect(tabScroll).not.toHaveClass('scrollbar-thin', 'py-1', '[scrollbar-gutter:stable]');
    // The close affordance sits in flow after the tab button, so no oversized
    // right padding is reserved for an overlay.
    expect(firstTab).toHaveClass('pl-2');
    expect(firstTab).not.toHaveClass('pr-8');
    // BST-1836 D2: overflow has no chevrons; the All-tabs menu is the affordance.
    expect(screen.queryByRole('button', { name: /Scroll assistant tabs/ })).toBeNull();
    expect(within(tabStrip).getByRole('button', { name: 'All tabs' })).toBeInTheDocument();
    expect(newThreadButton).toHaveClass(...TAB_STRIP_ICON_BUTTON_CLASS_NAME.split(' '));
    expect(newThreadButton).toHaveAttribute('data-size', 'xs');
    expect(screen.getByTestId('assistant-new-thread-label')).toHaveClass(
      'hidden',
      '@min-[380px]/tab-strip:inline'
    );
    expect(firstTab).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('links tabs and force-mounted panels while keeping one tab in the page tab sequence', async () => {
    renderWorkspace();

    const firstTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
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

  it('renders the Threads-panel identity mark on each tab and leaves unassigned tabs neutral', async () => {
    renderWorkspace();

    const coloredTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    expect(coloredTab).toHaveAttribute('data-thread-color', 'rose');
    // Color lives on the leading identity mark; the old top accent stripe is gone.
    expect(within(coloredTab).getByTestId('thread-color-rose')).toBeVisible();
    expect(screen.queryByTestId('assistant-thread-tab-accent-rose')).not.toBeInTheDocument();

    openThreadTabs('thread-b');
    const neutralTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    expect(neutralTab).toHaveAttribute('data-thread-color', 'unassigned');
    expect(within(neutralTab).getByTestId('thread-color-unassigned')).toBeVisible();
    expect(within(neutralTab).getByTestId('thread-icon-message')).toBeVisible();
  });

  it('projects durable icon and color updates into an already-open tab without remounting it', async () => {
    renderWorkspace();

    const tab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    const panel = screen.getByTestId('assistant-thread-panel-thread-a');
    expect(within(tab).getByTestId('thread-icon-research')).toBeVisible();

    const repository = {
      updateThreadMetadata: vi.fn(() => Promise.resolve()),
    } as unknown as AssistantThreadRepository;

    await act(async () => {
      await useAssistantThreadStore
        .getState()
        .updateThreadMetadata(repository, WORKSPACE_MEMORY_RESOURCE_ID, 'thread-a', {
          color: 'violet',
          icon: 'bug',
        });
    });

    expect(repository.updateThreadMetadata).toHaveBeenCalledWith('thread-a', {
      color: 'violet',
      icon: 'bug',
    });
    expect(within(tab).getByTestId('thread-icon-bug')).toBeVisible();
    expect(tab).toHaveAttribute('data-thread-color', 'violet');
    expect(screen.getByTestId('assistant-thread-panel-thread-a')).toBe(panel);
  });

  it('tints the whole tab with the same color surface the threads panel row uses', async () => {
    renderWorkspace();

    const shellOf = (name: RegExp): HTMLElement | null =>
      screen.getByRole('tab', { name }).closest('[data-slot="tab-shell"]');
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    // Active tab = the panel row's selected fill, not the neutral raised surface.
    expect(shellOf(/Purchasing app search log/)).toHaveClass(
      ...ASSISTANT_THREAD_COLOR_PRESENTATION.rose.selectedClassName.split(' ')
    );
    expect(shellOf(/Purchasing app search log/)).not.toHaveClass('bg-background');

    openThreadTabs('thread-b');

    expect(shellOf(/Purchasing app search log/)).toHaveClass(
      ...ASSISTANT_THREAD_COLOR_PRESENTATION.rose.idleClassName.split(' ')
    );
    expect(shellOf(/Purchasing app search log/)).not.toHaveClass('hover:bg-background/70');
    // Unassigned threads still get a surface — neutral, never blue.
    expect(shellOf(/Amazon Bedrock Converse/)).toHaveClass(
      ...UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION.selectedClassName.split(' ')
    );
  });

  it('sizes the tab from the tab-strip tokens around the shared thread mark', async () => {
    renderWorkspace();

    const tab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    const shell = tab.closest('[data-slot="tab-shell"]');
    // 28px pill on the token scale; the selected tint supplies the ring, so no border.
    expect(shell).toHaveClass('h-7', 'rounded-md');
    expect(shell).not.toHaveClass('border');
    // 12px/500 in every state: state changes colour, never weight.
    expect(tab).toHaveClass('text-xs', 'font-medium');
    expect(shell).toHaveClass('text-foreground');

    openThreadTabs('thread-b');
    const idleShell = screen
      .getByRole('tab', { name: /Purchasing app search log/ })
      .closest('[data-slot="tab-shell"]');
    expect(idleShell).toHaveClass('text-muted-foreground');
    expect(idleShell).not.toHaveClass('text-foreground');
    const mark = within(tab).getByTestId('thread-color-rose');
    expect(mark).toHaveClass(...THREAD_CONTROL_MARK_CLASS_NAME.split(' '));
    // The tab body is tinted, so the mark must not reuse that same fill or it
    // vanishes into the control it identifies.
    expect(mark).toHaveClass(...ASSISTANT_THREAD_COLOR_PRESENTATION.rose.markClassName.split(' '));
    expect(mark).not.toHaveClass('bg-rose-100');
  });

  it('keeps the mouse-only close affordance in flow and optically matched with the mark', async () => {
    renderWorkspace();

    const tab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    // BST-1836: the ✕ is a mouse-only sibling — out of the AT tree and tab order.
    const closeButton = screen.getByTitle('Close Purchasing app search log');
    expect(closeButton).toHaveAttribute('aria-hidden', 'true');
    expect(closeButton).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByRole('button', { name: /Close Purchasing/ })).toBeNull();

    expect(closeButton).not.toHaveClass('absolute');
    expect(closeButton.parentElement).toBe(tab.parentElement);
    // The same affordance geometry the threads-panel row actions use.
    expect(closeButton).toHaveClass(...THREAD_CONTROL_ACTION_CLASS_NAME.split(' '));
    // Tinted tabs: the hover fill rides the surface instead of an opaque chip.
    expect(closeButton).not.toHaveClass('hover:bg-muted');
    expect(closeButton.className).toMatch(/hover:bg-foreground\//);
    // Visual box is 20px; the pseudo-element extends the hit target to 28px.
    expect(closeButton.className).toMatch(/after:-inset-1/);

    // Leading and close glyphs share one optical size (12px in a 20px box).
    const mark = within(tab).getByTestId('thread-color-rose');
    expect(mark).toHaveClass('size-5');
    expect(mark.querySelector('svg')).toHaveClass('size-3');
    expect(closeButton.querySelector('svg')).toHaveClass('size-3');
  });

  it('moves focus with Arrow, Home and End and activates only on Enter or Space', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const firstTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
    const secondTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });

    secondTab.focus();
    await user.keyboard('{ArrowLeft}');
    expect(firstTab).toHaveFocus();
    // BST-1836 D3: manual activation — arrows never switch the thread.
    expect(activeThreadId()).toBe('thread-b');
    expect(firstTab).toHaveAttribute('aria-selected', 'false');

    await user.keyboard('{End}');
    expect(secondTab).toHaveFocus();
    await user.keyboard('{Home}');
    expect(firstTab).toHaveFocus();
    expect(activeThreadId()).toBe('thread-b');

    await user.keyboard('{Enter}');
    await waitFor(() => expect(firstTab).toHaveAttribute('aria-selected', 'true'));
    expect(activeThreadId()).toBe('thread-a');

    await user.keyboard('{ArrowRight}');
    expect(secondTab).toHaveFocus();
    await user.keyboard(' ');
    await waitFor(() => expect(activeThreadId()).toBe('thread-b'));
  });

  it('closes the focused tab with Delete and moves focus to the following tab', async () => {
    addThreadRow('thread-c', 'Release checklist');
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b', 'thread-c', 'thread-b');
    const middleTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    const followingTab = screen.getByRole('tab', { name: /Release checklist/ });

    middleTab.focus();
    fireEvent.keyDown(middleTab, { key: 'Delete' });

    await waitFor(() => expect(followingTab).toHaveFocus());
    expect(screen.queryByRole('tab', { name: /Amazon Bedrock Converse/ })).not.toBeInTheDocument();
    expect(followingTab).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps activation and focus where they were when the mouse closes an inactive tab', async () => {
    addThreadRow('thread-c', 'Release checklist');
    renderWorkspace();
    const activeTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b', 'thread-c', 'thread-a');
    activeTab.focus();

    fireEvent.click(screen.getByTitle('Close Amazon Bedrock Converse'));

    expect(openThreadIds()).toEqual(['thread-a', 'thread-c']);
    // The ✕ never takes focus (mouse-only), so focus stays on what the user had.
    expect(activeTab).toHaveFocus();
    expect(activeTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Release checklist/ })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('reorders tabs with Alt+Shift+Arrow without changing the active thread', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
    const activeTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });

    activeTab.focus();
    fireEvent.keyDown(activeTab, { altKey: true, key: 'ArrowLeft', shiftKey: true });

    await waitFor(() => {
      expect(openThreadIds()).toEqual(['thread-b', 'thread-a']);
    });
    await waitFor(() => expect(activeTab).toHaveFocus());
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

  it('lists every open thread in the All-tabs menu and closes them all from it', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');

    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual([
      'Purchasing app search log',
      'Amazon Bedrock Converse',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Close All' }));

    expect(openThreadIds()).toEqual([]);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('uses instant scroll behavior when reduced motion is requested', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
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

      openThreadTabs('thread-b');

      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenLastCalledWith({
          behavior: 'auto',
          block: 'nearest',
          inline: 'nearest',
        })
      );
    } finally {
      matchMediaSpy.mockRestore();
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('scrolls the newly active tab into view without moving the vertical page', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      renderWorkspace();
      await screen.findByRole('tab', { name: /Purchasing app search log/ });

      openThreadTabs('thread-b');

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
    openThreadTabs('thread-b');
    const inactiveTab = screen.getByRole('tab', { name: /Purchasing app search log/ });

    fireEvent.contextMenu(inactiveTab);
    expect(activeThreadId()).toBe('thread-b');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Thread Title' }));
    await waitFor(() => {
      expect(writtenTexts).toEqual(['Purchasing app search log']);
    });

    fireEvent.contextMenu(inactiveTab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Others' }));

    expect(openThreadIds()).toEqual(['thread-a']);
    expect(activeThreadId()).toBe('thread-a');
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

  it('offers the standard tab menu plus the global thread copy actions', async () => {
    renderWorkspace();
    const tab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');

    fireEvent.contextMenu(tab);
    const menu = await screen.findByRole('menu');
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Close',
        'Close Others',
        'Close to the Right',
        'Close All',
        'Move Left',
        'Move Right',
        'Copy Thread Title',
        'Copy Thread ID',
      ])
    );
    expect(labels).toHaveLength(8);
  });

  it('restores focus after closing a tab from its context menu', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
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
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close All' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New assistant thread' })).toHaveFocus();
    });
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('closes tabs to the right from the claimed tab and disables the no-op action', async () => {
    addThreadRow('thread-c', 'Release checklist');
    renderWorkspace();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Purchasing app search log/ })).toBeVisible();
    });
    openThreadTabs('thread-b', 'thread-c');
    const middleTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });

    fireEvent.contextMenu(middleTab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close to the Right' }));

    expect(openThreadIds()).toEqual(['thread-a', 'thread-b']);
    expect(activeThreadId()).toBe('thread-b');

    fireEvent.contextMenu(middleTab);
    expect(await screen.findByRole('menuitem', { name: 'Close to the Right' })).toHaveAttribute(
      'data-disabled'
    );
  });

  it('moves a tab left from its context action while preserving focus identity', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
    const secondTab = screen.getByRole('tab', { name: /Amazon Bedrock Converse/ });
    secondTab.focus();

    fireEvent.contextMenu(secondTab);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move Left' }));

    await waitFor(() => {
      expect(openThreadIds()).toEqual(['thread-b', 'thread-a']);
    });
    await waitFor(() => expect(secondTab).toHaveFocus());
  });

  it('exposes Move Right and disables movement beyond the left edge', async () => {
    renderWorkspace();
    const firstTab = await screen.findByRole('tab', { name: /Purchasing app search log/ });
    openThreadTabs('thread-b');
    firstTab.focus();

    fireEvent.contextMenu(firstTab);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Move Left' })).toHaveAttribute(
      'data-disabled'
    );
    const moveRight = within(menu).getByRole('menuitem', { name: 'Move Right' });
    expect(moveRight).not.toHaveAttribute('data-disabled');
  });

  it('offers New Thread and Close All from the empty strip background', async () => {
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-00000000000f');
    renderWorkspace();
    await screen.findByRole('tab', { name: /Purchasing app search log/ });

    fireEvent.contextMenu(screen.getByTestId('assistant-thread-tab-strip'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['New Thread', 'Close All']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New Thread' }));

    await waitFor(() => {
      expect(
        screen.getByTestId('assistant-thread-panel-thread-00000000-0000-4000-8000-00000000000f')
      ).toBeVisible();
    });
    uuidSpy.mockRestore();

    fireEvent.contextMenu(screen.getByTestId('assistant-thread-tab-strip'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close All' }));
    expect(openThreadIds()).toEqual([]);
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
    openThreadTabs('thread-b');
    await user.click(screen.getByTitle('Close Amazon Bedrock Converse'));

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
