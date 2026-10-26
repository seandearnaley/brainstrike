// Import the actual classes
import { ConcurrentLoadingError, FileContentError, PartialRefreshError } from './errors.ts';

export * from './agent-color.ts';
export * from './assistant-provider-settings.ts';
export * from './changeset.ts';
export * from './database.ts';
export * from './embedding-constants.ts';
// Export types from other files
export * from './errors.ts';
export * from './file-explorer-constants.ts';
export * from './file-explorer-persisted-state-types.ts';
export * from './file-explorer-selection-types.ts';
export * from './file-explorer-state-types.ts';
export * from './file-explorer-strings.ts';
export * from './file-system.ts'; // Added export for file system types
export * from './git.ts';
export * from './view-filter-preset-types.ts';
export * from './workspace-path-utils.ts';
export * from './worktree.ts';

// Explicitly re-export the classes as values
export { ConcurrentLoadingError, FileContentError, PartialRefreshError };

// Local type definition
export type FileContents = Record<string, string>;

// Global module augmentation moved to lucide-react.d.ts
// declare module 'lucide-react';

export type { CollectionMetadata, CollectionRecord } from './collection.ts';
export type { ContentClearCapability, ContentClearResult } from './content-clear.ts';
export type { SourceFileRecord } from './source-file.ts';
export * from './thread-groups.ts';
