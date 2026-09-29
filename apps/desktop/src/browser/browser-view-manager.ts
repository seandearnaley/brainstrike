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
  isLoading(): boolean;
  loadURL(url: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  reload(): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow' | 'deny' }): void;
}

export interface BrowserPaneView {
  setBounds(rect: PaneRect): void;
  setVisible(visible: boolean): void;
  readonly webContents: PaneWebContents;
}

export interface BrowserHostWindow {
  /**
   * Reading this THROWS `Object has been destroyed` once the window is
   * destroyed (Electron) — gate on {@link isDestroyed} first.
   */
  readonly contentView: {
    addChildView(view: BrowserPaneView): void;
    removeChildView(view: BrowserPaneView): void;
  };
  /** Safe on a destroyed window; true once the window's native object is gone. */
  isDestroyed(): boolean;
}

export type BrowserPaneViewFactory = (partition: string) => BrowserPaneView;

export interface BrowserTabState {
  readonly active: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** True while the tab's main frame is loading — agent navigate polls this. */
  readonly isLoading: boolean;
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
}

export interface BrowserViewManagerDeps {
  readonly createView: BrowserPaneViewFactory;
  readonly hostWindow: BrowserHostWindow;
  /** Injected id minter (uuidv7) so tests get deterministic ids. */
  readonly mintTabId: () => string;
  /** Optional: a navigation load rejected (bad host, aborted, blocked). */
  readonly onNavigationError?: (event: { readonly error: string; readonly url: string }) => void;
  /** Notifies the renderer that tab state changed (list/nav/title). */
  readonly onTabsChanged: (tabs: readonly BrowserTabState[]) => void;
  /** Dedicated non-default session partition (clean profile). */
  readonly partition: string;
}

