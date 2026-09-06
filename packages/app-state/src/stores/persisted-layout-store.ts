/**
 * Shared persistence plumbing for the panel layout stores (BST-516).
 *
 * `panel-layout-store.ts` and `context-explorer-layout-store.ts` persist the
 * same `sizes/showLeftPanel/showRightPanel/showConsole` subset and used to
 * carry private, drifting copies of everything below. This module is the ONE
 * owner of: corrupted-size detection, JSON parse + recovery, the adapter-backed
 * `PersistStorage` wrapper, the localStorage/memory fallback storage, the
 * browser-adapter-or-fallback resolution, size normalization, and the HMR-safe
 * global singleton registry. Store names, versions, defaults, migrations, and
 * partialize stay with each store.
 */

import { createLogger } from '@brainstrike/logging';
import type { StorageAdapter } from '@brainstrike/storage';
import { createBrowserStorageAdapter } from '@brainstrike/storage';
import type { PersistStorage } from 'zustand/middleware';

export type PanelSizes = [number, number, number];

/** The persisted subset every layout store shares. */
export interface PersistedLayoutState {
  showConsole: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  sizes: PanelSizes;
}

/**
 * What comes back from storage: the whitelisted keys of an untrusted snapshot.
 * `state` is honestly partial — only `sizes` is validated (and repaired);
 * zustand's merge lays the rest over the store defaults, as it always has.
 */
export interface PersistedLayoutStorageValue<P extends PersistedLayoutState> {
  state: Partial<P>;
  version: number;
}

export interface SizeRules {
  readonly defaultSizes: readonly [number, number, number];
  /** Panels smaller than this (but non-zero) are treated as corrupted. */
  readonly minPanelSize: number;
}

/** Default minimum panel size shared by both layout stores. */
export const DEFAULT_MIN_PANEL_SIZE = 10;

/**
 * True when `sizes` is not a tuple of the expected length made of finite,
 * non-negative numbers where every non-zero entry is at least `minPanelSize`.
 * Catches the `[4.488, 5.386, 0]` class of corrupted localStorage values.
 */
export function hasCorruptedSizes(
  sizes: unknown,
  rules: { readonly expectedLength: number; readonly minPanelSize: number }
): boolean {
  if (!Array.isArray(sizes) || sizes.length !== rules.expectedLength) {
    return true;
  }
  return sizes.some(
    (size) =>
      typeof size !== 'number' ||
      Number.isNaN(size) ||
      size < 0 ||
      (size > 0 && size < rules.minPanelSize)
  );
}

export interface PersistedLayoutParserOptions<P extends PersistedLayoutState> {
  readonly defaultSizes: readonly [number, number, number];
  /** Logger name for the invalid-JSON warning (non-production only). */
  readonly loggerName: string;
  readonly minPanelSize?: number;
  /**
   * The whitelist, as data: only these keys are copied out of a persisted
   * snapshot. Anything else (e.g. the outer shell's legacy `activeTab`) can
   * never restore, whatever an old snapshot contains — and there is no
   * projection function to accidentally pass through.
   */
  readonly persistedKeys: readonly (keyof P & string)[];
}

export type PersistedLayoutParser<P extends PersistedLayoutState> = (
  raw: string | null
) => PersistedLayoutStorageValue<P> | null;

function pickPersistedKeys<P extends PersistedLayoutState>(
  raw: Record<string, unknown>,
  keys: readonly (keyof P & string)[]
): Partial<P> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(raw, key)) {
      picked[key] = raw[key];
    }
  }
  // Values other than `sizes` are not validated here (pre-existing contract:
  // zustand's merge accepts them as-is); `Partial` is the honest shape.
  return picked as Partial<P>;
}

function isSnapshotObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Builds the read-side parser: invalid JSON or a snapshot without an object
 * `state` yields null (defaults win); a missing or corrupted `sizes` is
 * repaired to `defaultSizes` (a snapshot without `sizes` would otherwise
 * merge `undefined` over the default tuple and crash the first
 * `sizes[0]` read); the persisted version is preserved so zustand's
 * `migrate` still sees it.
 */
