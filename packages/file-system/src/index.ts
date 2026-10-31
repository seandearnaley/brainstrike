// Re-export IFileNode from types package for convenience
export type { IFileNode } from '@brainstrike/types';
export * from '@brainstrike/types';
export * from './absolute-read-path.ts';
// Explicit .js extensions keep Node ESM resolution happy in Vitest/SSR.
export * from './adapters/mock-file-system-adapter.ts';
// Configuration for file size limits
export * from './config.ts';
export * from './dev-fixture-adapter.ts';
export * from './dev-fixture-types.ts';
export * from './errors.ts';
export * from './factory.ts';
export * from './file-node-handles.ts';
export * from './file-system-access-types.ts';
// Metadata cache for Electron adapter (BST-146)
export * from './metadata-cache.ts';
// Testing utilities
export * from './testing/mock-data.ts';
// Note: Electron adapters and path-validation are node-only.
// Import them from '@brainstrike/file-system/electron' and
// '@brainstrike/file-system/path-validation' so renderer bundles
// do not pull node:fs/path modules into browser dependency graphs.
// utils.ts is also intentionally not exported because it imports node:fs/promises.
