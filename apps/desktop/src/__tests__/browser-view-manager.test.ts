import { describe, expect, it, vi } from 'vitest';
import {
  type BrowserPaneView,
  type BrowserTabState,
  BrowserViewManager,
  normalizeUrl,
  type PaneRect,
} from '../browser/browser-view-manager';

interface FakeView extends BrowserPaneView {
  readonly calls: {
    bounds: PaneRect[];
    visible: boolean[];
    loaded: string[];
    closed: boolean;
  };
  emit(event: string): void;
  readonly listeners: Map<string, Array<(...args: unknown[]) => void>>;
  navState: { back: boolean; forward: boolean; title: string; url: string };
}

function createFakeView(id: number): FakeView {
  const calls = {
    bounds: [] as PaneRect[],
    closed: false,
    loaded: [] as string[],
    visible: [] as boolean[],
  };
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const navState = { back: false, forward: false, title: '', url: 'about:blank' };
  let openHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | null = null;
  return {
    get __openHandler() {
      return openHandler;
    },
    calls,
    emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    listeners,
    navState,
    setBounds: (rect) => calls.bounds.push(rect),
    setVisible: (visible) => calls.visible.push(visible),
    webContents: {
      canGoBack: () => navState.back,
      canGoForward: () => navState.forward,
      close: () => {
        calls.closed = true;
      },
      getTitle: () => navState.title,
      getURL: () => navState.url,
      goBack: vi.fn(),
      goForward: vi.fn(),
      id,
      loadURL: (url) => {
        calls.loaded.push(url);
        navState.url = url;
        return Promise.resolve();
      },
      on: (event, listener) => {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
      setWindowOpenHandler: (handler) => {
        openHandler = handler;
      },
    },
  } as FakeView & { __openHandler: typeof openHandler };
}

function setup() {
  const created: FakeView[] = [];
  const added: BrowserPaneView[] = [];
  const removed: BrowserPaneView[] = [];
  let counter = 0;
  const onTabsChanged = vi.fn<(tabs: readonly BrowserTabState[]) => void>();
  const manager = new BrowserViewManager({
    createView: () => {
      const view = createFakeView(created.length + 1);
      created.push(view);
      return view;
    },
    hostWindow: {
      contentView: {
        addChildView: (view) => added.push(view),
        removeChildView: (view) => removed.push(view),
      },
    },
    mintTabId: () => `tab-${++counter}`,
    onTabsChanged,
    partition: 'persist:browser-pane-test',
  });
  return { added, created, manager, onTabsChanged, removed };
}

describe('normalizeUrl', () => {
  it('defaults blank to about:blank, keeps schemes, adds https to bare hosts', () => {
    expect(normalizeUrl(undefined)).toBe('about:blank');
    expect(normalizeUrl('  ')).toBe('about:blank');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeUrl('data:text/html,<p>hi</p>')).toBe('data:text/html,<p>hi</p>');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });
});

