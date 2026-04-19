import type { FileChunk, FileChunkUpdate, IDatabase, IFileRecordRepository } from '@brainstrike/db';

export interface FileImportChunkRepository {
  deleteByFileRecordId?(fileRecordId: string): Promise<unknown>;
  insertMany(chunks: FileChunk[]): Promise<unknown>;
  insertManyWithTx?(transaction: IDatabase, chunks: FileChunk[]): Promise<FileChunk[]>;
  update(chunk: FileChunkUpdate): Promise<FileChunk | null>;
}

export type FileImportFileRecordRepository = Pick<
  IFileRecordRepository,
  'findById' | 'findByIds' | 'update'
>;
