import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider, resetToastStore, Toaster } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBridge, BrowserTab } from '../browser-pane/browser-bridge';
import { BrowserPaneContent } from '../browser-pane/browser-pane-content';
import { useBrowserTabsStore } from '../browser-pane/browser-tabs-store';
import { useCommandPaletteStore } from '../stores/command-palette-store';
import { useQuickOpenStore } from '../stores/quick-open-store';

let tabsListener: ((tabs: readonly BrowserTab[]) => void) | null = null;
const bridge = {
  closeTab: vi.fn(() => Promise.resolve()),
  createTab: vi.fn(() => Promise.resolve('tab-new')),
  goBack: vi.fn(() => Promise.resolve()),
  goForward: vi.fn(() => Promise.resolve()),
  listTabs: vi.fn(() => Promise.resolve([] as BrowserTab[])),
  navigate: vi.fn(() => Promise.resolve()),
  onTabsChanged: vi.fn((listener: (tabs: readonly BrowserTab[]) => void) => {
    tabsListener = listener;
    return () => {
      tabsListener = null;
    };
  }),
  reload: vi.fn(() => Promise.resolve()),
  selectTab: vi.fn(() => Promise.resolve()),
  setBounds: vi.fn(() => Promise.resolve()),
  setOccluded: vi.fn(() => Promise.resolve()),
} satisfies BrowserBridge;

beforeEach(() => {
  vi.clearAllMocks();
  resetToastStore();
  tabsListener = null;
  useBrowserTabsStore.getState().reset();
  useCommandPaletteStore.setState({ isOpen: false });
  useQuickOpenStore.setState({ isOpen: false });
  usePanelLayoutStore.getState().setActiveTab('browser');
  (window as Window & { browser?: BrowserBridge }).browser = bridge;
  // happy-dom gives a zero-size layout; force a non-zero rect so the visible
  // path reports bounds rather than treating the pane as hidden.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 400,
    height: 300,
    left: 100,
    right: 700,
    toJSON: () => ({}),
    top: 100,
    width: 600,
    x: 100,
    y: 100,
  } as DOMRect);
});

afterEach(() => {
  Reflect.deleteProperty(window as Window & { browser?: unknown }, 'browser');
  vi.restoreAllMocks();
});

function tab(overrides: Partial<BrowserTab>): BrowserTab {
  return {
    active: false,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    tabId: 't',
    title: '',
    url: 'about:blank',
    ...overrides,
  };
}

/** The pane mounts under the app's ActionRegistryProvider; the Toaster shows menu outcomes. */
function renderPane() {
  const { registry } = createTestActionRegistry();
  return render(
    <ActionRegistryProvider registry={registry}>
      <BrowserPaneContent />
      <Toaster />
    </ActionRegistryProvider>
  );
}

function pushTabs(tabs: readonly BrowserTab[]): void {
  act(() => {
    tabsListener?.(tabs);
  });
}

/** One animation frame, so a pending bounds/occlusion report has flushed. */
function nextFrame(): Promise<void> {
  return act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      })
  );
}

const THREE_TABS: readonly BrowserTab[] = [
  tab({ active: true, tabId: 'a', title: 'Alpha', url: 'https://a.test/' }),
  tab({ tabId: 'b', title: 'Beta', url: 'https://b.test/' }),
  tab({ tabId: 'c', title: 'Gamma', url: 'https://c.test/' }),
];

const browserTab = (name: string): HTMLElement => screen.getByRole('tab', { name });

