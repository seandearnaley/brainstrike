// Import the actual classes
import { ConcurrentLoadingError, FileContentError, PartialRefreshError } from './errors.js';

export * from './assistant-provider-settings.js';
export * from './changeset.js';
export * from './electron-api.js';
export * from './embedding-constants.js';
// Export types from other files
export * from './errors.js';
export * from './file-explorer-constants.js';
export * from './file-explorer-persisted-state-types.js';
export * from './file-explorer-selection-types.js';
export * from './file-explorer-state-types.js';
export * from './file-explorer-strings.js';
export * from './file-system.js'; // Added export for file system types
export * from './forge.js';
export * from './git.js';
export * from './tapestry-colors.js';
export * from './view-filter-preset-types.js';
export * from './workspace-path-utils.js';
export * from './worktree.js';

// Explicitly re-export the classes as values
export { ConcurrentLoadingError, FileContentError, PartialRefreshError };

// Local type definition
export type FileContents = Record<string, string>;

// Global module augmentation moved to lucide-react.d.ts
// declare module 'lucide-react';
