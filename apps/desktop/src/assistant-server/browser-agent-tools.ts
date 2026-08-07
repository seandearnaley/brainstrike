/**
 * Executors for the embedded-browser-pane agent tools (BST-1176 PR2):
 * navigate / read a11y tree / read page text, over the ACTIVE pane tab.
 *
 * Every executor returns a STRUCTURED result ({ok:true,…} | {ok:false,error,
 * hint}) — a missing pane, an unsettled load, or a driver failure is model-
 * actionable feedback, never a throw and never a silent empty success.
 *
 * The a11y snapshot's `eN → backendDOMNodeId` ref map is deliberately NOT
 * returned to the model (the `[ref=eN]` handles are already in the tree text
 * and the raw ids are token waste); it is cached per webContents id so PR3's
 * click/type-by-ref can resolve handles from the agent's last look.
 */

import type {
  BrowserGetPageTextInput,
  BrowserNavigateInput,
  BrowserReadPageInput,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import type { AccessibilitySnapshot } from '../browser/accessibility-snapshot';
import type { BrowserDriver } from '../browser/browser-driver';
import type { BrowserTabState } from '../browser/browser-view-manager';

const logger = createLogger('BrowserAgentTools');

/** The slice of {@link BrowserPaneHost} the executors drive (fake-able). */
export interface BrowserPaneHostLike {
  readonly driver: Pick<BrowserDriver, 'getPageText' | 'snapshot'>;
  readonly manager: {
    createTab(url?: string): string;
    getActiveWebContentsId(): number | null;
    listTabs(): readonly BrowserTabState[];
    navigate(tabId: string, url: string): boolean;
  };
}

export interface BrowserToolFailure {
  readonly error: 'browser_unavailable' | 'driver_failed' | 'load_timeout' | 'navigate_failed';
  readonly hint: string;
  readonly ok: false;
}

export type BrowserNavigateResult =
  | { readonly ok: true; readonly title: string; readonly url: string }
  | BrowserToolFailure;

export type BrowserReadPageResult =
  | { readonly ok: true; readonly tree: string; readonly truncated: boolean }
  | BrowserToolFailure;

export type BrowserGetPageTextResult =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | BrowserToolFailure;

export interface BrowserNavigateOptions {
  /** Poll interval while waiting for the load to settle. */
  readonly pollMs?: number;
  /** Give up (structured `load_timeout`) after this long. */
  readonly timeoutMs?: number;
}

const DEFAULT_POLL_MS = 150;
const DEFAULT_TIMEOUT_MS = 15_000;

const UNAVAILABLE: BrowserToolFailure = {
  error: 'browser_unavailable',
  hint: 'The embedded browser pane is not available (no app window is open).',
  ok: false,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activeTab(host: BrowserPaneHostLike): BrowserTabState | undefined {
  return host.manager.listTabs().find((tab) => tab.active);
}

export async function runBrowserNavigate(
  input: BrowserNavigateInput,
  host: BrowserPaneHostLike | null,
  options?: BrowserNavigateOptions
): Promise<BrowserNavigateResult> {
  if (!host) {
    return UNAVAILABLE;
  }
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const existing = activeTab(host);
  if (existing) {
    if (!host.manager.navigate(existing.tabId, input.url)) {
      return {
        error: 'navigate_failed',
        hint: `Tab ${existing.tabId} vanished mid-call; retry to open a fresh tab.`,
        ok: false,
      };
    }
  } else {
    host.manager.createTab(input.url);
  }

  // Wait for the load to settle: poll the pane's own tab state (which already
  // carries isLoading/url/title) rather than adding a second event channel.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(pollMs);
    const tab = activeTab(host);
    if (tab && !tab.isLoading) {
      return { ok: true, title: tab.title, url: tab.url };
    }
  }
  return {
    error: 'load_timeout',
    hint: `The page did not finish loading within ${timeoutMs}ms; it may still be loading — read the page to see its current state.`,
    ok: false,
  };
}

/** Last a11y snapshot's ref map per webContents id (PR3 resolves eN → node). */
const snapshotRefsByWebContentsId = new Map<number, AccessibilitySnapshot['refs']>();

export function getCachedSnapshotRefs(
  webContentsId: number
): AccessibilitySnapshot['refs'] | undefined {
  return snapshotRefsByWebContentsId.get(webContentsId);
}

export async function runBrowserReadPage(
  input: BrowserReadPageInput,
  host: BrowserPaneHostLike | null
): Promise<BrowserReadPageResult> {
  if (!host) {
    return UNAVAILABLE;
  }
  try {
    const snapshot = await host.driver.snapshot({
      filter: input.filter,
      maxChars: input.maxChars,
    });
    const webContentsId = host.manager.getActiveWebContentsId();
    if (webContentsId !== null) {
      snapshotRefsByWebContentsId.set(webContentsId, snapshot.refs);
    }
    return { ok: true, tree: snapshot.text, truncated: snapshot.truncated };
  } catch (error) {
    logger.warn('browserReadPage driver call failed', { error });
    return driverFailure(error);
  }
}

export async function runBrowserGetPageText(
  input: BrowserGetPageTextInput,
  host: BrowserPaneHostLike | null
): Promise<BrowserGetPageTextResult> {
  if (!host) {
    return UNAVAILABLE;
  }
  try {
    const page = await host.driver.getPageText(input.maxChars);
    return { ok: true, text: page.text, truncated: page.truncated };
  } catch (error) {
    logger.warn('browserGetPageText driver call failed', { error });
    return driverFailure(error);
  }
}

function driverFailure(error: unknown): BrowserToolFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: 'driver_failed',
    hint: `${message}. Open a page with browserNavigate first if no tab is active.`,
    ok: false,
  };
}
