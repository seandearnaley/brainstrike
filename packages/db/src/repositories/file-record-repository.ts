import { BaseFileRecordRepository } from './base-repository.js';

/**
 * File-record repository for direct database access (web, Node, and desktop
 * assistant-server paths). Accepts the shared {@link IDatabase} surface so
 * callers can pass PGlite, RemoteDbClient, or any queryable handle without
 * cast chains.
 */
export class FileRecordRepository extends BaseFileRecordRepository {}
