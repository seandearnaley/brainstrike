/**
 * Main-process manager for the embedded browser pane's `WebContentsView`s
 * (BST-1174) — one view per tab, all attached to the visible window's
 * `contentView`, exactly one shown at a time.
 *
 * WHY A SEPARATE REGISTRY (not `window-role.ts`): a `WebContentsView` is not a
 * `BrowserWindow`; `window-role` is keyed on window `webContents` and tracks
 * top-level windows. Browser tabs are child views of the ONE visible window,
 * so they get their own lifecycle store here.
 *
 * SECURITY POSTURE:
 * - Views run on a DEDICATED session partition (clean profile), never the
 *   default session. This is a CORRECTNESS requirement, not just hygiene:
 *   `setup-security.ts` stamps the app CSP + `X-Frame-Options: DENY` on EVERY
 *   default-session response, which would break every real site the pane
 *   loads. The partition escapes that stamp.
 * - Unlike the visible window (`create-window.ts` `configureSecurity` denies
 *   all non-self navigation), browser views must reach the real web, so their
 *   own `webContents` gets a PERMISSIVE navigation policy — the deny-all never
 *   applied to them (it only binds the window's own `webContents`).
 * - Popups (`window.open`, target=_blank) are intercepted and turned into new
 *   tabs rather than spawning OS windows.
 *
 * This module speaks to narrow structural interfaces ({@link BrowserPaneView},
 * {@link BrowserHostWindow}, {@link BrowserPaneViewFactory}) so it is fully
 * unit-testable without a live Electron window.
 */

export interface PaneRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface PaneWebContents {
  canGoBack(): boolean;
  canGoForward(): boolean;
  close(): void;
  getTitle(): string;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  readonly id: number;
  loadURL(url: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
}

export interface BrowserPaneView {
  setBounds(rect: PaneRect): void;
  setVisible(visible: boolean): void;
  readonly webContents: PaneWebContents;
}

export interface BrowserHostWindow {
  readonly contentView: {
    addChildView(view: BrowserPaneView): void;
    removeChildView(view: BrowserPaneView): void;
  };
}

export type BrowserPaneViewFactory = (partition: string) => BrowserPaneView;

export interface BrowserTabState {
  readonly active: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
}

export interface BrowserViewManagerDeps {
  readonly createView: BrowserPaneViewFactory;
  readonly hostWindow: BrowserHostWindow;
  /** Injected id minter (uuidv7) so tests get deterministic ids. */
  readonly mintTabId: () => string;
  /** Notifies the renderer that tab state changed (list/nav/title). */
  readonly onTabsChanged: (tabs: readonly BrowserTabState[]) => void;
  /** Dedicated non-default session partition (clean profile). */
  readonly partition: string;
}

interface TrackedTab {
  readonly tabId: string;
  readonly view: BrowserPaneView;
}

const ZERO_RECT: PaneRect = { height: 0, width: 0, x: 0, y: 0 };

export class BrowserViewManager {
  private readonly tabs = new Map<string, TrackedTab>();
  private activeTabId: string | null = null;
  private bounds: PaneRect = ZERO_RECT;
  /** True while a renderer modal overlaps the pane — the native view must hide. */
  private occluded = false;

  constructor(private readonly deps: BrowserViewManagerDeps) {}

  createTab(url?: string): string {
    const tabId = this.deps.mintTabId();
    const view = this.deps.createView(this.deps.partition);
    this.wireView(tabId, view);
    this.tabs.set(tabId, { tabId, view });
    this.deps.hostWindow.contentView.addChildView(view);
    void view.webContents.loadURL(normalizeUrl(url));
    this.setActiveTab(tabId);
    return tabId;
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    this.tabs.delete(tabId);
    this.deps.hostWindow.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (this.activeTabId === tabId) {
      // Activate the most-recently-inserted remaining tab, or clear.
      const next = [...this.tabs.keys()].at(-1) ?? null;
      this.activeTabId = null;
      if (next) {
        this.setActiveTab(next);
      }
    }
    this.emitTabs();
  }

