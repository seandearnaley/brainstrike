export type { FileRecord } from './models/file-record.js';

// Legacy migration export
export * from './migrations/bootstrap.js';

// New migration system
export { MigrationRunner, migrations } from './migrations/index.js';
export type { Migration } from './migrations/index.js';

// Repository exports
export * from './repositories/index.js';

// Provider and utilities
export * from './db-provider.js';
export * from './wasm-loader.js';
