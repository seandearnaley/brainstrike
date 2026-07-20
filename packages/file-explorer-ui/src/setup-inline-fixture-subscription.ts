/**
 * Inline Fixture Subscription
 *
 * Sets up a Zustand store subscription to manage inline fixture
 * loading/clearing outside the React component tree. This ensures
 * the fixture activates regardless of which page/route is active.
 *
 * Also exposes `window.__BRAINSTRIKE_LOAD_FIXTURE__` and
 * `window.__BRAINSTRIKE_CLEAR_FIXTURE__` for automated testing
 * tools (Playwright, Chrome DevTools MCP, Claude Code) that
 * cannot interact with the native directory picker.
 *
 * @see https://github.com/microsoft/playwright/issues/11288
 */

import type { FileSystemAdapter } from '@brainstrike/file-system';
import {
  type DirectoryHandle,
  type FixtureCapableFileSystemAdapter,
  type FixtureDefinition,
  type FixtureLoadOptions,
  isFixtureCapableAdapter,
} from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import type { StoreApi } from 'zustand';
import { dispatchInjectRootHandle } from './inject-root-handle-event';
import { shouldExposeAutomatedTestApis } from './utils/fixture-test-exposure';
import { hasPersistHydrationApi } from './utils/persist-hydration';

const logger = createLogger('InlineFixtureSubscription');

interface IndexingDebugAccessIssue {
  reason: string;
  source: string;
}

interface IndexingDebugBridgeStatus {
  available: false;
  reason: string;
}

interface IndexingDebugAvailableHostStatus {
  available: true;
  status: unknown;
}

type IndexingDebugHostStatus = IndexingDebugAvailableHostStatus | IndexingDebugBridgeStatus;

interface IndexingDebugSnapshot {
  accessIssues?: IndexingDebugAccessIssue[];
  chunkingBacklog: unknown[];
  collectionStats: unknown[];
  hosts: {
    chunking: IndexingDebugHostStatus;
    embedding: IndexingDebugHostStatus;
  };
  queueCounts: unknown[];
  roots: unknown[];
}

interface IndexingDebugApi {
  snapshot: () => Promise<IndexingDebugSnapshot>;
}

type DbQueryBridge = (sql: string, params: unknown[]) => Promise<{ rows?: unknown[] }>;

interface IndexingDebugWindowBridges {
  chunkingHost?: { getStatus?: () => Promise<unknown> };
  electronAPI?: { db?: { query?: DbQueryBridge } };
  embeddingHost?: { getStatus?: () => Promise<unknown> };
}

declare global {
  interface Window {
    /**
     * Add an ADDITIONAL fixture root alongside the loaded inline fixture
     * (multi-root harness). Requires __BRAINSTRIKE_LOAD_FIXTURE__ first;
     * throws otherwise. The added root is never persisted.
     */
    // biome-ignore lint/style/useNamingConvention: Global test API uses double underscores for clarity
    __BRAINSTRIKE_ADD_FIXTURE_ROOT__?:
      | ((fixture: FixtureDefinition) => Promise<DirectoryHandle>)
      | undefined;
    /** Clear the dev fixture and reset the file explorer */
    // biome-ignore lint/style/useNamingConvention: Global test API uses double underscores for clarity
    __BRAINSTRIKE_CLEAR_FIXTURE__?: (() => void | Promise<void>) | undefined;
    /** Read-only indexing diagnostics for automated debugging tools */
    // biome-ignore lint/style/useNamingConvention: Global test API uses double underscores for clarity
    __BRAINSTRIKE_INDEXING_DEBUG__?: IndexingDebugApi | undefined;
    /** Load the built-in dev fixture into the file explorer (bypasses native directory picker) */
    // biome-ignore lint/style/useNamingConvention: Global test API uses double underscores for clarity
    __BRAINSTRIKE_LOAD_FIXTURE__?:
      | ((
          fixture?: FixtureDefinition,
          options?: FixtureLoadOptions
        ) => DirectoryHandle | Promise<DirectoryHandle | null> | null | undefined)
      | undefined;
    // biome-ignore lint/style/useNamingConvention: E2E init-script flag uses double underscores by convention
    __brainstrike_e2e_expose_file_explorer_store__?: boolean | undefined;
  }
}

