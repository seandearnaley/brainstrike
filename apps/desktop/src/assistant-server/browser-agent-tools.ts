/**
 * Executors for the embedded-browser agent tools (BST-1176 PR2, BST-2324):
 * navigate / read a11y tree / read page text, and click / type / select by a
 * ref from the last read, over the calling thread's current page (BST-1271).
 * A run's tools carry its admitting thread, so a subagent browses among its
 * top-level conversation's pages.
 *
 * Every executor returns a STRUCTURED result ({ok:true,…} | {ok:false,error,
 * hint}) — a missing pane, an unsettled load, or a driver failure is model-
 * actionable feedback, never a throw and never a silent empty success.
 *
 * The a11y snapshot's `eN → backendDOMNodeId` ref map is deliberately NOT
 * returned to the model (the `[ref=eN]` handles are already in the tree text
 * and the raw ids are token waste); it is cached per webContents id, with the
 * document it was read from, so the acting tools resolve handles from the
 * agent's last look and refuse them once the page has changed.
 */

import type {
  BrowserClickInput,
  BrowserGetPageTextInput,
  BrowserNavigateInput,
  BrowserReadPageInput,
  BrowserSelectOptionInput,
  BrowserTypeInput,
} from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import type { AccessibilitySnapshot } from '../browser/accessibility-snapshot';
import {
  type BrowserAction,
  blockedActionCategory,
  blockedActionHint,
} from '../browser/browser-action-guard';
import { BrowserActionError, type BrowserDriver } from '../browser/browser-driver';
import { getActiveBrowserPaneHost } from '../browser/browser-pane-registry';
import { agentNavigationTarget, type LoopbackAdmission } from '../browser/browser-url';
import type { BrowserTabOwner, BrowserTabState } from '../browser/browser-view-manager';

const logger = createLogger('BrowserAgentTools');

