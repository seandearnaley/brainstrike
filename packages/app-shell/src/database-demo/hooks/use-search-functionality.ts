import type {
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
} from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useRef, useState } from 'react';
import { getActiveEmbeddingSetId } from '../../vector-preferences';
import type { ChunkSearchResult, SearchFunctionality } from '../types';

export function useSearchFunctionality(
  embeddingService: SimpleEmbeddingService | null,
  chunkRepository: FileChunkRepository | ElectronFileChunkRepository | null,
  repository: FileRecordRepository | ElectronFileRecordRepository | null,
  selectedModel: string,
  toast: ReturnType<typeof useToast>['toast']
): SearchFunctionality {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChunkSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchThreshold, setSearchThreshold] = useState(0.5);
  const [hasSearched, setHasSearched] = useState(false);
  const db = usePGliteDatabase();

  // Maintain an internal service for queries when none is provided (decouples from import toggle)
  const serviceRef = useRef<SimpleEmbeddingService | null>(embeddingService);

  async function ensureServiceReady(modelKey: string): Promise<SimpleEmbeddingService> {
    let svc = serviceRef.current;
    if (!svc) {
      svc = new SimpleEmbeddingService();
      serviceRef.current = svc;
    }
    const status = svc.getStatus();
    const currentKey =
      typeof svc.getCurrentModelKey === 'function' ? svc.getCurrentModelKey() : null;
    // Initialize when not ready, or reinitialize when using a different model
    if (status !== 'ready') {
      await svc.initializeWithModel(modelKey);
      return svc;
    }
    if (currentKey && currentKey !== modelKey) {
      await svc.dispose();
      await svc.initializeWithModel(modelKey);
    }
    return svc;
  }

  function buildSearchOptions(threshold: number) {
    const activeSetId = getActiveEmbeddingSetId();
    return {
      limit: 20,
      threshold,
      ...(activeSetId ? { embeddingSetId: activeSetId } : {}),
    } as const;
  }

  async function getEffectiveModelKey(): Promise<string> {
    const activeSetId = getActiveEmbeddingSetId();
    let modelKey = selectedModel;
    if (db && activeSetId) {
      try {
        const res = await db.query<{ modelKey: string }>(
          'SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1 LIMIT 1',
          [activeSetId]
        );
        if (res.rows[0]?.modelKey) modelKey = res.rows[0].modelKey;
      } catch {
        // keep selectedModel on lookup failure
      }
    }
    return modelKey;
  }

  async function performRepositorySearch(
    embedding: number[]
  ): Promise<Array<{ chunk: FileChunk; similarity: number }>> {
    if (!chunkRepository) return [];
    const options = buildSearchOptions(searchThreshold);
    const repoResults = await chunkRepository.searchSimilar(embedding, options);
    return Array.isArray(repoResults) ? repoResults : [];
  }

  function handleSearchError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const needsSet = /requires embeddingSetId/i.test(message);
    toast({
      title: 'Search Failed',
      description: needsSet
        ? 'Select an active embedding set in Vector Status, then retry.'
        : message || 'Unknown error',
      variant: 'destructive',
    });
  }

  const enrichChunkResults = useCallback(
    async (chunkResults: Array<{ chunk: FileChunk; similarity: number }>) => {
      const results: ChunkSearchResult[] = [];
      for (const chunkResult of chunkResults) {
        let fileRecord: FileRecord | null = (await repository?.findById(
          chunkResult.chunk.fileRecordId
        )) as FileRecord | null;
        if (!fileRecord) {
          // Fallback: synthesize minimal record to avoid hiding valid matches
          fileRecord = {
            id: chunkResult.chunk.fileRecordId,
            name: 'Unknown file',
            path: '(unavailable)',
            size: 0,
            createdAt: chunkResult.chunk.createdAt,
            updatedAt: chunkResult.chunk.updatedAt,
          } as FileRecord;
        }
        results.push({
          chunk: chunkResult.chunk,
          similarity: chunkResult.similarity,
          fileRecord,
        });
      }
      return results;
    },
    [repository]
  );

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !chunkRepository) {
      return;
    }
    setSearching(true);
    setHasSearched(true);
    try {
      // Prefer active embedding set's model when available to avoid dimension mismatch
      const modelKey = await getEffectiveModelKey();
      const svc = await ensureServiceReady(modelKey);
      const queryEmbedding = await svc.generateEmbedding(searchQuery);
      const chunkResults = await performRepositorySearch(queryEmbedding.embedding);
      const results = await enrichChunkResults(chunkResults);
      setSearchResults(results);
    } catch (error) {
      // Ensure deterministic empty state on failures
      setSearchResults([]);
      handleSearchError(error);
    } finally {
      setSearching(false);
      // already set to true at start; keep for symmetry
      setHasSearched(true);
    }
  }, [searchQuery, chunkRepository, selectedModel, db, searchThreshold, enrichChunkResults]);

  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    searching,
    searchThreshold,
    setSearchThreshold,
    handleSearch,
    hasSearched,
  };
}