describe('BrowserPaneContent', () => {
  it('subscribes to tab pushes and renders the tab strip', async () => {
    renderPane();
    expect(bridge.onTabsChanged).toHaveBeenCalled();
    act(() => {
      tabsListener?.([
        tab({ active: true, tabId: 'a', title: 'Example', url: 'https://example.com' }),
      ]);
    });
    expect(await screen.findByText('Example')).toBeInTheDocument();
  });

  it('honors an authoritative empty push over a late non-empty seed', async () => {
    // The seed round-trip resolves AFTER a push already arrived. If the last
    // tab was closed (empty push), the stale non-empty seed must NOT be
    // reapplied — that would resurrect closed tabs whose actions fail.
    let resolveSeed: (tabs: BrowserTab[]) => void = () => undefined;
    bridge.listTabs.mockReturnValueOnce(
      new Promise<BrowserTab[]>((resolve) => {
        resolveSeed = resolve;
      })
    );
    renderPane();

    act(() => {
      tabsListener?.([tab({ active: true, tabId: 'a' })]);
      tabsListener?.([]); // authoritative empty push (last tab closed)
    });

    await act(async () => {
      resolveSeed([tab({ active: true, tabId: 'a' })]); // stale snapshot, resolves late
      await Promise.resolve();
    });

    expect(useBrowserTabsStore.getState().tabs).toHaveLength(0);
  });

  it('reports bounds to main when the pane is visible', async () => {
    renderPane();
    await waitFor(() => {
      expect(bridge.setBounds).toHaveBeenCalledWith({
        height: 300,
        width: 600,
        x: 100,
        y: 100,
      });
    });
    expect(bridge.setOccluded).toHaveBeenLastCalledWith(false);
  });

  it('occludes the native view when the command palette opens', async () => {
    renderPane();
    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalled());
    bridge.setOccluded.mockClear();

    useCommandPaletteStore.setState({ isOpen: true });
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenCalledWith(true));
  });

  it('occludes the native view when Quick Open opens (separate store from the palette)', async () => {
    renderPane();
    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalled());
    bridge.setOccluded.mockClear();

    act(() => useQuickOpenStore.setState({ isOpen: true }));
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenCalledWith(true));
  });

  it('does not apply a seed after the effect is torn down (StrictMode/unmount race)', async () => {
    // The first effect's listTabs() promise outlives its own cleanup; a late
    // resolve must NOT write the stale seed once the effect was cancelled.
    let resolveSeed: (tabs: BrowserTab[]) => void = () => undefined;
    bridge.listTabs.mockReturnValueOnce(
      new Promise<BrowserTab[]>((resolve) => {
        resolveSeed = resolve;
      })
    );
    const { unmount } = renderPane();
    unmount(); // cleanup sets cancelled = true and unsubscribes

    await act(async () => {
      resolveSeed([tab({ active: true, tabId: 'a' })]);
      await Promise.resolve();
    });

    expect(useBrowserTabsStore.getState().tabs).toHaveLength(0);
  });

  it('logs and resyncs the tab mirror when a tab action rejects (unknown-tab race)', async () => {
    renderPane();
    act(() => {
      tabsListener?.([tab({ active: true, tabId: 'a' })]);
    });
    bridge.closeTab.mockRejectedValueOnce(new Error('unknown tab'));
    bridge.listTabs.mockClear();

    // The ✕ is mouse-only since BST-1840 (spec §6.1): out of the accessibility tree.
    const close = await screen.findByTestId('browser-tab-close-a');
    expect(close).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(close);

    // The rejected action must not become an unhandledrejection — it re-seeds
    // the mirror from main's authoritative list instead.
    await waitFor(() => expect(bridge.listTabs).toHaveBeenCalled());
  });

  it('occludes the native view when the shell navigates to Settings (BST-1668)', async () => {
    // Settings is a shell route, so leaving for it is the same signal as any
    // other tab switch: `activeTab` moves off 'browser'. The pane's own DOM is
    // only toggled hidden by the shell (keep-mounted), so the explicit route
    // signal — not a zero rect — is what must hide the native view.
    renderPane();
    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalled());
    bridge.setOccluded.mockClear();

    usePanelLayoutStore.getState().openSettings();
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenCalledWith(true));
  });

  it('drives back/forward/reload through the dedicated history actions, not navigate', async () => {
    renderPane();
    act(() => {
      tabsListener?.([tab({ active: true, canGoBack: true, canGoForward: true, tabId: 'a' })]);
    });
    fireEvent.click(await screen.findByLabelText('Back'));
    fireEvent.click(screen.getByLabelText('Forward'));
    fireEvent.click(screen.getByLabelText('Reload'));
    expect(bridge.goBack).toHaveBeenCalledWith('a');
    expect(bridge.goForward).toHaveBeenCalledWith('a');
    expect(bridge.reload).toHaveBeenCalledWith('a');
    // navigate must NOT receive 'back'/'forward'/the url for these.
    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  it('occludes the native view when this route is not the active shell tab', async () => {
    renderPane();
    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalled());
    bridge.setOccluded.mockClear();

    usePanelLayoutStore.getState().setActiveTab('explorer');
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenCalledWith(true));
  });

  it('navigates the active tab from the URL bar', async () => {
    renderPane();
    act(() => {
      tabsListener?.([tab({ active: true, tabId: 'a', url: 'https://a.com' })]);
    });
    const input = await screen.findByTestId('browser-url-input');
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form') ?? input);
    expect(bridge.navigate).toHaveBeenCalledWith('a', 'example.com');
  });

  it('opens a new tab from the + button', () => {
    renderPane();
    fireEvent.click(screen.getByTestId('browser-new-tab'));
    expect(bridge.createTab).toHaveBeenCalledWith();
  });
});

