import type {
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileChunk,
  FileChunkRepository,
  FileRecordRepository,
} from '@brainstrike/db';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';
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

  async function ensureServiceReady(
    service: SimpleEmbeddingService,
    modelKey: string
  ): Promise<void> {
    const status = service.getStatus();
    if (status !== 'ready') {
      await service.initializeWithModel(modelKey);
    }
  }

  function buildSearchOptions(threshold: number) {
    const activeSetId = getActiveEmbeddingSetId();
    return {
      limit: 20,
      threshold,
      ...(activeSetId ? { embeddingSetId: activeSetId } : {}),
    } as const;
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
        const fileRecord = await repository?.findById(chunkResult.chunk.fileRecordId);
        if (fileRecord) {
          results.push({
            chunk: chunkResult.chunk,
            similarity: chunkResult.similarity,
            fileRecord,
          });
        }
      }
      return results;
    },
    [repository]
  );

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !embeddingService || !chunkRepository) return;
    setSearching(true);
    try {
      await ensureServiceReady(embeddingService, selectedModel);
      const queryEmbedding = await embeddingService.generateEmbedding(searchQuery);
      const options = buildSearchOptions(searchThreshold);
      const chunkResults = await chunkRepository.searchSimilar(queryEmbedding.embedding, options);
      const results = await enrichChunkResults(chunkResults);
      setSearchResults(results);
    } catch (error) {
      handleSearchError(error);
    } finally {
      setSearching(false);
    }
  }, [
    searchQuery,
    embeddingService,
    chunkRepository,
    selectedModel,
    searchThreshold,
    enrichChunkResults,
  ]);

  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    searching,
    searchThreshold,
    setSearchThreshold,
    handleSearch,
  };
}
