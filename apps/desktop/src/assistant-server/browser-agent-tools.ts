/**
 * Executors for the embedded-browser agent tools (BST-1176 PR2): navigate /
 * read a11y tree / read page text, over the calling thread's current page
 * (BST-1271). A run's tools carry its admitting thread, so a subagent browses
 * among its top-level conversation's pages.
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
import { getActiveBrowserPaneHost } from '../browser/browser-pane-registry';
import { agentNavigationTarget, type LoopbackAdmission } from '../browser/browser-url';
import type { BrowserTabOwner, BrowserTabState } from '../browser/browser-view-manager';

const logger = createLogger('BrowserAgentTools');

/** The slice of {@link BrowserPaneHost} the executors drive (fake-able). */
export interface BrowserPaneHostLike {
  driverFor(tabId: string): Pick<BrowserDriver, 'getPageText' | 'snapshot'>;
  readonly manager: {
    createTab(threadId: string, url?: string, owner?: BrowserTabOwner): string;
    currentTab(threadId: string, owner?: BrowserTabOwner): string | null;
    getWebContentsId(tabId: string): number | null;
    getNavigationError(tabId: string): string | null;
    listTabs(): readonly BrowserTabState[];
    navigate(tabId: string, url: string): boolean;
  };
  prepareAgentBrowsing(loopback?: LoopbackAdmission): Promise<void>;
}

interface BrowserToolFailure {
  readonly error:
    | 'blocked_destination'
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

/**
 * How long a stable not-loading state is trusted as "the load settled" when
 * neither a loading transition nor a url change was observed. Covers the
 * loadURL-initiation gap (the first polls can run before `isLoading` flips)
 * without hanging same-url re-navigations until the timeout.
 */
const SETTLE_GRACE_MS = 600;

/** The prefix the pane host gives a navigation the egress proxy refused. */
const BLOCKED_DESTINATION = 'blocked_destination:';

/** The thread's current agent page, if it has one. */
function currentAgentTab(host: BrowserPaneHostLike, threadId: string): BrowserTabState | undefined {
  const tabId = host.manager.currentTab(threadId, 'agent');
  return host.manager.listTabs().find((tab) => tab.tabId === tabId);
}

/**
 * Pin the TARGET tab now — polling "the current page" would report whatever
 * page the person showed mid-wait as the result of this navigation. The
 * agent drives only its own pages in its own thread, never one the person
 * opened: the thread's current agent page, else a new one. It never changes
 * which page the workspace shows.
 */
function startAgentNavigation(
  host: BrowserPaneHostLike,
  threadId: string,
  url: string
): { readonly preNavUrl: string | null; readonly tabId: string } | BrowserToolFailure {
  const existing = currentAgentTab(host, threadId);
  if (existing === undefined) {
    return { preNavUrl: null, tabId: host.manager.createTab(threadId, url, 'agent') };
  }
  if (!host.manager.navigate(existing.tabId, url)) {
    return {
      error: 'navigate_failed',
      hint: `Tab ${existing.tabId} vanished mid-call; retry to open a fresh tab.`,
      ok: false,
    };
  }
  return { preNavUrl: existing.url, tabId: existing.tabId };
}

/**
 * BST-1178: a loopback navigation names its tab in its admission, so the tab
 * must exist first: a new agent tab opens blank (no network), the proxy and
 * session admit the server for that tab only, and then the tab loads it.
 */
async function startLoopbackNavigation(
  host: BrowserPaneHostLike,
  threadId: string,
  target: { readonly loopback: string; readonly origin: string; readonly url: string }
): Promise<{ readonly preNavUrl: string | null; readonly tabId: string } | BrowserToolFailure> {
  const existing = currentAgentTab(host, threadId);
  const tabId = existing?.tabId ?? host.manager.createTab(threadId, 'about:blank', 'agent');
  const vanished: BrowserToolFailure = {
    error: 'navigate_failed',
    hint: `Tab ${tabId} vanished mid-call; retry to open a fresh tab.`,
    ok: false,
  };
  const webContentsId = host.manager.getWebContentsId(tabId);
  if (webContentsId === null) {
    return vanished;
  }
  await host.prepareAgentBrowsing({
    authority: target.loopback,
    origin: target.origin,
    webContentsId,
  });
  if (!host.manager.navigate(tabId, target.url)) {
    return vanished;
  }
  return { preNavUrl: existing?.url ?? 'about:blank', tabId };
}

/**
 * A blocked destination, a blocked scheme or a failed load
 * (ERR_NAME_NOT_RESOLVED, refused connection) must never read as an ok blank
 * page — NO SILENT FALLBACKS.
 */
function settledNavigation(
  navigationError: string | null,
  tab: BrowserTabState
): BrowserNavigateResult {
  if (navigationError?.startsWith(BLOCKED_DESTINATION) === true) {
    return {
      error: 'blocked_destination',
      hint: navigationError.slice(BLOCKED_DESTINATION.length).trim(),
      ok: false,
    };
  }
  if (navigationError !== null) {
    return { error: 'load_failed', hint: navigationError, ok: false };
  }
  return { ok: true, title: tab.title, url: tab.url };
}

/**
 * BST-1178: one agent navigation at a time per pane. A navigation's loopback
 * admission holds until it settles; a parallel call would replace it first.
 */
const navigations = new WeakMap<BrowserPaneHostLike, Promise<unknown>>();

export function runBrowserNavigate(
  input: BrowserNavigateInput,
  threadId: string,
  host: BrowserPaneHostLike | null,
  options?: BrowserNavigateOptions
): Promise<BrowserNavigateResult> {
  if (!host) {
    return Promise.resolve(UNAVAILABLE);
  }
  const navigation = (navigations.get(host) ?? Promise.resolve()).then(() =>
    navigateOnce(input, threadId, host, options)
  );
  navigations.set(
    host,
    navigation.catch(() => undefined)
  );
  return navigation;
}

async function navigateOnce(
  input: BrowserNavigateInput,
  threadId: string,
  host: BrowserPaneHostLike,
  options?: BrowserNavigateOptions
): Promise<BrowserNavigateResult> {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // An unguarded navigate could read cloud metadata, RFC1918 or loopback in
  // one turn. The agent host asked a person about this target's origin before
  // the call reached here (BST-1178), so a loopback target is a dev server
  // they approved: the proxy admits its exact host:port for this navigation.
  const target = agentNavigationTarget(input.url);
  if ('refusal' in target) {
    return { error: 'blocked_url', hint: target.refusal, ok: false };
  }
  // The literal check above is a fast refusal, not the boundary: agent tabs
  // connect only through the egress proxy, which checks every connection's
  // resolved address, redirects and popups included (BST-1238).
  let started: Awaited<ReturnType<typeof startLoopbackNavigation>>;
  try {
    const { loopback } = target;
    if (loopback === undefined) {
      await host.prepareAgentBrowsing();
      started = startAgentNavigation(host, threadId, target.url);
    } else {
      started = await startLoopbackNavigation(host, threadId, { ...target, loopback });
    }
  } catch (error) {
    return {
      error: 'browser_unavailable',
      hint: `Agent browsing could not start its network route: ${String(error)}`,
      ok: false,
    };
  }
  if ('ok' in started) {
    return started;
  }
  const { preNavUrl, tabId: targetTabId } = started;

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
    return settledNavigation(host.manager.getNavigationError(targetTabId), tab);
  }
  return {
    error: 'load_timeout',
    hint: `The page did not finish loading within ${timeoutMs}ms; it may still be loading — read the page to see its current state.`,
    ok: false,
  };
}

