// Export types from other files
export * from "./errors";
export * from "./git-types";
export * from "./file-explorer-types";
export * from "./file-system"; // Added export for file system types

// Local type definition
export type FileContents = Record<string, string>;

// Global module augmentation moved to lucide-react.d.ts
// declare module 'lucide-react';
