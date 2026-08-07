/**
 * Main-process handlers for the desktop `browser` IPC domain (BST-1174).
 *
 * Every renderer-supplied argument arrives as `unknown` (the IPC boundary is
 * untrusted) and is structurally narrowed here before it reaches the
 * `BrowserViewManager`. Malformed payloads return a typed
 * `{ ok: false, error }` result — never a thrown bare Error, never a silent
 * coercion — mirroring `changes-ipc-handlers.ts`.
 *
 * The manager itself is injected (resolved lazily from main once the visible
 * window exists) so these handlers are unit-testable with a fake.
 */
import { createLogger } from '@brainstrike/logging';
import type { BrowserTabState, PaneRect } from './browser/browser-view-manager';

const logger = createLogger('BrowserIpc');

export type BrowserResult<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: string; readonly ok: false };

/**
 * The manager surface these handlers drive (subset of BrowserViewManager).
 * The tab-targeting methods return `false` for an unknown tab id so the
 * handler can surface a structured failure instead of a silent success.
 */
export interface BrowserManagerLike {
  closeTab(tabId: string): boolean;
  createTab(url?: string): string;
  listTabs(): readonly BrowserTabState[];
  navigate(tabId: string, target: string): boolean;
  selectTab(tabId: string): boolean;
  setBounds(rect: PaneRect): void;
  setOccluded(occluded: boolean): void;
}

export interface BrowserIpcHandlers {
  closeTab(tabId: unknown): BrowserResult;
  createTab(url: unknown): BrowserResult<string>;
  listTabs(): BrowserResult<readonly BrowserTabState[]>;
  navigate(tabId: unknown, target: unknown): BrowserResult;
  selectTab(tabId: unknown): BrowserResult;
  setBounds(rect: unknown): BrowserResult;
  setOccluded(occluded: unknown): BrowserResult;
}

function ok<T>(value: T): BrowserResult<T> {
  return { ok: true, value };
}

function fail(error: string): BrowserResult<never> {
  logger.warn('browser IPC rejected a payload', { error });
  return { error, ok: false };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A rect is 4 finite numbers with non-negative width/height and nothing else.
 * `x`/`y` MAY be negative — a partially scrolled-offscreen pane is valid.
 */
function validateRect(value: unknown): PaneRect | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { height, width, x, y } = record;
  if (![height, width, x, y].every(isFiniteNumber)) {
    return null;
  }
  if ((width as number) < 0 || (height as number) < 0) {
    return null;
  }
  // Reject extra keys so a malformed payload can't smuggle fields through.
  const extra = Object.keys(record).filter((key) => !['height', 'width', 'x', 'y'].includes(key));
  if (extra.length > 0) {
    return null;
  }
  return { height: height as number, width: width as number, x: x as number, y: y as number };
}

/** `back`/`forward` are literals; anything else must be a non-empty URL string. */
function validateNavigateTarget(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

export function createBrowserIpcHandlers(manager: BrowserManagerLike): BrowserIpcHandlers {
  return {
    closeTab(tabId) {
      if (!isNonEmptyString(tabId)) {
        return fail('closeTab requires a non-empty tabId');
      }
      // A well-formed but UNKNOWN tab id is a real desync, not a success —
      // surface it (NO SILENT FALLBACKS) so the renderer can resync.
      return manager.closeTab(tabId) ? ok(undefined) : fail(`unknown tab: ${tabId}`);
    },
    createTab(url) {
      if (url !== undefined && typeof url !== 'string') {
        return fail('createTab url must be a string or omitted');
      }
      return ok(manager.createTab(url));
    },
    listTabs() {
      return ok(manager.listTabs());
    },
    navigate(tabId, target) {
      if (!isNonEmptyString(tabId)) {
        return fail('navigate requires a non-empty tabId');
      }
      const validTarget = validateNavigateTarget(target);
      if (!validTarget) {
        return fail('navigate requires a url or "back"/"forward"');
      }
      return manager.navigate(tabId, validTarget) ? ok(undefined) : fail(`unknown tab: ${tabId}`);
    },
    selectTab(tabId) {
      if (!isNonEmptyString(tabId)) {
        return fail('selectTab requires a non-empty tabId');
      }
      return manager.selectTab(tabId) ? ok(undefined) : fail(`unknown tab: ${tabId}`);
    },
    setBounds(rect) {
      const validated = validateRect(rect);
      if (!validated) {
        return fail('setBounds requires finite x/y and non-negative width/height');
      }
      manager.setBounds(validated);
      return ok(undefined);
    },
    setOccluded(occluded) {
      if (typeof occluded !== 'boolean') {
        return fail('setOccluded requires a boolean');
      }
      manager.setOccluded(occluded);
      return ok(undefined);
    },
  };
}
