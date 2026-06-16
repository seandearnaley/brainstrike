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
        source: 'electronAPI.db.query',
        reason: 'database bridge unavailable',
      });
    }
    return [];
  }
  try {
    const result = await query(sql, []);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (error) {
    accessIssues.push({
      source,
      reason: error instanceof Error ? error.message : String(error),
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
      const [roots, collectionStats, queueCounts, chunking, embedding] = await Promise.all([
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
        readHostStatus(bridges.chunkingHost, 'chunkingHost bridge unavailable'),
        readHostStatus(bridges.embeddingHost, 'embeddingHost bridge unavailable'),
      ]);

      return {
        roots,
        collectionStats,
        queueCounts,
        hosts: {
          chunking,
          embedding,
        },
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
      logger.warn('Failed to toggle inline fixture', { error, enabled });
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
      logger.error('Inline fixture toggle crashed outside guarded flow', { error, enabled });
    });
  };

  // Track previous state to detect actual changes
  let previousEnabled = store.getState().devInlineFixtureEnabled;

  // If fixture was enabled before subscription started (e.g., persisted state),
  // apply it immediately
  if (previousEnabled && !adapter.isInlineFixtureActive()) {
    safelyApplyFixtureState(true);
  }

  const unsubscribe = store.subscribe((state) => {
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
      window.__BRAINSTRIKE_INDEXING_DEBUG__ = createIndexingDebugApi();
    } else {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_INDEXING_DEBUG__ = undefined;
    }
  }

  return () => {
    unsubscribe();
    if (typeof window !== 'undefined') {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_INDEXING_DEBUG__ = undefined;
    }
  };
}