interface TrackedTab {
  /** Last load failure for this tab (cleared when a new load starts). */
  navigationError: string | null;
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
    // Attach BEFORE registering: if the host rejects the view, no phantom tab
    // may remain for a later listTabs() resync to paint (2026-08-07 live
    // regression), and the orphaned view's page process must not keep running.
    try {
      this.deps.hostWindow.contentView.addChildView(view);
    } catch (error) {
      try {
        view.webContents.close();
      } catch {
        // Best-effort orphan cleanup; never mask the attach failure.
      }
      throw error;
    }
    const tab: TrackedTab = { navigationError: null, tabId, view };
    this.tabs.set(tabId, tab);
    this.load(tab, normalizeUrl(url));
    this.setActiveTab(tabId);
    return tabId;
  }

  /** @returns `false` when `tabId` names no open tab. */
  closeTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }
    this.tabs.delete(tabId);
    this.deps.hostWindow.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (this.activeTabId === tabId) {
      // Activate the most-recently-inserted remaining tab, or clear.
      const next = [...this.tabs.keys()].at(-1) ?? null;
      this.activeTabId = null;
      if (next) {
        // setActiveTab emits; the empty-list case emits below.
        this.setActiveTab(next);
        return true;
      }
    }
    this.emitTabs();
    return true;
  }

  /** @returns `false` when `tabId` names no open tab. */
  selectTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) {
      return false;
    }
    this.setActiveTab(tabId);
    return true;
  }

  /**
   * Load `url` (or a search) into the tab. This is URL-ONLY — history is a
   * separate concern ({@link goBack}/{@link goForward}), so typing "back" in a
   * URL bar searches for the word rather than moving history.
   * @returns `false` when `tabId` names no open tab.
   */
  navigate(tabId: string, url: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }
    this.load(tab, normalizeUrl(url));
    return true;
  }

  /** @returns `false` when `tabId` names no open tab. */
  goBack(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }
    if (tab.view.webContents.canGoBack()) {
      tab.view.webContents.goBack();
    }
    return true;
  }

  /** @returns `false` when `tabId` names no open tab. */
  goForward(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }
    if (tab.view.webContents.canGoForward()) {
      tab.view.webContents.goForward();
    }
    return true;
  }

  /**
   * Reload the tab, preserving BOTH history stacks (a fresh `loadURL` would
   * truncate the forward stack). @returns `false` when `tabId` is unknown.
   */
  reload(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return false;
    }
    tab.view.webContents.reload();
    return true;
  }

  /**
   * Load a URL, refusing dangerous schemes and swallowing the routine
   * navigation rejections a browser produces (ERR_ABORTED when a load is
   * superseded, ERR_NAME_NOT_RESOLVED on a bad host, …) so they never surface
   * as unhandled promise rejections.
   */
  private load(tab: TrackedTab, url: string): void {
    tab.navigationError = null;
    if (!isNavigableUrl(url)) {
      // A blocked scheme is shown as about:blank rather than reaching the web
      // engine; the renderer's tab state reflects the real (blank) url, and
      // the refusal is queryable so an agent-initiated navigate never reads
      // as a silent success.
      tab.navigationError = `blocked scheme: ${url}`;
      void tab.view.webContents.loadURL('about:blank').catch(() => undefined);
      return;
    }
    tab.view.webContents.loadURL(url).catch((error: unknown) => {
      tab.navigationError = String(error);
      this.deps.onNavigationError?.({ error: String(error), url });
    });
  }

  /**
   * The tab's last load failure (`ERR_NAME_NOT_RESOLVED`, a blocked scheme, …)
   * or null after a clean load. Cleared when a new load starts. Lets the agent
   * navigate tool report `load_failed` instead of an ok-looking blank page.
   */
  getNavigationError(tabId: string): string | null {
    return this.tabs.get(tabId)?.navigationError ?? null;
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

  /**
   * The active tab's `webContents` id, or null when no tab is open. The CDP
   * driver's session resolver uses this to always target whichever tab is
   * active NOW — the manager stays Electron-agnostic and only surfaces the id
   * it already tracks.
   */
  getActiveWebContentsId(): number | null {
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    return active ? active.view.webContents.id : null;
  }

  dispose(): void {
    // `dispose()` runs on TWO paths: a LIVE window (renderer reload / factory
    // reset — the same manager then serves the fresh renderer) and, from the
    // window's `closed` event, an already-DESTROYED one. On a destroyed window
    // `hostWindow.contentView` throws `Object has been destroyed`, and
    // detaching a child from a view tree that died with the window is
    // meaningless — so ONLY the detach is skipped. Every page is still closed:
    // Electron does not destroy a `WebContentsView`'s `webContents` with its
    // window, so skipping `close()` would leak the page process.
    const detachViews = !this.deps.hostWindow.isDestroyed();
    for (const tab of this.tabs.values()) {
      if (detachViews) {
        this.deps.hostWindow.contentView.removeChildView(tab.view);
      }
      tab.view.webContents.close();
    }
    this.tabs.clear();
    this.activeTabId = null;
    // Reset geometry to a SAFE hidden state. This manager instance is REUSED
    // across a renderer reload / factory reset (dispose runs, then the same
    // manager serves the fresh renderer). Retaining the pre-dispose nonzero
    // `bounds`/`occluded` would let a tab created before the new renderer
    // reports geometry reveal a native view at the STALE rect, painting over
    // unrelated chrome. Zero rect + occluded keeps `showActive` hidden until
    // real bounds/occlusion arrive.
    this.bounds = ZERO_RECT;
    this.occluded = true;
    // Tell the renderer the pane is now empty, so a disposed-then-recreated
    // host never leaves phantom tabs in the strip.
    this.emitTabs();
  }

  private setActiveTab(tabId: string): void {
    this.activeTabId = tabId;
    for (const tab of this.tabs.values()) {
      if (tab.tabId === tabId) {
        this.showActive(tab.view);
      } else {
        tab.view.setVisible(false);
      }
    }
    this.emitTabs();
  }

  private applyActiveVisibility(): void {
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (active) {
      this.showActive(active.view);
    }
  }

  /**
   * Position THEN reveal, and never reveal at a zero rect: showing before
   * setBounds paints the view at its stale/zero position for one frame, and a
   * zero rect (occluded, or bounds not yet reported) must stay hidden.
   */
  private showActive(view: BrowserPaneView): void {
    const visible = !this.occluded && this.bounds.width > 0 && this.bounds.height > 0;
    if (visible) {
      view.setBounds(this.bounds);
    }
    view.setVisible(visible);
  }

  private wireView(tabId: string, view: BrowserPaneView): void {
    view.webContents.setWindowOpenHandler(({ url }) => {
      // Popups become new tabs, never OS windows — but the url here is fully
      // attacker-controlled (a page can `window.open('file:///…')`), so it is
      // scheme-filtered exactly like a navigation. A blocked popup is dropped.
      if (isNavigableUrl(url)) {
        this.createTab(url);
      }
      return { action: 'deny' };
    });
    // Navigation, title, AND load-state transitions re-emit tab state to the
    // renderer — did-stop-loading is what flips the pushed `isLoading` back to
    // false (did-navigate alone fires while the document is still loading).
    for (const event of [
      'did-navigate',
      'did-navigate-in-page',
      'did-start-loading',
      'did-stop-loading',
      'page-title-updated',
    ]) {
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
      isLoading: tab.view.webContents.isLoading(),
      tabId: tab.tabId,
      title: tab.view.webContents.getTitle(),
      url: tab.view.webContents.getURL(),
    };
  }

  private emitTabs(): void {
    this.deps.onTabsChanged(this.listTabs());
  }
}

