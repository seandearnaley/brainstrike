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

export interface BrowserPaneRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface BrowserTab {
  readonly active: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
}

export interface BrowserBridge {
  closeTab: (tabId: string) => Promise<void>;
  /** Open a new tab (optionally at `url`); resolves the new tabId. */
  createTab: (url?: string) => Promise<string>;
  listTabs: () => Promise<readonly BrowserTab[]>;
  /** `url`, or the literals `'back'` / `'forward'`. */
  navigate: (tabId: string, target: string) => Promise<void>;
  /** Subscribe to tab-state changes (nav/title/list). Returns unsubscribe. */
  onTabsChanged: (listener: (tabs: readonly BrowserTab[]) => void) => () => void;
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
  listTabs: true,
  navigate: true,
  onTabsChanged: true,
  selectTab: true,
  setBounds: true,
  setOccluded: true,
} as const satisfies Record<keyof BrowserBridge, true>;

/** Exact method set the preload must expose; pinned by the preload contract test. */
export const BROWSER_BRIDGE_REQUIRED_METHODS = Object.keys(
  BROWSER_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof BrowserBridge)[];

/** Resolve `window.browser`, or `null` when absent (web) or malformed. */
export function resolveBrowserBridge(): BrowserBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { browser?: Partial<BrowserBridge> }).browser;
  if (!bridge) {
    return null;
  }
  const missing = BROWSER_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.browser bridge is malformed; browser pane disabled', { missing });
    return null;
  }
  return bridge as BrowserBridge;
}

/** True when a fully-formed desktop `window.browser` bridge is present. */
export function isBrowserBridgeAvailable(): boolean {
  return resolveBrowserBridge() !== null;
}
