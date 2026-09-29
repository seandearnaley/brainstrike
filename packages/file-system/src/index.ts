// Re-export IFileNode from types package for convenience
export type { IFileNode } from '@brainstrike/types';
export * from './absolute-read-path.js';
// Explicit .js extensions keep Node ESM resolution happy in Vitest/SSR.
export * from './adapters/mock-file-system-adapter.js';
export * from './adapters/web-adapter.js';
export * from './adapters/web-handle-cache.js';
// Configuration for file size limits
export * from './config.js';
export * from './dev-fixture-adapter.js';
export * from './dev-fixture-types.js';
export * from './errors.js';
export * from './factory.js';
export * from './file-node-handles.js';
// Metadata cache for Electron adapter (BST-146)
export * from './metadata-cache.js';
// Testing utilities
export * from './testing/mock-data.js';
export * from './types.js';
// Note: Electron adapters and path-validation are node-only.
// Import them from '@brainstrike/file-system/electron' and
// '@brainstrike/file-system/path-validation' so renderer bundles
// do not pull node:fs/path modules into browser dependency graphs.
// utils.ts is also intentionally not exported because it imports node:fs/promises.