describe('BrowserPaneContent tab strip (BST-1840)', () => {
  it('renders the tabs as a named strip whose tabs control the reserved pane region', () => {
    renderPane();
    pushTabs([
      tab({ active: true, tabId: 'a', title: 'Alpha', url: 'https://a.test/' }),
      tab({ tabId: 'b', url: 'https://b.test/' }),
      tab({ tabId: 'c', url: '' }),
      tab({ isLoading: true, tabId: 'd', title: 'Delta', url: 'https://d.test/' }),
    ]);

    const tablist = screen.getByRole('tablist', { name: 'Browser tabs' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((element) => element.textContent)
    ).toEqual(['Alpha', 'https://b.test/', 'New Tab', 'Delta']);
    const alpha = browserTab('Alpha');
    expect(alpha).toHaveAttribute('id', 'browser-tab-a');
    expect(alpha).toHaveAttribute('data-testid', 'browser-tab-a');
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    expect(alpha).toHaveAttribute('title', 'https://a.test/');
    expect(browserTab('Delta, loading')).toHaveAttribute('aria-selected', 'false');

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('data-testid', 'browser-pane-viewport');
    expect(alpha).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', 'browser-tab-a');
    expect(screen.getByTestId('browser-new-tab').closest('[role="tablist"]')).toBeNull();
  });

  it('selects a tab on click or Enter, never on arrow focus (manual activation)', async () => {
    const user = userEvent.setup();
    renderPane();
    pushTabs(THREE_TABS);

    await user.click(browserTab('Beta'));
    expect(bridge.selectTab).toHaveBeenCalledExactlyOnceWith('b');
    bridge.selectTab.mockClear();

    browserTab('Alpha').focus();
    await user.keyboard('{ArrowRight}');
    expect(browserTab('Beta')).toHaveFocus();
    await user.keyboard('{End}');
    expect(browserTab('Gamma')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(browserTab('Alpha')).toHaveFocus();
    expect(bridge.selectTab).not.toHaveBeenCalled();

    await user.keyboard('{ArrowRight}{Enter}');
    expect(bridge.selectTab).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('closes the focused tab with Delete through the bridge', async () => {
    const user = userEvent.setup();
    renderPane();
    pushTabs(THREE_TABS);

    browserTab('Beta').focus();
    await user.keyboard('{Delete}');
    expect(bridge.closeTab).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('opens a tab menu with Close, Close Others, Close All, Reload and Duplicate', async () => {
    renderPane();
    pushTabs(THREE_TABS);

    fireEvent.contextMenu(browserTab('Beta'));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Close',
      'Close Others',
      'Close All',
      'Reload',
      'Duplicate',
    ]);
  });

  it.each([
    ['Close', () => expect(bridge.closeTab.mock.calls).toEqual([['b']])],
    ['Close Others', () => expect(bridge.closeTab.mock.calls).toEqual([['a'], ['c']])],
    ['Close All', () => expect(bridge.closeTab.mock.calls).toEqual([['a'], ['b'], ['c']])],
    ['Reload', () => expect(bridge.reload).toHaveBeenCalledExactlyOnceWith('b')],
    [
      'Duplicate',
      () => expect(bridge.createTab).toHaveBeenCalledExactlyOnceWith('https://b.test/'),
    ],
  ])('runs %s against the right-clicked tab through the bridge', async (label, assertCalls) => {
    const user = userEvent.setup();
    renderPane();
    pushTabs(THREE_TABS);

    fireEvent.contextMenu(browserTab('Beta'));
    await user.click(await screen.findByRole('menuitem', { name: label }));
    await waitFor(assertCalls);
    expect(screen.queryByText('Action failed')).toBeNull();
  });

  it.each([
    ['Reload', () => bridge.reload.mockRejectedValueOnce(new Error('unknown tab b'))],
    ['Duplicate', () => bridge.createTab.mockRejectedValueOnce(new Error('unknown tab b'))],
  ])(
    'reports a rejected %s as a failed action and re-seeds the tab mirror',
    async (label, reject) => {
      const user = userEvent.setup();
      reject();
      renderPane();
      pushTabs(THREE_TABS);
      bridge.listTabs.mockClear();

      fireEvent.contextMenu(browserTab('Beta'));
      await user.click(await screen.findByRole('menuitem', { name: label }));

      expect(await screen.findByText('Action failed')).toBeInTheDocument();
      expect(screen.getByText('unknown tab b')).toBeInTheDocument();
      await waitFor(() => expect(bridge.listTabs).toHaveBeenCalledOnce());
    }
  );

  it('re-seeds the tab mirror when a menu Close rejects', async () => {
    const user = userEvent.setup();
    bridge.closeTab.mockRejectedValueOnce(new Error('unknown tab b'));
    renderPane();
    pushTabs(THREE_TABS);
    bridge.listTabs.mockClear();

    fireEvent.contextMenu(browserTab('Beta'));
    await user.click(await screen.findByRole('menuitem', { name: 'Close' }));
    await waitFor(() => expect(bridge.listTabs).toHaveBeenCalledOnce());
  });

  it('disables Reload and Duplicate once the right-clicked tab has closed', async () => {
    renderPane();
    pushTabs(THREE_TABS);

    fireEvent.contextMenu(browserTab('Beta'));
    await screen.findByRole('menu');
    pushTabs([THREE_TABS[0] ?? tab({}), THREE_TABS[2] ?? tab({})]);

    for (const label of ['Reload', 'Duplicate']) {
      expect(screen.getByRole('menuitem', { name: label })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
    }
  });

  it.each([
    ['Reload', bridge.reload],
    ['Duplicate', bridge.createTab],
  ])('refuses %s when the tab closed before the menu re-rendered', async (label, bridgeCall) => {
    renderPane();
    pushTabs(THREE_TABS);
    fireEvent.contextMenu(browserTab('Beta'));
    const item = await screen.findByRole('menuitem', { name: label });

    // Main's push lands between the menu's last render and the click: the run
    // re-checks the live mirror instead of trusting its enabled state. The push
    // is deliberately outside act() (React warns) so the re-render stays pending.
    useBrowserTabsStore.setState({ tabs: [THREE_TABS[0] ?? tab({}), THREE_TABS[2] ?? tab({})] });
    fireEvent.click(item);

    expect(await screen.findByText('This browser tab is no longer open')).toBeInTheDocument();
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('offers only New Tab on the empty strip background', async () => {
    const user = userEvent.setup();
    renderPane();
    pushTabs(THREE_TABS);

    fireEvent.contextMenu(screen.getByRole('tablist', { name: 'Browser tabs' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['New Tab']);
    await user.click(screen.getByRole('menuitem', { name: 'New Tab' }));
    await waitFor(() => expect(bridge.createTab).toHaveBeenCalledExactlyOnceWith());
  });
});

describe('BrowserPaneContent occlusion while a tab-strip menu is open (BST-1840)', () => {
  const VISIBLE_RECT = { height: 300, width: 600, x: 100, y: 100 };

  async function renderVisiblePane(): Promise<void> {
    renderPane();
    pushTabs(THREE_TABS);
    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalledWith(VISIBLE_RECT));
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenLastCalledWith(false));
    bridge.setBounds.mockClear();
    bridge.setOccluded.mockClear();
  }

  it('occludes the native view while the tab menu is open, then re-reports bounds', async () => {
    const user = userEvent.setup();
    await renderVisiblePane();

    fireEvent.contextMenu(browserTab('Beta'));
    await screen.findByRole('menu');
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenLastCalledWith(true));
    expect(bridge.setBounds).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenLastCalledWith(false));
    expect(bridge.setBounds).toHaveBeenCalledExactlyOnceWith(VISIBLE_RECT);
    // Position before reveal: the view never appears at a stale rect.
    expect(bridge.setBounds.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.setOccluded.mock.invocationCallOrder.at(-1) ?? 0
    );
  });

  it('occludes the native view while the All-tabs menu is open', async () => {
    const user = userEvent.setup();
    await renderVisiblePane();

    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(3);
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenLastCalledWith(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenLastCalledWith(false));
  });

  it('stays occluded when the All-tabs menu opens straight from an open tab menu', async () => {
    const user = userEvent.setup();
    await renderVisiblePane();

    fireEvent.contextMenu(browserTab('Beta'));
    await screen.findByRole('menu');
    await user.click(screen.getByRole('button', { name: 'All tabs' }));
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(3);
    await nextFrame();
    await nextFrame();

    expect(bridge.setOccluded).toHaveBeenLastCalledWith(true);
    expect(bridge.setBounds).not.toHaveBeenCalled();
  });
});
