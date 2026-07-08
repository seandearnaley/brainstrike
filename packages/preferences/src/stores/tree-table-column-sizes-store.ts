/**
 * TreeTable column sizes store factory.
 *
 * Each call to `createTreeTableColumnSizesStore` returns a fresh per-surface
 * Zustand store that persists `Record<columnId, pixelWidth>` to localStorage
 * (via `@brainstrike/storage`). The persistence layer mirrors the
 * `context-explorer-layout-store.ts` precedent:
 *
 * - Versioned storage name; bump `version` to invalidate stale data.
 * - `partialize` keeps only `sizes` in storage; methods and ephemeral state
 *   are derived at runtime.
 * - `migrate` callback receives the persisted value plus an integer version
 *   so consumers can transform old layouts safely.
 * - All persisted values are clamped to `[minWidth, maxWidth]` per column and
 *   stripped of NaN / non-finite / negative entries before they reach the
 *   store. Malformed columns fall back to their `defaultWidth`.
 *
 * Factory reset is handled implicitly: `clearPersistentUiState` performs a
 * `localStorage.clear()` (see `factory-reset-helpers.ts`), which removes every
 * versioned store created here.
 */
import type { StorageAdapter } from '@brainstrike/storage';
import { createBrowserStorageAdapter } from '@brainstrike/storage';
import { createLogger } from '@brainstrike/utils';
import type { StateCreator } from 'zustand';
import { type PersistOptions, type PersistStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

const logger = createLogger('TreeTableColumnSizesStore');

export interface ColumnSizeBounds {
  defaultWidth?: number;
  maxWidth?: number;
  minWidth?: number;
}

export interface TreeTableColumnSizesStoreState {
  /** Reset all sizes back to the column defaults. */
  reset: () => void;
  /** Bulk set; replaces the current map. Values are sanitized. */
  setAll: (next: Record<string, number>) => void;
  /** Update a single column. Sanitized against the column bounds. */
  setColumn: (columnId: string, width: number) => void;
  /** Current size map (sanitized). */
  sizes: Record<string, number>;
}

export interface CreateTreeTableColumnSizesStoreOptions {
  /** Bounds per column id used for sanitization. Defaults fill missing keys. */
  columnBounds: Record<string, ColumnSizeBounds>;
  /**
   * Optional migration hook. Receives the raw persisted state and the version
   * it was written at; should return a sanitizable map (or `null` to discard).
   */
  migrate?: (raw: unknown, version: number) => Record<string, number> | null;
  /** Optional storage override. Defaults to the browser storage adapter. */
  storage?: StorageAdapter;
  /** Unique persisted name; should include a version suffix (e.g. ".v1"). */
  storeName: string;
  /** Schema version. Bump to invalidate stale persisted layouts. */
  version: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampToBounds(width: number, bounds: ColumnSizeBounds | undefined): number {
  const min = bounds?.minWidth ?? 0;
  const max = bounds?.maxWidth ?? Number.POSITIVE_INFINITY;
  return Math.max(min, Math.min(max, Math.round(width)));
}

/**
 * Drop non-finite / negative entries, clamp surviving values to per-column
 * bounds, and substitute `defaultWidth` for any column whose persisted value
 * is missing or malformed.
 */
export function sanitizeColumnSizes(
  raw: unknown,
  columnBounds: Record<string, ColumnSizeBounds>
): Record<string, number> {
  const next: Record<string, number> = {};
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  for (const [columnId, bounds] of Object.entries(columnBounds)) {
    const candidate = source[columnId];
    // Distinguish garbage (NaN / Infinity / non-numeric) from finite-but-OOB
    // values: garbage falls back to defaultWidth, finite values (including
    // negatives and zero) are clamped into [minWidth, maxWidth].
    if (isFiniteNumber(candidate)) {
      next[columnId] = clampToBounds(candidate, bounds);
      continue;
    }
    if (bounds.defaultWidth !== undefined) {
      next[columnId] = clampToBounds(bounds.defaultWidth, bounds);
    }
  }

  return next;
}

export interface PersistedShape {
  sizes: Record<string, number>;
}

function parsePersistedRaw(raw: string | null): { state: PersistedShape; version: number } | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      state?: PersistedShape | Record<string, number>;
      version?: number;
    };
    const version = typeof parsed.version === 'number' ? parsed.version : 0;
    // Defensive: support both shape variants — `state.sizes` (preferred) and
    // a flat `state` map for older snapshots.
    const sizes =
      parsed?.state && typeof parsed.state === 'object' && 'sizes' in parsed.state
        ? (parsed.state.sizes as Record<string, number>)
        : ((parsed?.state as Record<string, number> | undefined) ?? {});
    return { state: { sizes }, version };
  } catch (error) {
    if (process.env['NODE_ENV'] !== 'production') {
      logger.warn('Ignoring invalid persisted column sizes', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function createAdapterPersistStorage(storage: StorageAdapter): PersistStorage<PersistedShape> {
  return {
    getItem: async (name) => parsePersistedRaw(await storage.getItem(name)),
    removeItem: async (name) => {
      await storage.removeItem(name);
    },
    setItem: async (name, value) => {
      await storage.setItem(name, JSON.stringify(value));
    },
  };
}

interface ResolveInitialOptions {
  columnBounds: Record<string, ColumnSizeBounds>;
  migrate: CreateTreeTableColumnSizesStoreOptions['migrate'];
  raw: unknown;
  version: number;
}

function resolveInitialFromRaw({
  raw,
  version,
  migrate,
  columnBounds,
}: ResolveInitialOptions): Record<string, number> {
  if (raw === null || raw === undefined) {
    return sanitizeColumnSizes({}, columnBounds);
  }
  if (migrate) {
    const migrated = migrate(raw, version);
    if (migrated !== null) {
      return sanitizeColumnSizes(migrated, columnBounds);
    }
    return sanitizeColumnSizes({}, columnBounds);
  }
  return sanitizeColumnSizes(raw, columnBounds);
}

function buildCreator(
  columnBounds: Record<string, ColumnSizeBounds>
): StateCreator<TreeTableColumnSizesStoreState, [['zustand/persist', unknown]], []> {
  return (set, _get) => ({
    reset: () => {
      set({ sizes: sanitizeColumnSizes({}, columnBounds) });
    },
    setAll: (next) => {
      set({ sizes: sanitizeColumnSizes(next, columnBounds) });
    },
    setColumn: (columnId, width) => {
      const bounds = columnBounds[columnId];
      if (!bounds) {
        return;
      }
      if (!isFiniteNumber(width)) {
        return;
      }
      set((state) => ({
        sizes: {
          ...state.sizes,
          [columnId]: clampToBounds(width, bounds),
        },
      }));
    },
    sizes: sanitizeColumnSizes({}, columnBounds),
  });
}

function buildPersistOptions(
  options: CreateTreeTableColumnSizesStoreOptions,
  storage: PersistStorage<PersistedShape>
): PersistOptions<TreeTableColumnSizesStoreState, PersistedShape> {
  return {
    merge: (persisted, current) => ({
      ...current,
      sizes: sanitizeColumnSizes(
        (persisted as PersistedShape | undefined)?.sizes,
        options.columnBounds
      ),
    }),
    migrate: (persisted, version) => {
      // Persisted shape is already `{ sizes }`; route through resolveInitial
      // so consumer-provided migrate hooks and sanitization run uniformly.
      const initial = resolveInitialFromRaw({
        columnBounds: options.columnBounds,
        migrate: options.migrate,
        raw: (persisted as PersistedShape | undefined)?.sizes ?? persisted,
        version,
      });
      return { sizes: initial } as PersistedShape;
    },
    name: options.storeName,
    partialize: (state) => ({ sizes: state.sizes }),
    storage,
    version: options.version,
  };
}

function resolveStorageAdapter(
  override: StorageAdapter | undefined
): PersistStorage<PersistedShape> {
  if (override) {
    return createAdapterPersistStorage(override);
  }
  try {
    return createAdapterPersistStorage(createBrowserStorageAdapter());
  } catch {
    // Fall back to a no-op storage so the store still functions in
    // environments without browser storage (SSR / non-DOM tests).
    return {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    };
  }
}

export function createTreeTableColumnSizesStore(options: CreateTreeTableColumnSizesStoreOptions) {
  const storage = resolveStorageAdapter(options.storage);
  return create<TreeTableColumnSizesStoreState>()(
    persist(buildCreator(options.columnBounds), buildPersistOptions(options, storage))
  );
}

/**
 * Per-process singleton wrapper for `createTreeTableColumnSizesStore`.
 *
 * HMR, React StrictMode double-invocation, and dynamic imports across
 * workspace boundaries can all instantiate a module more than once in a
 * single tab. Stashing the store on `globalThis` under a unique key (with a
 * brand check that survives module reloads) ensures every caller resolves to
 * the same Zustand instance so persistence + subscriptions stay coherent.
 *
 * Consumers pass the column bounds + persisted name/version they want; the
 * helper handles the rest. Extracted to remove the ~30-line copy/paste pair
 * that existed in collection-browser and context-preview singleton files.
 */
const SINGLETON_BRAND = '__brainstrike_store_brand__';
const SINGLETON_BRAND_VERSION = 1 as const;

type ColumnSizesStore = ReturnType<typeof createTreeTableColumnSizesStore>;

function isValidColumnSizesStore(
  candidate: unknown
): candidate is ColumnSizesStore & { [k: string]: unknown } {
  if (!candidate || typeof candidate !== 'function') {
    return false;
  }
  const fn = candidate as unknown as {
    getState?: unknown;
    setState?: unknown;
    [k: string]: unknown;
  };
  const ok = typeof fn.getState === 'function' && typeof fn.setState === 'function';
  return ok && fn[SINGLETON_BRAND] === SINGLETON_BRAND_VERSION;
}

export function createSingletonColumnSizesStore(
  globalKey: string,
  options: CreateTreeTableColumnSizesStoreOptions
): ColumnSizesStore {
  const g = globalThis as unknown as Record<string, unknown>;
  let singleton = g[globalKey] as unknown;
  if (!isValidColumnSizesStore(singleton)) {
    singleton = createTreeTableColumnSizesStore(options);
    (singleton as Record<string, unknown>)[SINGLETON_BRAND] = SINGLETON_BRAND_VERSION;
    g[globalKey] = singleton as unknown;
  }
  return singleton as ColumnSizesStore;
}
