// Re-export IFileNode from types package for convenience
export type { IFileNode } from '@brainstrike/types';
// Explicit .js extensions keep Node ESM resolution happy in Vitest/SSR.
export * from './adapters/electron-adapter.js';
export * from './adapters/mock-file-system-adapter.js';
export * from './adapters/web-adapter.js';
// Configuration for file size limits
export * from './config.js';
export * from './dev-fixture-adapter.js';
export * from './dev-fixture-types.js';
export * from './errors.js';
export * from './factory.js';
// Metadata cache for Electron adapter (BST-146)
export * from './metadata-cache.js';
// Node-only path helpers (avoid importing in renderer processes).
export * from './path-validation.js';
// Testing utilities
export * from './testing/mock-data.js';
export * from './types.js';
// Note: utils.ts is NOT exported from index because it imports node:fs/promises
// which breaks renderer processes. Import from './utils' directly if needed in main process.
