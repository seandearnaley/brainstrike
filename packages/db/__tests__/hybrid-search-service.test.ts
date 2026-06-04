import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChunkSearchResult, FileChunk, FTSSearchResult } from '../src/models/file-chunk.js';
import type { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import {
  createHybridSearchService,
  HybridSearchService,
} from '../src/search/hybrid-search-service.js';

// Mock chunk factory
function createMockChunk(id: string, content: string): FileChunk {
  return {
    id,
    fileRecordId: 'file-1',
    chunkIndex: 0,
    content,
    contentHash: `hash-${id}`,
    tokenCount: content.split(' ').length,
    chunkType: 'text',
    chunkSize: content.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Mock vector search results
function createVectorResult(id: string, content: string, similarity: number): ChunkSearchResult {
  return {
    chunk: createMockChunk(id, content),
    similarity,
    rank: 0, // Will be set by position
  };
}

// Mock FTS results
function createFTSResult(
  id: string,
  content: string,
  rank: number,
  position: number
): FTSSearchResult {
  return {
    chunk: createMockChunk(id, content),
    rank,
    position,
    headline: `...${content.slice(0, 50)}...`,
  };
}

describe('HybridSearchService', () => {
  let mockRepository: {
    searchSimilar: ReturnType<typeof vi.fn>;
    fullTextSearch: ReturnType<typeof vi.fn>;
  };
  let service: HybridSearchService;

  beforeEach(() => {
    mockRepository = {
      searchSimilar: vi.fn(),
      fullTextSearch: vi.fn(),
    };
    service = new HybridSearchService(mockRepository as unknown as FileChunkRepository);
  });

  describe('search', () => {
    it('should combine vector and FTS results using RRF', async () => {
      // Setup: doc1 is top in vector, doc2 is top in FTS, doc3 appears in both
      mockRepository.searchSimilar.mockResolvedValue([
        createVectorResult('doc1', 'semantic match content', 0.95),
        createVectorResult('doc3', 'both matches content', 0.85),
        createVectorResult('doc4', 'only vector content', 0.75),
      ]);

      mockRepository.fullTextSearch.mockResolvedValue([
        createFTSResult('doc2', 'keyword match content', 15.2, 1),
        createFTSResult('doc3', 'both matches content', 12.8, 2),
        createFTSResult('doc5', 'only fts content', 8.5, 3),
      ]);

      const response = await service.search('test query', [0.1, 0.2, 0.3], {
        embeddingSetId: 'test-set',
        limit: 10,
      });

      // Verify both searches were called
      expect(mockRepository.searchSimilar).toHaveBeenCalledOnce();
      expect(mockRepository.fullTextSearch).toHaveBeenCalledOnce();

      // Verify results contain items from both sources
      expect(response.results.length).toBeGreaterThan(0);

      // doc3 should rank highly since it appears in both (sourceCount = 2)
      const doc3 = response.results.find((r) => r.chunk.id === 'doc3');
      expect(doc3).toBeDefined();
      expect(doc3?.sourceCount).toBe(2);

      // All results should have RRF scores
      for (const result of response.results) {
        expect(result.rrfScore).toBeGreaterThan(0);
        expect(result.position).toBeGreaterThan(0);
      }
    });

    it('omits the heavy embedding vector from both source-pool reads', async () => {
      mockRepository.searchSimilar.mockResolvedValue([]);
      mockRepository.fullTextSearch.mockResolvedValue([]);

      await service.search('test query', [0.1, 0.2, 0.3], {
        embeddingSetId: 'test-set',
        limit: 10,
      });

      // RRF fusion needs only ids + scores, and result rows only need the
      // embedding DIMENSION (preserved via vector_dims), never the multi-KB
      // vector. So both fan-out reads must request the projected-away embedding.
      expect(mockRepository.searchSimilar).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ includeEmbedding: false })
      );
      expect(mockRepository.fullTextSearch).toHaveBeenCalledWith(
        'test query',
        expect.objectContaining({ includeEmbedding: false })
      );
    });

    it('should preserve vector similarity scores in results', async () => {
      mockRepository.searchSimilar.mockResolvedValue([
        createVectorResult('doc1', 'vector content', 0.92),
      ]);
      mockRepository.fullTextSearch.mockResolvedValue([]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
      });

      expect(response.results.length).toBe(1);
      expect(response.results[0]?.vectorSimilarity).toBe(0.92);
      expect(response.results[0]?.ftsRank).toBeUndefined();
    });

    it('should preserve FTS rank and headline in results', async () => {
      mockRepository.searchSimilar.mockResolvedValue([]);
      mockRepository.fullTextSearch.mockResolvedValue([
        createFTSResult('doc1', 'fts content', 18.5, 1),
      ]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
      });

      expect(response.results.length).toBe(1);
      expect(response.results[0]?.ftsRank).toBe(18.5);
      expect(response.results[0]?.headline).toBeDefined();
      expect(response.results[0]?.vectorSimilarity).toBeUndefined();
    });

    it('should respect limit option', async () => {
      mockRepository.searchSimilar.mockResolvedValue([
        createVectorResult('doc1', 'content 1', 0.9),
        createVectorResult('doc2', 'content 2', 0.8),
        createVectorResult('doc3', 'content 3', 0.7),
      ]);
      mockRepository.fullTextSearch.mockResolvedValue([
        createFTSResult('doc4', 'content 4', 10, 1),
        createFTSResult('doc5', 'content 5', 8, 2),
      ]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
        limit: 3,
      });

      expect(response.results.length).toBe(3);
    });

    it('should apply minSourceCount filter', async () => {
      mockRepository.searchSimilar.mockResolvedValue([
        createVectorResult('doc1', 'only vector', 0.9),
        createVectorResult('doc2', 'both sources', 0.8),
      ]);
      mockRepository.fullTextSearch.mockResolvedValue([
        createFTSResult('doc2', 'both sources', 10, 1),
        createFTSResult('doc3', 'only fts', 8, 2),
      ]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
        minSourceCount: 2,
      });

      // Only doc2 appears in both sources
      expect(response.results.length).toBe(1);
      expect(response.results[0]?.chunk.id).toBe('doc2');
      expect(response.results[0]?.sourceCount).toBe(2);
    });

    it('should apply vector weight to RRF scoring', async () => {
      mockRepository.searchSimilar.mockResolvedValue([
        createVectorResult('doc1', 'vector match', 0.9),
      ]);
      mockRepository.fullTextSearch.mockResolvedValue([
        createFTSResult('doc2', 'fts match', 10, 1),
      ]);

      // Higher vector weight should boost doc1's score
      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
        vectorWeight: 2.0,
        ftsWeight: 1.0,
      });

      expect(response.results.length).toBe(2);
      // doc1 should be first due to higher vector weight
      expect(response.results[0]?.chunk.id).toBe('doc1');
    });

    it('should apply FTS weight to RRF scoring', async () => {
      mockRepository.searchSimilar.mockResolvedValue([
        createVectorResult('doc1', 'vector match', 0.9),
      ]);
      mockRepository.fullTextSearch.mockResolvedValue([
        createFTSResult('doc2', 'fts match', 10, 1),
      ]);

      // Higher FTS weight should boost doc2's score
      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
        vectorWeight: 1.0,
        ftsWeight: 2.0,
      });

      expect(response.results.length).toBe(2);
      // doc2 should be first due to higher FTS weight
      expect(response.results[0]?.chunk.id).toBe('doc2');
    });

    it('should handle empty vector results', async () => {
      mockRepository.searchSimilar.mockResolvedValue([]);
      mockRepository.fullTextSearch.mockResolvedValue([createFTSResult('doc1', 'fts only', 10, 1)]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
      });

      expect(response.results.length).toBe(1);
      expect(response.metadata.vectorResultCount).toBe(0);
      expect(response.metadata.ftsResultCount).toBe(1);
    });

    it('should handle empty FTS results', async () => {
      mockRepository.searchSimilar.mockResolvedValue([
        createVectorResult('doc1', 'vector only', 0.9),
      ]);
      mockRepository.fullTextSearch.mockResolvedValue([]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
      });

      expect(response.results.length).toBe(1);
      expect(response.metadata.vectorResultCount).toBe(1);
      expect(response.metadata.ftsResultCount).toBe(0);
    });

    it('should handle both empty results', async () => {
      mockRepository.searchSimilar.mockResolvedValue([]);
      mockRepository.fullTextSearch.mockResolvedValue([]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
      });

      expect(response.results.length).toBe(0);
      expect(response.metadata.fusedResultCount).toBe(0);
    });

    it('should pass filters to both searches', async () => {
      mockRepository.searchSimilar.mockResolvedValue([]);
      mockRepository.fullTextSearch.mockResolvedValue([]);

      await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
        fileRecordId: 'file-123',
        chunkType: 'code',
        filePaths: ['/src/test.ts'],
        selectionSnapshotId: 'snapshot-1',
      });

      // Verify vector search received filters
      expect(mockRepository.searchSimilar).toHaveBeenCalledWith(
        [0.1],
        expect.objectContaining({
          fileRecordId: 'file-123',
          chunkType: 'code',
          filePaths: ['/src/test.ts'],
          selectionSnapshotId: 'snapshot-1',
        })
      );

      // Verify FTS received filters
      expect(mockRepository.fullTextSearch).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({
          fileRecordId: 'file-123',
          chunkType: 'code',
          filePaths: ['/src/test.ts'],
          selectionSnapshotId: 'snapshot-1',
        })
      );
    });

    it('should pass FTS-specific options', async () => {
      mockRepository.searchSimilar.mockResolvedValue([]);
      mockRepository.fullTextSearch.mockResolvedValue([]);

      await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
        ftsQueryMode: 'phrase',
        ftsLanguage: 'spanish',
      });

      expect(mockRepository.fullTextSearch).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({
          queryMode: 'phrase',
          language: 'spanish',
        })
      );
    });

    it('should include timing metadata', async () => {
      mockRepository.searchSimilar.mockResolvedValue([]);
      mockRepository.fullTextSearch.mockResolvedValue([]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
      });

      expect(response.metadata.vectorSearchMs).toBeGreaterThanOrEqual(0);
      expect(response.metadata.ftsSearchMs).toBeGreaterThanOrEqual(0);
      expect(response.metadata.fusionMs).toBeGreaterThanOrEqual(0);
      expect(response.metadata.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('should rank results by RRF score descending', async () => {
      // Setup results where combined RRF score order differs from individual rankings
      // With RRF k=60:
      // - doc1: rank 1 vector (1/61) + rank 3 FTS (1/63) ≈ 0.0323
      // - doc2: rank 2 vector (1/62) + rank 2 FTS (1/62) ≈ 0.0322
      // - doc3: rank 3 vector (1/63) + rank 1 FTS (1/61) ≈ 0.0323
      mockRepository.searchSimilar.mockResolvedValue([
        createVectorResult('doc1', 'content 1', 0.95), // Rank 1 in vector
        createVectorResult('doc2', 'content 2', 0.9), // Rank 2 in vector
        createVectorResult('doc3', 'content 3', 0.85), // Rank 3 in vector
      ]);
      mockRepository.fullTextSearch.mockResolvedValue([
        createFTSResult('doc3', 'content 3', 15, 1), // Rank 1 in FTS
        createFTSResult('doc2', 'content 2', 12, 2), // Rank 2 in FTS
        createFTSResult('doc1', 'content 1', 10, 3), // Rank 3 in FTS
      ]);

      const response = await service.search('test', [0.1], {
        embeddingSetId: 'test-set',
      });

      // All docs appear in both, so we can check RRF ordering
      expect(response.results.length).toBe(3);

      // Verify descending RRF score order
      for (let i = 1; i < response.results.length; i++) {
        const prev = response.results[i - 1];
        const curr = response.results[i];
        expect(prev?.rrfScore).toBeGreaterThanOrEqual(curr?.rrfScore ?? 0);
      }

      // All items should have sourceCount = 2 (appeared in both)
      for (const result of response.results) {
        expect(result.sourceCount).toBe(2);
      }

      // doc2 should be last (rank 2+2 = 4 total rank, worst combined)
      // doc1 and doc3 are tied with same RRF scores (rank 1+3 vs 3+1)
      expect(response.results[2]?.chunk.id).toBe('doc2');
    });
  });

  describe('createHybridSearchService', () => {
    it('should create a HybridSearchService instance', () => {
      const service = createHybridSearchService(mockRepository as unknown as FileChunkRepository);
      expect(service).toBeInstanceOf(HybridSearchService);
    });
  });
});
