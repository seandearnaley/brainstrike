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
import { refuseExtractUrl } from '@brainstrike/host-capabilities/extract-url-refusal';
import { createLogger } from '@brainstrike/logging';
import type { AccessibilitySnapshot } from '../browser/accessibility-snapshot';
import type { BrowserDriver } from '../browser/browser-driver';
import { getActiveBrowserPaneHost } from '../browser/browser-pane-registry';
import {
  type BrowserTabState,
  isNavigableUrl,
  normalizeUrl,
} from '../browser/browser-view-manager';
import type { BrowserToolRunner } from './native-tool-executors-browser';

const logger = createLogger('BrowserAgentTools');

/** The slice of {@link BrowserPaneHost} the executors drive (fake-able). */
export interface BrowserPaneHostLike {
  readonly driver: Pick<BrowserDriver, 'getPageText' | 'snapshot'>;
  readonly manager: {
    createTab(url?: string): string;
    getActiveWebContentsId(): number | null;
    getNavigationError(tabId: string): string | null;
    listTabs(): readonly BrowserTabState[];
    navigate(tabId: string, url: string): boolean;
  };
}

export interface BrowserToolFailure {
  readonly error:
    | 'blocked_url'
    | 'browser_unavailable'
    | 'driver_failed'
    | 'load_failed'
    | 'load_timeout'
    | 'navigate_failed';
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

/**
 * How long a stable not-loading state is trusted as "the load settled" when
 * neither a loading transition nor a url change was observed. Covers the
 * loadURL-initiation gap (the first polls can run before `isLoading` flips)
 * without hanging same-url re-navigations until the timeout.
 */
const SETTLE_GRACE_MS = 600;

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

  // AGENT-initiated navigation gets webExtract's host guard, not just the
  // pane's scheme gate: with requiresApproval false, an unguarded navigate
  // could read cloud metadata endpoints / RFC1918 / loopback in one turn.
  // The USER's own URL bar is unaffected. (BST-1175/1178 add scoped, approved
  // paths for dev-server preview.) Normalize FIRST so the gate sees exactly
  // what the pane would load — including the search fallback.
  const normalized = normalizeUrl(input.url);
  const refusal = isNavigableUrl(normalized)
    ? refuseExtractUrl(normalized)
    : `refused: only http(s) pages can be opened by the agent (got "${normalized}")`;
  if (refusal) {
    return { error: 'blocked_url', hint: refusal, ok: false };
  }

  // Pin the TARGET tab now — polling "the active tab" would report whatever
  // tab the user (or a popup interception) activated mid-wait as the result
  // of this navigation.
  const existing = activeTab(host);
  const targetTabId = existing?.tabId ?? host.manager.createTab(normalized);
  const preNavUrl = existing?.url ?? null;
  if (existing && !host.manager.navigate(existing.tabId, normalized)) {
    return {
      error: 'navigate_failed',
      hint: `Tab ${existing.tabId} vanished mid-call; retry to open a fresh tab.`,
      ok: false,
    };
  }

  // Settle discipline: accept a stable not-loading state only once we have
  // EVIDENCE the navigation ran — a loading transition was observed, or the
  // url changed from the pre-navigation url — or after the grace window (the
  // same-url case, where neither signal can fire).
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let sawLoading = false;
  while (Date.now() < deadline) {
    await delay(pollMs);
    const tab = host.manager.listTabs().find((candidate) => candidate.tabId === targetTabId);
    if (!tab) {
      return {
        error: 'navigate_failed',
        hint: 'The navigated tab was closed before the load settled.',
        ok: false,
      };
    }
    if (tab.isLoading) {
      sawLoading = true;
      continue;
    }
    const urlChanged = preNavUrl !== null && tab.url !== preNavUrl;
    const gracePassed = Date.now() - startedAt >= SETTLE_GRACE_MS;
    if (!(sawLoading || urlChanged || preNavUrl === null || gracePassed)) {
      continue;
    }
    // A blocked scheme or a failed load (ERR_NAME_NOT_RESOLVED, refused
    // connection) must never read as an ok blank page — NO SILENT FALLBACKS.
    const navigationError = host.manager.getNavigationError(targetTabId);
    if (navigationError) {
      return {
        error: 'load_failed',
        hint: navigationError,
        ok: false,
      };
    }
    return { ok: true, title: tab.title, url: tab.url };
  }
  return {
    error: 'load_timeout',
    hint: `The page did not finish loading within ${timeoutMs}ms; it may still be loading — read the page to see its current state.`,
    ok: false,
  };
}

/**
 * Last a11y snapshot's ref map per webContents id. Bounded (closed tabs never
 * unregister here), keyed by the id captured BEFORE the snapshot await — the
 * driver resolves the active tab's session at call time, so a mid-await tab
 * switch must not file tab A's node ids under tab B. PR3's act-by-ref MUST
 * additionally validate the document is unchanged before resolving a handle
 * (backendDOMNodeIds are per-document; navigation silently invalidates them).
 */
const SNAPSHOT_REF_CACHE_MAX_ENTRIES = 8;
const snapshotRefsByWebContentsId = new Map<number, AccessibilitySnapshot['refs']>();

export function getCachedSnapshotRefs(
  webContentsId: number
): AccessibilitySnapshot['refs'] | undefined {
  return snapshotRefsByWebContentsId.get(webContentsId);
}

function cacheSnapshotRefs(webContentsId: number, refs: AccessibilitySnapshot['refs']): void {
  snapshotRefsByWebContentsId.delete(webContentsId); // refresh insertion order
  snapshotRefsByWebContentsId.set(webContentsId, refs);
  for (const key of snapshotRefsByWebContentsId.keys()) {
    if (snapshotRefsByWebContentsId.size <= SNAPSHOT_REF_CACHE_MAX_ENTRIES) {
      break;
    }
    snapshotRefsByWebContentsId.delete(key);
  }
}

export async function runBrowserReadPage(
  input: BrowserReadPageInput,
  host: BrowserPaneHostLike | null
): Promise<BrowserReadPageResult> {
  if (!host) {
    return UNAVAILABLE;
  }
  // Captured BEFORE the await: this is the tab the driver's session resolver
  // will target, regardless of what becomes active while the snapshot runs.
  const webContentsId = host.manager.getActiveWebContentsId();
  try {
    const snapshot = await host.driver.snapshot({
      filter: input.filter,
      maxChars: input.maxChars,
    });
    if (webContentsId !== null) {
      cacheSnapshotRefs(webContentsId, snapshot.refs);
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

/**
 * Main's runner: the active pane host is resolved PER CALL from the registry,
 * so a window opened after the stream started still serves, and a closed
 * window returns the structured browser_unavailable failure instead of a
 * stale handle.
 */
export const mainBrowserToolRunner: BrowserToolRunner = {
  getPageText: (input) => runBrowserGetPageText(input, getActiveBrowserPaneHost()),
  navigate: (input) => runBrowserNavigate(input, getActiveBrowserPaneHost()),
  readPage: (input) => runBrowserReadPage(input, getActiveBrowserPaneHost()),
};
