/**
 * File Explorer Persistence
 *
 * This module contains persistence configuration and utilities for the file explorer store.
 * It handles state serialization/deserialization and rehydration.
 */
import type { PersistOptions } from 'zustand/middleware';
import type { FileExplorerState, SerializedState } from '../types/file-explorer-types';
export declare const createPersistOptions: () => PersistOptions<FileExplorerState, SerializedState>;
//# sourceMappingURL=file-explorer-persistence.d.ts.map