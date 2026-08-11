import type { EnhancedImportProgress } from './types';

export interface ImportActivitySnapshot {
  /** Live progress of the running import, or null when nothing is running. */
  readonly progress: EnhancedImportProgress | null;
  /** Files the running (or next) import would cover. */
  readonly selectedFileCount: number;
}

const IDLE: ImportActivitySnapshot = { progress: null, selectedFileCount: 0 };

let current: ImportActivitySnapshot = IDLE;

/** Test-only reset helper for the module-scoped import activity slot. */
export function __resetImportActivitySnapshotForTests(): void {
  current = IDLE;
}

/**
 * One-slot publication of the active import's progress.
 *
 * The import trigger lives in the file explorer's selection bar, but the
 * Database panel still owns the app's import observability hook. Rather than
 * give the Database panel a second (untriggerable) import service just to have
 * something to report, the surface that actually runs the import publishes
 * here and the panel reads it.
 *
 * Single-writer by construction: exactly one surface owns an import flow.
 */
export function publishImportActivitySnapshot(snapshot: ImportActivitySnapshot): void {
  current = snapshot;
}

export function clearImportActivitySnapshot(): void {
  current = IDLE;
}

export function readImportActivitySnapshot(): ImportActivitySnapshot {
  return current;
}