/** Explicit `scheme://authority` at the START of the string (not a substring). */
const HIERARCHICAL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `about:` / `data:` a user may type; NO `file:`/`devtools:`/`chrome:`/`blob:`. */
const PRESERVED_SCHEME = /^(about|data):/i;
/** A bare host: a dotted name, `localhost`, or an explicit `host:port`. */
const BARE_HOST = /^(localhost|[^\s/]+\.[^\s/]+|[^\s/]+:\d+)(\/|$|\?|#)/i;
/** DuckDuckGo query fallback for input that is neither a URL nor a host. */
const SEARCH_PREFIX = 'https://duckduckgo.com/?q=';

/**
 * Normalize URL-bar / popup input to a loadable URL:
 * - blank → `about:blank`
 * - explicit `scheme://…` or `about:`/`data:` → preserved
 * - a bare host (`example.com`, `localhost:3000`) → `https://…`
 * - anything else (`what is rust`) → a search query
 *
 * Dangerous schemes (`file:`, `devtools:`, `chrome:`, `blob:`, `view-source:`)
 * are deliberately NOT preserved — {@link isNavigableUrl} is the final gate.
 */
export function normalizeUrl(url: string | undefined): string {
  const trimmed = url?.trim();
  if (!trimmed) {
    return 'about:blank';
  }
  if (HIERARCHICAL_SCHEME.test(trimmed) || PRESERVED_SCHEME.test(trimmed)) {
    return trimmed;
  }
  if (BARE_HOST.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `${SEARCH_PREFIX}${encodeURIComponent(trimmed)}`;
}

/** Schemes the pane will actually load — everything else is refused. */
const NAVIGABLE_SCHEME = /^(https?|about|data):/i;

/**
 * Final navigation gate (also applied to attacker-controlled popup urls). Only
 * http/https/about/data reach the web engine; `file:`, `devtools:`, `chrome:`,
 * `blob:`, `chrome-extension:` and anything else are refused, so a page can
 * never pivot the pane into reading the local filesystem or privileged UIs.
 */
export function isNavigableUrl(url: string): boolean {
  return NAVIGABLE_SCHEME.test(url.trim());
}
