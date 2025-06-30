import type { PGlite } from '@electric-sql/pglite';
import {
  type ElectronDbAPI,
  ElectronFileRecordRepository,
} from './electron-file-record-repository.js';
import { FileRecordRepository } from './file-record-repository.js';
import type { IFileRecordRepository } from './interfaces.js';

// Re-export types for consumers
export type { ElectronDbAPI } from './electron-file-record-repository.js';

/**
 * Create a FileRecordRepository for the given database
 */
export function createFileRecordRepository(db: PGlite | ElectronDbAPI): IFileRecordRepository {
  // Check if it's a PGlite instance by looking for PGlite-specific properties
  if (isPGlite(db)) {
    return new FileRecordRepository(db);
  }

  // Otherwise, assume it's an Electron IPC database
  return new ElectronFileRecordRepository(db);
}

/**
 * Type guard to check if database is PGlite
 */
export function isPGlite(db: unknown): db is PGlite {
  return (
    typeof db === 'object' && db !== null && 'exec' in db && 'listen' in db && 'unlisten' in db
  );
}
