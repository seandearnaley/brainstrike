// Interfaces

// Base class
export { BaseFileRecordRepository } from './base-repository.js';
export {
  type ElectronDbAPI,
  ElectronFileRecordRepository,
} from './electron-file-record-repository.js';

// Implementations
export { FileRecordRepository } from './file-record-repository.js';
export type { IDatabase, IFileRecordRepository } from './interfaces.js';

// Factory functions
export { createFileRecordRepository, isPGlite } from './repository-factory.js';
