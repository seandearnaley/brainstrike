/**
 * Main-process handlers for the desktop `browser` IPC domain (BST-1174).
 *
 * The dispatcher decodes every renderer argument with `browserArgs` before
 * these handlers run. An unknown tab and a manager throw return a typed
 * `{ ok: false, error }` result, never a thrown bare Error.
 *
 * The manager itself is injected (resolved lazily from main once the visible
 * window exists) so these handlers are unit-testable with a fake.
 */
import { createLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import type { BrowserTabState, PaneRect } from './browser/browser-view-manager';
import { NoArgs } from './platform/ipc-args';

const logger = createLogger('BrowserIpc');

type BrowserResult<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: string; readonly ok: false };

/**
 * The manager surface these handlers drive (subset of BrowserViewManager).
 * The tab-targeting methods return `false` for an unknown tab id so the
 * handler can surface a structured failure instead of a silent success.
 */
export interface BrowserManagerLike {
  closeTab(tabId: string): boolean;
  createTab(threadId: string, url?: string): string;
  goBack(tabId: string): boolean;
  goForward(tabId: string): boolean;
  listTabs(): readonly BrowserTabState[];
  navigate(tabId: string, url: string): boolean;
  reload(tabId: string): boolean;
  setBounds(rect: PaneRect): void;
  setOccluded(occluded: boolean): void;
  showTab(tabId: string): boolean;
}

export interface BrowserIpcHandlers {
  closeTab(tabId: string): BrowserResult;
  createTab(threadId: string, url?: string): BrowserResult<string>;
  goBack(tabId: string): BrowserResult;
  goForward(tabId: string): BrowserResult;
  listTabs(): BrowserResult<readonly BrowserTabState[]>;
  navigate(tabId: string, url: string): BrowserResult;
  reload(tabId: string): BrowserResult;
  setBounds(rect: PaneRect): BrowserResult;
  setOccluded(occluded: boolean): BrowserResult;
  showTab(tabId: string): BrowserResult;
}

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const TabId = Schema.Tuple([NonEmptyString]);
const Finite = Schema.Finite;
const Extent = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** The renderer arguments of each browser method; `x`/`y` may be negative (a scrolled pane). */
export const browserArgs = {
  closeTab: TabId,
  createTab: Schema.Tuple([NonEmptyString, Schema.optional(Schema.String)]),
  goBack: TabId,
  goForward: TabId,
  listTabs: NoArgs,
  navigate: Schema.Tuple([NonEmptyString, NonEmptyString]),
  reload: TabId,
  setBounds: Schema.Tuple([Schema.Struct({ height: Extent, width: Extent, x: Finite, y: Finite })]),
  setOccluded: Schema.Tuple([Schema.Boolean]),
  showTab: TabId,
} satisfies Record<keyof BrowserIpcHandlers, Schema.Top>;

function ok<T>(value: T): BrowserResult<T> {
  return { ok: true, value };
}

function fail(error: string): BrowserResult<never> {
  logger.warn('browser IPC rejected a payload', { error });
  return { error, ok: false };
}

export function createBrowserIpcHandlers(manager: BrowserManagerLike): BrowserIpcHandlers {
  const tabAction = (tabId: string, run: (id: string) => boolean): BrowserResult =>
    // A well-formed but UNKNOWN tab id is a real desync, not a success —
    // surface it (NO SILENT FALLBACKS) so the renderer can resync.
    run(tabId) ? ok(undefined) : fail(`unknown tab: ${tabId}`);
  // The structured-result contract holds for unknown tabs AND executor throws (live 2026-08-07: a native attach TypeError
  // propagated to the renderer as a raw invoke rejection). Errors stay fully
  // visible — logged + returned — never swallowed.
  const guard =
    <A extends never[], T>(
      verb: string,
      handler: (...args: A) => BrowserResult<T>
    ): ((...args: A) => BrowserResult<T>) =>
    (...args) => {
      try {
        return handler(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('browser IPC handler threw', { error, verb });
        return { error: `${verb} failed: ${message}`, ok: false };
      }
    };
  const handlers: BrowserIpcHandlers = {
    closeTab(tabId) {
      return tabAction(tabId, (id) => manager.closeTab(id));
    },
    createTab(threadId, url) {
      return ok(manager.createTab(threadId, url));
    },
    goBack(tabId) {
      return tabAction(tabId, (id) => manager.goBack(id));
    },
    goForward(tabId) {
      return tabAction(tabId, (id) => manager.goForward(id));
    },
    listTabs() {
      return ok(manager.listTabs());
    },
    navigate(tabId, url) {
      return tabAction(tabId, (id) => manager.navigate(id, url));
    },
    reload(tabId) {
      return tabAction(tabId, (id) => manager.reload(id));
    },
    setBounds(rect) {
      manager.setBounds(rect);
      return ok(undefined);
    },
    setOccluded(occluded) {
      manager.setOccluded(occluded);
      return ok(undefined);
    },
    showTab(tabId) {
      return tabAction(tabId, (id) => manager.showTab(id));
    },
  };
  // Wrap BY CONSTRUCTION — every key of the implementation object is guarded,
  // so a future handler cannot ship unwrapped (a hand-maintained re-listing
  // type-checks even when a key is wired through bare).
  const wrapped = {} as Record<keyof BrowserIpcHandlers, unknown>;
  for (const key of Object.keys(handlers) as (keyof BrowserIpcHandlers)[]) {
    wrapped[key] = guard(key, handlers[key] as (...args: never[]) => BrowserResult<unknown>);
  }
  return wrapped as BrowserIpcHandlers;
}
