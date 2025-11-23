// Re-export IFileNode from types package for convenience
export type { IFileNode } from '@brainstrike/types';
export * from './adapters/electron-adapter';
export * from './adapters/mock-file-system-adapter';
export * from './adapters/web-adapter';
export * from './dev-fixture-adapter';
export * from './dev-fixture-types';
export * from './errors';
export * from './factory';
// Testing utilities
export * from './testing/mock-data';
export * from './types';
// Note: utils.ts is NOT exported from index because it imports node:fs/promises
// which breaks renderer processes. Import from './utils' directly if needed in main process.