  selectTab(tabId: string): void {
    if (this.tabs.has(tabId)) {
      this.setActiveTab(tabId);
    }
  }

  navigate(tabId: string, target: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    if (target === 'back') {
      if (tab.view.webContents.canGoBack()) {
        tab.view.webContents.goBack();
      }
      return;
    }
    if (target === 'forward') {
      if (tab.view.webContents.canGoForward()) {
        tab.view.webContents.goForward();
      }
      return;
    }
    void tab.view.webContents.loadURL(normalizeUrl(target));
  }

  /** Renderer reports the pane's on-screen rect (ResizeObserver → IPC). */
  setBounds(rect: PaneRect): void {
    this.bounds = rect;
    this.applyActiveVisibility();
  }

  /**
   * Occlusion policy: a `WebContentsView` paints ABOVE all renderer DOM, so
   * `layers.ts` z-index cannot place a dialog/popover/toast over it. When the
   * renderer reports a modal is open, the active view is hidden so overlays are
   * never occluded by the pane.
   */
  setOccluded(occluded: boolean): void {
    this.occluded = occluded;
    this.applyActiveVisibility();
  }

  listTabs(): readonly BrowserTabState[] {
    return [...this.tabs.values()].map((tab) => this.toState(tab));
  }

  dispose(): void {
    for (const tab of this.tabs.values()) {
      this.deps.hostWindow.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    }
    this.tabs.clear();
    this.activeTabId = null;
  }

  private setActiveTab(tabId: string): void {
    this.activeTabId = tabId;
    for (const tab of this.tabs.values()) {
      const isActive = tab.tabId === tabId;
      // Inactive tabs are always invisible; the active tab is visible unless
      // occluded by a modal.
      tab.view.setVisible(isActive && !this.occluded);
      if (isActive) {
        tab.view.setBounds(this.bounds);
      }
    }
    this.emitTabs();
  }

  private applyActiveVisibility(): void {
    if (!this.activeTabId) {
      return;
    }
    const active = this.tabs.get(this.activeTabId);
    if (!active) {
      return;
    }
    active.view.setVisible(!this.occluded);
    if (!this.occluded) {
      active.view.setBounds(this.bounds);
    }
  }

  private wireView(tabId: string, view: BrowserPaneView): void {
    view.webContents.setWindowOpenHandler(({ url }) => {
      // Popups become new tabs, never OS windows.
      this.createTab(url);
      return { action: 'deny' };
    });
    // Navigation/title/loading changes re-emit tab state to the renderer.
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
      view.webContents.on(event, () => {
        if (this.tabs.has(tabId)) {
          this.emitTabs();
        }
      });
    }
  }

  private toState(tab: TrackedTab): BrowserTabState {
    return {
      active: tab.tabId === this.activeTabId,
      canGoBack: tab.view.webContents.canGoBack(),
      canGoForward: tab.view.webContents.canGoForward(),
      tabId: tab.tabId,
      title: tab.view.webContents.getTitle(),
      url: tab.view.webContents.getURL(),
    };
  }

  private emitTabs(): void {
    this.deps.onTabsChanged(this.listTabs());
  }
}

/**
 * Non-hierarchical / no-authority schemes a user can type directly and that
 * must be preserved verbatim. Anything else without an explicit `://`
 * authority is treated as a bare host (incl. `localhost:3000`, whose `:3000`
 * is a PORT, not a scheme) and gets `https://`.
 */
const PRESERVED_SCHEME = /^(about|data|blob|file|view-source|chrome|devtools):/i;

/** Blank tabs open to `about:blank`; a bare host gets `https://`. */
export function normalizeUrl(url: string | undefined): string {
  const trimmed = url?.trim();
  if (!trimmed) {
    return 'about:blank';
  }
  if (trimmed.includes('://') || PRESERVED_SCHEME.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}
