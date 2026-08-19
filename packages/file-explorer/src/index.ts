/* c8 ignore file -- barrel exports only */
export * from './actions/directory-expansion-actions';
export * from './actions/file-selection-actions';
export {
  getSelectionAncestorDirectories,
  getSelectionProjectionPaths,
} from './actions/file-selection-reconciliation';
export * from './actions/folder-state-actions';
export * from './actions/selection-model-actions';
export * from './actions/settings-actions';
export * from './constants';
export * from './persistence/file-explorer-persistence';
export {
  FILE_EXPLORER_STORAGE_KEY,
  FILE_EXPLORER_STORAGE_VERSION,
} from './persistence/persistence-constants';
export * from './persistence/tab-persistence';
export { resolveWorkerStorageUrl } from './persistence/worker-storage';
export * from './store';
export type { GetState, SetState } from './types/store-types';
export {
  getFocusedSelectionCount,
  getForeignSelectionCount,
  getUnionSelectionCount,
} from './utils/file-explorer-utils';
export * from './utils/query-selection-manifest';
