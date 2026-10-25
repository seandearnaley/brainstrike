/**
 * Structural typing + capability resolution for the desktop `window.browser`
 * bridge (BST-1174) — the embedded browser pane.
 *
 * Capability gating (mirrors `changes/changes-bridge.ts` exactly): a consumer
 * is desktop-only because the pane surface is constructed ONLY when
 * `resolveBrowserBridge()` returns a fully-formed bridge. Web never sees it —
 * no `isElectron()` check anywhere. A present-but-malformed bridge logs and
 * stays absent (no silent half-working surface).
 *
 * The bridge is a thin RPC over the `browser` IPC domain backed by
 * `BrowserViewManager` in main; the manager owns the actual `WebContentsView`s.
 */
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('BrowserBridge');

interface BrowserPaneRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface BrowserTab {
  readonly active: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** True while the tab's main frame is loading. */
  readonly isLoading: boolean;
  /** `agent` tabs are the agent's own, browsing behind its egress proxy (BST-1238). */
  readonly owner: 'agent' | 'user';
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
}

export interface BrowserBridge {
  closeTab: (tabId: string) => Promise<void>;
  /** Open a new tab (optionally at `url`); resolves the new tabId. */
  createTab: (url?: string) => Promise<string>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  listTabs: () => Promise<readonly BrowserTab[]>;
  /** Load a URL/search into the tab. History is separate (goBack/goForward). */
  navigate: (tabId: string, url: string) => Promise<void>;
  /** Subscribe to tab-state changes (nav/title/list). Returns unsubscribe. */
  onTabsChanged: (listener: (tabs: readonly BrowserTab[]) => void) => () => void;
  /** Reload preserving both history stacks (not a fresh navigation). */
  reload: (tabId: string) => Promise<void>;
  selectTab: (tabId: string) => Promise<void>;
  /** Report the pane's on-screen rect (renderer ResizeObserver → main). */
  setBounds: (rect: BrowserPaneRect) => Promise<void>;
  /** Hide the native view while a renderer modal overlaps the pane. */
  setOccluded: (occluded: boolean) => Promise<void>;
}

// Compile-time exact-set proof (same device as changes-bridge): adding a
// method to the interface without listing it here fails the build.
const BROWSER_BRIDGE_REQUIRED_METHOD_SET = {
  closeTab: true,
  createTab: true,
  goBack: true,
  goForward: true,
  listTabs: true,
  navigate: true,
  onTabsChanged: true,
  reload: true,
  selectTab: true,
  setBounds: true,
  setOccluded: true,
} as const satisfies Record<keyof BrowserBridge, true>;

/** Exact method set the preload must expose; pinned by the preload contract test. */
export const BROWSER_BRIDGE_REQUIRED_METHODS = Object.keys(
  BROWSER_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof BrowserBridge)[];

function missingBrowserBridgeMethods(bridge: Partial<BrowserBridge>): (keyof BrowserBridge)[] {
  return BROWSER_BRIDGE_REQUIRED_METHODS.filter((method) => typeof bridge[method] !== 'function');
}

/** A bridge exposing every required method is the whole bridge. */
function isCompleteBrowserBridge(bridge: Partial<BrowserBridge>): bridge is BrowserBridge {
  return missingBrowserBridgeMethods(bridge).length === 0;
}

/** Resolve `window.browser`, or `null` when absent (web) or malformed. */
export function resolveBrowserBridge(): BrowserBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = window.browser;
  if (!bridge) {
    return null;
  }
  const missing = missingBrowserBridgeMethods(bridge);
  if (!isCompleteBrowserBridge(bridge)) {
    logger.error('window.browser bridge is malformed; browser pane disabled', { missing });
    return null;
  }
  return bridge;
}

/** True when a fully-formed desktop `window.browser` bridge is present. */
export function isBrowserBridgeAvailable(): boolean {
  return resolveBrowserBridge() !== null;
}
