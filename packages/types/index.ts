// Import the actual classes
import {
  PartialRefreshError,
  // FSInitializationError, // Removed
  // GitOperationError, // Removed
  FileContentError,
  ConcurrentLoadingError,
} from './errors';

// Export types from other files
export * from "./errors";
export * from "./file-explorer-types";
export * from "./file-explorer-constants";
export * from "./file-explorer-strings";
// export * from "./git-types"; // Removed as git-types.ts is deleted
export * from "./file-system"; // Added export for file system types

// Explicitly re-export the classes as values
export {
  PartialRefreshError,
  // FSInitializationError, // Removed
  // GitOperationError, // Removed
  FileContentError,
  ConcurrentLoadingError,
};

// Local type definition
export type FileContents = Record<string, string>;

// Global module augmentation moved to lucide-react.d.ts
// declare module 'lucide-react';
