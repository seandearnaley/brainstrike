// Interfaces
export type { IFileRecordRepository, IDatabase } from './interfaces.js';

// Base class
export { BaseFileRecordRepository } from './base-repository.js';

// Implementations
export { FileRecordRepository } from './file-record-repository.js';
export {
  ElectronFileRecordRepository,
  type ElectronDbAPI,
} from './electron-file-record-repository.js';

// Factory functions
export { createFileRecordRepository, isPGlite } from './repository-factory.js';