async function readRows(
  query: DbQueryBridge | undefined,
  sql: string,
  accessIssues: IndexingDebugAccessIssue[],
  source: string
): Promise<unknown[]> {
  if (!query) {
    if (!accessIssues.some((issue) => issue.source === 'electronAPI.db.query')) {
      accessIssues.push({
        reason: 'database bridge unavailable',
        source: 'electronAPI.db.query',
      });
    }
    return [];
  }
  try {
    const result = await query(sql, []);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (error) {
    accessIssues.push({
      reason: error instanceof Error ? error.message : String(error),
      source,
    });
    return [];
  }
}

async function readHostStatus(
  host: { getStatus?: () => Promise<unknown> } | undefined,
  unavailableReason: string
): Promise<IndexingDebugHostStatus> {
  if (!host?.getStatus) {
    return {
      available: false,
      reason: unavailableReason,
    };
  }
  try {
    return {
      available: true,
      status: await host.getStatus(),
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function createIndexingDebugApi(): IndexingDebugApi {
  return Object.freeze({
    snapshot: async (): Promise<IndexingDebugSnapshot> => {
      const accessIssues: IndexingDebugAccessIssue[] = [];
      const bridges = window as Window & IndexingDebugWindowBridges;
      const query = bridges.electronAPI?.db?.query;
      const [roots, collectionStats, queueCounts, chunkingBacklog, chunking, embedding] =
        await Promise.all([
          readRows(
            query,
            'SELECT id, path, display_name, kind, status, created_at, last_verified_at FROM roots ORDER BY created_at ASC',
            accessIssues,
            'roots'
          ),
          readRows(
            query,
            'SELECT embedding_set_id, file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty, last_refreshed_at FROM collection_indexing_stats ORDER BY last_refreshed_at DESC',
            accessIssues,
            'collection_indexing_stats'
          ),
          readRows(
            query,
            "SELECT queue, job_type, state, COUNT(*)::int AS count FROM job_queue WHERE job_type = 'embed_chunk' GROUP BY queue, job_type, state ORDER BY queue, job_type, state",
            accessIssues,
            'job_queue'
          ),
          readRows(
            query,
            // Debug-only backlog snapshot: `oldest_updated_at` is the oldest
            // current row write time, not the original discovery/enqueue time.
            'SELECT embedding_set_id, root_id, COUNT(*)::int AS file_count, MIN(updated_at) AS oldest_updated_at FROM file_records WHERE embedding_set_id IS NOT NULL AND root_id IS NOT NULL AND chunks_processed_at IS NULL GROUP BY embedding_set_id, root_id ORDER BY embedding_set_id, root_id',
            accessIssues,
            'file_records_chunking_backlog'
          ),
          readHostStatus(bridges.chunkingHost, 'chunkingHost bridge unavailable'),
          readHostStatus(bridges.embeddingHost, 'embeddingHost bridge unavailable'),
        ]);

      return {
        chunkingBacklog,
        collectionStats,
        hosts: {
          chunking,
          embedding,
        },
        queueCounts,
        roots,
        ...(accessIssues.length > 0 ? { accessIssues } : {}),
      };
    },
  });
}

/**
 * Sets up a store subscription that loads/clears the inline fixture
 * whenever `devInlineFixtureEnabled` changes.
 *
 * Returns an unsubscribe function for cleanup (e.g., HMR dispose).
 */
export function setupInlineFixtureSubscription(
  store: StoreApi<FileExplorerState>,
  fileSystemAdapter: FileSystemAdapter
): () => void {
  if (!isFixtureCapableAdapter(fileSystemAdapter)) {
    logger.debug('Adapter does not support inline fixtures, skipping subscription');
    return () => {};
  }

  const adapter = fileSystemAdapter as FixtureCapableFileSystemAdapter;
  let isProcessing = false;
  let suppressNextSubscription = false;
  // The handle's render source of truth is the reducer (reached via the inject
  // event below). This local mirrors the last-DISPATCHED handle so the
  // synchronous early-return can answer while a load is in flight; E2E awaits the
  // returned Promise for the committed handle.
  let lastInjectedHandle: DirectoryHandle | null = null;

  const applyFixtureState = async (
    enabled: boolean,
    fixture?: FixtureDefinition,
    options?: FixtureLoadOptions
  ): Promise<DirectoryHandle | null> => {
    if (isProcessing) {
      return enabled ? lastInjectedHandle : null;
    }
    isProcessing = true;

    try {
      if (enabled) {
        adapter.setInlineFixtureOptions?.(options);
        const handle = await adapter.loadInlineFixture(fixture);
        lastInjectedHandle = handle;
        dispatchInjectRootHandle(handle);
        logger.info('Inline fixture loaded');
        return handle;
      }
      await adapter.clearInlineFixture();
      adapter.setInlineFixtureOptions?.();
      lastInjectedHandle = null;
      dispatchInjectRootHandle(null);
      logger.info('Inline fixture cleared');
      return null;
    } catch (error) {
      logger.warn('Failed to toggle inline fixture', { enabled, error });
      // Roll back the toggle without re-entering the subscription loop.
      suppressNextSubscription = true;
      store.getState().setDevInlineFixtureEnabled(!enabled);
      return null;
    } finally {
      isProcessing = false;
    }
  };

  const safelyApplyFixtureState = (
    enabled: boolean,
    fixture?: FixtureDefinition,
    options?: FixtureLoadOptions
  ): void => {
    void applyFixtureState(enabled, fixture, options).catch((error) => {
      logger.error('Inline fixture toggle crashed outside guarded flow', { enabled, error });
    });
  };

  // Baseline for change detection. Seeded post-hydration in `armAfterHydration`
  // below — the file-explorer store hydrates ASYNCHRONOUSLY (the persist
  // `getItem` returns a Promise on every backend, worker-backed or not; see
  // packages/file-explorer/src/persistence/), so at this useEffect-setup time
  // the flag still holds its pre-hydration default. Reading it here would seed a
  // stale baseline AND leave the guard a no-op, so the subsequent hydration
  // merge flipping false→true would look like a genuine user toggle and load the
  // fixture in mode 'replace' — dropping the user's restored roots. Deferring
  // BOTH the guard and the subscription until hydration folds whatever value the
  // merge installs into the baseline instead of firing a load.
  let previousEnabled = false;
  let storeUnsubscribe: (() => void) | null = null;
  let disposed = false;

  const armAfterHydration = (): void => {
    if (disposed) {
      // Torn down (HMR/unmount) before hydration finished — do not arm.
      return;
    }

    // Post-hydration baseline: the REAL persisted flag value.
    previousEnabled = store.getState().devInlineFixtureEnabled;
    // A programmatic load/clear via the window globals may have run before
    // hydration finished; its suppression token is meaningless now that the
    // subscription is armed against a fresh baseline.
    suppressNextSubscription = false;

    // A PERSISTED enable must NOT resurrect at boot: fixture injection routes
    // through mode 'replace' (drops other roots), so auto-applying it silently
    // swapped the user's restored workspace for the mock fixture on every
    // launch ("my roots don't persist"). Reset the flag instead — enabling the
    // inline fixture is an explicit per-session action. (When the adapter is
    // ALREADY active — e.g. HMR re-setup mid-session — the fixture stays; only
    // the cold-boot resurrection is blocked.)
    if (previousEnabled && !adapter.isInlineFixtureActive()) {
      logger.warn(
        'Inline fixture was enabled in persisted state — resetting to keep the restored workspace; re-enable it from settings for this session'
      );
      // Runs BEFORE the subscription below is registered, so no suppression is
      // needed — the reset cannot bounce back into this handler.
      try {
        store.getState().setDevInlineFixtureEnabled(false);
      } catch (error) {
        logger.error('Failed to reset persisted inline fixture flag', { error });
      }
      previousEnabled = false;
    }

    storeUnsubscribe = store.subscribe((state) => {
      const currentEnabled = state.devInlineFixtureEnabled;
      if (suppressNextSubscription) {
        suppressNextSubscription = false;
        previousEnabled = currentEnabled;
        return;
      }
      if (currentEnabled === previousEnabled) {
        return;
      }
      previousEnabled = currentEnabled;
      safelyApplyFixtureState(currentEnabled);
    });
  };

  // Order the guard + subscription AFTER persist hydration. `onFinishHydration`
  // is edge-triggered (fires once, never retro-fires), so check `hasHydrated()`
  // first — same two-step pattern as `waitForHydration`. A store without the
  // persist API (vanilla test store, or synchronous already-hydrated storage)
  // arms immediately, matching the previous synchronous behavior.
  let cancelHydrationWait: (() => void) | null = null;
  if (hasPersistHydrationApi(store) && !store.persist.hasHydrated()) {
    cancelHydrationWait = store.persist.onFinishHydration(() => {
      cancelHydrationWait = null;
      armAfterHydration();
    });
  } else {
    armAfterHydration();
  }

  // Expose global testing API
  if (typeof window !== 'undefined') {
    const env = (
      import.meta as ImportMeta & {
        env?: Record<string, unknown>;
      }
    ).env;
    if (shouldExposeAutomatedTestApis(env)) {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = async (
        fixture?: FixtureDefinition,
        options?: FixtureLoadOptions
      ) => {
        suppressNextSubscription = true;
        store.getState().setDevInlineFixtureEnabled(true);
        return await applyFixtureState(true, fixture, options);
      };
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = async () => {
        suppressNextSubscription = true;
        store.getState().setDevInlineFixtureEnabled(false);
        await applyFixtureState(false);
      };
      window.__BRAINSTRIKE_ADD_FIXTURE_ROOT__ = async (fixture: FixtureDefinition) => {
        // Multi-root harness: the adapter appends the fixture state (throws
        // without a primary fixture / on duplicates — no half-activation) and
        // the inject 'add' path appends the handle as an additional root.
        // Shares the load/clear re-entrancy guard: an in-flight
        // loadInlineFixture reassigns the adapter's fixture list, which would
        // silently drop a concurrently-added root — fail loudly instead.
        if (isProcessing) {
          throw new Error('Cannot add a fixture root while a fixture load or clear is in flight');
        }
        isProcessing = true;
        try {
          const handle = await adapter.addInlineFixtureRoot(fixture);
          dispatchInjectRootHandle(handle, 'add');
          logger.info('Inline fixture root added', { name: fixture.name });
          return handle;
        } finally {
          isProcessing = false;
        }
      };
      window.__BRAINSTRIKE_INDEXING_DEBUG__ = createIndexingDebugApi();
    } else {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_ADD_FIXTURE_ROOT__ = undefined;
      window.__BRAINSTRIKE_INDEXING_DEBUG__ = undefined;
    }
  }

  return () => {
    disposed = true;
    // Cancel a still-pending hydration wait so a late `onFinishHydration` cannot
    // arm a subscription on a torn-down setup.
    if (cancelHydrationWait) {
      cancelHydrationWait();
      cancelHydrationWait = null;
    }
    if (storeUnsubscribe) {
      storeUnsubscribe();
      storeUnsubscribe = null;
    }
    if (typeof window !== 'undefined') {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_ADD_FIXTURE_ROOT__ = undefined;
      window.__BRAINSTRIKE_INDEXING_DEBUG__ = undefined;
    }
  };
}
