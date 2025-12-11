// Re-export IFileNode from types package for convenience
export type { IFileNode } from '@brainstrike/types';
// Explicit .js extensions keep Node ESM resolution happy in Vitest/SSR.
export * from './adapters/electron-adapter.js';
export * from './adapters/mock-file-system-adapter.js';
export * from './adapters/web-adapter.js';
export * from './dev-fixture-adapter.js';
export * from './dev-fixture-types.js';
export * from './errors.js';
export * from './factory.js';
// Testing utilities
export * from './testing/mock-data.js';
export * from './types.js';
// Note: utils.ts is NOT exported from index because it imports node:fs/promises
// which breaks renderer processes. Import from './utils' directly if needed in main process.
