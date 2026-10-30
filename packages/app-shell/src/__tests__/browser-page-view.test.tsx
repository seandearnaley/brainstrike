/**
 * A browser page in its own workspace tab (BST-1271): the tab is named after
 * the page, and main's native view covers the tab's body only while the tab
 * is selected and nothing drops over it.
 */
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { WorkspaceTabsContext, type WorkspaceTabsValue } from '@brainstrike/file-explorer-ui/shell';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { act } from '@brainstrike/test-utils/react-act';
import { resetToastStore, toast } from '@brainstrike/ui';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBridge, BrowserTab } from '../browser-pane/browser-bridge';
import { browserPageTabId } from '../browser-pane/browser-page-tab';
import { useBrowserTabsStore } from '../browser-pane/browser-tabs-store';
import { useBrowserWorkspaceApps } from '../browser-pane/use-browser-workspace-apps';
import { useCommandPaletteStore } from '../stores/command-palette-store';

const bridge = {
  closeTab: vi.fn(() => Promise.resolve()),
  createTab: vi.fn(() => Promise.resolve('new')),
  goBack: vi.fn(() => Promise.resolve()),
  goForward: vi.fn(() => Promise.resolve()),
  listTabs: vi.fn(() => Promise.resolve([] as BrowserTab[])),
  navigate: vi.fn(() => Promise.resolve()),
  onTabsChanged: vi.fn(() => () => undefined),
  reload: vi.fn(() => Promise.resolve()),
  setBounds: vi.fn(() => Promise.resolve()),
  setOccluded: vi.fn(() => Promise.resolve()),
  showTab: vi.fn(() => Promise.resolve()),
} satisfies BrowserBridge;

const PAGE: BrowserTab = {
  canGoBack: true,
  canGoForward: false,
  isLoading: false,
  owner: 'user',
  tabId: 'p1',
  threadId: 'thread-a',
  title: 'Docs',
  url: 'https://docs.test/',
};
const PAGE_TAB = browserPageTabId(PAGE);

function PageTabs({ isMenuOpen }: { readonly isMenuOpen: boolean }) {
  const apps = useBrowserWorkspaceApps(bridge);
  const tabs = { isMenuOpen } as unknown as WorkspaceTabsValue;
  return (
    <WorkspaceTabsContext.Provider value={tabs}>
      {apps.map((app) => (
        <section aria-label={app.label} key={app.id}>
          {app.render()}
        </section>
      ))}
    </WorkspaceTabsContext.Provider>
  );
}

/** One animation frame, so a pending bounds report has flushed. */
function nextFrame(): Promise<void> {
  return act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useBrowserTabsStore.getState().setTabs([PAGE]);
  useCommandPaletteStore.setState({ isOpen: false });
  usePanelLayoutStore.getState().setActiveTab('explorer');
  useWorkspaceTabSelectionStore.getState().openApp(PAGE_TAB);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  );
  // happy-dom lays nothing out; give the viewport a real rect.
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
  cleanup();
  act(() => resetToastStore());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useBrowserTabsStore.getState().reset();
  __resetWorkspaceTabSelectionStoreForTests();
});

describe('browser page tab', () => {
  it('shows the selected page over its tab body, and hides it when another tab is selected', async () => {
    render(<PageTabs isMenuOpen={false} />);
    await nextFrame();

    expect(bridge.showTab).toHaveBeenCalledWith('p1');
    expect(bridge.setBounds).toHaveBeenLastCalledWith({ height: 300, width: 600, x: 100, y: 100 });
    expect(bridge.setOccluded).toHaveBeenLastCalledWith(false);

    act(() => useWorkspaceTabSelectionStore.getState().selectApp('context-explorer'));
    expect(bridge.setOccluded).toHaveBeenLastCalledWith(true);
  });

  it('keeps the page hidden while a strip menu or the command palette drops over it', async () => {
    const view = render(<PageTabs isMenuOpen />);
    await nextFrame();
    expect(bridge.setOccluded).not.toHaveBeenCalledWith(false);

    view.rerender(<PageTabs isMenuOpen={false} />);
    await nextFrame();
    expect(bridge.setOccluded).toHaveBeenLastCalledWith(false);

    act(() => useCommandPaletteStore.setState({ isOpen: true }));
    expect(bridge.setOccluded).toHaveBeenLastCalledWith(true);
  });

  it('steps aside while a toast is up, so the toast is not drawn under the page', async () => {
    render(<PageTabs isMenuOpen={false} />);
    await nextFrame();
    expect(bridge.setOccluded).toHaveBeenLastCalledWith(false);

    let saved: ReturnType<typeof toast> | undefined;
    act(() => {
      saved = toast({ description: '/Downloads/thread-debug.json', title: 'Debug pack saved' });
    });
    expect(bridge.setOccluded).toHaveBeenLastCalledWith(true);

    act(() => saved?.dismiss());
    await nextFrame();
    expect(bridge.setOccluded).toHaveBeenLastCalledWith(false);
  });

  it('keeps the page hidden away from the Explorer route', async () => {
    usePanelLayoutStore.getState().setActiveTab('settings');
    render(<PageTabs isMenuOpen={false} />);
    await nextFrame();

    expect(bridge.showTab).not.toHaveBeenCalled();
  });

  it('loads what the person types in the address bar, and goes back', async () => {
    const user = userEvent.setup();
    render(<PageTabs isMenuOpen={false} />);

    const address = screen.getByRole('textbox', { name: 'Address' });
    expect(address).toHaveValue('https://docs.test/');
    await user.clear(address);
    await user.type(address, 'example.com{Enter}');
    expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('p1', 'example.com');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(bridge.goBack).toHaveBeenCalledExactlyOnceWith('p1');
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('names the tab after its page, marks it while it loads, and says when the page is closed', () => {
    const { result } = renderHook(() => useBrowserWorkspaceApps(bridge));
    expect(result.current.map((app) => [app.label, app.status, app.tooltip])).toEqual([
      ['Docs', undefined, 'https://docs.test/'],
    ]);

    act(() => useBrowserTabsStore.getState().setTabs([{ ...PAGE, isLoading: true, title: '' }]));
    expect(result.current.map((app) => [app.label, app.status])).toEqual([
      ['https://docs.test/', 'loading'],
    ]);

    act(() => useBrowserTabsStore.getState().setTabs([]));
    render(<PageTabs isMenuOpen={false} />);
    expect(screen.getByRole('region', { name: 'Browser' })).toHaveTextContent(
      'This page is closed.'
    );
  });

  it('registers no page tab without the desktop browser', () => {
    const { result } = renderHook(() => useBrowserWorkspaceApps(null));
    expect(result.current).toEqual([]);
  });
});
