export interface FileChunk {
  id: string;
  fileRecordId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize: number;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface FileChunkInsert {
  id: string;
  fileRecordId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize: number;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface FileChunkUpdate {
  id: string;
  content?: string;
  contentHash?: string;
  tokenCount?: number;
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize?: number;
  embedding?: number[];
  updatedAt: string;
}

export interface ChunkSearchResult {
  chunk: FileChunk;
  similarity: number;
  rank: number;
}

export interface ChunkSearchOptions {
  limit?: number;
  threshold?: number;
  fileRecordId?: string;
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
}
