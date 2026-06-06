// Import the actual classes
import {
  ConcurrentLoadingError,
  // FSInitializationError, // Removed
  // GitOperationError, // Removed
  FileContentError,
  PartialRefreshError,
} from './errors';

export * from './assistant-provider-settings';
export * from './electron-api';
export * from './embedding-constants';
// Export types from other files
export * from './errors';
export * from './file-explorer-constants';
export * from './file-explorer-strings';
export * from './file-explorer-types';
// export * from "./git-types"; // Removed as git-types.ts is deleted
export * from './file-system'; // Added export for file system types
export * from './tapestry-colors';
export * from './view-filter-preset-types';
export * from './workspace-path-utils';

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
