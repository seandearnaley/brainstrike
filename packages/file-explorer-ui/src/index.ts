export * from './action-buttons';
export * from './components/restore-access-banner';
export * from './components/restore-access-modal';
export * from './context-actions';
export * from './contexts/file-editor-context';
export * from './contexts/markdown-preview-capabilities';
export { default as FileExplorerErrorBoundary } from './file-explorer-error-boundary';
export { default as FileRow } from './file-row';
export * from './folder-badge';
export { default as FolderSummaryThresholdSetting } from './folder-summary-threshold-setting';
export * from './hooks';
export { default as IncludeProjectTreeSetting } from './include-project-tree-setting';
export * from './indexing';
export { default as NodeCheckbox } from './node-checkbox';
export { default as NodeIcon } from './node-icon';
export * from './restoration-status';
export * from './scanning-status';
export * from './selection-counter';
export * from './selection-mode-badge';
export * from './shell';
// Explicit so the barrel's `LoadingProgressState` is a deliberate choice rather
// than an artefact of export precedence. Until BST-965 an explicit re-export
// from the (now deleted) loading-overlay shadowed this one, and the two are
// structurally unrelated: the old shape was
// `{ currentPath?, depthProgress?, loaded, percentage?, phase, total }`, this
// one is `{ isInitialLoading, loadingCount }`. Removing the explicit line
// silently swapped the public type instead of removing it, which no consumer
// would see as a missing export.
export type { LoadingProgressState } from './tree';
export * from './tree';
export * from './use-shared-file-content-loading';
export * from './utils/file-content-worker';
export * from './utils/file-node-cache';
export { DirectoryListingTruncatedError } from './utils/parallel-directory-walker';
export { processDirectoryEntry } from './utils/process-directory-entry';
export { processFileEntry } from './utils/process-file-entry';
export { readFullTree, readFullTreeWithOptions } from './utils/read-full-tree';
export * from './view-filter-preset-dropdown';