/**
 * Last a11y snapshot's ref map per webContents id. Bounded (closed tabs never
 * unregister here), keyed by the page the snapshot was read from. PR3's
 * act-by-ref MUST
 * additionally validate the document is unchanged before resolving a handle
 * (backendDOMNodeIds are per-document; navigation silently invalidates them).
 */
const SNAPSHOT_REF_CACHE_MAX_ENTRIES = 8;
const snapshotRefsByWebContentsId = new Map<number, AccessibilitySnapshot['refs']>();

/** @internal Browser tool regressions inspect the current snapshot reference cache. */
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

/**
 * The page a read targets: the thread's current page, whoever opened it, so
 * the agent can read what the person is looking at in its conversation.
 */
function readTarget(host: BrowserPaneHostLike, threadId: string): string | BrowserToolFailure {
  return (
    host.manager.currentTab(threadId) ?? {
      error: 'driver_failed',
      hint: 'No browser page is open in this conversation. Open one with browserNavigate first.',
      ok: false,
    }
  );
}

export async function runBrowserReadPage(
  input: BrowserReadPageInput,
  threadId: string,
  host: BrowserPaneHostLike | null
): Promise<BrowserReadPageResult> {
  if (!host) {
    return UNAVAILABLE;
  }
  const tabId = readTarget(host, threadId);
  if (typeof tabId !== 'string') {
    return tabId;
  }
  const webContentsId = host.manager.getWebContentsId(tabId);
  try {
    const snapshot = await host.driverFor(tabId).snapshot({
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
  threadId: string,
  host: BrowserPaneHostLike | null
): Promise<BrowserGetPageTextResult> {
  if (!host) {
    return UNAVAILABLE;
  }
  const tabId = readTarget(host, threadId);
  if (typeof tabId !== 'string') {
    return tabId;
  }
  try {
    const page = await host.driverFor(tabId).getPageText(input.maxChars);
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
    hint: `${message}. Open a page with browserNavigate first if this conversation has none.`,
    ok: false,
  };
}

/** The browser tools as Main runs them for a host run: each call names its thread. */
export interface MainBrowserToolRunner {
  getPageText(input: BrowserGetPageTextInput, threadId: string): Promise<BrowserGetPageTextResult>;
  navigate(input: BrowserNavigateInput, threadId: string): Promise<BrowserNavigateResult>;
  readPage(input: BrowserReadPageInput, threadId: string): Promise<BrowserReadPageResult>;
}

/**
 * Main's runner: the active pane host is resolved PER CALL from the registry,
 * so a window opened after the stream started still serves, and a closed
 * window returns the structured browser_unavailable failure instead of a
 * stale handle.
 */
export const mainBrowserToolRunner: MainBrowserToolRunner = {
  getPageText: (input, threadId) =>
    runBrowserGetPageText(input, threadId, getActiveBrowserPaneHost()),
  navigate: (input, threadId) => runBrowserNavigate(input, threadId, getActiveBrowserPaneHost()),
  readPage: (input, threadId) => runBrowserReadPage(input, threadId, getActiveBrowserPaneHost()),
};
