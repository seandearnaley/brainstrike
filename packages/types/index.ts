// Import the actual classes
import {
  PartialRefreshError,
  FSInitializationError,
  GitOperationError,
  FileContentError,
  ConcurrentLoadingError,
} from './errors';

// Export types from other files
export * from "./errors";
export * from "./git-types";
export * from "./file-explorer-types";
export * from "./file-system"; // Added export for file system types

// Explicitly re-export the classes as values
export {
  PartialRefreshError,
  FSInitializationError,
  GitOperationError,
  FileContentError,
  ConcurrentLoadingError,
};

// Local type definition
export type FileContents = Record<string, string>;

// Global module augmentation moved to lucide-react.d.ts
// declare module 'lucide-react';