export function createPersistedLayoutParser<P extends PersistedLayoutState>(
  options: PersistedLayoutParserOptions<P>
): PersistedLayoutParser<P> {
  const logger = createLogger(options.loggerName);
  const minPanelSize = options.minPanelSize ?? DEFAULT_MIN_PANEL_SIZE;
  const expectedLength = options.defaultSizes.length;

  return (raw) => {
    if (!raw) {
      return null;
    }
    // Only the parse is guarded: a JSON failure is genuinely corrupt storage,
    // and nothing after it should be able to masquerade as one.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (process.env['NODE_ENV'] !== 'production') {
        logger.warn('Ignoring invalid persisted layout state', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
    if (!(isSnapshotObject(parsed) && isSnapshotObject(parsed['state']))) {
      return null;
    }
    const state = pickPersistedKeys<P>(parsed['state'], options.persistedKeys);
    const version = typeof parsed['version'] === 'number' ? parsed['version'] : 0;
    if (hasCorruptedSizes(state.sizes, { expectedLength, minPanelSize })) {
      return {
        state: { ...state, sizes: [...options.defaultSizes] as PanelSizes },
        version,
      };
    }
    return { state, version };
  };
}

/**
 * Adapter-backed storage stays async, so hydration through it resolves on a
 * later microtask; the fallback storage below is synchronous for direct
 * localStorage environments.
 */
export function createAdapterPersistStorage<P extends PersistedLayoutState>(
  storage: StorageAdapter,
  parse: PersistedLayoutParser<P>
): PersistStorage<Partial<P>> {
  return {
    getItem: async (name: string) => parse(await storage.getItem(name)),
    removeItem: async (name: string) => {
      await storage.removeItem(name);
    },
    setItem: async (name: string, value) => {
      await storage.setItem(name, JSON.stringify(value));
    },
  };
}

/** `window.localStorage` when reachable, otherwise a per-instance memory map. */
export function createFallbackPersistStorage<P extends PersistedLayoutState>(
  parse: PersistedLayoutParser<P>
): PersistStorage<Partial<P>> {
  const memoryStorage = new Map<string, string>();

  const getBrowserStorage = (): Storage | null => {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };

  return {
    getItem: (name: string) => {
      const browserStorage = getBrowserStorage();
      return parse(
        browserStorage ? browserStorage.getItem(name) : (memoryStorage.get(name) ?? null)
      );
    },
    removeItem: (name: string) => {
      const browserStorage = getBrowserStorage();
      if (browserStorage) {
        browserStorage.removeItem(name);
        return;
      }
      memoryStorage.delete(name);
    },
    setItem: (name: string, value) => {
      const serialized = JSON.stringify(value);
      const browserStorage = getBrowserStorage();
      if (browserStorage) {
        browserStorage.setItem(name, serialized);
        return;
      }
      memoryStorage.set(name, serialized);
    },
  };
}

/**
 * Module-singleton storage: the browser storage adapter when it can be
 * constructed, otherwise the fallback. The throw→fallback path is what the
 * singleton tests exercise by making `createBrowserStorageAdapter` throw.
 */
export function resolveDefaultPersistStorage<P extends PersistedLayoutState>(
  parse: PersistedLayoutParser<P>
): PersistStorage<Partial<P>> {
  try {
    return createAdapterPersistStorage(createBrowserStorageAdapter(), parse);
  } catch {
    return createFallbackPersistStorage(parse);
  }
}

/**
 * Clamp into [0, 100], repair corrupted (non-zero below minimum) values to the
 * defaults, spread an all-zero tuple evenly, and rescale totals above 100%.
 * An empty input stays empty so callers can keep the current tuple.
 */
export function normalizeSizes(sizes: number[], rules: SizeRules): number[] {
  if (!sizes || sizes.length === 0) {
    return [];
  }

  const clamped = sizes.map((size) => {
    const num = typeof size === 'number' && !Number.isNaN(size) ? size : 0;
    return Math.max(0, Math.min(100, num));
  });

  if (clamped.some((size) => size > 0 && size < rules.minPanelSize)) {
    return [...rules.defaultSizes];
  }

  const total = clamped.reduce((sum, size) => sum + size, 0);
  if (total === 0) {
    return clamped.map(() => 100 / clamped.length);
  }
  if (total > 100) {
    return clamped.map((size) => (size / total) * 100);
  }
  return clamped;
}

/** Normalizes `sizes` and fills any omitted slot from `current`. */
export function resolveNextSizes(
  sizes: number[],
  current: PanelSizes,
  rules: SizeRules
): PanelSizes {
  const normalized = normalizeSizes(sizes, rules);
  return [normalized[0] ?? current[0], normalized[1] ?? current[1], normalized[2] ?? current[2]];
}

const BRAND = '__brainstrike_store_brand__';
const BRAND_VERSION = 1 as const;

interface BrandedStoreLike {
  getState: () => unknown;
  setState: (...args: never[]) => unknown;
}

function isValidStore(candidate: unknown): candidate is BrandedStoreLike {
  if (!candidate || typeof candidate !== 'function') {
    return false;
  }
  const fn = candidate as { getState?: unknown; setState?: unknown; [BRAND]?: unknown };
  return (
    typeof fn.getState === 'function' &&
    typeof fn.setState === 'function' &&
    fn[BRAND] === BRAND_VERSION
  );
}

/**
 * HMR-safe module singleton: reuses the store registered under `globalKey`
 * when it carries the current brand, otherwise builds, brands, and registers
 * a new one.
 */
export function resolveGlobalStoreSingleton<TStore extends BrandedStoreLike>(
  globalKey: string,
  build: () => TStore
): TStore {
  // `typeof globalThis` carries an implicit string index signature, so the
  // registry view is a plain annotated assignment — no cast required.
  const registry: Record<string, unknown> = globalThis;
  const existing = registry[globalKey];
  if (isValidStore(existing)) {
    return existing as TStore;
  }
  const created = build();
  (created as unknown as Record<string, unknown>)[BRAND] = BRAND_VERSION;
  registry[globalKey] = created;
  return created;
}
