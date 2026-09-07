import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('BrowserPaneContent', () => {
  it('subscribes to tab pushes and renders the tab strip', async () => {
    render(<BrowserPaneContent />);
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
    render(<BrowserPaneContent />);

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
    render(<BrowserPaneContent />);
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
    render(<BrowserPaneContent />);
    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalled());
    bridge.setOccluded.mockClear();

    useCommandPaletteStore.setState({ isOpen: true });
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenCalledWith(true));
  });

  it('occludes the native view when Quick Open opens (separate store from the palette)', async () => {
    render(<BrowserPaneContent />);
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
    const { unmount } = render(<BrowserPaneContent />);
    unmount(); // cleanup sets cancelled = true and unsubscribes

    await act(async () => {
      resolveSeed([tab({ active: true, tabId: 'a' })]);
      await Promise.resolve();
    });

    expect(useBrowserTabsStore.getState().tabs).toHaveLength(0);
  });

  it('logs and resyncs the tab mirror when a tab action rejects (unknown-tab race)', async () => {
    render(<BrowserPaneContent />);
    act(() => {
      tabsListener?.([tab({ active: true, tabId: 'a' })]);
    });
    bridge.closeTab.mockRejectedValueOnce(new Error('unknown tab'));
    bridge.listTabs.mockClear();

    fireEvent.click(await screen.findByLabelText('Close tab'));

    // The rejected action must not become an unhandledrejection — it re-seeds
    // the mirror from main's authoritative list instead.
    await waitFor(() => expect(bridge.listTabs).toHaveBeenCalled());
  });

  it('occludes the native view when the shell navigates to Settings (BST-1668)', async () => {
    // Settings is a shell route, so leaving for it is the same signal as any
    // other tab switch: `activeTab` moves off 'browser'. The pane's own DOM is
    // only toggled hidden by the shell (keep-mounted), so the explicit route
    // signal — not a zero rect — is what must hide the native view.
    render(<BrowserPaneContent />);
    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalled());
    bridge.setOccluded.mockClear();

    usePanelLayoutStore.getState().openSettings();
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenCalledWith(true));
  });

  it('drives back/forward/reload through the dedicated history actions, not navigate', async () => {
    render(<BrowserPaneContent />);
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
    render(<BrowserPaneContent />);
    await waitFor(() => expect(bridge.setBounds).toHaveBeenCalled());
    bridge.setOccluded.mockClear();

    usePanelLayoutStore.getState().setActiveTab('explorer');
    await waitFor(() => expect(bridge.setOccluded).toHaveBeenCalledWith(true));
  });

  it('navigates the active tab from the URL bar', async () => {
    render(<BrowserPaneContent />);
    act(() => {
      tabsListener?.([tab({ active: true, tabId: 'a', url: 'https://a.com' })]);
    });
    const input = await screen.findByTestId('browser-url-input');
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form') ?? input);
    expect(bridge.navigate).toHaveBeenCalledWith('a', 'example.com');
  });

  it('opens a new tab from the + button', () => {
    render(<BrowserPaneContent />);
    fireEvent.click(screen.getByTestId('browser-new-tab'));
    expect(bridge.createTab).toHaveBeenCalledWith();
  });
});
