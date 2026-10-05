import {
  applyManagedCacheBatch,
  createPriorityDbHandle,
  getDesktopDatabaseBridge,
} from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useEffect, useMemo } from 'react';
import type { runWorkspaceIndexStageBenchmark } from './workspace-index-debug-benchmark';
import { shouldExposeWorkspaceIndexDebugApi } from './workspace-index-debug-harness';
import { createWorkspaceIndexStageApi } from './workspace-index-stage-harness';

type StageDependencies = Parameters<typeof runWorkspaceIndexStageBenchmark>[0];
interface StageWindow {
  readonly chunkingHost?: StageDependencies['chunkingHost'];
  readonly embeddingHost?: StageDependencies['embeddingHost'];
}
const WORK_OPTIONS = { label: 'workspace component benchmark', priority: 'background' } as const;

/** Opt-in component verifier stays mounted on both native and browser indexing paths. */
export function WorkspaceIndexStageProvider(): null {
  const db = usePGliteDatabase();
  const backgroundDb = useMemo(() => (db ? createPriorityDbHandle(db, 'background') : null), [db]);
  useEffect(() => {
    if (
      !shouldExposeWorkspaceIndexDebugApi(
        (import.meta as ImportMeta & { env?: Record<string, unknown> }).env
      )
    ) {
      return;
    }
    const api = createWorkspaceIndexStageApi(() => {
      const bridge = getDesktopDatabaseBridge();
      const applyBatch = bridge?.applyManagedCacheBatch;
      const hosts = window as Window & StageWindow;
      return {
        applyManagedCacheBatch: applyBatch
          ? (args) => applyBatch(args, WORK_OPTIONS)
          : backgroundDb
            ? (args) => applyManagedCacheBatch(backgroundDb, args)
            : undefined,
        chunkingHost: hosts.chunkingHost,
        db: backgroundDb,
        electronRunTransaction: bridge?.runTransaction,
        electronTransactionOptions: WORK_OPTIONS,
        embeddingHost: hosts.embeddingHost,
      };
    });
    window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__ = api;
    return () => {
      if (window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__ === api) {
        window.__BRAINSTRIKE_WORKSPACE_INDEX_STAGE__ = undefined;
      }
    };
  }, [backgroundDb]);
  return null;
}