describe('BrowserViewManager', () => {
  it('creates a tab: attaches the view, loads the url, makes it active and visible', () => {
    const { added, created, manager } = setup();
    const tabId = manager.createTab('example.com');

    expect(added).toHaveLength(1);
    expect(created[0]?.calls.loaded).toEqual(['https://example.com']);
    const tabs = manager.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ active: true, tabId });
    expect(created[0]?.calls.visible.at(-1)).toBe(true);
  });

  it('shows only the active tab; selecting hides the rest', () => {
    const { created, manager } = setup();
    manager.createTab('a.com');
    const second = manager.createTab('b.com');

    // Second is active now → first invisible, second visible.
    expect(created[0]?.calls.visible.at(-1)).toBe(false);
    expect(created[1]?.calls.visible.at(-1)).toBe(true);

    manager.selectTab(manager.listTabs()[0]?.tabId ?? '');
    expect(created[0]?.calls.visible.at(-1)).toBe(true);
    expect(created[1]?.calls.visible.at(-1)).toBe(false);
    expect(manager.listTabs().find((tab) => tab.tabId === second)?.active).toBe(false);
  });

  it('applies the reported bounds to the active view and re-applies on activation', () => {
    const { created, manager } = setup();
    manager.createTab('a.com');
    const rect = { height: 400, width: 600, x: 10, y: 20 };
    manager.setBounds(rect);
    expect(created[0]?.calls.bounds.at(-1)).toEqual(rect);

    manager.createTab('b.com');
    expect(created[1]?.calls.bounds.at(-1)).toEqual(rect);
  });

  it('occludes the active view (modal open) and restores it, without touching geometry while hidden', () => {
    const { created, manager } = setup();
    manager.createTab('a.com');
    manager.setBounds({ height: 400, width: 600, x: 0, y: 0 });
    const boundsCallsBefore = created[0]?.calls.bounds.length ?? 0;

    manager.setOccluded(true);
    expect(created[0]?.calls.visible.at(-1)).toBe(false);
    // No new bounds applied while hidden.
    expect(created[0]?.calls.bounds.length).toBe(boundsCallsBefore);

    manager.setOccluded(false);
    expect(created[0]?.calls.visible.at(-1)).toBe(true);
    expect(created[0]?.calls.bounds.length).toBe(boundsCallsBefore + 1);
  });

  it('keeps a newly created tab hidden if a modal is currently occluding the pane', () => {
    const { created, manager } = setup();
    manager.createTab('a.com');
    manager.setOccluded(true);
    manager.createTab('b.com');
    // The new active tab must NOT paint over the open modal.
    expect(created[1]?.calls.visible.at(-1)).toBe(false);
  });

  it('turns popups into new tabs instead of OS windows', () => {
    const { added, created, manager } = setup();
    manager.createTab('a.com');
    const handler = (
      created[0] as unknown as { __openHandler: (d: { url: string }) => { action: string } }
    ).__openHandler;
    const result = handler({ url: 'https://popup.example' });

    expect(result.action).toBe('deny');
    expect(manager.listTabs()).toHaveLength(2);
    expect(added).toHaveLength(2);
    expect(created[1]?.calls.loaded).toEqual(['https://popup.example']);
  });

  it('navigates: loads urls, and only goes back/forward when history allows', () => {
    const { created, manager } = setup();
    const tabId = manager.createTab('a.com');
    manager.navigate(tabId, 'other.com');
    expect(created[0]?.calls.loaded.at(-1)).toBe('https://other.com');

    manager.navigate(tabId, 'back');
    expect(created[0]?.webContents.goBack).not.toHaveBeenCalled();
    created[0]!.navState.back = true;
    manager.navigate(tabId, 'back');
    expect(created[0]?.webContents.goBack).toHaveBeenCalledTimes(1);
  });

  it('closing the active tab activates the most recent remaining tab', () => {
    const { manager, removed } = setup();
    const first = manager.createTab('a.com');
    const second = manager.createTab('b.com');
    manager.createTab('c.com'); // active

    manager.closeTab(manager.listTabs().find((t) => t.active)?.tabId ?? '');
    expect(removed).toHaveLength(1);
    const active = manager.listTabs().find((tab) => tab.active);
    expect(active?.tabId).toBe(second);
    expect(manager.listTabs().map((t) => t.tabId)).toEqual([first, second]);
  });

  it('closing the last tab leaves no active tab and no crash', () => {
    const { manager } = setup();
    const only = manager.createTab('a.com');
    manager.closeTab(only);
    expect(manager.listTabs()).toEqual([]);
  });

  it('re-emits tab state when a view navigates or its title changes', () => {
    const { created, manager, onTabsChanged } = setup();
    manager.createTab('a.com');
    onTabsChanged.mockClear();
    created[0]!.navState.title = 'Example';
    created[0]?.emit('page-title-updated');
    expect(onTabsChanged).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ title: 'Example' })])
    );
  });

  it('dispose destroys every view and detaches it', () => {
    const { manager, removed } = setup();
    manager.createTab('a.com');
    manager.createTab('b.com');
    manager.dispose();
    expect(removed).toHaveLength(2);
    expect(manager.listTabs()).toEqual([]);
  });
});
