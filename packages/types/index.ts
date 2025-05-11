// Import the actual classes
import {
  PartialRefreshError,
  // FSInitializationError, // Removed
  // GitOperationError, // Removed
  FileContentError,
  ConcurrentLoadingError,
} from './errors.js';

// Export types from other files
export * from "./errors.js";
export * from "./file-explorer-types.js";
export * from "./file-explorer-constants.js";
export * from "./file-explorer-strings.js";
// export * from "./git-types"; // Removed as git-types.ts is deleted
export * from "./file-system.js"; // Added export for file system types

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

// Dummy value export to force .d.ts emission
export const __types_dummy_export = 0;

// Global module augmentation moved to lucide-react.d.ts
// declare module 'lucide-react';
