// Import the actual classes
import {
  ConcurrentLoadingError,
  // FSInitializationError, // Removed
  // GitOperationError, // Removed
  FileContentError,
  PartialRefreshError,
} from './errors.js';

export * from './assistant-provider-settings.js';
export * from './changeset.js';
export * from './electron-api.js';
export * from './embedding-constants.js';
// Export types from other files
export * from './errors.js';
export * from './file-explorer-constants.js';
export * from './file-explorer-strings.js';
export * from './file-explorer-types.js';
export * from './file-system.js'; // Added export for file system types
export * from './git.js';
export * from './tapestry-colors.js';
export * from './view-filter-preset-types.js';
export * from './workspace-path-utils.js';

// Explicitly re-export the classes as values
export {
  ConcurrentLoadingError,
  // FSInitializationError, // Removed
  // GitOperationError, // Removed
  FileContentError,
  PartialRefreshError,
};

// Local type definition
export type FileContents = Record<string, string>;

// Dummy value export to force .d.ts emission
export const TYPES_DUMMY_EXPORT = 0;

// Global module augmentation moved to lucide-react.d.ts
// declare module 'lucide-react';