/** The slice of {@link BrowserPaneHost} the executors drive (fake-able). */
export interface BrowserPaneHostLike {
  driverFor(
    tabId: string
  ): Pick<
    BrowserDriver,
    'click' | 'documentId' | 'getPageText' | 'selectOptions' | 'snapshot' | 'targetFacts' | 'type'
  >;
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
    | 'blocked_action'
    | 'blocked_destination'
    | 'blocked_url'
    | 'browser_unavailable'
    | 'driver_failed'
    | 'element_not_actionable'
    | 'load_failed'
    | 'load_timeout'
    | 'navigate_failed'
    | 'not_agent_page'
    | 'origin_not_approved'
    | 'stale_ref';
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

/** Where the page is once an action's own navigation, if any, settled. */
export type BrowserActionResult =
  | { readonly ok: true; readonly title: string; readonly url: string }
  | BrowserToolFailure;

export type BrowserSelectOptionResult =
  | {
      readonly ok: true;
      readonly selected: readonly string[];
      readonly title: string;
      readonly url: string;
    }
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
 * BST-1178: one agent navigation (or action, BST-2324) at a time per pane. A
 * navigation's loopback admission holds until it settles; a parallel call
 * would replace it first.
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
  return queued(host, () => navigateOnce(input, threadId, host, options));
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
  rememberApprovedOrigin(host, targetTabId, target.origin);

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
 * BST-2325: per agent tab, the origins its navigations opened. Main runs a
 * navigation only after the host's per-origin consent admitted it (BST-1178),
 * so these are the origins a person approved for this page. The acting tools
 * refuse any other: a link, redirect or typed URL that took the tab elsewhere
 * needs its own browserNavigate, which asks. The saved answers stay the
 * host's; this only remembers which this tab was opened at, for its life.
 */
const approvedOrigins = new WeakMap<BrowserPaneHostLike, Map<string, Set<string>>>();

function rememberApprovedOrigin(host: BrowserPaneHostLike, tabId: string, origin: string): void {
  let byTab = approvedOrigins.get(host);
  if (byTab === undefined) {
    byTab = new Map();
    approvedOrigins.set(host, byTab);
  }
  byTab.set(tabId, new Set([...(byTab.get(tabId) ?? []), origin]));
}

/** The approved origins of the live tabs; a closed tab's entry is dropped. */
function approvedOriginsOf(
  host: BrowserPaneHostLike,
  tabs: readonly BrowserTabState[],
  tabId: string
): ReadonlySet<string> {
  const byTab = approvedOrigins.get(host);
  const live = new Set(tabs.map((tab) => tab.tabId));
  for (const id of byTab?.keys() ?? []) {
    if (!live.has(id)) {
      byTab?.delete(id);
    }
  }
  return byTab?.get(tabId) ?? new Set();
}

/**
 * Last a11y snapshot's ref map per webContents id, with the document it was
 * read from. Bounded (closed tabs never unregister here). backendDOMNodeIds
 * are per-document and navigation silently invalidates them, so an action
 * resolves a ref only while the page still shows that document.
 */
interface CachedSnapshotRefs {
  readonly documentId: string;
  readonly refs: AccessibilitySnapshot['refs'];
}
const SNAPSHOT_REF_CACHE_MAX_ENTRIES = 8;
const snapshotRefsByWebContentsId = new Map<number, CachedSnapshotRefs>();

/** @internal Browser tool regressions inspect the current snapshot reference cache. */
export function getCachedSnapshotRefs(
  webContentsId: number
): AccessibilitySnapshot['refs'] | undefined {
  return snapshotRefsByWebContentsId.get(webContentsId)?.refs;
}

function cacheSnapshotRefs(webContentsId: number, cached: CachedSnapshotRefs): void {
  snapshotRefsByWebContentsId.delete(webContentsId); // refresh insertion order
  snapshotRefsByWebContentsId.set(webContentsId, cached);
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
    const driver = host.driverFor(tabId);
    const documentId = await driver.documentId();
    const snapshot = await driver.snapshot({
      filter: input.filter,
      maxChars: input.maxChars,
    });
    if (webContentsId !== null) {
      // A load during the read leaves refs of no one document: keep none,
      // so an action asks for a fresh read instead of guessing.
      if ((await driver.documentId()) === documentId) {
        cacheSnapshotRefs(webContentsId, { documentId, refs: snapshot.refs });
      } else {
        snapshotRefsByWebContentsId.delete(webContentsId);
      }
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

export interface BrowserActionOptions {
  /** How long to wait for a navigation the action started to begin. */
  readonly graceMs?: number;
  readonly pollMs?: number;
  /** Stop waiting for that navigation after this long; the action still ran. */
  readonly timeoutMs?: number;
}

/** A click or Enter that starts a load flips `isLoading` within this window. */
const ACTION_GRACE_MS = 300;

function failure(error: BrowserToolFailure['error'], hint: string): BrowserToolFailure {
  return { error, hint, ok: false };
}

/**
 * Everything an action needs before it may touch the page (BST-2324): the
 * thread's current page is the agent's own, at an origin a person approved
 * (BST-2325), and the ref belongs to the document the agent last read.
 */
async function resolveActionTarget(
  ref: string,
  threadId: string,
  host: BrowserPaneHostLike
): Promise<
  | {
      readonly backendNodeId: number;
      readonly driver: ReturnType<BrowserPaneHostLike['driverFor']>;
      readonly tabId: string;
    }
  | BrowserToolFailure
> {
  const tabId = readTarget(host, threadId);
  if (typeof tabId !== 'string') {
    return tabId;
  }
  const tabs = host.manager.listTabs();
  const tab = tabs.find((candidate) => candidate.tabId === tabId);
  if (tab === undefined) {
    return failure('navigate_failed', `Tab ${tabId} vanished mid-call; read the page again.`);
  }
  if (tab.owner !== 'agent') {
    return failure(
      'not_agent_page',
      "This conversation's current page is one the user opened; you act only on pages you opened with browserNavigate."
    );
  }
  const origin = URL.canParse(tab.url) ? new URL(tab.url).origin : tab.url;
  if (!approvedOriginsOf(host, tabs, tabId).has(origin)) {
    return failure(
      'origin_not_approved',
      `This page is now at ${origin}, which you did not open with browserNavigate, so the user has not approved acting there. Open it with browserNavigate first; the user approves each new site.`
    );
  }
  const webContentsId = host.manager.getWebContentsId(tabId);
  const cached =
    webContentsId === null ? undefined : snapshotRefsByWebContentsId.get(webContentsId);
  const backendNodeId = cached?.refs[ref];
  if (cached === undefined || backendNodeId === undefined) {
    return failure(
      'stale_ref',
      `Your last browserReadPage of this page has no [ref=${ref}]. Read the page again and use a ref from that read.`
    );
  }
  const driver = host.driverFor(tabId);
  if ((await driver.documentId()) !== cached.documentId) {
    return failure(
      'stale_ref',
      'The page changed since your last browserReadPage, so its refs no longer apply. Read the page again.'
    );
  }
  return { backendNodeId, driver, tabId };
}

/** Wait for any load the action started, then report where the page is. */
async function settleAfterAction(
  host: BrowserPaneHostLike,
  tabId: string,
  options: BrowserActionOptions | undefined
): Promise<BrowserTabState | undefined> {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  await delay(options?.graceMs ?? ACTION_GRACE_MS);
  for (;;) {
    const tab = host.manager.listTabs().find((candidate) => candidate.tabId === tabId);
    if (tab === undefined || !tab.isLoading || Date.now() >= deadline) {
      return tab;
    }
    await delay(pollMs);
  }
}

async function actOnce<Value>(
  input: { readonly ref: string },
  action: BrowserAction,
  threadId: string,
  host: BrowserPaneHostLike,
  act: (
    driver: ReturnType<BrowserPaneHostLike['driverFor']>,
    backendNodeId: number
  ) => Promise<Value>,
  options: BrowserActionOptions | undefined
): Promise<
  | { readonly ok: true; readonly title: string; readonly url: string; readonly value: Value }
  | BrowserToolFailure
> {
  const target = await resolveActionTarget(input.ref, threadId, host);
  if ('ok' in target) {
    return target;
  }
  let value: Value;
  try {
    const facts = await target.driver.targetFacts(target.backendNodeId);
    if (facts.disabled) {
      return failure('element_not_actionable', `[ref=${input.ref}] is disabled.`);
    }
    // BST-2209: decided before any input reaches the page.
    const blocked = blockedActionCategory(facts, action);
    if (blocked !== undefined) {
      return failure('blocked_action', blockedActionHint(blocked));
    }
    value = await act(target.driver, target.backendNodeId);
  } catch (error) {
    if (error instanceof BrowserActionError) {
      return failure(
        error.code,
        error.code === 'stale_ref'
          ? `${error.message}. Read the page again for fresh refs.`
          : `${error.message}. Read the page again to see its current state.`
      );
    }
    logger.warn('browser action driver call failed', { error });
    return failure('driver_failed', error instanceof Error ? error.message : String(error));
  }
  const settled = await settleAfterAction(host, target.tabId, options);
  if (settled === undefined) {
    return failure('navigate_failed', 'The action ran, then its page closed.');
  }
  return { ok: true, title: settled.title, url: settled.url, value };
}

/**
 * Actions run one at a time with the pane's navigations: a navigation's
 * loopback admission holds until it settles (BST-1178), and an action's
 * own navigation settles before the next call reads the page.
 */
function queued<Result>(host: BrowserPaneHostLike, run: () => Promise<Result>): Promise<Result> {
  const next = (navigations.get(host) ?? Promise.resolve()).then(run);
  navigations.set(
    host,
    next.catch(() => undefined)
  );
  return next;
}

export function runBrowserClick(
  input: BrowserClickInput,
  threadId: string,
  host: BrowserPaneHostLike | null,
  options?: BrowserActionOptions
): Promise<BrowserActionResult> {
  if (!host) {
    return Promise.resolve(UNAVAILABLE);
  }
  return queued(host, async () => {
    const result = await actOnce(
      input,
      { kind: 'click' },
      threadId,
      host,
      (driver, node) => driver.click(node),
      options
    );
    return result.ok ? { ok: true, title: result.title, url: result.url } : result;
  });
}

export function runBrowserType(
  input: BrowserTypeInput,
  threadId: string,
  host: BrowserPaneHostLike | null,
  options?: BrowserActionOptions
): Promise<BrowserActionResult> {
  if (!host) {
    return Promise.resolve(UNAVAILABLE);
  }
  return queued(host, async () => {
    const result = await actOnce(
      input,
      { kind: 'type', submit: input.submit, text: input.text },
      threadId,
      host,
      (driver, node) => driver.type(node, input.text, input.submit),
      options
    );
    return result.ok ? { ok: true, title: result.title, url: result.url } : result;
  });
}

export function runBrowserSelectOption(
  input: BrowserSelectOptionInput,
  threadId: string,
  host: BrowserPaneHostLike | null,
  options?: BrowserActionOptions
): Promise<BrowserSelectOptionResult> {
  if (!host) {
    return Promise.resolve(UNAVAILABLE);
  }
  return queued(host, async () => {
    const result = await actOnce(
      input,
      { kind: 'select', values: input.values },
      threadId,
      host,
      (driver, node) => driver.selectOptions(node, input.values),
      options
    );
    return result.ok
      ? { ok: true, selected: result.value, title: result.title, url: result.url }
      : result;
  });
}

/** The browser tools as Main runs them for a host run: each call names its thread. */
export interface MainBrowserToolRunner {
  click(input: BrowserClickInput, threadId: string): Promise<BrowserActionResult>;
  getPageText(input: BrowserGetPageTextInput, threadId: string): Promise<BrowserGetPageTextResult>;
  navigate(input: BrowserNavigateInput, threadId: string): Promise<BrowserNavigateResult>;
  readPage(input: BrowserReadPageInput, threadId: string): Promise<BrowserReadPageResult>;
  selectOption(
    input: BrowserSelectOptionInput,
    threadId: string
  ): Promise<BrowserSelectOptionResult>;
  type(input: BrowserTypeInput, threadId: string): Promise<BrowserActionResult>;
}

/**
 * Main's runner: the active pane host is resolved PER CALL from the registry,
 * so a window opened after the stream started still serves, and a closed
 * window returns the structured browser_unavailable failure instead of a
 * stale handle.
 */
export const mainBrowserToolRunner: MainBrowserToolRunner = {
  click: (input, threadId) => runBrowserClick(input, threadId, getActiveBrowserPaneHost()),
  getPageText: (input, threadId) =>
    runBrowserGetPageText(input, threadId, getActiveBrowserPaneHost()),
  navigate: (input, threadId) => runBrowserNavigate(input, threadId, getActiveBrowserPaneHost()),
  readPage: (input, threadId) => runBrowserReadPage(input, threadId, getActiveBrowserPaneHost()),
  selectOption: (input, threadId) =>
    runBrowserSelectOption(input, threadId, getActiveBrowserPaneHost()),
  type: (input, threadId) => runBrowserType(input, threadId, getActiveBrowserPaneHost()),
};
